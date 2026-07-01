/**
 * Background service worker for the translator extension.
 * Handles LLM API calls (streaming with fallback), storage management.
 */

/**
 * Keep service worker alive to prevent Chrome from terminating it.
 * Chrome MV3 may kill the service worker after 30s of inactivity,
 * which causes "Failed to fetch" when content script sends messages.
 */
const KEEP_ALIVE_INTERVAL = 25000;
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.storage.local.get('__keepalive__', () => {});
  }, KEEP_ALIVE_INTERVAL);
}

startKeepAlive();

/**
 * 版本更新检查相关常量
 */
const UPDATE_CHECK_ALARM = 'checkUpdate';
const UPDATE_CHECK_INTERVAL_MIN = 1440; // 24小时
const GITHUB_RELEASE_API = 'https://api.github.com/repos/chenzq1604/translator-plugs/releases/latest';
const GITHUB_RELEASE_URL = 'https://github.com/chenzq1604/translator-plugs/releases/tag/';

/**
 * 安装/更新时创建定时检查 alarm，并立即检查一次
 */
chrome.runtime.onInstalled.addListener(function (details) {
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
  checkForUpdate();
});

/**
 * alarm 触发时执行版本检查
 */
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === UPDATE_CHECK_ALARM) {
    checkForUpdate();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  startKeepAlive();
});

/**
 * Normalize the API URL by automatically appending /chat/completions if missing.
 * @param {string} url - The base API URL entered by the user.
 * @returns {string} The full API URL with /chat/completions.
 */
function normalizeApiUrl(url) {
  if (!url) return url;
  url = url.trim();
  // 循环剥离尾部斜杠
  while (url.endsWith('/')) url = url.slice(0, -1);
  // 剥离后再检查是否已包含 /chat/completions
  if (url.endsWith('/chat/completions')) return url;
  return url + '/chat/completions';
}

/**
 * Build the system prompt for batch translation based on direction.
 * @param {string} direction - 'en-zh' (English to Chinese) or 'zh-en' (Chinese to English).
 * @returns {string} The system prompt instructing the model how to translate.
 */
function buildTranslateSystemPrompt(direction) {
  if (direction === 'zh-en') {
    return 'You are a professional Chinese to English translator. I will send you a JSON array of Chinese texts. Translate each one to English. Return each translation on a separate line in the exact format: INDEX|||TRANSLATION where INDEX is the 0-based array position. For example:\n0|||Hello world\n1|||This is a test\nDo not add any other text, explanation, markdown formatting, or code blocks. Just return the translations line by line.';
  }
  return 'You are a professional English to Chinese translator. I will send you a JSON array of English texts. Translate each one to Chinese. Return each translation on a separate line in the exact format: INDEX|||TRANSLATION where INDEX is the 0-based array position. For example:\n0|||你好世界\n1|||这是测试\nDo not add any other text, explanation, markdown formatting, or code blocks. Just return the translations line by line.';
}

/**
 * Build the prompt for multimodal (image) translation based on direction.
 * @param {string} direction - 'en-zh' or 'zh-en'.
 * @returns {string} The prompt instructing the model to OCR and translate.
 */
function buildMultimodalPrompt(direction) {
  if (direction === 'zh-en') {
    return '请识别图片中的所有中文文字，并翻译成英文。保持原文的段落结构。只返回翻译结果，不要其他内容。';
  }
  return '请识别图片中的所有英文文字，并翻译成中文。保持原文的段落结构。只返回翻译结果，不要其他内容。';
}

/**
 * Build parameters to disable thinking/reasoning mode based on API provider and model.
 * Different providers use different parameter names:
 * - DeepSeek & 智谱GLM: thinking: { type: "disabled" }
 * - 通义千问 Qwen: enable_thinking: false
 * - 火山Coding Plan (ark-code-latest): 后端模型不确定，同时添加两种参数
 * - OpenAI/Claude/Moonshot/MiniMax: no thinking by default, no params needed
 * @param {string} apiUrl - The API URL to detect the provider.
 * @param {string} model - The model identifier to detect the actual model.
 * @param {boolean} thinkingEnabled - If true, allow thinking mode (skip disabling params).
 * @returns {Object} Parameters to merge into the request body.
 */
function buildNoThinkingParams(apiUrl, model, thinkingEnabled) {
  if (thinkingEnabled) return {};
  var params = {};
  if (!apiUrl) return params;
  var url = apiUrl.toLowerCase();
  var modelLower = (model || '').toLowerCase();

  // DeepSeek: deepseek.com API 或 model名包含deepseek
  if (url.indexOf('deepseek.com') !== -1 || modelLower.indexOf('deepseek') !== -1) {
    params.thinking = { type: 'disabled' };
  }
  // 智谱GLM: bigmodel.cn API 或 model名包含glm
  if (url.indexOf('bigmodel.cn') !== -1 || modelLower.indexOf('glm') !== -1) {
    params.thinking = { type: 'disabled' };
  }
  // 通义千问: aliyuncs.com/dashscope API 或 model名包含qwen
  if (url.indexOf('aliyuncs.com') !== -1 || url.indexOf('dashscope') !== -1 || modelLower.indexOf('qwen') !== -1) {
    params.enable_thinking = false;
  }
  // 火山Coding Plan: ark-code-latest后端模型不确定，同时添加两种参数（OpenAI兼容API会忽略不认识的参数）
  if (url.indexOf('volces.com') !== -1 && modelLower === 'ark-code-latest') {
    params.thinking = { type: 'disabled' };
    params.enable_thinking = false;
  }
  return params;
}

/**
 * Parse a translation line in the format "INDEX|||TRANSLATION".
 * @param {string} line - A single line from the streaming response.
 * @returns {Object|null} - { index, translation } or null if invalid.
 */
function parseTranslationLine(line) {
  line = line.trim();
  if (!line) return null;
  const separatorIndex = line.indexOf('|||');
  if (separatorIndex === -1) return null;
  const indexStr = line.substring(0, separatorIndex).trim();
  const translation = line.substring(separatorIndex + 3);
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) return null;
  return { index, translation };
}

/**
 * Extract translations from a non-streaming API response.
 * Tries line-by-line INDEX|||TRANSLATION format first, then JSON array format.
 * @param {string} content - The full response content text.
 * @param {number} count - Expected number of translations.
 * @returns {Array<string>|null} Array of translations or null if parsing fails.
 */
function extractTranslationsFromContent(content, count) {
  content = content.trim();

  // When only one translation is expected (e.g. word/sentence lookup),
  // return the full content, stripping any INDEX||| prefix from the first line.
  if (count === 1) {
    const rawLines = content.split('\n');
    const firstLine = rawLines[0];
    const sepIdx = firstLine.indexOf('|||');
    if (sepIdx !== -1) {
      const rest = firstLine.substring(sepIdx + 3);
      if (rawLines.length > 1) {
        // 检查后续行是否也有 INDEX||| 格式
        // 如果有，说明模型误解了指令，把一条文本拆成了多条翻译
        // 只取第一条翻译，丢弃其余行
        let hasMoreIndexedLines = false;
        for (let i = 1; i < rawLines.length; i++) {
          const line = rawLines[i].trim();
          if (line && /^\d+\|\|\|/.test(line)) {
            hasMoreIndexedLines = true;
            break;
          }
        }
        if (hasMoreIndexedLines) {
          return [rest];
        }
        // 正常情况：剩余行是翻译的一部分（如多行文本）
        return [rest + '\n' + rawLines.slice(1).join('\n')];
      }
      return [rest];
    }
    return [content];
  }

  const lines = content.split('\n');
  const lineResults = [];
  let currentResult = null;

  // 逐行解析，非 INDEX||| 格式的行追加到上一条翻译（处理多行翻译内容）
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseTranslationLine(trimmed);
    if (parsed) {
      if (currentResult) lineResults.push(currentResult);
      currentResult = { index: parsed.index, translation: parsed.translation };
    } else if (currentResult) {
      // 非索引行，追加到当前翻译（保留换行）
      currentResult.translation += '\n' + trimmed;
    }
  }
  if (currentResult) lineResults.push(currentResult);

  // 允许模型返回的条数 >= 预期（截取前 count 条），或按 index 过滤
  if (lineResults.length >= count) {
    lineResults.sort((a, b) => a.index - b.index);
    return lineResults.slice(0, count).map(r => r.translation);
  }

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(String);
      }
    } catch (e) {}
  }

  if (lines.length === count) {
    return lines;
  }

  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 安全包装：任何 handler 异常都不会导致调用方挂起
  function safeCall(promise) {
    Promise.resolve(promise).then(
      function (result) { sendResponse(result); },
      function (err) { sendResponse({ success: false, error: err ? err.message : 'Unknown error' }); }
    );
    return true;
  }

  switch (request.type) {
    case 'translateText':
      return safeCall(handleTranslateText(request.data));
    case 'translateMultimodal':
      return safeCall(handleTranslateMultimodal(request.data));
    case 'testModel':
      return safeCall(handleTestModel(request.data));
    case 'getConfig':
      return safeCall(handleGetConfig());
    case 'saveConfig':
      return safeCall(handleSaveConfig(request.data));
    case 'getDefaultModel':
      return safeCall(handleGetDefaultModel(request.data));
    case 'getUpdateStatus':
      return safeCall(handleGetUpdateStatus());
    case 'dismissUpdate':
      return safeCall(handleDismissUpdate(request.data));
    default:
      sendResponse({ success: false, error: 'Unknown message type: ' + request.type });
      return false;
  }
});

/**
 * Handle multimodal (image) translation using a vision-capable model.
 * @param {Object} data - { apiUrl, apiKey, model, image, direction, thinking }
 * @returns {Object} - { success, translation, latency, error }
 */
async function handleTranslateMultimodal(data) {
  if (!data) return { success: false, error: 'Invalid request: data is null' };
  const { apiKey, model, image, direction } = data;
  const apiUrl = normalizeApiUrl(data.apiUrl);
  const prompt = buildMultimodalPrompt(direction);
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(Object.assign({
        model: model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ],
        temperature: 0.3
      }, buildNoThinkingParams(data.apiUrl, model, data.thinking))),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { success: false, error: `HTTP ${response.status} [${apiUrl}]: ${errorText.substring(0, 200) || response.statusText}` };
    }

    const result = await response.json();
    const latency = Date.now() - startTime;
    const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;

    if (!content) {
      return { success: false, error: 'Empty response from model', latency };
    }

    return { success: true, translation: content.trim(), latency };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { success: false, error: 'Translation timed out (120s)' };
    }
    return { success: false, error: err.message || 'Unknown error' };
  }
}

/**
 * Handle non-streaming translation as fallback.
 * @param {Object} data - { apiUrl, apiKey, model, texts }
 * @returns {Object} - { success, translations, latency, error }
 */
async function handleTranslateText(data) {
  try {
    if (!data) return { success: false, error: 'Invalid request: data is null' };
    const { apiKey, model, texts } = data;
    const apiUrl = normalizeApiUrl(data.apiUrl);
    const systemPrompt = buildTranslateSystemPrompt(data.direction);
    const startTime = Date.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(Object.assign({
        model: model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: JSON.stringify(texts)
          }
        ],
        temperature: 0.3
      }, buildNoThinkingParams(data.apiUrl, model, data.thinking)))
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { success: false, error: `HTTP ${response.status} [${apiUrl}]: ${errorText.substring(0, 200) || response.statusText}` };
    }

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      return { success: false, error: `响应非JSON格式: ${responseText.substring(0, 200)}` };
    }

    const latency = Date.now() - startTime;

    if (result.error) {
      return { success: false, error: result.error.message || JSON.stringify(result.error).substring(0, 200) };
    }

    if (result.choices && result.choices[0]) {
      const content = result.choices[0].message.content.trim();
      const translations = extractTranslationsFromContent(content, texts.length);
      if (translations) {
        return { success: true, translations, latency };
      }
      return { success: false, error: `无法解析翻译结果: ${content.substring(0, 200)}` };
    }

    return { success: false, error: `无效的API响应: ${responseText.substring(0, 200)}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Handle streaming translation via long-lived port connection.
 * Auto-detects whether the API actually returns a stream and falls back if not.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translateStream') return;

  port.onMessage.addListener(async (msg) => {
    const { apiKey, model, texts, startIndex } = msg;
    const apiUrl = normalizeApiUrl(msg.apiUrl);
    const systemPrompt = buildTranslateSystemPrompt(msg.direction);

    // 端口断开标志和 AbortController
    let disconnected = false;
    const controller = new AbortController();
    port.onDisconnect.addListener(() => {
      disconnected = true;
      controller.abort();
    });

    // 安全发送消息：端口断开后不再发送
    function safePostMessage(data) {
      if (disconnected) return;
      try { port.postMessage(data); } catch (e) { disconnected = true; }
    }

    const startTime = Date.now();

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(Object.assign({
          model: model,
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: JSON.stringify(texts)
            }
          ],
          temperature: 0.3,
          stream: true
        }, buildNoThinkingParams(msg.apiUrl, model, msg.thinking))),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        safePostMessage({
          type: 'error',
          error: `HTTP ${response.status} [${apiUrl}]: ${errorText.substring(0, 200) || response.statusText}`
        });
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      const isStream = contentType.includes('text/event-stream') || contentType.includes('text/stream');

      if (!isStream) {
        const responseText = await response.text();
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (parseErr) {
          safePostMessage({ type: 'error', error: `响应非JSON格式: ${responseText.substring(0, 200)}` });
          return;
        }

        if (result.error) {
          safePostMessage({ type: 'error', error: result.error.message || JSON.stringify(result.error).substring(0, 200) });
          return;
        }

        if (result.choices && result.choices[0]) {
          const content = result.choices[0].message.content.trim();
          const translations = extractTranslationsFromContent(content, texts.length);
          if (translations) {
            for (let i = 0; i < translations.length; i++) {
              safePostMessage({
                type: 'translation',
                index: startIndex + i,
                translation: translations[i]
              });
            }
          } else {
            safePostMessage({ type: 'error', error: `无法解析翻译结果: ${content.substring(0, 200)}` });
            return;
          }
        } else {
          safePostMessage({ type: 'error', error: `无效的API响应: ${responseText.substring(0, 200)}` });
          return;
        }

        safePostMessage({ type: 'done', latency: Date.now() - startTime });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let lineBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // 规范化 \r\n 为 \n，兼容不同 SSE 服务器实现
        sseBuffer = sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() || '';

        for (const event of events) {
          const eventLines = event.split('\n');
          for (const eventLine of eventLines) {
            if (!eventLine.startsWith('data:')) continue;
            const data = eventLine.slice(5).trim();
            if (data === '[DONE]') continue;
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
              if (!delta) continue;

              lineBuffer += delta;

              let newlineIndex;
              while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
                const completeLine = lineBuffer.substring(0, newlineIndex);
                lineBuffer = lineBuffer.substring(newlineIndex + 1);

                const result = parseTranslationLine(completeLine);
                if (result) {
                  safePostMessage({
                    type: 'translation',
                    index: startIndex + result.index,
                    translation: result.translation
                  });
                }
              }
            } catch (e) {
              // skip unparseable SSE chunks
            }
          }
        }
      }

      const remaining = lineBuffer.trim();
      if (remaining) {
        const result = parseTranslationLine(remaining);
        if (result) {
          safePostMessage({
            type: 'translation',
            index: startIndex + result.index,
            translation: result.translation
          });
        }
      }

      safePostMessage({
        type: 'done',
        latency: Date.now() - startTime
      });
    } catch (error) {
      if (error.name === 'AbortError') return; // 端口断开导致的取消，无需报错
      safePostMessage({
        type: 'error',
        error: error.message
      });
    }
  });
});

/**
 * Handle model test request by sending a simple prompt and measuring response time.
 * @param {Object} data - { apiUrl, apiKey, model }
 * @returns {Object} - { success, latency, testTime, returnContent, error }
 */
async function handleTestModel(data) {
  try {
    if (!data) return { success: false, error: 'Invalid request: data is null' };
    const { apiKey, model } = data;
    const apiUrl = normalizeApiUrl(data.apiUrl);
    const startTime = Date.now();
    const testTime = new Date().toLocaleString('zh-CN');

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(Object.assign({
        model: model,
        messages: [
          {
            role: 'user',
            content: '请用一句话介绍你自己。'
          }
        ],
        temperature: 0.7
      }, buildNoThinkingParams(data.apiUrl, model, data.thinking)))
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        success: false,
        error: `HTTP ${response.status} [${apiUrl}]: ${errorText.substring(0, 200) || response.statusText}`,
        latency: 0,
        testTime
      };
    }

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      return {
        success: false,
        error: `响应非JSON格式: ${responseText.substring(0, 200)}`,
        latency: 0,
        testTime
      };
    }

    const latency = Date.now() - startTime;

    if (result.choices && result.choices[0]) {
      const returnContent = result.choices[0].message.content.trim();
      return { success: true, latency, testTime, returnContent };
    }

    if (result.error) {
      return {
        success: false,
        error: result.error.message || JSON.stringify(result.error).substring(0, 200),
        latency,
        testTime
      };
    }

    return { success: false, error: `无效的API响应: ${responseText.substring(0, 200)}`, latency, testTime };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      latency: 0,
      testTime: new Date().toLocaleString('zh-CN')
    };
  }
}

/**
 * Get configuration from chrome.storage.
 * @returns {Object} - { models, language, timeout, selectionTranslate }
 */
async function handleGetConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['models', 'language', 'timeout', 'selectionTranslate'], (result) => {
      resolve({
        models: result.models || [],
        language: result.language || 'en-zh',
        timeout: result.timeout || 120,
        selectionTranslate: result.selectionTranslate !== false
      });
    });
  });
}

/**
 * Save configuration to chrome.storage.
 * @param {Object} data - { models, language }
 * @returns {Object} - { success }
 */
async function handleSaveConfig(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      resolve({ success: true });
    });
  });
}

/**
 * Get the default model from chrome.storage.
 * Supports two default types: 'text' (page/compare/word/selection translation)
 * and 'pic' (scanned PDF / image translation via vision model).
 * @param {Object} data - { type: 'text' | 'pic' }, defaults to 'text'.
 * @returns {Object|null} - The default model or null
 */
async function handleGetDefaultModel(data) {
  var type = (data && data.type) || 'text';
  return new Promise((resolve) => {
    chrome.storage.local.get(['models'], (result) => {
      const models = result.models || [];
      var field = type === 'pic' ? 'isDefaultPic' : 'isDefaultText';
      var defaultModel = models.find(function (m) {
        if (m[field] !== undefined) return m[field];
        // 向后兼容：旧数据只有 isDefault
        if (field === 'isDefaultText') return m.isDefault;
        return false;
      });
      resolve(defaultModel || null);
    });
  });
}

/**
 * 调用 GitHub API 检查最新 release，与当前版本比较
 * 有新版本时缓存到 storage 并发送桌面通知
 */
function checkForUpdate() {
  var currentVersion = chrome.runtime.getManifest().version;
  fetch(GITHUB_RELEASE_API, { headers: { 'Accept': 'application/vnd.github+json' } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.tag_name) return;
      var latestVersion = data.tag_name.replace(/^v/, '');
      if (compareVersions(latestVersion, currentVersion) > 0) {
        var updateInfo = {
          hasUpdate: true,
          latestVersion: latestVersion,
          releaseNotes: data.body || '',
          releaseUrl: data.html_url || (GITHUB_RELEASE_URL + 'v' + latestVersion),
          checkedAt: Date.now()
        };
        chrome.storage.local.set({ __updateStatus__: updateInfo });
        chrome.storage.local.get(['__notifiedVersion__', '__dismissedVersion__'], function (result) {
          if (result.__notifiedVersion__ !== latestVersion && result.__dismissedVersion__ !== latestVersion) {
            sendUpdateNotification(updateInfo);
            chrome.storage.local.set({ __notifiedVersion__: latestVersion });
          }
        });
      } else {
        chrome.storage.local.set({ __updateStatus__: { hasUpdate: false, checkedAt: Date.now() } });
      }
    })
    .catch(function (err) {
      console.log('Update check failed:', err.message);
    });
}

/**
 * 语义化版本比较：返回 1 表示 a>b，-1 表示 a<b，0 表示相等
 */
function compareVersions(a, b) {
  var partsA = a.split('.').map(Number);
  var partsB = b.split('.').map(Number);
  for (var i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    var va = partsA[i] || 0;
    var vb = partsB[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * 发送桌面通知提示新版本
 */
function sendUpdateNotification(updateInfo) {
  chrome.notifications.create('translator-update-' + updateInfo.latestVersion, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'translator-plugs 发现新版本 v' + updateInfo.latestVersion,
    message: '点击查看更新内容并下载新版本',
    priority: 2
  });
}

/**
 * 点击通知后打开 GitHub Release 页面
 */
chrome.notifications.onClicked.addListener(function (notificationId) {
  if (notificationId && notificationId.indexOf('translator-update-') === 0) {
    chrome.storage.local.get('__updateStatus__', function (result) {
      var status = result.__updateStatus__;
      if (status && status.releaseUrl) {
        chrome.tabs.create({ url: status.releaseUrl });
      }
    });
    chrome.notifications.clear(notificationId);
  }
});

/**
 * 返回缓存的更新状态，已忽略的版本不显示更新提示
 */
function handleGetUpdateStatus() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['__updateStatus__', '__dismissedVersion__'], function (result) {
      var status = result.__updateStatus__ || { hasUpdate: false };
      if (result.__dismissedVersion__ && status.latestVersion === result.__dismissedVersion__) {
        status.hasUpdate = false;
      }
      resolve(status);
    });
  });
}

/**
 * 用户忽略某个版本的更新提示
 */
function handleDismissUpdate(data) {
  return new Promise(function (resolve) {
    if (data && data.version) {
      chrome.storage.local.set({ __dismissedVersion__: data.version });
    }
    resolve({ success: true });
  });
}