(function () {
  'use strict';

  let isTranslated = false;
  let textEntries = [];
  let configVisible = false;
  let isTranslating = false;
  let cancelTranslation = false;
  let currentModels = [];
  let editingModelId = null;
  let loadedConfigVersion = 0;
  let loadedModelsSnapshot = '';
  let configLockId = null;
  let configLockHeartbeat = null;
  let domObserver = null;
  let pendingObserverTimer = null;
  let defaultTextModelCache = null;
  let defaultPicModelCache = null;
  let batchTimeout = 120;
  let selectionTranslateEnabled = true;
  let translateDirection = 'en-zh';
  let selectionTranslateBtn = null;
  let selectionTranslatePopup = null;
  let isCompareMode = false;
  let isPicTranslating = false;
  let compareEntries = [];
  let compareOverlay = null;
  let selectionListenersBound = false;
  let translatedTracks = [];
  let shadowObservers = [];
  let processedTextNodes = new WeakSet();

  const BATCH_SIZE = 30;
  const CONCURRENCY = 3;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'MATH', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR'
  ]);
  const TRANSLATABLE_ATTRS = ['aria-label', 'title', 'alt', 'placeholder'];

  /**
   * 安全读取元素的 id 属性字符串。
   * 不能直接读 el.id：HTMLFormElement 等"具名属性集合"元素在内部存在 name/id 为 "id" 的子元素时，
   * el.id 会返回该子元素对象（非字符串），后续 .startsWith/.indexOf 会抛 TypeError，
   * 从而中断整页文本采集并把翻译状态永久卡在"翻译中"。
   * @param {Element} el - 目标元素。
   * @returns {string} 元素的 id 属性值；无 id 属性或非元素时返回空字符串。
   */
  function getElementIdAttr(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    var id = el.getAttribute('id');
    return typeof id === 'string' ? id : '';
  }

  const MODEL_PRESETS = {
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
    'zhipu-glm5': { name: 'GLM-5.1', apiUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
    'volcengine-ark-code': { name: 'ark-code-latest', apiUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'ark-code-latest' },
    'minimax-m2.7': { name: 'MiniMax M2.7', apiUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-M2.7' }
  };

  const isTopFrame = (window === window.top);

  init();

  /**
   * Initialize the extension: create UI elements only in top frame, load config.
   * Iframe instances listen for translation commands from the top frame.
   */
  function init() {
    if (isTopFrame) {
      if (document.getElementById('translator-float-panel')) return;
      createFloatPanel();
      createConfigPanel();
      createWordPanel();
      createAddModelModal();
      createToast();
      createProgressBar();
      initSelectionTranslate();
      watchPanelRemoval();
      // 页面卸载时释放配置面板全局锁，避免其他窗口长时间无法打开配置面板
      window.addEventListener('pagehide', releaseConfigPanelLock);
    }
    loadConfig();
    listenForFrameMessages();
    checkUpdateStatus();
  }

  /**
   * Periodically check if the float panel has been removed from the DOM
   * (e.g. by React hydration or page scripts) and re-create all UI if so.
   */
  function watchPanelRemoval() {
    setInterval(function () {
      if (!document.getElementById('translator-float-panel')) {
        createFloatPanel();
        createConfigPanel();
        createWordPanel();
        createAddModelModal();
        createToast();
        createProgressBar();
        syncButtonState();
        checkUpdateStatus();
      }
    }, 2000);
  }

  /**
   * Sync button state after panel rebuild.
   * Restores the translate button text/class based on isTranslated flag.
   */
  function syncButtonState() {
    var btn = document.getElementById('translator-btn-translate');
    if (!btn) return;
    if (isTranslated) {
      btn.classList.add('translator-translated');
      btn.textContent = '原文';
    } else {
      btn.classList.remove('translator-translated');
      btn.textContent = '翻译';
    }
    if (isTranslating) {
      btn.classList.add('translator-loading');
      btn.textContent = '翻译中';
    }
    if (isCompareMode) {
      var compareBtn = document.getElementById('translator-btn-compare');
      if (compareBtn) {
        compareBtn.textContent = '对照中';
        compareBtn.style.background = '#52c41a';
        compareBtn.style.color = '#fff';
        compareBtn.style.borderColor = '#52c41a';
      }
    }
  }

  /**
   * 查询 background 缓存的更新状态，显示/隐藏红点徽章
   */
  function checkUpdateStatus() {
    chrome.runtime.sendMessage({ type: 'getUpdateStatus' }, function (response) {
      if (chrome.runtime.lastError) return;
      var badge = document.getElementById('translator-update-badge');
      if (!badge) return;
      if (response && response.hasUpdate) {
        badge.style.display = 'block';
        badge.setAttribute('data-version', response.latestVersion);
        renderUpdateSection(response);
      } else {
        badge.style.display = 'none';
      }
    });
  }

  /**
   * 在配置面板中渲染版本更新区域：版本号、更新日志、下载/忽略按钮
   */
  function renderUpdateSection(updateInfo) {
    var section = document.getElementById('translator-update-section');
    if (!section) {
      section = document.createElement('div');
      section.id = 'translator-update-section';
      section.className = 'translator-section translator-update-section';
      var infoArea = document.querySelector('.translator-config-info');
      if (infoArea) {
        infoArea.parentNode.insertBefore(section, infoArea);
      } else {
        var body = document.querySelector('.translator-config-body');
        if (body) body.appendChild(section);
      }
    }
    var currentVersion = chrome.runtime.getManifest().version;
    section.innerHTML =
      '<h4>有新版本</h4>' +
      '<div class="translator-update-current">当前版本: v' + currentVersion + '</div>' +
      '<div class="translator-update-latest">最新版本: v' + updateInfo.latestVersion + '</div>' +
      '<div class="translator-update-notes">' + renderMarkdown(updateInfo.releaseNotes) + '</div>' +
      '<div class="translator-update-actions">' +
        '<a href="' + updateInfo.releaseUrl + '" target="_blank" rel="noopener noreferrer" class="translator-update-download">前往下载</a>' +
        '<button id="translator-update-dismiss" class="translator-update-dismiss">忽略此版本</button>' +
      '</div>';
    var dismissBtn = document.getElementById('translator-update-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'dismissUpdate', data: { version: updateInfo.latestVersion } }, function () {
          checkUpdateStatus();
          showToast('已忽略此版本的更新提示', 'info');
        });
      });
    }
  }

  /**
   * Handle the compare button click.
   * Toggles between starting compare translation and restoring the page.
   */
  async function handleCompareClick() {
    if (isPicTranslating) {
      showToast('PIC翻译正在进行中，请先取消PIC翻译', 'warning');
      return;
    }

    if (isCompareMode) {
      restoreCompare();
      return;
    }
    await startCompareTranslation();
  }

  /**
   * Handle PIC button click: detect scanned PDF or images and translate via vision model.
   */
  async function handlePicClick() {
    if (isPicTranslating) {
      cancelTranslation = true;
      return;
    }

    if (isTranslating) {
      showToast('页面翻译正在进行中，请先取消', 'warning');
      return;
    }
    if (isCompareMode) {
      showToast('对照翻译正在进行中，请先取消', 'warning');
      return;
    }

    var picModel = defaultPicModelCache;
    if (!picModel) {
      picModel = await getDefaultModel('pic');
      if (!picModel) {
        // 没有 PIC 默认模型，查找任意多模态模型作为后备
        var fallbackVision = currentModels.find(function (m) { return m.vision; });
        if (!fallbackVision) {
          showToast('请先在配置中设置 PIC 默认模型（需多模态）', 'error');
          return;
        }
        picModel = fallbackVision;
      }
      defaultPicModelCache = picModel;
    }

    // 防护：PIC默认模型必须支持多模态
    if (!picModel.vision) {
      defaultPicModelCache = null;
      showToast('PIC默认模型不支持多模态，请设置多模态模型为PIC默认', 'error');
      return;
    }

    var pdfResult = detectScannedPdf();
    if (pdfResult && pdfResult.isScanned) {
      isCompareMode = true;
      isPicTranslating = true;
      cancelTranslation = false;
      var picBtn = document.getElementById('translator-btn-pic');
      if (picBtn) {
        picBtn.textContent = '取消';
        picBtn.style.background = '#ff4d4f';
        picBtn.style.color = '#fff';
        picBtn.style.borderColor = '#ff4d4f';
      }
      await translateScannedPdf(picModel, pdfResult.canvases);
      if (picBtn) {
        picBtn.textContent = 'PIC';
        picBtn.style.background = '';
        picBtn.style.color = '';
        picBtn.style.borderColor = '';
      }
      isCompareMode = false;
      isPicTranslating = false;
      cancelTranslation = false;
      return;
    }

    showToast('未检测到可识别的图片或PDF', 'info');
  }

  /**
   * Start compare translation: collect text nodes, translate them, and insert
   * the translation directly below each original text in the page.
   */
  async function startCompareTranslation() {
    var model = defaultTextModelCache;
    if (!model) {
      model = await getDefaultModel('text');
      if (!model) {
        showToast('请先配置好大模型', 'error');
        return;
      }
      defaultTextModelCache = model;
    }

    isCompareMode = true;
    cancelTranslation = false;
    var compareBtn = document.getElementById('translator-btn-compare');
    if (compareBtn) {
      compareBtn.textContent = '对照中';
      compareBtn.style.background = '#52c41a';
      compareBtn.style.color = '#fff';
      compareBtn.style.borderColor = '#52c41a';
    }

    // 创建浮动层（所有译文卡片将放在此层中，不破坏页面 DOM 结构）
    createCompareFloatLayer();

    compareEntries = [];
    collectCompareTexts(document.body, compareEntries);

    // 专门收集 <pre> 标签（LICENSE 等长文本通常在 <pre> 中）
    collectPreElements(compareEntries);

    if (compareEntries.length === 0) {
      COMPARE_BLOCK_TAGS.add('DIV');
      try { collectCompareTexts(document.body, compareEntries); }
      finally { COMPARE_BLOCK_TAGS.delete('DIV'); }
    }

    // 如果仍然没有收集到内容，稍等 2 秒再试（处理 LICENSE 等 JS 动态加载内容）
    if (compareEntries.length === 0) {
      await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      collectCompareTexts(document.body, compareEntries);
      collectPreElements(compareEntries);
      if (compareEntries.length === 0) {
        COMPARE_BLOCK_TAGS.add('DIV');
        try { collectCompareTexts(document.body, compareEntries); }
        finally { COMPARE_BLOCK_TAGS.delete('DIV'); }
        collectPreElements(compareEntries);
      }
    }

    if (compareEntries.length === 0) {
      showToast('未找到可翻译的内容', 'info');
      restoreCompare();
      return;
    }

    showToast('对照翻译中... 共' + compareEntries.length + '条', 'info');

    var translated = 0;
    var failedCount = 0;

    async function translateOne(index) {
      if (!isCompareMode || index >= compareEntries.length) return;
      var entry = compareEntries[index];
      return new Promise(function (resolve) {
        // 超时保护：60 秒无响应则放弃此条
        var settled = false;
        var timer = setTimeout(function () {
          if (!settled) {
            settled = true;
            failedCount++;
            resolve();
          }
        }, 60000);

        chrome.runtime.sendMessage({
          type: 'translateText',
          data: {
            apiUrl: model.apiUrl,
            apiKey: model.apiKey,
            model: model.model,
            texts: [entry.originalText]
          }
        }, function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (response && response.success && response.translations && response.translations.length > 0) {
            entry.translatedText = response.translations[0];
            insertCompareTranslation(index);
            translated++;
          } else {
            failedCount++;
          }
          resolve();
        });
      });
    }

    async function runBatch(startIndex) {
      var tasks = [];
      for (var k = 0; k < CONCURRENCY && (startIndex + k) < compareEntries.length; k++) {
        tasks.push(translateOne(startIndex + k));
      }
      await Promise.all(tasks);
    }

    for (var i = 0; i < compareEntries.length; i += CONCURRENCY) {
      if (!isCompareMode) break;
      await runBatch(i);
    }

    if (!isCompareMode) return;

    if (failedCount > 0 && translated === 0) {
      showToast('翻译失败，请检查模型配置', 'error');
      restoreCompare();
    } else if (failedCount > 0) {
      showToast('对照翻译完成（部分失败）', 'info');
    } else {
      showToast('对照翻译完成', 'success');
    }
  }

  /**
   * 判断一段文本是否需要跳过翻译。
   * 跳过的情况：
   *  1. 已经是中文（中文字符占比 > 50%）
   *  2. 太短（< 3个字符）或太长（> 3000字符，单行限制，避免极端巨型文本）
   *  3. 纯数字 / 日期 / 版本号 / 百分比 / 计数类文本
   *  4. 常见 UI 按钮/提示英文短语（如 OK, Reload, Loading 等）
   *  5. 代码 / JSON / HTML 片段（但排除明显是自然语言文本的情况）
   *  6. 纯标点/特殊符号
   *  7. 前后翻译相同（模型返回原文）
   * @param {string} text
   * @returns {boolean}
   */
  function shouldSkipTranslation(text) {
    if (!text) return true;
    var t = text.trim();
    if (t.length === 0) return true;

    // 太短：少于 3 个字符（如 "OK"、"Go"）直接跳过
    if (t.length < 3) return true;

    // 太长（> 50000 字符）跳过，避免极端单行占据所有 token
    // 50000 字符可覆盖 GPL 等长协议文本（约 35000 字符）
    if (t.length > 50000) return true;

    // 纯数字、日期、版本号、百分比、计数
    if (/^[\d\s\.:,\-/]+$/.test(t)) return true;
    if (/^\d+(\.\d+)*[\sa-zA-Z]*$/.test(t)) return true; // e.g. "1.2k", "1.2.3", "1.2k stars"

    // 纯标点/符号
    if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true;

    // 统计中英文字符数量
    var cjkCount = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    var asciiLetterCount = (t.match(/[a-zA-Z]/g) || []).length;

    if (translateDirection === 'zh-en') {
      // 中文→英文模式：跳过已为英文或英文为主的文本，收集中文文本
      if (asciiLetterCount > 0 && cjkCount === 0) return true; // 全英文
      if (asciiLetterCount > 0 && asciiLetterCount >= cjkCount * 1.5) return true; // 英文为主
      // 没有任何中文（只有数字、符号或空）
      if (cjkCount === 0) return true;
    } else {
      // 英文→中文模式（默认）：跳过已为中文或中文为主的文本
      if (cjkCount > 0 && asciiLetterCount === 0) return true; // 全中文
      if (cjkCount > 0 && cjkCount >= asciiLetterCount * 1.5) return true; // 中文为主
      // 没有任何英文（只有数字、符号或空）
      if (asciiLetterCount === 0) return true;
    }

    // 常见 UI 短语或按钮：大小写不敏感 + 长度 < 25
    var uiPhrases = [
      'ok', 'reload', 'refresh', 'close', 'cancel', 'confirm', 'submit',
      'loading', 'error', 'warning', 'success', 'failed', 'done', 'yes',
      'no', 'save', 'delete', 'remove', 'edit', 'create', 'new', 'open',
      'copy', 'paste', 'sign in', 'login', 'logout', 'log out', 'sign out',
      'try again', 'try again?', 'dismiss', 'go', 'back', 'next', 'previous',
      'skip', 'menu', 'settings', 'about', 'help', 'search', 'reply', 'like',
      'follow', 'unfollow', 'star', 'unstar', 'fork', 'watch', 'code', 'raw',
      'issues', 'pull requests', 'pull request', 'actions', 'projects', 'wiki',
      'security', 'insights', 'show', 'hide', 'more', 'less', 'all', 'none',
      'default', 'custom', 'file', 'raw', 'blame', 'history', 'permalink'
    ];
    var tl = t.toLowerCase();
    if (tl.length <= 25 && uiPhrases.indexOf(tl) !== -1) return true;

    // GitHub UI 错误提示/弹窗文本过滤（这些文本通常在隐藏的弹窗模板中）
    var githubUiPatterns = [
      /sorry,?\s*something went wrong/i,
      /oops!?/i,
      /uh\s*oh/i,
      /error\s+(while\s+)?loading[\s\S]*reload/i,
      /loading error[\s\S]*reload/i,
      /something went wrong/i,
      /unable to load/i,
      /add this (repo|repository) to a list/i,
      /create a list/i,
      /you don(?:'|')t have any lists?/i,
      /add to list/i,
      /fork your own copy of/i
    ];
    for (var gi = 0; gi < githubUiPatterns.length; gi++) {
      if (githubUiPatterns[gi].test(t)) return true;
    }

    // 代码/JSON检测（但不把明显自然语言的长文本误判）
    if (isCodeOrJson(t)) return true;

    return false;
  }

  /**
   * 判断文本是否为 JSON / 代码片段，这类内容不应翻译。
   * 关键改进：只有"非常像代码"的文本才会被拦截，避免把 LICENSE 等自然语言误判。
   * @param {string} text
   * @returns {boolean}
   */
  function isCodeOrJson(text) {
    if (!text) return false;
    var t = text.trim();

    // 1. 有效的 JSON：以 { 开头且 } 结尾，或以 [ 开头且 ] 结尾，JSON.parse 成功
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        JSON.parse(t);
        return true;
      } catch (e) {}
    }

    // 2. 典型代码前缀关键字（function / var / const / import / HTML 标签 等）
    //    仅在前 120 字符内出现时才认为是代码（避免误抓代码块中间的内容）
    var prefix = t.substring(0, Math.min(120, t.length));
    if (/^(function |var |let |const |return |import |export |class |def |public |private |protected |static |#include |#define |<\/?[a-zA-Z][a-zA-Z0-9-]*)/.test(prefix)) {
      return true;
    }

    // 3. 代码特征字符（{}[];:）的比例非常高（>= 8%），且有英文关键词
    //    这是真正像 JSON/YAML/代码的情况 —— 自然语言中 {} 出现率极低
    var codeCharCount = (t.match(/[{}[\];:]/g) || []).length;
    var codeRatio = codeCharCount / Math.max(t.length, 1);
    if (codeCharCount >= 4 && codeRatio > 0.05) {
      // 但排除"明显是自然语言"的情况：包含常见英文动词且 {} 不是核心结构
      // 这里不排除，{} 超过 5% 的文本在自然语言中极罕见
      return true;
    }

    // 4. 包含字面 \n / \t / \r 等转义序列（即模型输出的 JSON 文本）
    if (/\\n|\\t|\\r/.test(t)) {
      if (codeRatio > 0.02) return true;
    }

    // 5. 典型文件/URL 路径模式（如 /usr/bin/... 或 file:///...）
    //    不翻译这些路径，但仅在前缀位置
    if (/^([a-zA-Z]:\\|\/([a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]*|file:\/\/[^\s]+)\s*$/.test(t)) {
      return true;
    }

    return false;
  }

  /**
   * 解码模型回显的字面转义序列（\n \t \r \" \'）。
   * 背景：后台按 JSON.stringify 发送待翻译文本（content: JSON.stringify(texts)），
   * 文本节点里真实的换行/制表符在 JSON 中变成字面量 \n / \t，模型会原样回显这些转义；
   * 若直接写入 DOM，页面上就会出现 "\n\t\t开始使用\n\t" 这类字符。
   * 本函数只做解码，不做 trim / 空行压缩，以保留内联元素之间的空白（如 "Hello " + <b>world</b>）。
   * @param {string} text
   * @returns {string}
   */
  function decodeModelEscapeSequences(text) {
    if (!text) return '';
    var s = String(text);

    // 先保护 \\ （双反斜杠，表示字面反斜杠），用占位符替换
    s = s.replace(/\\\\/g, '\x00BACKSLASH\x00');

    // 把字面出现的 \n / \t / \r 转成实际换行/制表/回车
    s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

    // 把字面出现的 \" / \' 转成引号
    s = s.replace(/\\"/g, '"').replace(/\\'/g, "'");

    // 恢复字面反斜杠
    s = s.replace(/\x00BACKSLASH\x00/g, '\\');

    return s;
  }

  /**
   * 清理翻译文本中的转义字符（对照模式浮动卡片用：解码 + 裁掉多余空白）。
   * @param {string} text
   * @returns {string}
   */
  function cleanTranslatedText(text) {
    if (!text) return '';
    var cleaned = decodeModelEscapeSequences(text);

    // 去除行首行尾多余的空白
    cleaned = cleaned.replace(/[ \t]+$/gm, '');

    // 压缩连续空行为单个换行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }

  /* ========================================================================
   * 对照翻译浮动层管理
   * 浮动卡片不再插入到页面 DOM 结构中，而是用 position:absolute 浮动定位
   * 在原文元素下方显示，完全不破坏原有布局
   * ======================================================================== */
  var compareFloatLayer = null;
  var compareFloatCards = [];
  var compareScrollRAF = null;

  /**
   * 创建全局浮动层。所有对照翻译卡片将放在此层中。
   */
  function createCompareFloatLayer() {
    removeCompareFloatLayer();
    compareFloatLayer = document.createElement('div');
    compareFloatLayer.id = 'translator-compare-float-layer';
    compareFloatLayer.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: 0',
      'overflow: visible',
      'pointer-events: none',
      'z-index: 2147483646'
    ].join(' !important;') + ' !important;';
    document.body.appendChild(compareFloatLayer);

    // 监听滚动和 resize，使用 capture 模式捕获所有滚动容器
    window.addEventListener('scroll', updateCompareFloatPositions, true);
    window.addEventListener('resize', updateCompareFloatPositions);
  }

  /**
   * 更新所有浮动卡片的位置（滚动/resize 时调用）。
   * 使用 requestAnimationFrame 节流。
   */
  function updateCompareFloatPositions() {
    if (compareScrollRAF) return;
    compareScrollRAF = requestAnimationFrame(function () {
      compareScrollRAF = null;
      for (var i = compareFloatCards.length - 1; i >= 0; i--) {
        var item = compareFloatCards[i];
        if (!item.card || !item.element) {
          compareFloatCards.splice(i, 1);
          continue;
        }
        // 原文元素已脱离 DOM（SPA 页面切换等），移除卡片
        if (!item.element.isConnected) {
          if (item.card.parentNode) item.card.parentNode.removeChild(item.card);
          compareFloatCards.splice(i, 1);
          continue;
        }
        var rect = item.element.getBoundingClientRect();
        // 原文元素不可见时隐藏卡片
        if (rect.width === 0 && rect.height === 0) {
          item.card.style.display = 'none';
          continue;
        }
        // 原文在视口上方（已滚走）时隐藏卡片
        if (rect.bottom < -50) {
          item.card.style.display = 'none';
          continue;
        }
        // 原文在视口下方（还没滚到）时隐藏卡片
        if (rect.top > window.innerHeight + 50) {
          item.card.style.display = 'none';
          continue;
        }
        // 被用户拖动过的卡片不更新位置，只确保可见
        if (item.card.getAttribute('data-dragged') === 'true') {
          item.card.style.display = '';
          continue;
        }
        item.card.style.display = '';
        item.card.style.left = rect.left + 'px';
        // 防重叠：检查同一位置是否已有前面的卡片
        var cardTop = rect.bottom + 4;
        for (var ci = 0; ci < i; ci++) {
          var prev = compareFloatCards[ci];
          if (!prev.card || prev.card.style.display === 'none') continue;
          var prevLeft = parseInt(prev.card.style.left) || 0;
          var prevBottom = parseInt(prev.card.style.top) || 0;
          var prevHeight = prev.card.offsetHeight || 0;
          if (Math.abs(prevLeft - rect.left) < 100 && cardTop < prevBottom + prevHeight + 2) {
            cardTop = prevBottom + prevHeight + 2;
          }
        }
        item.card.style.top = cardTop + 'px';
        item.card.style.maxWidth = Math.min(Math.max(rect.width, 200), 600) + 'px';
      }
    });
  }

  /**
   * 移除浮动层及所有卡片，清理事件监听。
   */
  function removeCompareFloatLayer() {
    if (compareScrollRAF) {
      cancelAnimationFrame(compareScrollRAF);
      compareScrollRAF = null;
    }
    window.removeEventListener('scroll', updateCompareFloatPositions, true);
    window.removeEventListener('resize', updateCompareFloatPositions);
    compareFloatCards = [];
    if (compareFloatLayer) {
      compareFloatLayer.remove();
      compareFloatLayer = null;
    }
  }

  /**
   * 将 Markdown 文本渲染为 HTML。
   * 支持：标题、加粗、斜体、行内代码、代码块、无序/有序列表、表格、水平线、段落。
   * 先转义 HTML 防止 XSS，再逐行应用 Markdown 语法转换。
   * @param {string} text - Markdown 原始文本。
   * @returns {string} 渲染后的 HTML 字符串。
   */
  function renderMarkdown(text) {
    if (!text) return '';
    var lines = text.split('\n');
    var html = [];
    var inCodeBlock = false;
    var codeBlockLang = '';
    var codeBlockContent = [];
    var inList = false;
    var listType = '';
    var inTable = false;
    var tableHeaders = [];
    var tableAligns = [];
    var tableRows = [];

    /**
     * 转义 HTML 特殊字符，防止 XSS。
     * @param {string} s - 原始字符串。
     * @returns {string} 转义后的字符串。
     */
    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /**
     * 处理行内 Markdown 语法（加粗、斜体、行内代码、链接）。
     * @param {string} s - 单行文本。
     * @returns {string} 处理后的 HTML。
     */
    function processInline(s) {
      var result = escapeHtml(s);
      // 行内代码（先处理，避免代码内容被其他规则影响）
      result = result.replace(/`([^`]+)`/g, function (m, code) {
        return '<code style="background:#f5f5f5;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:12px;">' + code + '</code>';
      });
      // 加粗 **text** 或 __text__
      result = result.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      // 斜体 *text* 或 _text_
      result = result.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
      result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>');
      // 链接 [text](url) — 仅允许 http/https 协议，防止 javascript: 等 XSS
      result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, text, url) {
        var trimmedUrl = url.trim();
        if (/^https?:\/\//i.test(trimmedUrl)) {
          return '<a href="' + trimmedUrl + '" target="_blank" rel="noopener noreferrer" style="color:#1677ff;">' + text + '</a>';
        }
        return text;
      });
      return result;
    }

    /**
     * 刷新表格缓冲：将收集的表格行渲染为 HTML table。
     */
    function flushTable() {
      if (!inTable) return;
      var t = '<table style="border-collapse:collapse;width:100%;font-size:12px;margin:4px 0;">';
      t += '<thead><tr>';
      for (var h = 0; h < tableHeaders.length; h++) {
        var align = tableAligns[h] || 'left';
        t += '<th style="border:1px solid #ddd;padding:4px 8px;background:#fafafa;text-align:' + align + ';font-weight:600;">' + tableHeaders[h] + '</th>';
      }
      t += '</tr></thead><tbody>';
      for (var r = 0; r < tableRows.length; r++) {
        t += '<tr>';
        for (var c = 0; c < tableRows[r].length; c++) {
          var calign = tableAligns[c] || 'left';
          t += '<td style="border:1px solid #ddd;padding:4px 8px;text-align:' + calign + ';">' + tableRows[r][c] + '</td>';
        }
        t += '</tr>';
      }
      t += '</tbody></table>';
      html.push(t);
      inTable = false;
      tableHeaders = [];
      tableAligns = [];
      tableRows = [];
    }

    /**
     * 刷新列表缓冲：关闭当前打开的列表标签。
     */
    function flushList() {
      if (!inList) return;
      html.push('</' + listType + '>');
      inList = false;
      listType = '';
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 代码块处理
      if (line.match(/^```/)) {
        if (inCodeBlock) {
          // 结束代码块
          var codeHtml = '<pre style="background:#f5f5f5;padding:8px 12px;border-radius:4px;overflow-x:auto;font-size:12px;line-height:1.5;margin:4px 0;"><code>' + escapeHtml(codeBlockContent.join('\n')) + '</code></pre>';
          html.push(codeHtml);
          inCodeBlock = false;
          codeBlockLang = '';
          codeBlockContent = [];
        } else {
          // 开始代码块
          flushList();
          flushTable();
          inCodeBlock = true;
          codeBlockLang = line.replace(/^```/, '').trim();
        }
        continue;
      }
      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      // 空行
      if (line.trim() === '') {
        flushList();
        flushTable();
        continue;
      }

      // 标题 # ~ ######
      var headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushList();
        flushTable();
        var level = headingMatch[1].length;
        var sizes = ['20px', '18px', '16px', '14px', '13px', '12px'];
        html.push('<h' + level + ' style="font-size:' + sizes[level - 1] + ';font-weight:600;margin:8px 0 4px 0;color:rgba(0,0,0,0.88);">' + processInline(headingMatch[2]) + '</h' + level + '>');
        continue;
      }

      // 水平线 --- 或 ***
      if (line.match(/^(-{3,}|\*{3,})$/)) {
        flushList();
        flushTable();
        html.push('<hr style="border:none;border-top:1px solid #e0e0e0;margin:8px 0;">');
        continue;
      }

      // 表格行（包含 |）
      if (line.indexOf('|') !== -1 && line.trim().charAt(0) === '|') {
        var cells = line.split('|').filter(function (c, idx, arr) {
          // 去掉首尾空元素
          return !(idx === 0 || idx === arr.length - 1) || c.trim() !== '';
        }).map(function (c) { return c.trim(); });

        // 分隔行 |---|:---:|---:|
        if (cells.every(function (c) { return c.match(/^:?-+:?$/); })) {
          tableAligns = cells.map(function (c) {
            if (c.charAt(0) === ':' && c.charAt(c.length - 1) === ':') return 'center';
            if (c.charAt(c.length - 1) === ':') return 'right';
            return 'left';
          });
          continue;
        }

        if (!inTable) {
          flushList();
          inTable = true;
          tableHeaders = cells.map(function (c) { return processInline(c); });
        } else {
          tableRows.push(cells.map(function (c) { return processInline(c); }));
        }
        continue;
      } else if (inTable) {
        flushTable();
      }

      // 无序列表 - 或 * 开头
      var ulMatch = line.match(/^(\s*)[-\*]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          flushList();
          inList = true;
          listType = 'ul';
          html.push('<ul style="margin:4px 0;padding-left:20px;">');
        }
        html.push('<li style="margin:2px 0;">' + processInline(ulMatch[2]) + '</li>');
        continue;
      }

      // 有序列表 1. 开头
      var olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (olMatch) {
        if (!inList || listType !== 'ol') {
          flushList();
          inList = true;
          listType = 'ol';
          html.push('<ol style="margin:4px 0;padding-left:20px;">');
        }
        html.push('<li style="margin:2px 0;">' + processInline(olMatch[2]) + '</li>');
        continue;
      }

      // 引用 >
      var quoteMatch = line.match(/^>\s*(.*)$/);
      if (quoteMatch) {
        flushList();
        flushTable();
        html.push('<blockquote style="border-left:3px solid #ccc;padding-left:10px;margin:4px 0;color:rgba(0,0,0,0.65);">' + processInline(quoteMatch[1]) + '</blockquote>');
        continue;
      }

      // 普通段落
      flushList();
      flushTable();
      html.push('<p style="margin:3px 0;line-height:1.6;">' + processInline(line) + '</p>');
    }

    // 刷新剩余缓冲
    if (inCodeBlock) {
      html.push('<pre style="background:#f5f5f5;padding:8px 12px;border-radius:4px;overflow-x:auto;font-size:12px;"><code>' + escapeHtml(codeBlockContent.join('\n')) + '</code></pre>');
    }
    flushList();
    flushTable();

    return html.join('');
  }

  /**
   * Translate scanned PDF pages by capturing canvas images and sending to a vision model.
   * @param {Object} model - Vision-capable model config.
   * @param {Array<HTMLCanvasElement>} canvases - PDF canvas elements to translate.
   */
  async function translateScannedPdf(model, canvases) {
    if (!compareFloatLayer) createCompareFloatLayer();

    var picBtn = document.getElementById('translator-btn-pic');
    var totalCanvases = canvases.length;
    var completed = 0;
    var failedCount = 0;

    showToast('PDF视觉翻译中... 共' + totalCanvases + '页', 'info');
    showProgress(0);
    showPicProgress(0, totalCanvases, '准备中...');

    for (var i = 0; i < canvases.length; i++) {
      if (cancelTranslation || !isCompareMode) break;

      var canvas = canvases[i];
      var imageData = canvasToBase64(canvas);
      if (!imageData) { failedCount++; continue; }

      // 在发送API请求前就更新进度，让用户知道正在翻译第几页
      showProgress(Math.round((i / totalCanvases) * 100));
      showPicProgress(i, totalCanvases, '正在翻译第 ' + (i + 1) + ' 页...');
      if (picBtn) {
        picBtn.textContent = (i + 1) + '/' + totalCanvases;
      }

      var result = await new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (!settled) { settled = true; resolve({ success: false, error: 'Timeout' }); }
        }, 120000);

        chrome.runtime.sendMessage({
          type: 'translateMultimodal',
          data: {
            apiUrl: model.apiUrl,
            apiKey: model.apiKey,
            model: model.model,
            image: imageData,
            direction: translateDirection,
            thinking: model.thinking
          }
        }, function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response);
        });
      });

      if (cancelTranslation || !isCompareMode) break;

      if (result && result.success && result.translation) {
        insertPdfTranslationCard(canvas, result.translation);
        completed++;
      } else {
        failedCount++;
        var errMsg = (result && result.error) ? result.error.substring(0, 60) : '翻译失败';
        insertPdfTranslationCard(canvas, '[翻译失败] ' + errMsg, true);
      }

      // 每页完成后更新进度
      showPicProgress(i + 1, totalCanvases, '已完成 ' + (i + 1) + ' 页');
    }

    if (cancelTranslation) {
      showProgress(Math.round((completed + failedCount) / totalCanvases * 100));
      showPicProgress(completed + failedCount, totalCanvases, '已取消');
      showToast('PDF翻译已取消，已完成' + completed + '/' + totalCanvases + '页', 'info');
      setTimeout(hideProgress, 1000);
      hidePicProgress();
    } else if (failedCount === totalCanvases) {
      showProgress(100);
      showPicProgress(totalCanvases, totalCanvases, '全部失败');
      showToast('PDF翻译全部失败', 'error');
      setTimeout(hideProgress, 1000);
      hidePicProgress();
    } else if (failedCount > 0) {
      showProgress(100);
      showPicProgress(totalCanvases, totalCanvases, '完成（部分失败）');
      showToast('PDF翻译完成，成功' + completed + '页，失败' + failedCount + '页', 'info');
      setTimeout(hideProgress, 1500);
      hidePicProgress();
    } else {
      showProgress(100);
      showPicProgress(totalCanvases, totalCanvases, '全部完成');
      showToast('PDF翻译完成，共' + completed + '页', 'success');
      setTimeout(hideProgress, 1500);
      hidePicProgress();
    }
  }

  /**
   * Insert a translation card for a scanned PDF canvas page.
   * @param {HTMLCanvasElement} canvas - The PDF canvas element.
   * @param {string} translatedText - The translated text to display.
   * @param {boolean} isError - Whether this is an error message.
   */
  function insertPdfTranslationCard(canvas, translatedText, isError) {
    if (!isCompareMode) return;
    if (!compareFloatLayer) createCompareFloatLayer();

    var card = document.createElement('div');
    card.className = 'translator-compare-float-card';
    card.style.cssText = [
      'position: absolute',
      'background: ' + (isError ? '#fff2f0' : '#fff'),
      'border-radius: 6px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.12)',
      'border-left: 3px solid ' + (isError ? '#ff4d4f' : '#ccc'),
      'padding: 10px 14px',
      'font-size: 13px',
      'line-height: 1.6',
      'color: ' + (isError ? '#cf1322' : 'rgba(0,0,0,0.88)'),
      'pointer-events: auto',
      'max-width: 600px',
      'max-height: 500px',
      'overflow-y: auto',
      'cursor: grab',
      'z-index: 2147483646'
    ].join(' !important;') + ' !important;';

    if (isError) {
      card.textContent = translatedText;
    } else {
      card.innerHTML = renderMarkdown(translatedText);
    }

    var rect = canvas.getBoundingClientRect();
    var cardTop = rect.bottom + window.scrollY + 4;
    var cardLeft = rect.left + window.scrollX;

    var cardWidth = Math.min(rect.width, 600);
    card.style.left = cardLeft + 'px';
    card.style.top = cardTop + 'px';
    card.style.width = cardWidth + 'px';

    card.setAttribute('data-dragged', 'false');

    card.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var startX = e.clientX;
      var startY = e.clientY;
      var origLeft = parseInt(card.style.left) || 0;
      var origTop = parseInt(card.style.top) || 0;
      var hasMoved = false;

      function onMove(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (!hasMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          hasMoved = true;
          card.style.cursor = 'grabbing';
          card.style.userSelect = 'none';
        }
        if (hasMoved) {
          card.style.left = (origLeft + dx) + 'px';
          card.style.top = (origTop + dy) + 'px';
          card.setAttribute('data-dragged', 'true');
          ev.preventDefault();
        }
      }

      function onUp() {
        if (hasMoved) { card.style.cursor = 'grab'; card.style.userSelect = ''; }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    compareFloatLayer.appendChild(card);
    compareFloatCards.push({ card: card, element: canvas, index: -1 });
  }

  /**
   * 插入对照翻译（浮动窗口模式）。
   * 不再修改页面 DOM 结构，而是在原文元素下方用浮动卡片显示译文。
   * @param {number} index - The entry index in compareEntries.
   */
  function insertCompareTranslation(index) {
    // 如果对照模式已被取消（restoreCompare），不要重建浮动层
    if (!isCompareMode) return;

    var entry = compareEntries[index];
    if (!entry || !entry.element || !entry.translatedText) return;

    var el = entry.element;

    // 原文元素已脱离 DOM，跳过
    if (!el.isConnected) return;

    // 如果翻译结果检测为 JSON / 代码，则不显示对照翻译
    if (isCodeOrJson(entry.translatedText)) return;

    var cleaned = cleanTranslatedText(entry.translatedText);
    if (!cleaned) return;

    // 翻译前后一致（模型返回原文）——跳过
    if (cleaned === entry.originalText.trim()) return;

    // 确保浮动层存在
    if (!compareFloatLayer) createCompareFloatLayer();

    // 创建浮动卡片
    var card = document.createElement('div');
    card.className = 'translator-compare-float-card';
    card.setAttribute('data-translator-compare', index);
    card.style.cssText = [
      'position: absolute',
      'background: #fff',
      'border-radius: 6px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.12)',
      'border-left: 3px solid #ccc',
      'padding: 6px 10px',
      'font-size: 13px',
      'line-height: 1.55',
      'color: rgba(0,0,0,0.88)',
      'pointer-events: auto',
      'max-width: 600px',
      'max-height: 400px',
      'overflow-y: auto',
      'overflow-wrap: anywhere',
      'word-break: break-word',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      'z-index: 2147483646',
      'display: block',
      'opacity: 1',
      'visibility: visible',
      'box-sizing: border-box'
    ].join(' !important;') + ' !important;';

    var escaped = cleaned.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    card.innerHTML = escaped;

    compareFloatLayer.appendChild(card);

    // 计算初始位置
    var rect = el.getBoundingClientRect();
    var cardTop = rect.bottom + 4;

    // 防重叠：检查同一位置是否已有卡片，向下偏移
    for (var ci = 0; ci < compareFloatCards.length; ci++) {
      var prev = compareFloatCards[ci];
      if (!prev.card || prev.card === card) continue;
      var prevRect = prev.card.getBoundingClientRect();
      // 水平位置相近（同一列）且垂直位置重叠 → 向下偏移
      var prevLeft = parseInt(prev.card.style.left) || 0;
      if (Math.abs(prevLeft - rect.left) < 100 && cardTop < prevRect.bottom + 2) {
        cardTop = prevRect.bottom + 2;
      }
    }

    card.style.left = rect.left + 'px';
    card.style.top = cardTop + 'px';
    card.style.maxWidth = Math.min(Math.max(rect.width, 200), 600) + 'px';

    // 添加拖动功能（左键拖动，移动 >3px 才算拖动）
    card.style.cursor = 'grab';
    card.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var startX = e.clientX;
      var startY = e.clientY;
      var cardLeft = parseInt(card.style.left) || 0;
      var cardTop = parseInt(card.style.top) || 0;
      var hasMoved = false;

      function onMove(ev) {
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (!hasMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          hasMoved = true;
          card.style.cursor = 'grabbing';
          card.style.userSelect = 'none';
        }
        if (hasMoved) {
          card.style.left = (cardLeft + dx) + 'px';
          card.style.top = (cardTop + dy) + 'px';
          card.setAttribute('data-dragged', 'true');
          ev.preventDefault();
        }
      }

      function onUp() {
        if (hasMoved) {
          card.style.cursor = 'grab';
          card.style.userSelect = '';
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 存储引用以便滚动时更新位置
    compareFloatCards.push({ card: card, element: el, index: index });
  }

  /**
   * Restore the page by removing all inserted compare translation elements.
   */
  function restoreCompare() {
    isCompareMode = false;
    compareEntries = [];

    // 清理浮动层及所有卡片
    removeCompareFloatLayer();

    var compareBtn = document.getElementById('translator-btn-compare');
    if (compareBtn) {
      compareBtn.textContent = '对照';
      compareBtn.style.background = '';
      compareBtn.style.color = '';
      compareBtn.style.borderColor = '';
    }
  }

  /**
   * Block-level element tags that are valid containers for compare translation.
   * Only these elements will have translations inserted after them.
   * Inline elements (span, a, strong, etc.) are excluded to avoid breaking
   * paragraph structure.
   */
  var COMPARE_BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
    'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'PRE'
  ]);

  /**
   * 快速检查元素是否可见（display:none、hidden 属性等）。
   * 对于不可见元素，offsetParent 为 null（fixed 定位除外）。
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    // offsetParent 为 null 且不是 fixed → 不可见
    if (el.offsetParent === null) {
      var style = window.getComputedStyle(el);
      if (style.position === 'fixed' &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity) !== 0) {
        return true;
      }
      return false;
    }
    // offsetParent 不为 null，但仍需检查 visibility 和 opacity
    // GitHub 等站点常用 visibility:hidden 隐藏弹窗模板
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    return true;
  }

  /**
   * 专门收集 <pre> 标签中的文本（如 LICENSE 等长文本）。
   * 补充 collectCompareTexts 可能遗漏的 <pre> 内容。
   * @param {Array} entries - Array to store entries.
   */
  function collectPreElements(entries) {
    var preElements = document.querySelectorAll('pre');
    for (var i = 0; i < preElements.length; i++) {
      var preEl = preElements[i];
      // 跳过翻译插件自己的元素
      if (getElementIdAttr(preEl).startsWith('translator-')) continue;
      if (preEl.closest && preEl.closest('[id^="translator-"]')) continue;
      // 跳过不可见元素
      if (!isElementVisible(preEl)) continue;

      var text = preEl.textContent.trim();
      if (!text) continue;
      if (!/[a-zA-Z]/.test(text)) continue;
      if (text.length > 50000) continue;
      if (isCodeOrJson(text)) continue;
      if (shouldSkipTranslation(text)) continue;

      // 检查是否已被收集（避免重复）
      var alreadyCollected = false;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].element === preEl) {
          alreadyCollected = true;
          break;
        }
      }
      if (alreadyCollected) continue;

      // 对于长文本（> 5000 字符），按段落合并成约 2000 字符的块后翻译
      // 避免单条 35000 字符的文本导致模型超时，也避免 122 个段落太多
      if (text.length > 5000) {
        var paragraphs = text.split(/\n\s*\n/); // 按空行分割
        var currentChunk = '';
        for (var pi = 0; pi < paragraphs.length; pi++) {
          var paraText = paragraphs[pi].trim();
          if (!paraText || paraText.length < 3) continue;
          if (!/[a-zA-Z]/.test(paraText)) continue;

          // 合并相邻段落，直到达到约 2000 字符
          if (currentChunk.length + paraText.length + 2 > 2000 && currentChunk) {
            // 当前块已满，提交
            if (!isCodeOrJson(currentChunk) && !shouldSkipTranslation(currentChunk)) {
              entries.push({ element: preEl, originalText: currentChunk });
            }
            currentChunk = paraText;
          } else {
            currentChunk = currentChunk ? currentChunk + '\n\n' + paraText : paraText;
          }
        }
        // 提交最后一个块
        if (currentChunk && !isCodeOrJson(currentChunk) && !shouldSkipTranslation(currentChunk)) {
          entries.push({ element: preEl, originalText: currentChunk });
        }
      } else {
        entries.push({
          element: preEl,
          originalText: text
        });
      }
    }
  }

  /**
   * Collect text from block-level elements for compare mode.
   * Only collects from leaf block elements (no nested block elements inside)
   * to avoid inserting translations in the middle of a section.
   * Inline child elements (span, a, strong, etc.) are ignored in nesting check.
   * @param {Node} root - The root node to traverse.
   * @param {Array} entries - Array to store entries.
   */
  /**
   * Detect if the page is a scanned PDF rendered via canvas (e.g. react-pdf).
   * Returns { canvases: [...], isScanned: true } or null.
   */
  function detectScannedPdf() {
    var canvases = document.querySelectorAll('canvas');
    if (canvases.length === 0) return null;

    var pdfCanvases = [];
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      if (c.width === 0 || c.height === 0) continue;
      var parent = c.parentElement;
      if (!parent) continue;
      var parentClass = (parent.className || '').toString().toLowerCase();
      if (parentClass.indexOf('pdf') !== -1 || parentClass.indexOf('react-pdf') !== -1) {
        pdfCanvases.push(c);
      }
    }

    if (pdfCanvases.length === 0) return null;

    var hasTextContent = false;
    for (var j = 0; j < pdfCanvases.length; j++) {
      var p = pdfCanvases[j].parentElement;
      var textLayer = p.querySelector('.textLayer, .react-pdf__Page__textContent');
      if (textLayer && textLayer.querySelectorAll('span').length > 0) {
        hasTextContent = true;
        break;
      }
    }

    if (hasTextContent) return null;

    return { canvases: pdfCanvases, isScanned: true };
  }

  /**
   * Convert a canvas element to a JPEG base64 data URL.
   * @param {HTMLCanvasElement} canvas - The canvas to convert.
   * @returns {string|null} Base64 data URL or null if canvas is empty.
   */
  function canvasToBase64(canvas) {
    if (canvas.width === 0 || canvas.height === 0) return null;
    try {
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return null;
    }
  }

  function collectCompareTexts(root, entries) {
    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (getElementIdAttr(el).startsWith('translator-')) continue;
      if (el.closest && el.closest('[id^="translator-"]')) continue;
      if (el.hasAttribute('data-translator-compare')) continue;

      if (COMPARE_BLOCK_TAGS.has(el.tagName)) {
        // 跳过不可见元素（display:none、hidden 属性等）
        // 避免收集 GitHub 等页面的隐藏 UI 元素（如错误提示弹窗）
        if (!isElementVisible(el)) continue;

        // DIV 容器通常包含大量 UI 子元素（如 GitHub 的 Fork 按钮、通知等）
        // children > 3 的 DIV 几乎都是 UI 容器而非自然语言段落，跳过
        if (el.tagName === 'DIV' && el.children.length > 3) continue;

        var text = el.textContent.trim();
        if (!text) continue;
        if (!/[a-zA-Z]/.test(text)) continue;
        // 过滤长度放宽到 50000（LICENSE 等长文本常见，GPL-3.0 约 35000 字符）
        if (text.length > 50000) continue;
        // 预过滤 1：JSON / 代码内容不发给模型
        if (isCodeOrJson(text)) continue;
        // 预过滤 2：已中文、太短、UI 按钮、数字计数等不翻译
        if (shouldSkipTranslation(text)) continue;

        // 预过滤 3：表格单元格中进一步收紧，避免撑破表格布局
        var inTable = false;
        var p = el.parentElement;
        while (p) {
          if (p.tagName === 'TD' || p.tagName === 'TH' || p.tagName === 'TR') {
            inTable = true;
            break;
          }
          p = p.parentElement;
        }
        if (inTable) {
          // 表格中：短文本（< 20字符）不翻译；典型文件名/路径不翻译
          if (text.length < 20) continue;
          if (/^[a-zA-Z0-9_.\-\/\\]+\.(md|markdown|txt|yml|yaml|json|js|ts|jsx|tsx|py|c|h|cpp|hpp|java|go|rs|rb|sh|bash|zsh|fish|inc|linux|darwin|freebsd|openbsd|openwrt|mingw|x86_64|i686|csv|log|ini|cfg|conf|xml|html|css|vue|htm)$/i.test(text)) continue;
          if (/^(Makefile|README|LICENSE|TODO|CHANGELOG|CONTRIBUTING|INSTALL|AUTHORS|CODEOWNERS|SECURITY|version|package|lib[s]?|script[s]?|doc[s]?|src|bin|test[s]?|example[s]?)\b/i.test(text)) continue;
        }

        var hasNestedBlock = false;
        for (var j = 0; j < el.children.length; j++) {
          if (COMPARE_BLOCK_TAGS.has(el.children[j].tagName)) {
            hasNestedBlock = true;
            break;
          }
        }
        if (hasNestedBlock) continue;

        entries.push({
          element: el,
          originalText: text
        });
      }

      if (el.shadowRoot) {
        collectCompareTexts(el.shadowRoot, entries);
      }
    }
  }

  /**
   * Create the floating panel with translate button, word button and config icon.
   * Only the translate button is visible by default; word and config buttons
   * appear on hover.
   */
  function createFloatPanel() {
    var panel = document.createElement('div');
    panel.id = 'translator-float-panel';
    panel.className = 'translator-float-panel';

    var translateBtn = document.createElement('div');
    translateBtn.id = 'translator-btn-translate';
    translateBtn.className = 'translator-3d-btn';
    translateBtn.textContent = '翻译';
    translateBtn.addEventListener('click', handleTranslateClick);

    var wordBtn = document.createElement('div');
    wordBtn.id = 'translator-btn-word';
    wordBtn.className = 'translator-word-btn';
    wordBtn.textContent = '单词';
    wordBtn.title = '单词/句子翻译';
    wordBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleWordPanel();
    });

    var compareBtn = document.createElement('div');
    compareBtn.id = 'translator-btn-compare';
    compareBtn.className = 'translator-compare-btn';
    compareBtn.textContent = '对照';
    compareBtn.title = '对照翻译（原文+译文）';
    compareBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      handleCompareClick();
    });

    var picBtn = document.createElement('div');
    picBtn.id = 'translator-btn-pic';
    picBtn.className = 'translator-pic-btn';
    picBtn.textContent = 'PIC';
    picBtn.title = '图片/PDF翻译（需要多模态模型）';
    picBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      handlePicClick();
    });

    var configBtn = document.createElement('div');
    configBtn.id = 'translator-btn-config';
    configBtn.className = 'translator-config-icon';
    configBtn.title = '配置';
    configBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">' +
      '<path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 ' +
      'l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 ' +
      'h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 ' +
      'C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 ' +
      'c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 ' +
      'c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 ' +
      'c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 ' +
      's1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>' +
      '</svg>';
    configBtn.addEventListener('click', toggleConfigPanel);

    panel.appendChild(translateBtn);
    panel.appendChild(wordBtn);
    panel.appendChild(compareBtn);
    panel.appendChild(picBtn);
    panel.appendChild(configBtn);

    var updateBadge = document.createElement('span');
    updateBadge.id = 'translator-update-badge';
    updateBadge.className = 'translator-update-badge';
    updateBadge.style.display = 'none';
    updateBadge.title = '发现新版本，点击查看';
    updateBadge.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleConfigPanel();
      setTimeout(function () {
        var updateSection = document.getElementById('translator-update-section');
        if (updateSection) updateSection.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    });
    panel.appendChild(updateBadge);

    document.body.appendChild(panel);

    initDrag(panel);
  }

  /**
   * Initialize drag functionality for the floating panel.
   * Supports mouse and touch drag. Distinguishes click vs drag by movement threshold.
   * @param {HTMLElement} panel - The floating panel element.
   */
  function initDrag(panel) {
    var isDragging = false;
    var hasMoved = false;
    var startX = 0;
    var startY = 0;
    var panelStartX = 0;
    var panelStartY = 0;
    var DRAG_THRESHOLD = 5;
    var positionInitialized = false;

    function ensurePosition() {
      if (positionInitialized) return;
      positionInitialized = true;
      var rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.top = rect.top + 'px';
      panel.style.left = rect.left + 'px';
      panel.style.transform = 'none';
    }

    function onPointerDown(e) {
      if (e.button && e.button !== 0) return;
      isDragging = true;
      hasMoved = false;
      var rect = panel.getBoundingClientRect();
      startX = e.clientX || (e.touches && e.touches[0].clientX);
      startY = e.clientY || (e.touches && e.touches[0].clientY);
      panelStartX = rect.left;
      panelStartY = rect.top;
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      var clientX = e.clientX || (e.touches && e.touches[0].clientX);
      var clientY = e.clientY || (e.touches && e.touches[0].clientY);
      var dx = clientX - startX;
      var dy = clientY - startY;

      if (!hasMoved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        hasMoved = true;
        ensurePosition();
      }

      if (hasMoved) {
        var newX = panelStartX + dx;
        var newY = panelStartY + dy;
        newX = Math.max(0, Math.min(newX, window.innerWidth - panel.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - panel.offsetHeight));
        panel.style.left = newX + 'px';
        panel.style.top = newY + 'px';
        e.preventDefault();
      }
    }

    function onPointerUp() {
      isDragging = false;
    }

    panel.addEventListener('mousedown', onPointerDown);
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);
    panel.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend', onPointerUp);

    panel.addEventListener('click', function (e) {
      if (hasMoved) {
        e.stopPropagation();
        e.preventDefault();
        hasMoved = false;
      }
    }, true);
  }

  /**
   * Create the configuration side panel.
   */
  function createConfigPanel() {
    const panel = document.createElement('div');
    panel.id = 'translator-config-panel';
    panel.className = 'translator-config-panel translator-config-hidden';

    var currentVersion = chrome.runtime.getManifest().version;

    panel.innerHTML =
      '<div class="translator-config-header">' +
      '<h3>translator-plugs - 配置</h3>' +
      '<span id="translator-config-close" class="translator-close-btn">&times;</span>' +
      '</div>' +
      '<div class="translator-config-body">' +
      '<div class="translator-section">' +
      '<h4>翻译语言</h4>' +
      '<select id="translator-lang-select">' +
      '<option value="en-zh">英文 → 中文</option>' +
      '<option value="zh-en">中文 → 英文</option>' +
      '</select>' +
      '</div>' +
      '<div class="translator-section">' +
      '<h4>翻译设置</h4>' +
      '<label class="translator-setting-label">单批次超时时间（秒，最长600）</label>' +
      '<input type="number" id="translator-timeout-input" class="translator-setting-input" min="30" max="600" step="10" value="120">' +
      '<div class="translator-switch-row">' +
      '<span class="translator-switch-label">划词翻译</span>' +
      '<label class="translator-switch">' +
      '<input type="checkbox" id="translator-selection-toggle">' +
      '<span class="translator-switch-slider"></span>' +
      '</label>' +
      '</div>' +
      '</div>' +
      '<div class="translator-section">' +
      '<h4>大模型配置</h4>' +
      '<div id="translator-model-list" class="translator-model-list"></div>' +
      '<div class="translator-model-actions">' +
      '<button id="translator-add-model" class="translator-btn">+ 添加模型</button>' +
      '<button id="translator-test-all" class="translator-btn">测试全部</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="translator-config-info">' +
      '<span>作者: chenzq1604</span>' +
      '<span>版本: v' + currentVersion + '</span>' +
      '<span>GitHub: <a href="https://github.com/chenzq1604/translator-plugs" target="_blank" rel="noopener noreferrer">translator-plugs</a></span>' +
      '</div>' +
      '<div class="translator-config-footer">' +
      '<button id="translator-confirm" class="translator-btn-primary">确认</button>' +
      '</div>';

    document.body.appendChild(panel);

    document.getElementById('translator-config-close').addEventListener('click', function () {
      toggleConfigPanel();
    });
    document.getElementById('translator-add-model').addEventListener('click', showAddModelModal);
    document.getElementById('translator-test-all').addEventListener('click', testAllModels);
    document.getElementById('translator-confirm').addEventListener('click', saveAndCloseConfig);
  }

  /**
   * Create the add/edit model modal dialog.
   */
  function createAddModelModal() {
    const overlay = document.createElement('div');
    overlay.id = 'translator-modal-overlay';
    overlay.className = 'translator-modal-overlay translator-modal-hidden';

    overlay.innerHTML =
      '<div class="translator-modal">' +
      '<h4 id="translator-modal-title">添加大模型</h4>' +
      '<div class="translator-modal-content">' +
      '<label for="translator-model-preset-select">快速选择</label>' +
      '<select id="translator-model-preset-select">' +
      '<option value="">-- 选择预设模型 --</option>' +
      '<option value="deepseek-v4-flash">DeepSeek - V4 Flash</option>' +
      '<option value="deepseek-v4-pro">DeepSeek - V4 Pro</option>' +
      '<option value="zhipu-glm5">智谱 - GLM-5.1</option>' +
      '<option value="volcengine-ark-code">火山 - ark-code-latest</option>' +
      '<option value="minimax-m2.7">MiniMax - M2.7</option>' +
      '</select>' +
      '<label for="translator-model-name-input">模型名称</label>' +
      '<input type="text" id="translator-model-name-input" placeholder="例如: GPT-4o">' +
      '<label for="translator-model-url-input">API 地址</label>' +
      '<input type="text" id="translator-model-url-input" placeholder="例如: https://api.openai.com/v1">' +
      '<label for="translator-model-key-input">API 密钥</label>' +
      '<input type="password" id="translator-model-key-input" placeholder="sk-...">' +
      '<label for="translator-model-id-input">模型标识</label>' +
      '<input type="text" id="translator-model-id-input" placeholder="例如: gpt-4o">' +
      '<div class="translator-switch-row">' +
      '<span class="translator-switch-label">Thinking 模式</span>' +
      '<label class="translator-switch">' +
      '<input type="checkbox" id="translator-model-thinking-input">' +
      '<span class="translator-switch-slider"></span>' +
      '</label>' +
      '</div>' +
      '<div class="translator-switch-row">' +
      '<span class="translator-switch-label">视觉（支持图片翻译）</span>' +
      '<label class="translator-switch">' +
      '<input type="checkbox" id="translator-model-vision-input">' +
      '<span class="translator-switch-slider"></span>' +
      '</label>' +
      '</div>' +
      '</div>' +
      '<div class="translator-modal-buttons">' +
      '<button id="translator-modal-cancel" class="translator-modal-cancel">取消</button>' +
      '<button id="translator-modal-save" class="translator-modal-save">保存</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('translator-model-preset-select').addEventListener('change', function () {
      var presetKey = this.value;
      if (!presetKey || !MODEL_PRESETS[presetKey]) return;
      var preset = MODEL_PRESETS[presetKey];
      document.getElementById('translator-model-name-input').value = preset.name;
      document.getElementById('translator-model-url-input').value = preset.apiUrl;
      document.getElementById('translator-model-id-input').value = preset.model;
      document.getElementById('translator-model-key-input').focus();
    });
    document.getElementById('translator-modal-cancel').addEventListener('click', hideAddModelModal);
    document.getElementById('translator-modal-save').addEventListener('click', saveModelFromModal);
  }

  /**
   * Create the toast notification element.
   */
  function createToast() {
    const toast = document.createElement('div');
    toast.id = 'translator-toast';
    toast.className = 'translator-toast';
    document.body.appendChild(toast);
  }

  /**
   * Create the progress bar element.
   */
  function createProgressBar() {
    const bar = document.createElement('div');
    bar.id = 'translator-progress-bar';
    bar.className = 'translator-progress-bar';
    bar.style.width = '0%';
    bar.style.display = 'none';
    document.body.appendChild(bar);

    // 创建 PIC 翻译专用进度面板（醒目显示）
    const picPanel = document.createElement('div');
    picPanel.id = 'translator-pic-progress';
    picPanel.className = 'translator-pic-progress';
    picPanel.style.display = 'none';
    picPanel.innerHTML =
      '<div class="translator-pic-progress-inner">' +
      '<div class="translator-pic-progress-title">PDF翻译进度</div>' +
      '<div class="translator-pic-progress-percent">0%</div>' +
      '<div class="translator-pic-progress-bar-bg">' +
      '<div class="translator-pic-progress-bar-fill"></div>' +
      '</div>' +
      '<div class="translator-pic-progress-info">准备中...</div>' +
      '</div>';
    document.body.appendChild(picPanel);
  }

  /**
   * Show a toast notification.
   * @param {string} message - The message to display.
   * @param {string} type - 'error', 'success', or 'info'.
   */
  function showToast(message, type) {
    type = type || 'info';
    const toast = document.getElementById('translator-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'translator-toast translator-toast-' + type + ' translator-toast-show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove('translator-toast-show');
    }, 3000);
  }

  /**
   * Show the progress bar with a given percentage.
   * @param {number} percent - Progress percentage (0-100).
   */
  function showProgress(percent) {
    const bar = document.getElementById('translator-progress-bar');
    if (!bar) return;
    bar.style.display = 'block';
    bar.style.width = percent + '%';
  }

  /**
   * Hide the progress bar.
   */
  function hideProgress() {
    const bar = document.getElementById('translator-progress-bar');
    if (!bar) return;
    bar.style.width = '100%';
    setTimeout(function () {
      bar.style.display = 'none';
      bar.style.width = '0%';
    }, 500);
  }

  /**
   * 显示 PIC 翻译进度面板。
   * @param {number} current - 当前页码（从1开始）。
   * @param {number} total - 总页数。
   * @param {string} status - 状态文字（如"正在翻译..."）。
   */
  function showPicProgress(current, total, status) {
    var panel = document.getElementById('translator-pic-progress');
    if (!panel) return;
    var percent = total > 0 ? Math.round((current / total) * 100) : 0;
    var percentEl = panel.querySelector('.translator-pic-progress-percent');
    var fillEl = panel.querySelector('.translator-pic-progress-bar-fill');
    var infoEl = panel.querySelector('.translator-pic-progress-info');
    if (percentEl) percentEl.textContent = percent + '%';
    if (fillEl) fillEl.style.width = percent + '%';
    if (infoEl) infoEl.textContent = '第 ' + current + ' / ' + total + ' 页' + (status ? ' - ' + status : '');
    panel.style.display = 'flex';
  }

  /**
   * 隐藏 PIC 翻译进度面板。
   */
  function hidePicProgress() {
    var panel = document.getElementById('translator-pic-progress');
    if (!panel) return;
    setTimeout(function () {
      panel.style.display = 'none';
    }, 800);
  }

  /**
   * Load configuration from chrome.storage.
   */
  function loadConfig() {
    chrome.runtime.sendMessage({ type: 'getConfig' }, function (response) {
      if (response) {
        currentModels = response.models || [];
        batchTimeout = response.timeout || 120;
        selectionTranslateEnabled = response.selectionTranslate !== false;
        translateDirection = response.language || 'en-zh';
        // 记录读取时的配置版本号，用于保存时的多窗口冲突检测
        loadedConfigVersion = response.configVersion || 0;
        // 记录加载时的模型配置快照，用于保存时判断是否有实际变更（dirty check）
        loadedModelsSnapshot = stringifyModelsForCompare(currentModels);
        var timeoutInput = document.getElementById('translator-timeout-input');
        if (timeoutInput) timeoutInput.value = batchTimeout;
        var selToggle = document.getElementById('translator-selection-toggle');
        if (selToggle) selToggle.checked = selectionTranslateEnabled;
        var langSelect = document.getElementById('translator-lang-select');
        if (langSelect) langSelect.value = translateDirection;
        renderModelList();
      }
    });
  }

  /**
   * 将模型列表规范化为可比较的 JSON 字符串。
   * 仅保留配置相关字段，排除 latency/testTime/returnContent 等测试产生的临时字段，
   * 避免仅执行了"测试"而未修改配置时被误判为有变更。
   * @param {Array} models - 模型列表
   * @returns {string} 规范化 JSON 字符串
   */
  function stringifyModelsForCompare(models) {
    return JSON.stringify((models || []).map(function (m) {
      return {
        id: m.id,
        name: m.name,
        apiUrl: m.apiUrl,
        apiKey: m.apiKey,
        model: m.model,
        thinking: !!m.thinking,
        vision: !!m.vision,
        isDefaultText: !!m.isDefaultText,
        isDefaultPic: !!m.isDefaultPic
      };
    }));
  }

  /**
   * 尝试获取配置面板全局锁：本机 Chrome 同一时间只允许一个页面打开配置面板。
   * @param {Function} callback - 回调，参数为是否获取成功
   */
  function acquireConfigPanelLock(callback) {
    if (!configLockId) {
      configLockId = 'lock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    }
    chrome.runtime.sendMessage({ type: 'acquireConfigLock', data: { lockId: configLockId } }, function (response) {
      var ok = !!(response && response.success);
      if (ok) startConfigLockHeartbeat();
      callback(ok);
    });
  }

  /**
   * 释放配置面板全局锁（仅当自己仍是持有者时生效）并停止心跳。
   */
  function releaseConfigPanelLock() {
    stopConfigLockHeartbeat();
    if (!configLockId) return;
    chrome.runtime.sendMessage({ type: 'releaseConfigLock', data: { lockId: configLockId } }, function () {});
  }

  /**
   * 启动配置面板锁心跳，定期刷新锁时间戳，防止持有期间被其他窗口判定过期抢占。
   */
  function startConfigLockHeartbeat() {
    stopConfigLockHeartbeat();
    configLockHeartbeat = setInterval(function () {
      if (!configLockId) return;
      chrome.runtime.sendMessage({ type: 'refreshConfigLock', data: { lockId: configLockId } }, function () {});
    }, 5000);
  }

  /**
   * 停止配置面板锁心跳定时器。
   */
  function stopConfigLockHeartbeat() {
    if (configLockHeartbeat) {
      clearInterval(configLockHeartbeat);
      configLockHeartbeat = null;
    }
  }

  /**
   * Toggle the configuration panel visibility.
   * 打开前先获取全局锁：若其他窗口已打开配置面板，则提示并拒绝打开；
   * 关闭时释放锁，允许其他窗口随后打开。
   */
  function toggleConfigPanel() {
    const panel = document.getElementById('translator-config-panel');
    if (configVisible) {
      configVisible = false;
      releaseConfigPanelLock();
      panel.classList.add('translator-config-hidden');
    } else {
      acquireConfigPanelLock(function (ok) {
        if (!ok) {
          showToast('已经有大模型正在打开配置窗口请先关闭', 'error');
          return;
        }
        configVisible = true;
        loadConfig();
        panel.classList.remove('translator-config-hidden');
      });
    }
  }

  /**
   * Create the word/sentence translation panel that slides in from the right.
   * Supports Chinese-to-English and English-to-Chinese translation modes.
   */
  function createWordPanel() {
    var overlay = document.createElement('div');
    overlay.id = 'translator-word-overlay';
    overlay.className = 'translator-word-overlay';

    var panel = document.createElement('div');
    panel.id = 'translator-word-panel';
    panel.className = 'translator-word-panel translator-word-hidden';

    panel.innerHTML =
      '<div class="translator-word-header">' +
      '<h3>单词/句子翻译</h3>' +
      '<span id="translator-word-close" class="translator-close-btn">&times;</span>' +
      '</div>' +
      '<div class="translator-word-body">' +
      '<div class="translator-word-mode">' +
      '<button id="translator-word-mode-en2zh" class="translator-word-mode-btn active">英译中</button>' +
      '<button id="translator-word-mode-zh2en" class="translator-word-mode-btn">中译英</button>' +
      '<button id="translator-word-mode-zh2zh" class="translator-word-mode-btn">中译中</button>' +
      '</div>' +
      '<textarea id="translator-word-input" class="translator-word-input" placeholder="输入要翻译的文字..." rows="4"></textarea>' +
      '<button id="translator-word-translate" class="translator-btn-primary">翻译</button>' +
      '<div id="translator-word-result" class="translator-word-result" style="display:none;"></div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    var modeEn2zh = document.getElementById('translator-word-mode-en2zh');
    var modeZh2en = document.getElementById('translator-word-mode-zh2en');
    var modeZh2zh = document.getElementById('translator-word-mode-zh2zh');
    var translateBtn = document.getElementById('translator-word-translate');
    var closeBtn = document.getElementById('translator-word-close');
    var input = document.getElementById('translator-word-input');
    var resultDiv = document.getElementById('translator-word-result');

    var currentMode = 'en2zh';

    modeEn2zh.addEventListener('click', function () {
      currentMode = 'en2zh';
      modeEn2zh.classList.add('active');
      modeZh2en.classList.remove('active');
      modeZh2zh.classList.remove('active');
      input.placeholder = '输入英文单词或句子...';
    });

    modeZh2en.addEventListener('click', function () {
      currentMode = 'zh2en';
      modeZh2en.classList.add('active');
      modeEn2zh.classList.remove('active');
      modeZh2zh.classList.remove('active');
      input.placeholder = '输入中文词语或句子...';
    });

    modeZh2zh.addEventListener('click', function () {
      currentMode = 'zh2zh';
      modeZh2zh.classList.add('active');
      modeEn2zh.classList.remove('active');
      modeZh2en.classList.remove('active');
      input.placeholder = '输入中文汉字、词语或成语...';
    });

    closeBtn.addEventListener('click', toggleWordPanel);
    overlay.addEventListener('click', toggleWordPanel);

    translateBtn.addEventListener('click', function () {
      var text = input.value.trim();
      if (!text) {
        showToast('请输入要翻译的文字', 'info');
        return;
      }
      doWordTranslate(text, currentMode, resultDiv, translateBtn);
    });

    input.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'Enter') {
        translateBtn.click();
      }
    });
  }

  /**
   * Toggle the word translation panel visibility.
   */
  function toggleWordPanel() {
    var panel = document.getElementById('translator-word-panel');
    var overlay = document.getElementById('translator-word-overlay');
    if (!panel) return;
    if (panel.classList.contains('translator-word-hidden')) {
      panel.classList.remove('translator-word-hidden');
      overlay.classList.add('active');
      var input = document.getElementById('translator-word-input');
      if (input) setTimeout(function () { input.focus(); }, 300);
    } else {
      panel.classList.add('translator-word-hidden');
      overlay.classList.remove('active');
    }
  }

  /**
   * Detect the type of input text: English word, single Chinese character,
   * Chinese sentence, or English sentence.
   * @param {string} text - The input text.
   * @returns {string} - 'word' | 'hanzi' | 'zh-sentence' | 'sentence'
   */
  function detectInputType(text) {
    text = text.trim();
    if (/^[\u4e00-\u9fa5]$/.test(text)) return 'hanzi';
    if (/^[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef，。！？、；：""''（）【】《》\s]+$/.test(text) && /[\u4e00-\u9fa5]/.test(text)) return 'zh-sentence';
    if (/^[a-zA-Z][a-zA-Z\-']*$/.test(text)) return 'word';
    return 'sentence';
  }

  /**
   * Build prompt suffix: 强调占位符必须替换为真实内容，禁止复读格式模板，
   * 并为生僻字/词留出"如实说明"的退路，避免模型因无法填充而原样输出模板。
   * @returns {string} - 附加指令文本。
   */
  function buildNoEchoSuffix() {
    return '\n\n【重要】以上方括号 [ ] 内的说明仅是格式示例，输出时必须将每一项替换为该字/词的真实内容，' +
      '禁止保留任何方括号占位说明，更禁止原样输出本格式模板。' +
      '如果该字/词过于生僻、确无古代典籍出处，请如实注明"该字较为生僻，暂无典籍出处"，' +
      '并尽力解释你能确定的部分，不要编造，也不要输出空模板。';
  }

  /**
   * Build a detailed prompt for English word lookup.
   * @param {string} word - The English word.
   * @returns {string} - The formatted prompt.
   */
  function buildWordPrompt(word) {
    return '请详细解释英文单词 "' + word + '"，按以下格式输出（保持格式，每项一行）：\n' +
      '🔤 音标: [音标，如 /ˈæpl/]\n' +
      '📝 词性: [词性缩写，如 n. v. adj.]\n' +
      '📖 释义: [中文释义，多条用分号分隔]\n' +
      '🌱 词根: [词根词缀分析]\n' +
      '📜 词源: [词源演变说明]\n' +
      '💬 例句:\n' +
      '1. [英文例句] — [中文翻译]\n' +
      '2. [英文例句] — [中文翻译]\n' +
      '3. [英文例句] — [中文翻译]' + buildNoEchoSuffix();
  }

  /**
   * Build a detailed prompt for single Chinese character lookup.
   * @param {string} hanzi - The Chinese character.
   * @returns {string} - The formatted prompt.
   */
  function buildHanziPrompt(hanzi) {
    return '请详细解释汉字"' + hanzi + '"，按以下格式输出（保持格式，每项一行）：\n' +
      '🔊 拼音: [拼音，含声调]\n' +
      '📌 部首: [部首]\n' +
      '✏️ 笔画: [笔画数]\n' +
      '📖 释义: [字的含义解释]\n' +
      '📜 字源: [字形演变和造字本义]\n' +
      '💬 常用词组:\n' +
      '1. [词组] — [解释]\n' +
      '2. [词组] — [解释]\n' +
      '3. [词组] — [解释]' + buildNoEchoSuffix();
  }

  /**
   * Build a prompt for single Chinese character lookup in zh2zh mode.
   * Focuses on Chinese explanation with pinyin, etymology and daily usage.
   * @param {string} hanzi - The Chinese character.
   * @returns {string} - The formatted prompt.
   */
  function buildHanziZh2zhPrompt(hanzi) {
    return '请用中文详细解释汉字"' + hanzi + '"。你必须按照以下格式逐项输出，每一项都必须填写完整内容，不要省略任何一项：\n' +
      '🔊 拼音: [汉语拼音，含声调]\n' +
      '📌 部首: [部首]\n' +
      '✏️ 笔画: [总笔画数]\n' +
      '📖 释义: [用中文详细解释这个字的含义，至少写2-3句]\n' +
      '📜 字源: [字形演变历史和造字本义，详细说明]\n' +
      '📚 来源出处: [古代典籍中的出处和引用，如诗经、论语等]\n' +
      '💬 日常用语:\n' +
      '1. [含该字的常用词语] — [词语解释]\n' +
      '2. [含该字的常用词语] — [词语解释]\n' +
      '3. [含该字的常用词语] — [词语解释]' + buildNoEchoSuffix();
  }

  /**
   * Build an English dictionary-style prompt for a single Chinese character (zh2en mode).
   * 单个汉字在英文中没有对应单词，用"只输出翻译结果"的通用指令时模型只能给出拼音，
   * 因此按英文字典条目形式要求：拼音、部首笔画、英文释义、字源、常用词。
   * @param {string} hanzi - The Chinese character.
   * @returns {string} - The formatted prompt.
   */
  function buildHanziEnPrompt(hanzi) {
    return 'Explain the Chinese character "' + hanzi + '" in English. It has no single-word English equivalent, ' +
      'so give a dictionary-style entry. Output each item on its own line in the format below:\n' +
      '🔊 Pinyin: [pinyin with tone marks]\n' +
      '📌 Radical: [radical]\n' +
      '✏️ Strokes: [total stroke count]\n' +
      '📖 Meaning: [detailed English meaning of the character, 1-3 sentences]\n' +
      '📜 Etymology: [origin and evolution of the character]\n' +
      '💬 Common words:\n' +
      '1. [word containing this character] — [English explanation]\n' +
      '2. [word containing this character] — [English explanation]\n' +
      '3. [word containing this character] — [English explanation]' +
      '\n\nIMPORTANT: The text in [ ] is only a format example. Replace every bracketed part with the real content of ' +
      'this character. Never keep the bracketed placeholders, and never output this template as-is. ' +
      'If the character is too rare to have attested classical sources, say so honestly and explain what you can ' +
      'determine — do not fabricate, and do not output an empty template.';
  }

  /**
   * Build a prompt for Chinese word/idiom lookup in zh2zh mode.
   * Explains Chinese words or idioms in Chinese with pinyin, source and usage.
   * @param {string} text - The Chinese word or idiom.
   * @returns {string} - The formatted prompt.
   */
  function buildZh2zhPrompt(text) {
    return '请用中文详细解释词语"' + text + '"。你必须按照以下格式逐项输出，每一项都必须填写完整内容，不要省略任何一项：\n' +
      '🔊 拼音: [汉语拼音，含声调]\n' +
      '📖 释义: [用中文详细解释这个词语的含义，至少写2-3句]\n' +
      '📜 来源出处: [典故来源、最早出处及历史背景，详细说明]\n' +
      '📚 引用: [古代典籍或名人名言中的引用，至少给出1-2个]\n' +
      '💬 日常用语:\n' +
      '1. [使用该词的日常例句]\n' +
      '2. [使用该词的日常例句]\n' +
      '3. [使用该词的日常例句]' + buildNoEchoSuffix();
  }

  /**
   * 检测模型响应是否为"空模板复读"（模型未填充占位符而是原样输出了格式说明）。
   * 判定标准：响应中同时出现多个 prompt 模板里的方括号占位说明片段。
   * @param {string} result - 模型返回的文本。
   * @returns {boolean} - 是否为空模板复读。
   */
  function isTemplateEcho(result) {
    if (!result) return false;
    var markers = [
      '[拼音，含声调]', '[汉语拼音，含声调]', '[部首]', '[笔画数]', '[总笔画数]',
      '[字的含义解释]', '[字形演变和造字本义]', '[古代典籍中的出处和引用',
      '[词组] — [解释]', '[含该字的常用词语] — [词语解释]',
      '[用中文详细解释这个字的含义', '[用中文详细解释这个词语的含义',
      '[典故来源', '[使用该词的日常例句]', '[音标，如', '[词性缩写',
      '[中文释义', '[词根词缀分析]', '[词源演变说明]', '[英文例句] — [中文翻译]'
    ];
    var hits = 0;
    for (var i = 0; i < markers.length; i++) {
      if (result.indexOf(markers[i]) !== -1) hits++;
    }
    return hits >= 2;
  }

  /**
   * 向后台请求一次单词/句子查词。
   * 使用 lookupText 专用通道（不注入批量翻译 system prompt、不把 prompt 包成 JSON 数组），
   * 因为查词 prompt 本身就是一条完整指令，走批量翻译通道会被 system prompt 覆盖，
   * 导致模型去翻译"指令本身"而不是执行指令。
   * @param {Object} model - 模型配置。
   * @param {string} prompt - 完整 prompt。
   * @param {Function} callback - 回调(success, result, error)。
   */
  function requestWordTranslate(model, prompt, callback) {
    chrome.runtime.sendMessage({
      type: 'lookupText',
      data: {
        apiUrl: model.apiUrl,
        apiKey: model.apiKey,
        model: model.model,
        prompt: prompt,
        thinking: model.thinking
      }
    }, function (response) {
      if (response && response.success && response.result) {
        callback(true, response.result, null);
      } else {
        callback(false, null, response ? response.error : '未知错误');
      }
    });
  }

  /**
   * Perform word/sentence translation using the default model.
   * Automatically detects input type and uses appropriate prompt:
   * - English word: phonetics, definitions, etymology, examples
   * - Single Chinese character: pinyin, radical, etymology, common words
   * - Sentences: direct translation only
   * @param {string} text - The text to translate.
   * @param {string} mode - Translation mode: 'en2zh' or 'zh2en'.
   * @param {HTMLElement} resultDiv - The result display element.
   * @param {HTMLElement} btn - The translate button (for loading state).
   */
  async function doWordTranslate(text, mode, resultDiv, btn) {
    var model = defaultTextModelCache;
    if (!model) {
      model = await getDefaultModel('text');
      if (!model) {
        showToast('请先配置好大模型', 'error');
        return;
      }
      defaultTextModelCache = model;
    }

    var originalBtnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '翻译中...';
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<span class="translator-word-loading">翻译中...</span>';

    var inputType = detectInputType(text);
    var prompt;
    var useFormatted = false;

    // 路由顺序：先按翻译模式判定，再按输入类型判定。
    // 否则"中译英"模式下的汉字输入会被 hanzi 分支截获，输出汉字详解而非英文翻译。
    if (mode === 'zh2en') {
      // 中译英：单个汉字在英文中没有对应单词，直接翻译只会得到拼音，
      // 故按英文字典条目给出英文释义；词语与句子仍走地道翻译。
      if (inputType === 'hanzi') {
        prompt = buildHanziEnPrompt(text);
        useFormatted = true;
      } else {
        prompt = '将以下中文翻译成英文。只输出翻译结果，不要解释：\n\n' + text;
      }
    } else if (inputType === 'word') {
      prompt = buildWordPrompt(text);
      useFormatted = true;
    } else if (inputType === 'hanzi') {
      if (mode === 'zh2zh') {
        prompt = buildHanziZh2zhPrompt(text);
      } else {
        prompt = buildHanziPrompt(text);
      }
      useFormatted = true;
    } else if (mode === 'zh2zh') {
      prompt = buildZh2zhPrompt(text);
      useFormatted = true;
    } else {
      prompt = '将以下英文翻译成中文。只输出翻译结果，不要解释：\n\n' + text;
    }

    /**
     * 结束翻译并恢复按钮状态。
     * @param {boolean} success - 是否成功。
     * @param {string|null} result - 翻译结果文本。
     * @param {string|null} error - 错误信息。
     */
    function finish(success, result, error) {
      btn.disabled = false;
      btn.textContent = originalBtnText;
      if (success) {
        // 兜底：模型可能把多行内容作为转义字面量 \n 返回（如 JSON 字符串），
        // 后台未能还原时，将字面 \n 还原为真实换行，保证查词结果按行显示
        if (useFormatted && result.indexOf('\n') === -1 && result.indexOf('\\n') !== -1) {
          result = result.replace(/\\n/g, '\n');
        }
        resultDiv.innerHTML = useFormatted ? formatWordResult(result) : result;
      } else {
        resultDiv.innerHTML = '<span class="translator-word-error">翻译失败: ' + escapeHtml(error) + '</span>';
      }
    }

    requestWordTranslate(model, prompt, function (success, result, error) {
      if (success && isTemplateEcho(result)) {
        // 模型复读空模板 → 追加纠错指令自动重试一次
        var retryPrompt = prompt +
          '\n\n【纠错】你上一次的输出只是格式模板本身，没有填写任何实际内容，这是错误的。' +
          '请重新回答：必须把每一项的方括号占位内容替换为该字/词的真实信息后输出。' +
          '如果你确实不了解该字/词，请直接输出"该字/词较为生僻，暂无详细资料"，并解释你能确定的任何部分。';
        requestWordTranslate(model, retryPrompt, function (success2, result2, error2) {
          if (success2 && !isTemplateEcho(result2)) {
            finish(true, result2, null);
          } else {
            finish(false, null, '模型未能生成有效解释（返回了空模板）。该字/词可能过于生僻，建议更换模型后重试');
          }
        });
        return;
      }
      finish(success, result, error);
    });
  }

  /**
   * Format the word/character lookup result into styled HTML.
   * Parses lines with emoji markers and wraps them in styled elements.
   * @param {string} text - The raw result text from the model.
   * @returns {string} - Formatted HTML string.
   */
  function formatWordResult(text) {
    var lines = text.split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;

      var isHeader = /^[🔤📝📖🌱📜💬🔊📌✏️]/.test(line);
      var isExample = /^\d+\./.test(line);

      if (isHeader) {
        var parts = line.split(/[:：]/);
        if (parts.length >= 2) {
          var label = parts[0].trim();
          var value = parts.slice(1).join(':').trim();
          html += '<div class="translator-word-result-line translator-word-result-header">' +
            '<span class="translator-word-result-label">' + escapeHtml(label) + '</span>' +
            '<span class="translator-word-result-value">' + escapeHtml(value) + '</span></div>';
        } else {
          html += '<div class="translator-word-result-line translator-word-result-header">' +
            escapeHtml(line) + '</div>';
        }
      } else if (isExample) {
        html += '<div class="translator-word-result-line translator-word-result-example">' +
          escapeHtml(line) + '</div>';
      } else {
        html += '<div class="translator-word-result-line">' + escapeHtml(line) + '</div>';
      }
    }
    return html;
  }

  /**
   * Collect video track (VTT subtitle) texts for translation.
   * Finds all <track> elements, fetches their VTT content, and adds each cue as an entry.
   * @param {Node} root - The root node to start traversal.
   * @param {Array} entries - Array to store text entries.
   */
  function collectVideoTracks(root, entries) {
    var videos = root.querySelectorAll('video');
    for (var v = 0; v < videos.length; v++) {
      var tracks = videos[v].querySelectorAll('track');
      for (var t = 0; t < tracks.length; t++) {
        var track = tracks[t];
        var src = track.getAttribute('src');
        if (!src) continue;
        if (track.__translatorCollected) continue;
        track.__translatorCollected = true;

        var trackInfo = {
          track: track,
          video: videos[v],
          src: src,
          cues: []
        };

        var cues = track.track ? track.track.cues : null;
        if (cues && cues.length > 0) {
          for (var c = 0; c < cues.length; c++) {
            var cue = cues[c];
            var text = cue.text ? cue.text.trim() : '';
            if (!text || !/[a-zA-Z]/.test(text)) continue;
            var id = 'tr_' + entries.length + '_' + Math.random().toString(36).substr(2, 4);
            entries.push({
              id: id,
              type: 'cue',
              cue: cue,
              originalText: text
            });
            trackInfo.cues.push(id);
          }
        }

        if (trackInfo.cues.length > 0) {
          translatedTracks.push(trackInfo);
        }
      }
    }
  }

  /**
   * Render the model list in the config panel.
   */
  function renderModelList() {
    const container = document.getElementById('translator-model-list');
    if (!container) return;

    if (currentModels.length === 0) {
      container.innerHTML = '<div class="translator-empty-tip">暂无模型，请点击"添加模型"</div>';
      return;
    }

    let html = '';
    currentModels.forEach(function (model) {
      // 向后兼容：旧数据只有 isDefault，映射到 isDefaultText
      var isDefaultText = model.isDefaultText !== undefined ? model.isDefaultText : !!model.isDefault;
      var isDefaultPic = !!model.isDefaultPic;
      var isAnyDefault = isDefaultText || isDefaultPic;
      html +=
        '<div class="translator-model-item' + (isAnyDefault ? ' translator-model-default' : '') + '" data-id="' + model.id + '">' +
        '<div class="translator-model-name">' +
        escapeHtml(model.name) +
        (isDefaultText ? '<span class="translator-model-default-badge">默认文本</span>' : '') +
        (isDefaultPic ? '<span class="translator-model-pic-badge">默认PIC</span>' : '') +
        (model.vision ? '<span class="translator-model-vision-badge">多模态</span>' : '') +
        '</div>' +
        '<div class="translator-model-info">' +
        '<span>延时: ' + (model.latency != null ? model.latency + 'ms' : '未测试') + '</span>' +
        '<span>测试时间: ' + (model.testTime || '未测试') + '</span>' +
        '</div>';

      if (model.returnContent) {
        html += '<div class="translator-model-return-content">' + escapeHtml(model.returnContent.substring(0, 100)) + '</div>';
      }

      html +=
        '<div class="translator-model-actions-row">' +
        '<button class="translator-btn-default' + (isDefaultText ? ' translator-btn-default-active' : '') + '" data-action="defaultText" data-id="' + model.id + '">' +
        (isDefaultText ? '默认文本' : '默认文本') +
        '</button>' +
        '<button class="translator-btn-default' + (isDefaultPic ? ' translator-btn-default-active' : '') + '" data-action="defaultPic" data-id="' + model.id + '"' +
        (model.vision ? '' : ' disabled title="非多模态模型不能设为PIC默认"') + '>' +
        (isDefaultPic ? '默认PIC' : '默认PIC') +
        '</button>' +
        '<button class="translator-btn-test" data-action="test" data-id="' + model.id + '">测试</button>' +
        '<button class="translator-btn-edit" data-action="edit" data-id="' + model.id + '">编辑</button>' +
        '<button class="translator-btn-delete" data-action="delete" data-id="' + model.id + '">删除</button>' +
        '</div>' +
        '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('button[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var action = this.getAttribute('data-action');
        var id = this.getAttribute('data-id');
        handleModelAction(action, id);
      });
    });
  }

  /**
   * Handle model actions: set default text/pic, edit, delete, test.
   * @param {string} action - 'defaultText', 'defaultPic', 'edit', 'delete', or 'test'.
   * @param {string} id - Model ID.
   */
  function handleModelAction(action, id) {
    switch (action) {
      case 'defaultText':
        // toggle 逻辑：如果目标模型已是默认文本，则取消；否则设为默认并取消其他
        var targetTextModel = currentModels.find(function (m) { return m.id === id; });
        var isAlreadyTextDefault = targetTextModel && targetTextModel.isDefaultText;
        currentModels.forEach(function (m) {
          if (isAlreadyTextDefault) {
            // 取消模式：目标模型取消默认，其他保持不变
            if (m.id === id) m.isDefaultText = false;
          } else {
            // 设置模式：目标模型设为默认，其他取消
            m.isDefaultText = (m.id === id);
          }
          // 旧字段兼容清理
          delete m.isDefault;
        });
        // 清除文本默认模型缓存，下次使用时重新获取
        defaultTextModelCache = null;
        renderModelList();
        break;
      case 'defaultPic':
        // 只有 vision 模型才能设为 PIC 默认
        var picModel = currentModels.find(function (m) { return m.id === id; });
        if (!picModel || !picModel.vision) {
          showToast('非多模态模型不能设为PIC默认', 'error');
          break;
        }
        // toggle 逻辑：如果目标模型已是 PIC 默认，则取消；否则设为默认并取消其他
        var isAlreadyPicDefault = picModel.isDefaultPic;
        currentModels.forEach(function (m) {
          if (isAlreadyPicDefault) {
            if (m.id === id) m.isDefaultPic = false;
          } else {
            m.isDefaultPic = (m.id === id);
          }
        });
        // 清除 PIC 默认模型缓存
        defaultPicModelCache = null;
        renderModelList();
        break;
      case 'edit':
        var editModel = currentModels.find(function (m) { return m.id === id; });
        if (editModel) showAddModelModal(editModel);
        break;
      case 'delete':
        if (!window.confirm('确定要删除这个模型配置吗？')) break;
        currentModels = currentModels.filter(function (m) { return m.id !== id; });
        defaultTextModelCache = null;
        defaultPicModelCache = null;
        renderModelList();
        break;
      case 'test':
        testSingleModel(id);
        break;
    }
  }

  /**
   * Test a single model and update its latency, testTime, and returnContent.
   * @param {string} id - Model ID.
   */
  async function testSingleModel(id) {
    var m = currentModels.find(function (item) { return item.id === id; });
    if (!m) return;

    if (!m.apiUrl || !m.apiKey || !m.model) {
      m.latency = null;
      m.testTime = new Date().toLocaleString('zh-CN');
      m.returnContent = '配置不完整，无法测试';
      renderModelList();
      return;
    }

    var testBtn = document.querySelector('button[data-action="test"][data-id="' + id + '"]');
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.innerHTML = '<span class="translator-testing-indicator"></span>';
    }

    var maxRetries = 2;
    var result = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await new Promise(function (resolve) {
          var timeout = setTimeout(function () {
            resolve({ success: false, error: '请求超时，后台服务可能未启动' });
          }, 15000);

          chrome.runtime.sendMessage({
            type: 'testModel',
            data: {
              apiUrl: m.apiUrl,
              apiKey: m.apiKey,
              model: m.model,
              thinking: m.thinking
            }
          }, function (response) {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response || { success: false, error: '后台服务未响应' });
          });
        });

        if (result.success || !result.error || result.error.indexOf('Failed to fetch') === -1) {
          break;
        }

        if (attempt < maxRetries) {
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
      } catch (err) {
        result = { success: false, error: err.message };
        if (attempt < maxRetries) {
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
      }
    }

    if (result && result.success) {
      m.latency = result.latency;
      m.testTime = result.testTime;
      m.returnContent = result.returnContent;
    } else {
      m.latency = null;
      m.testTime = new Date().toLocaleString('zh-CN');
      m.returnContent = '测试失败: ' + (result ? result.error : '未知错误');
    }

    renderModelList();
    showToast('测试完成', 'success');
  }

  /**
   * Show the add/edit model modal.
   * @param {Object} [model] - Existing model for editing.
   */
  function showAddModelModal(model) {
    var overlay = document.getElementById('translator-modal-overlay');
    var title = document.getElementById('translator-modal-title');
    var nameInput = document.getElementById('translator-model-name-input');
    var urlInput = document.getElementById('translator-model-url-input');
    var keyInput = document.getElementById('translator-model-key-input');
    var idInput = document.getElementById('translator-model-id-input');

    var presetSelect = document.getElementById('translator-model-preset-select');
    var thinkingInput = document.getElementById('translator-model-thinking-input');
    var visionInput = document.getElementById('translator-model-vision-input');

    if (model) {
      editingModelId = model.id;
      title.textContent = '编辑大模型';
      nameInput.value = model.name || '';
      urlInput.value = model.apiUrl || '';
      keyInput.value = model.apiKey || '';
      idInput.value = model.model || '';
      presetSelect.value = '';
      if (thinkingInput) thinkingInput.checked = !!model.thinking;
      if (visionInput) visionInput.checked = !!model.vision;
    } else {
      editingModelId = null;
      title.textContent = '添加大模型';
      nameInput.value = '';
      urlInput.value = '';
      keyInput.value = '';
      idInput.value = '';
      presetSelect.value = '';
      if (thinkingInput) thinkingInput.checked = false;
      if (visionInput) visionInput.checked = false;
    }

    overlay.classList.remove('translator-modal-hidden');
    nameInput.focus();
  }

  /**
   * Hide the add/edit model modal.
   */
  function hideAddModelModal() {
    var overlay = document.getElementById('translator-modal-overlay');
    overlay.classList.add('translator-modal-hidden');
    editingModelId = null;
  }

  /**
   * Save model from the modal form.
   */
  function saveModelFromModal() {
    var name = document.getElementById('translator-model-name-input').value.trim();
    var apiUrl = document.getElementById('translator-model-url-input').value.trim();
    var apiKey = document.getElementById('translator-model-key-input').value.trim();
    var model = document.getElementById('translator-model-id-input').value.trim();
    var thinkingInput = document.getElementById('translator-model-thinking-input');
    var thinking = thinkingInput ? thinkingInput.checked : false;
    var visionInput = document.getElementById('translator-model-vision-input');
    var vision = visionInput ? visionInput.checked : false;

    if (!name || !apiUrl || !apiKey || !model) {
      showToast('请填写所有字段', 'error');
      return;
    }

    if (editingModelId) {
      var existing = currentModels.find(function (m) { return m.id === editingModelId; });
      if (existing) {
        existing.name = name;
        existing.apiUrl = apiUrl;
        existing.apiKey = apiKey;
        existing.model = model;
        existing.thinking = thinking;
        existing.vision = vision;
        // 如果取消多模态且该模型是PIC默认，清除PIC默认状态
        if (!vision && existing.isDefaultPic) {
          existing.isDefaultPic = false;
          defaultPicModelCache = null;
          showToast('已取消该模型的PIC默认（非多模态）', 'info');
        }
      }
    } else {
      var newModel = {
        id: 'model_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: name,
        apiUrl: apiUrl,
        apiKey: apiKey,
        model: model,
        thinking: thinking,
        vision: vision,
        isDefaultText: currentModels.length === 0,
        isDefaultPic: (currentModels.length === 0 && vision),
        latency: null,
        testTime: null,
        returnContent: null
      };
      currentModels.push(newModel);
    }

    renderModelList();
    hideAddModelModal();
    showToast(editingModelId ? '模型已更新' : '模型已添加', 'success');
  }

  /**
   * Test all configured models and update their latency, testTime, and returnContent.
   */
  async function testAllModels() {
    if (currentModels.length === 0) {
      showToast('请先添加模型', 'error');
      return;
    }

    var testBtn = document.getElementById('translator-test-all');
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="translator-testing-indicator"></span>测试中...';

    for (var i = 0; i < currentModels.length; i++) {
      var m = currentModels[i];
      if (!m.apiUrl || !m.apiKey || !m.model) {
        m.latency = null;
        m.testTime = new Date().toLocaleString('zh-CN');
        m.returnContent = '配置不完整，无法测试';
        renderModelList();
        continue;
      }

      try {
        var result = await new Promise(function (resolve) {
          chrome.runtime.sendMessage({
            type: 'testModel',
            data: {
              apiUrl: m.apiUrl,
              apiKey: m.apiKey,
              model: m.model,
              thinking: m.thinking
            }
          }, function (response) {
            resolve(response || { success: false, error: 'No response' });
          });
        });

        if (result.success) {
          m.latency = result.latency;
          m.testTime = result.testTime;
          m.returnContent = result.returnContent;
        } else {
          m.latency = null;
          m.testTime = new Date().toLocaleString('zh-CN');
          m.returnContent = '测试失败: ' + (result.error || '未知错误');
        }
      } catch (err) {
        m.latency = null;
        m.testTime = new Date().toLocaleString('zh-CN');
        m.returnContent = '测试异常: ' + err.message;
      }

      renderModelList();
    }

    testBtn.disabled = false;
    testBtn.textContent = '测试全部';
    showToast('测试完成', 'success');
  }

  /**
   * Save configuration and close the config panel.
   * 保存前先做 dirty check：模型与设置项均无实际变更时不写存储、不递增版本号，直接关闭面板，
   * 避免"未修改任何配置却点确认"导致旧快照覆盖其他窗口刚保存的配置。
   */
  function saveAndCloseConfig() {
    var timeoutInput = document.getElementById('translator-timeout-input');
    var timeoutVal = parseInt(timeoutInput ? timeoutInput.value : '120', 10);
    if (isNaN(timeoutVal) || timeoutVal < 30) timeoutVal = 30;
    if (timeoutVal > 600) timeoutVal = 600;

    var langSelect = document.getElementById('translator-lang-select');
    var langVal = langSelect ? langSelect.value : 'en-zh';

    var selToggle = document.getElementById('translator-selection-toggle');
    var selEnabled = selToggle ? selToggle.checked : true;

    // dirty check：对比当前配置与打开面板时加载的快照
    var modelsChanged = stringifyModelsForCompare(currentModels) !== loadedModelsSnapshot;
    var settingsChanged = (timeoutVal !== batchTimeout) ||
      (langVal !== translateDirection) ||
      (selEnabled !== selectionTranslateEnabled);
    if (!modelsChanged && !settingsChanged) {
      showToast('配置未变更，无需保存', 'info');
      toggleConfigPanel();
      return;
    }

    batchTimeout = timeoutVal;

    // 配置变更后清除默认模型缓存，确保后续翻译使用最新配置
    defaultTextModelCache = null;
    defaultPicModelCache = null;

    translateDirection = langVal;

    var prevEnabled = selectionTranslateEnabled;
    selectionTranslateEnabled = selEnabled;
    if (prevEnabled !== selectionTranslateEnabled) {
      if (selectionTranslateEnabled) {
        initSelectionTranslate();
      } else {
        removeSelectionBtn();
        removeSelectionPopup();
      }
    }

    sendConfigToStorage(false);
  }

  /**
   * Send the saveConfig message to the background worker.
   * 携带读取配置时的版本号 baseVersion 做乐观锁检测：
   * 若配置已被其他窗口/页面修改并保存，则提示用户选择强制覆盖或放弃本次修改。
   * @param {boolean} force - true 表示用户已确认强制覆盖其他窗口的修改。
   */
  function sendConfigToStorage(force) {
    chrome.runtime.sendMessage({
      type: 'saveConfig',
      data: {
        models: currentModels,
        language: translateDirection,
        timeout: batchTimeout,
        selectionTranslate: selectionTranslateEnabled,
        baseVersion: loadedConfigVersion,
        force: !!force
      }
    }, function (response) {
      if (response && response.conflict) {
        var overwrite = window.confirm(
          '检测到配置已在其他窗口/页面修改并保存。\n\n' +
          '【确定】用当前窗口的配置覆盖（其他窗口的修改将丢失）\n' +
          '【取消】放弃本次修改，并加载最新配置'
        );
        if (overwrite) {
          sendConfigToStorage(true);
        } else {
          // 放弃本地修改：重新加载最新配置并同步划词翻译开关状态
          loadConfig();
          if (selectionTranslateEnabled) {
            initSelectionTranslate();
          } else {
            removeSelectionBtn();
            removeSelectionPopup();
          }
          showToast('已放弃本次修改，加载最新配置', 'info');
        }
        return;
      }
      if (response && response.success) {
        // 保存成功后同步本地版本号与快照，避免后续保存误报冲突/误判变更
        loadedConfigVersion = response.configVersion != null ? response.configVersion : loadedConfigVersion;
        loadedModelsSnapshot = stringifyModelsForCompare(currentModels);
        showToast('配置已保存', 'success');
        toggleConfigPanel();
      } else {
        showToast('保存失败', 'error');
      }
    });
  }

  /**
   * Handle the translate/restore button click.
   */
  async function handleTranslateClick() {
    if (isPicTranslating) {
      showToast('PIC翻译正在进行中，请先取消PIC翻译', 'warning');
      return;
    }

    if (isTranslating) {
      cancelTranslation = true;
      broadcastToIframes({ type: 'cancel' });
      showToast('正在取消翻译...', 'info');
      return;
    }

    if (isTranslated) {
      restorePage();
      return;
    }

    var defaultModel = await getDefaultModel('text');
    if (!defaultModel) {
      showToast('请先配置好大模型', 'error');
      return;
    }

    await translatePage(defaultModel).catch(function (err) {
      recoverFromTranslateError(err);
    });
  }

  /**
   * 整页翻译异常兜底：复位翻译状态、恢复按钮文案并提示错误。
   * 确保任何未预期异常都不会让按钮永久停留在"翻译中"（并导致后续点击只被当作"取消"）。
   * @param {Error} err - 捕获到的异常。
   */
  function recoverFromTranslateError(err) {
    isTranslating = false;
    cancelTranslation = false;
    var btn = document.getElementById('translator-btn-translate');
    if (btn && !isTranslated) {
      btn.classList.remove('translator-loading');
      btn.textContent = '翻译';
    }
    hideProgress();
    showToast('翻译失败: ' + ((err && err.message) || err), 'error');
  }

  /**
   * Get the default model from storage, with timeout and retry.
   * @param {string} type - 'text' for page/compare/word/selection, 'pic' for vision translation.
   * @returns {Object|null} The default model or null.
   */
  function getDefaultModel(type) {
    var modelType = type || 'text';
    var maxRetries = 2;
    return new Promise(function (resolve) {
      function attempt(remaining) {
        var timeout = setTimeout(function () {
          if (remaining > 0) {
            attempt(remaining - 1);
          } else {
            resolve(null);
          }
        }, 10000);

        chrome.runtime.sendMessage({ type: 'getDefaultModel', data: { type: modelType } }, function (response) {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            if (remaining > 0) {
              setTimeout(function () { attempt(remaining - 1); }, 1000);
            } else {
              resolve(null);
            }
            return;
          }
          resolve(response || null);
        });
      }
      attempt(maxRetries);
    });
  }

  /**
   * Translate the current page from English to Chinese using streaming with concurrency.
   * @param {Object} defaultModel - The default LLM model configuration.
   */
  async function translatePage(defaultModel) {
    isTranslating = true;
    cancelTranslation = false;
    var btn = document.getElementById('translator-btn-translate');
    btn.classList.add('translator-loading');
    btn.textContent = '翻译中';

    textEntries = [];
    processedTextNodes = new WeakSet();
    collectTextNodes(document.body, textEntries);

    if (textEntries.length === 0) {
      showToast('未找到可翻译的英文内容', 'info');
      isTranslating = false;
      btn.classList.remove('translator-loading');
      btn.textContent = '翻译';
      return;
    }

    var batches = createBatches(textEntries, BATCH_SIZE);
    var totalItems = textEntries.length;
    var completedItems = 0;
    var failedBatches = 0;
    var wasCancelled = false;

    showProgress(0);

    var batchInfos = batches.map(function (batch, i) {
      var startIndex = 0;
      for (var k = 0; k < i; k++) {
        startIndex += batches[k].length;
      }
      return { batch: batch, texts: batch.map(function (e) { return e.originalText; }), startIndex: startIndex };
    });

    var running = 0;
    var nextIndex = 0;

    await new Promise(function (resolveAll) {
      function launchNext() {
        while (running < CONCURRENCY && nextIndex < batchInfos.length && !cancelTranslation) {
          var info = batchInfos[nextIndex];
          nextIndex++;
          running++;

          translateBatchStream(defaultModel, info.texts, info.startIndex, function (globalIndex, translation) {
            if (cancelTranslation) return;
            if (globalIndex < textEntries.length) {
              applyTranslation(textEntries[globalIndex], translation);
              completedItems++;
              showProgress(Math.round((completedItems / totalItems) * 100));
            }
          }).then(function (success) {
            running--;
            if (!success) failedBatches++;
            if (cancelTranslation) {
              wasCancelled = true;
              if (running === 0) resolveAll();
              return;
            }
            if (running === 0 && nextIndex >= batchInfos.length) {
              resolveAll();
            } else {
              launchNext();
            }
          });
        }

        if (cancelTranslation && running === 0) {
          wasCancelled = true;
          resolveAll();
          return;
        }

        if (running === 0 && nextIndex >= batchInfos.length) {
          resolveAll();
        }
      }

      launchNext();
    });

    isTranslating = false;

    if (wasCancelled) {
      textEntries.forEach(function (entry) {
        if (entry.type === 'attr') {
          entry.element.setAttribute(entry.attrName, entry.originalText);
          entry.element.removeAttribute('data-translator-attr_' + entry.attrName);
        } else {
          entry.node.textContent = entry.originalText;
          var parent = entry.node.parentElement;
          if (parent) parent.removeAttribute('data-translator-id');
        }
      });
      textEntries = [];
      processedTextNodes = new WeakSet();
      isTranslated = false;
      btn.classList.remove('translator-loading');
      btn.textContent = '翻译';
      hideProgress();
      showToast('翻译已取消', 'info');
      return;
    }

    isTranslated = true;
    defaultTextModelCache = defaultModel;
    btn.classList.remove('translator-loading');
    btn.classList.add('translator-translated');
    btn.textContent = '原文';
    hideProgress();
    if (failedBatches === 0) {
      startDomObserver();
      showToast('翻译完成', 'success');
    } else {
      startDomObserver();
      showToast('翻译完成（部分批次失败，' + failedBatches + '批未翻译）', 'info');
    }
    // Broadcast translate command to iframes WITHOUT the model object.
    // Iframes fetch the default model themselves via chrome.runtime.sendMessage,
    // so the apiKey never crosses the postMessage boundary.
    broadcastToIframes({ type: 'translate' });
  }

  /**
   * Translate a batch of texts using streaming port connection.
   * @param {Object} defaultModel - The default LLM model configuration.
   * @param {Array} texts - Array of texts to translate.
   * @param {number} startIndex - The global start index of this batch.
   * @param {Function} onTranslation - Callback(globalIndex, translation) for each result.
   * @returns {Promise<boolean>} Whether every text in the batch got a translation.
   */
  function translateBatchStream(defaultModel, texts, startIndex, onTranslation) {
    var MAX_BATCH_RETRIES = 2;
    var received = {};   // 根局部索引 -> 是否已收到译文
    var pending = [];    // 本轮需要发送的条目
    var lastError = '';

    for (var i = 0; i < texts.length; i++) pending.push({ rootIdx: i, text: texts[i] });

    /**
     * 发送一批条目（首次是全量，重试时是缺失子集）。收到译文即登记到 received，
     * 并按"根局部索引"还原为全局索引回调，避免子集下标导致错位。
     * 无论成功与否都会 resolve，由 attempt 复检覆盖情况后决定是否重试。
     * @param {Array} items - 待发送条目数组，元素为 { rootIdx, text }。
     * @returns {Promise<void>}
     */
    function sendOnce(items) {
      return new Promise(function (resolve) {
        var port = null;
        var settled = false;
        var timer = null;

        /**
         * 保证一次发送只结束一次，并清理超时定时器。
         */
        function finish() {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        }

        try {
          port = chrome.runtime.connect({ name: 'translateStream' });

          timer = setTimeout(function () {
            try { port.disconnect(); } catch (e) {}
            finish();
          }, batchTimeout * 1000);

          port.onMessage.addListener(function (msg) {
            switch (msg.type) {
              case 'translation':
                // 后台返回的是本次发送子集内的下标，需映射回根局部索引
                if (typeof msg.index !== 'number' || !items[msg.index]) return;
                var rootIdx = items[msg.index].rootIdx;
                received[rootIdx] = true;
                try {
                  onTranslation(startIndex + rootIdx, msg.translation);
                } catch (e) {
                  // 单条译文应用失败不影响整批流程
                }
                break;
              case 'done':
                finish();
                break;
              case 'error':
                lastError = msg.error || '';
                finish();
                break;
            }
          });

          port.onDisconnect.addListener(function () {
            if (chrome.runtime.lastError) {
              lastError = lastError || chrome.runtime.lastError.message || '';
            }
            finish();
          });

          port.postMessage({
            apiUrl: defaultModel.apiUrl,
            apiKey: defaultModel.apiKey,
            model: defaultModel.model,
            texts: items.map(function (it) { return it.text; }),
            startIndex: 0, // 子集下标由本函数映射回全局下标
            direction: translateDirection,
            thinking: defaultModel.thinking
          });
        } catch (e) {
          if (!port) lastError = lastError || '无法连接后台服务';
          try { if (port) port.disconnect(); } catch (e2) {}
          finish();
        }
      });
    }

    /**
     * 校验本批覆盖情况：仍有条目没拿到译文时，按缺失子集重试，最多 MAX_BATCH_RETRIES 次。
     * 这是修复"模型漏返回若干行导致中间整块未翻译却仍提示翻译完成"的关键。
     * @param {number} retriesLeft - 剩余重试次数。
     * @returns {Promise<boolean>} 是否所有条目都拿到了译文。
     */
    function attempt(retriesLeft) {
      return sendOnce(pending).then(function () {
        var missing = [];
        for (var i = 0; i < pending.length; i++) {
          if (!received[pending[i].rootIdx]) missing.push(pending[i]);
        }
        if (missing.length === 0) return true;
        if (retriesLeft <= 0) {
          if (lastError) showToast('翻译失败: ' + lastError, 'error');
          return false;
        }
        pending = missing;
        return attempt(retriesLeft - 1);
      });
    }

    return attempt(MAX_BATCH_RETRIES);
  }

  /**
   * Collect all English text nodes and translatable attributes from the DOM tree.
   * Also collects video track (VTT) subtitles for translation.
   * @param {Node} root - The root node to start traversal.
   * @param {Array} entries - Array to store text entries.
   */
  function collectTextNodes(root, entries) {
    collectTextNodesRecursive(root, entries);
    collectAttributeTextsDeep(root, entries);
    collectVideoTracks(root, entries);
  }

  /**
   * Recursively collect text nodes, penetrating Shadow DOM boundaries.
   * @param {Node} root - The root node to start traversal.
   * @param {Array} entries - Array to store text entries.
   */
  function collectTextNodesRecursive(root, entries) {
    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (getElementIdAttr(parent).startsWith('translator-')) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('[id^="translator-"]')) return NodeFilter.FILTER_REJECT;
          if (processedTextNodes.has(node)) return NodeFilter.FILTER_REJECT;
          var text = node.textContent.trim();
          if (!text) return NodeFilter.FILTER_REJECT;
          if (!/[a-zA-Z]/.test(text)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var node;
    while ((node = walker.nextNode())) {
      var id = 'tr_' + entries.length + '_' + Math.random().toString(36).substr(2, 4);
      entries.push({
        id: id,
        type: 'text',
        node: node,
        originalText: node.textContent
      });
      processedTextNodes.add(node);
      node.parentElement.setAttribute('data-translator-id', id);
    }

    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot) {
        collectTextNodesRecursive(el.shadowRoot, entries);
      }
    }
  }

  /**
   * Collect translatable English text from HTML attributes, penetrating Shadow DOM.
   * @param {Node} root - The root node to start traversal.
   * @param {Array} entries - Array to store text entries.
   */
  function collectAttributeTextsDeep(root, entries) {
    collectAttributeTexts(root, entries);

    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot) {
        collectAttributeTextsDeep(el.shadowRoot, entries);
      }
    }
  }

  /**
   * Collect translatable English text from HTML attributes.
   * @param {Node} root - The root node to start traversal.
   * @param {Array} entries - Array to store text entries.
   */
  function collectAttributeTexts(root, entries) {
    var allElements = root.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (getElementIdAttr(el).startsWith('translator-')) continue;
      if (el.closest && el.closest('[id^="translator-"]')) continue;

      for (var j = 0; j < TRANSLATABLE_ATTRS.length; j++) {
        var attrName = TRANSLATABLE_ATTRS[j];
        if (!el.hasAttribute(attrName)) continue;
        var attrKey = 'attr_' + attrName;
        if (el.hasAttribute('data-translator-' + attrKey)) continue;

        var value = el.getAttribute(attrName).trim();
        if (!value) continue;
        if (!/[a-zA-Z]/.test(value)) continue;

        var id = 'tr_' + entries.length + '_' + Math.random().toString(36).substr(2, 4);
        entries.push({
          id: id,
          type: 'attr',
          attrName: attrName,
          element: el,
          originalText: value
        });
        el.setAttribute('data-translator-' + attrKey, id);
      }
    }
  }

  /**
   * Create batches from an array.
   * @param {Array} arr - The array to batch.
   * @param {number} size - Batch size.
   * @returns {Array} Array of batches.
   */
  function createBatches(arr, size) {
    var batches = [];
    for (var i = 0; i < arr.length; i += size) {
      batches.push(arr.slice(i, i + size));
    }
    return batches;
  }

  /**
   * Apply a translation to a text entry.
   * @param {Object} entry - The text entry.
   * @param {string} translation - The translated text.
   */
  function applyTranslation(entry, translation) {
    if (!translation) return;
    // 解码模型回显的字面转义（\n \t \" 等），否则页面会直接显示 "\n\t" 这类字符
    translation = decodeModelEscapeSequences(translation);
    entry.translatedText = translation;
    if (entry.type === 'attr') {
      entry.element.setAttribute(entry.attrName, translation);
    } else if (entry.type === 'cue') {
      entry.cue.text = translation;
    } else {
      entry.node.textContent = translation;
    }
  }

  /**
   * Restore the page to its original English text.
   */
  function restorePage() {
    textEntries.forEach(function (entry) {
      if (entry.type === 'attr') {
        entry.element.setAttribute(entry.attrName, entry.originalText);
        entry.element.removeAttribute('data-translator-attr_' + entry.attrName);
      } else if (entry.type === 'cue') {
        entry.cue.text = entry.originalText;
      } else {
        entry.node.textContent = entry.originalText;
        var parent = entry.node.parentElement;
        if (parent) {
          parent.removeAttribute('data-translator-id');
        }
      }
    });

    textEntries = [];
    translatedTracks = [];
    processedTextNodes = new WeakSet();
    isTranslated = false;
    stopDomObserver();

    var btn = document.getElementById('translator-btn-translate');
    btn.classList.remove('translator-translated');
    btn.textContent = '翻译';
    showToast('已恢复原文', 'info');
    broadcastToIframes({ type: 'restore' });
  }

  /**
   * Start observing DOM changes to translate dynamically loaded content.
   * Also observes Shadow DOM roots for Web Components.
   */
  function startDomObserver() {
    if (domObserver) return;
    domObserver = new MutationObserver(function (mutations) {
      if (!isTranslated || isTranslating) return;
      if (pendingObserverTimer) clearTimeout(pendingObserverTimer);
      pendingObserverTimer = setTimeout(function () {
        translateNewContent();
        observeNewShadowRoots();
      }, 800);
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    observeNewShadowRoots();
  }

  /**
   * Find and observe Shadow DOM roots that haven't been observed yet.
   */
  function observeNewShadowRoots() {
    var allElements = document.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      if (el.shadowRoot && !el.shadowRoot.__translatorObserved) {
        el.shadowRoot.__translatorObserved = true;
        var observer = new MutationObserver(function () {
          if (!isTranslated || isTranslating) return;
          if (pendingObserverTimer) clearTimeout(pendingObserverTimer);
          pendingObserverTimer = setTimeout(function () {
            translateNewContent();
          }, 800);
        });
        observer.observe(el.shadowRoot, { childList: true, subtree: true });
        shadowObservers.push(observer);
      }
    }
  }

  /**
   * Stop observing DOM changes including Shadow DOM observers.
   */
  function stopDomObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    shadowObservers.forEach(function (obs) { obs.disconnect(); });
    shadowObservers = [];
    if (pendingObserverTimer) {
      clearTimeout(pendingObserverTimer);
      pendingObserverTimer = null;
    }
  }

  /**
   * Translate newly added content detected by MutationObserver.
   */
  async function translateNewContent() {
    if (!isTranslated || isTranslating) return;

    var model = defaultTextModelCache;
    if (!model) {
      model = await getDefaultModel('text');
      if (!model) return;
      defaultTextModelCache = model;
    }

    var prevLen = textEntries.length;
    collectTextNodes(document.body, textEntries);
    var newEntries = textEntries.slice(prevLen);

    if (newEntries.length === 0) return;

    var batches = createBatches(newEntries, BATCH_SIZE);
    var totalNew = newEntries.length;
    var completedNew = 0;

    var batchInfos = batches.map(function (batch, i) {
      var startInNew = 0;
      for (var k = 0; k < i; k++) startInNew += batches[k].length;
      return { batch: batch, texts: batch.map(function (e) { return e.originalText; }), startInNew: startInNew };
    });

    var running = 0;
    var nextIdx = 0;

    await new Promise(function (resolveAll) {
      function launchNext() {
        while (running < CONCURRENCY && nextIdx < batchInfos.length) {
          var info = batchInfos[nextIdx];
          nextIdx++;
          running++;

          translateBatchStream(model, info.texts, prevLen + info.startInNew, function (globalIndex, translation) {
            if (globalIndex < textEntries.length) {
              applyTranslation(textEntries[globalIndex], translation);
              completedNew++;
            }
          }).then(function () {
            running--;
            if (running === 0 || nextIdx >= batchInfos.length) {
              if (running === 0) resolveAll();
            } else {
              launchNext();
            }
          });
        }
        if (running === 0) resolveAll();
      }
      launchNext();
    });
  }

  /**
   * Escape HTML special characters.
   * @param {string} str - The string to escape.
   * @returns {string} The escaped string.
   */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Listen for messages from the top frame to translate/restore iframe content.
   * Iframe instances receive commands and execute translation on their own document.
   * Security:
   *   - Validates event.origin to only accept messages from the same origin (top frame
   *     or parent frame). Cross-origin iframes controlled by third parties cannot trigger
   *     translation commands.
   *   - Does NOT trust event.data.model. Instead, fetches the default model via
   *     chrome.runtime.sendMessage so that apiKey never traverses postMessage and cannot
   *     be intercepted by malicious iframes sharing the page.
   */
  function listenForFrameMessages() {
    window.addEventListener('message', function (event) {
      if (!event.data || event.data.source !== 'translator-plugs') return;
      // Origin allowlist: same-origin (covers top frame and same-origin iframes)
      var allowedOrigins = [window.location.origin];
      if (window.parent && window.parent !== window) {
        try { allowedOrigins.push(window.parent.location.origin); } catch (e) {}
      }
      if (window.top && window.top !== window) {
        try { allowedOrigins.push(window.top.location.origin); } catch (e) {}
      }
      if (allowedOrigins.indexOf(event.origin) === -1) return;

      switch (event.data.type) {
        case 'translate':
          // Fetch the default text model directly from the background service worker.
          // This avoids receiving a (possibly tampered) model object via postMessage
          // and ensures the apiKey never leaves the content-script context.
          chrome.runtime.sendMessage(
            { type: 'getDefaultModel', data: { type: 'text' } },
            function (response) {
              if (response) {
                handleFrameTranslate(response);
              }
            }
          );
          break;
        case 'restore':
          handleFrameRestore();
          break;
        case 'cancel':
          cancelTranslation = true;
          break;
      }
    });
  }

  /**
   * Handle translate command received in an iframe.
   * @param {Object} model - The default model configuration from top frame.
   */
  async function handleFrameTranslate(model) {
    if (!model) return;
    cancelTranslation = false;
    textEntries = [];
    processedTextNodes = new WeakSet();
    collectTextNodes(document.body, textEntries);
    if (textEntries.length === 0) return;

    var batches = createBatches(textEntries, BATCH_SIZE);
    var totalItems = textEntries.length;
    var completedItems = 0;

    var batchInfos = batches.map(function (batch, i) {
      var startIndex = 0;
      for (var k = 0; k < i; k++) startIndex += batches[k].length;
      return { batch: batch, texts: batch.map(function (e) { return e.originalText; }), startIndex: startIndex };
    });

    var running = 0;
    var nextIndex = 0;

    await new Promise(function (resolveAll) {
      function launchNext() {
        while (running < CONCURRENCY && nextIndex < batchInfos.length && !cancelTranslation) {
          var info = batchInfos[nextIndex];
          nextIndex++;
          running++;

          translateBatchStream(model, info.texts, info.startIndex, function (globalIndex, translation) {
            if (cancelTranslation) return;
            if (globalIndex < textEntries.length) {
              applyTranslation(textEntries[globalIndex], translation);
              completedItems++;
            }
          }).then(function () {
            running--;
            if (cancelTranslation && running === 0) {
              resolveAll();
              return;
            }
            if (running === 0) resolveAll();
            else launchNext();
          });
        }
        if (running === 0) resolveAll();
      }
      launchNext();
    });

    isTranslated = true;
  }

  /**
   * Handle restore command received in an iframe.
   */
  function handleFrameRestore() {
    textEntries.forEach(function (entry) {
      if (entry.type === 'attr') {
        entry.element.setAttribute(entry.attrName, entry.originalText);
        entry.element.removeAttribute('data-translator-attr_' + entry.attrName);
      } else {
        entry.node.textContent = entry.originalText;
        var parent = entry.node.parentElement;
        if (parent) parent.removeAttribute('data-translator-id');
      }
    });
    textEntries = [];
    processedTextNodes = new WeakSet();
    isTranslated = false;
  }

  /**
   * Broadcast a message to all iframes on the page.
   * Security: uses each iframe's origin (parsed from its src) as the targetOrigin
   * instead of '*' to prevent sensitive data from being delivered to cross-origin
   * iframes that may be controlled by third parties. Iframes without a src
   * (e.g. about:blank, javascript:) inherit the parent's origin.
   * @param {Object} data - Message data to send (must NOT contain apiKey or other secrets).
   */
  function broadcastToIframes(data) {
    data.source = 'translator-plugs';
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var iframe = iframes[i];
        var targetOrigin = window.location.origin;
        var src = iframe.getAttribute('src');
        if (src) {
          // Skip special schemes that inherit the parent's origin
          if (/^(about:|javascript:)/i.test(src)) {
            targetOrigin = window.location.origin;
          } else {
            try {
              var parsed = new URL(src, window.location.origin);
              // URL.origin returns "null" for some special schemes; fall back to parent origin
              targetOrigin = (parsed.origin && parsed.origin !== 'null')
                ? parsed.origin
                : window.location.origin;
            } catch (e) {
              targetOrigin = window.location.origin;
            }
          }
        }
        iframe.contentWindow.postMessage(data, targetOrigin);
      } catch (e) {}
    }
  }

  /**
   * Initialize selection-based translation: listen for mouse events to detect
   * text selection and show a translate button near the selection.
   * Also listens for document 'selectionchange' for reliable detection on complex sites.
   * Only binds listeners once; subsequent calls are no-ops.
   */
  function initSelectionTranslate() {
    if (selectionListenersBound) return;
    selectionListenersBound = true;

    // 使用 capture 模式：确保在页面脚本处理事件之前我们先捕获，避免被 stopPropagation 拦截
    document.addEventListener('mouseup', handleSelectionMouseUp, true);
    document.addEventListener('mousedown', handleSelectionMouseDown, true);

    // 触屏支持（MSN 也有移动端流量）
    document.addEventListener('touchend', handleSelectionMouseUp, true);
    document.addEventListener('touchstart', handleSelectionMouseDown, true);

    // selectionchange：浏览器原生"文本选择变化"事件，对复杂 JS 处理的页面最可靠
    document.addEventListener('selectionchange', handleSelectionChange, true);
  }

  /**
   * 判断选区内容是否可用于划词翻译。
   * 原实现要求选区必须含英文字母（/[a-zA-Z]/），导致在中文页面（如网易文章页）
   * 划选中文正文时完全不触发划词翻译。改为：含英文字母或含汉字均可翻译。
   * @param {string} text - 规范化后的选中文本。
   * @returns {boolean} - 是否可翻译。
   */
  function isTranslatableSelection(text) {
    if (!text || text.length < 2) return false;
    if (text.length > 10000) return false;
    return /[a-zA-Z]/.test(text) || /[\u4e00-\u9fff]/.test(text);
  }

  /**
   * 按选区内容自动判定翻译方向。
   * 划词场景下页面语言不可预知（中英文页面都可能划词），固定使用全局方向设置
   * 会导致"中文页面上选中英文"或"英文页面上选中中文"时方向相反，故按内容判定：
   * 选区英文字母多于汉字 → 英译中，否则 → 中译英。
   * @param {string} text - 规范化后的选中文本。
   * @returns {string} - 'en-zh' 或 'zh-en'。
   */
  function resolveSelectionDirection(text) {
    var latinCount = (text.match(/[a-zA-Z]/g) || []).length;
    var cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return latinCount > cjkCount ? 'en-zh' : 'zh-en';
  }

  /**
   * 规范化选中的文本：去除控制字符、合并空白、返回清理后的文本。
   * @param {string} text
   * @returns {string}
   */
  function normalizeSelectionText(text) {
    if (!text) return '';
    return text
      .replace(/\r/g, '\n') // 统一换行
      .replace(/\u00a0/g, ' ') // 非间断空格
      .replace(/[ \t]*\n[ \t]*/g, '\n') // 清除行首尾空白
      .replace(/\n{3,}/g, '\n\n') // 合并过多空行
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, '') // 零宽字符/BOM
      .replace(/[ \t]{2,}/g, ' ') // 合并连续空白
      .trim();
  }

  /**
   * 判断某个选择是否来自我们自己注入的 DOM 元素。
   * @param {Selection} selection
   * @returns {boolean}
   */
  function isSelectionInOurElements(selection) {
    if (!selection) return false;
    var anchorNode = selection.anchorNode;
    var focusNode = selection.focusNode;
    var nodes = [anchorNode, focusNode];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n) continue;
      var el = n.nodeType === 1 ? n : n.parentNode;
      while (el && el.nodeType === 1) {
        if (getElementIdAttr(el).indexOf('translator-') === 0) return true;
        el = el.parentNode;
      }
    }
    return false;
  }

  /**
   * 获取当前选择的文本和位置矩形。
   * 在普通页面中，window.getSelection().toString() 和 range.getBoundingClientRect() 正常工作。
   * 但在 Shadow DOM 中（如 MSN 页面），sel.toString() 可能返回空字符串，
   * range.getBoundingClientRect() 可能返回全零矩形。
   * 此函数通过 range.toString() 和 anchorNode 父元素 rect 来兼容 Shadow DOM 场景。
   * @returns {{ text: string, rect: DOMRect|null } | null}
   */
  function getSelectionTextAndRect() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    // 优先使用 sel.toString()，若为空则尝试 range.toString()
    // Shadow DOM 中 sel.toString() 可能返回空字符串，但 range.toString() 正常
    var rawText = selection.toString();
    if (!rawText && selection.rangeCount > 0) {
      try {
        rawText = selection.getRangeAt(0).toString();
      } catch (e) {}
    }

    var range = selection.getRangeAt(0);
    var rect = range.getBoundingClientRect();

    // Shadow DOM 中 range.getBoundingClientRect() 可能返回全零矩形，
    // 逐级向上查找有有效 rect 的元素：anchorNode 父元素 → Shadow Host
    if (rect.width === 0 && rect.height === 0 && selection.anchorNode) {
      var node = selection.anchorNode;
      // 从 anchorNode 向上遍历，找到第一个有有效 rect 的元素
      var el = node.nodeType === 1 ? node : node.parentElement;
      while (el) {
        var elRect = el.getBoundingClientRect();
        if (elRect.width > 0 || elRect.height > 0) {
          rect = elRect;
          break;
        }
        // 如果到达 Shadow Root 的边界，使用 Shadow Host 的 rect
        if (el.parentNode && el.parentNode instanceof ShadowRoot) {
          var host = el.parentNode.host;
          if (host) {
            var hostRect = host.getBoundingClientRect();
            if (hostRect.width > 0 || hostRect.height > 0) {
              rect = hostRect;
              break;
            }
          }
        }
        el = el.parentElement;
      }
    }

    return { text: rawText, rect: rect };
  }

  let selectionChangeTimer = null;
  function handleSelectionChange() {
    if (!selectionTranslateEnabled) return;

    clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(function () {
      if (!selectionTranslateEnabled) return;

      var info = getSelectionTextAndRect();
      if (!info) return;

      var text = normalizeSelectionText(info.text);
      if (!isTranslatableSelection(text)) return;

      var selection = window.getSelection();
      // 避免在我们自己的元素上触发
      if (isSelectionInOurElements(selection)) return;

      // 避免与 mouseup 重复触发
      if (selectionTranslateBtn) return;

      var rect = info.rect;
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      showSelectionBtn(rect, text);
    }, 150);
  }

  /**
   * Handle mousedown: close selection button and popup when clicking elsewhere.
   * @param {MouseEvent} e - The mouse event.
   */
  function handleSelectionMouseDown(e) {
    if (!selectionTranslateEnabled) return;
    if (selectionTranslateBtn && selectionTranslateBtn.contains(e.target)) return;
    if (selectionTranslatePopup && selectionTranslatePopup.contains(e.target)) return;
    removeSelectionBtn();
    removeSelectionPopup();
  }

  /**
   * Handle mouseup: detect text selection and show translate button.
   * @param {MouseEvent} e - The mouse event.
   */
  function handleSelectionMouseUp(e) {
    if (!selectionTranslateEnabled) return;
    if (selectionTranslateBtn && selectionTranslateBtn.contains(e.target)) return;
    if (selectionTranslatePopup && selectionTranslatePopup.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('[id^="translator-"]')) return;

    // 先清除 selectionchange 的定时器，避免两者冲突
    clearTimeout(selectionChangeTimer);

    setTimeout(function () {
      var info = getSelectionTextAndRect();
      if (!info) return;

      var text = normalizeSelectionText(info.text);
      removeSelectionBtn();

      if (!isTranslatableSelection(text)) return;

      var selection = window.getSelection();
      if (isSelectionInOurElements(selection)) return;

      var rect = info.rect;
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      showSelectionBtn(rect, text);
    }, 10);
  }

  /**
   * Show the translate button near the selection.
   * @param {DOMRect} rect - The bounding rect of the selection.
   * @param {string} text - The selected text.
   */
  function showSelectionBtn(rect, text) {
    removeSelectionBtn();

    selectionTranslateBtn = document.createElement('div');
    selectionTranslateBtn.id = 'translator-selection-btn';
    selectionTranslateBtn.textContent = '译';
    // 强制内联样式，防止被 MSN 等站点全局 CSS 覆盖
    selectionTranslateBtn.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      'width: 28px',
      'height: 28px',
      'border-radius: 6px',
      'background: #1677ff',
      'color: #fff',
      'font-size: 13px',
      'font-weight: 600',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'cursor: pointer',
      'user-select: none',
      'box-shadow: 0 2px 6px rgba(5, 145, 255, 0.3)',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      'line-height: 1',
      'opacity: 1',
      'visibility: visible',
      'margin: 0',
      'padding: 0',
      'border: none',
      'box-sizing: content-box'
    ].join(' !important;') + ' !important;';

    selectionTranslateBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });
    selectionTranslateBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      translateSelection(text, rect);
    });

    document.body.appendChild(selectionTranslateBtn);

    var btnRect = selectionTranslateBtn.getBoundingClientRect();
    var left = rect.right + 4;
    var top = rect.bottom + 4;

    if (left + btnRect.width > window.innerWidth - 4) {
      left = window.innerWidth - btnRect.width - 4;
    }
    if (top + btnRect.height > window.innerHeight - 4) {
      top = rect.top - btnRect.height - 4;
    }
    if (left < 4) left = 4;
    if (top < 4) top = 4;

    selectionTranslateBtn.style.left = left + 'px';
    selectionTranslateBtn.style.top = top + 'px';
  }

  /**
   * Remove the selection translate button.
   */
  function removeSelectionBtn() {
    if (selectionTranslateBtn) {
      selectionTranslateBtn.remove();
      selectionTranslateBtn = null;
    }
  }

  /**
   * Remove the selection translate popup.
   */
  function removeSelectionPopup() {
    if (selectionTranslatePopup) {
      selectionTranslatePopup.remove();
      selectionTranslatePopup = null;
    }
  }

  /**
   * Translate the selected text and show result in a popup.
   * @param {string} text - The selected text to translate.
   * @param {DOMRect} rect - The bounding rect of the selection for positioning.
   */
  async function translateSelection(text, rect) {
    removeSelectionBtn();
    showSelectionPopup('翻译中...', rect, true);

    var model = defaultTextModelCache;
    if (!model) {
      model = await getDefaultModel('text');
      if (!model) {
        showSelectionPopup('请先配置好大模型', rect, false);
        return;
      }
      defaultTextModelCache = model;
    }

    // 超时保护：30 秒无响应则提示错误
    var selectionSettled = false;
    var selectionTimer = setTimeout(function () {
      if (!selectionSettled) {
        selectionSettled = true;
        showSelectionPopup('翻译超时，请稍后重试', rect, false);
      }
    }, 30000);

    chrome.runtime.sendMessage({
      type: 'translateText',
      data: {
        apiUrl: model.apiUrl,
        apiKey: model.apiKey,
        model: model.model,
        texts: [text],
        direction: resolveSelectionDirection(text),
        thinking: model.thinking
      }
    }, function (response) {
      if (selectionSettled) return;
      selectionSettled = true;
      clearTimeout(selectionTimer);
      if (response && response.success && response.translations && response.translations.length > 0) {
        showSelectionPopup(response.translations[0], rect, false);
      } else {
        showSelectionPopup('翻译失败: ' + (response ? response.error : '未知错误'), rect, false);
      }
    });
  }

  /**
   * Show the translation result popup near the selection.
   * @param {string} content - The content to display.
   * @param {DOMRect} rect - The bounding rect for positioning.
   * @param {boolean} isLoading - Whether the content is a loading indicator.
   */
  function showSelectionPopup(content, rect, isLoading) {
    removeSelectionPopup();

    selectionTranslatePopup = document.createElement('div');
    selectionTranslatePopup.id = 'translator-selection-popup';
    selectionTranslatePopup.className = 'translator-selection-popup';
    if (isLoading) {
      selectionTranslatePopup.classList.add('translator-selection-popup-loading');
    }
    // 强制内联样式，防止被 MSN 等站点全局 CSS 覆盖
    var cssRules = [
      'position: fixed',
      'z-index: 2147483647',
      'background: #fff',
      'border-radius: 8px',
      'box-shadow: 0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12), 0 9px 28px 8px rgba(0,0,0,0.05)',
      'max-width: 500px',
      'min-width: 200px',
      'max-height: 500px',
      'overflow: hidden',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      'color: rgba(0,0,0,0.88)',
      'font-size: 14px',
      'line-height: 1.6',
      'display: block',
      'opacity: 1',
      'visibility: visible',
      'box-sizing: content-box'
    ];
    if (isLoading) {
      cssRules.push('border: 2px solid #1677ff');
    } else {
      cssRules.push('border: 1px solid #f0f0f0');
    }
    selectionTranslatePopup.style.cssText = cssRules.join(' !important;') + ' !important;';

    var closeBtn = document.createElement('span');
    closeBtn.className = 'translator-selection-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = [
      'position: absolute',
      'top: 6px',
      'right: 8px',
      'font-size: 16px',
      'cursor: pointer',
      'color: rgba(0,0,0,0.45)',
      'line-height: 1',
      'width: 20px',
      'height: 20px',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'border-radius: 4px',
      'z-index: 1',
      'font-weight: normal',
      'font-style: normal'
    ].join(' !important;') + ' !important;';
    closeBtn.addEventListener('click', function () {
      removeSelectionPopup();
    });

    var contentDiv = document.createElement('div');
    contentDiv.className = 'translator-selection-content';
    contentDiv.style.cssText = [
      'padding: 12px 32px 12px 14px',
      'font-size: 14px',
      'line-height: 1.6',
      'color: rgba(0,0,0,0.88)',
      'max-height: 476px',
      'overflow-y: auto',
      'word-break: break-word',
      'white-space: pre-wrap',
      'display: block'
    ].join(' !important;') + ' !important;';
    contentDiv.textContent = content;

    selectionTranslatePopup.appendChild(closeBtn);
    selectionTranslatePopup.appendChild(contentDiv);
    document.body.appendChild(selectionTranslatePopup);

    var popupRect = selectionTranslatePopup.getBoundingClientRect();
    var left = rect.left;
    var top = rect.bottom + 8;

    if (left + popupRect.width > window.innerWidth - 16) {
      left = window.innerWidth - popupRect.width - 16;
    }
    if (left < 16) left = 16;
    if (top + popupRect.height > window.innerHeight - 16) {
      top = rect.top - popupRect.height - 8;
      if (top < 16) top = 16;
    }

    selectionTranslatePopup.style.left = left + 'px';
    selectionTranslatePopup.style.top = top + 'px';
  }
})();