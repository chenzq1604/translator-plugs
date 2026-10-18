(function () {
  'use strict';

  let currentModels = [];
  let editingModelId = null;
  let loadedConfigVersion = 0;
  let loadedModelsSnapshot = '';
  let loadedSettingsSnapshot = '';

  const MODEL_PRESETS = {
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', apiUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
    'zhipu-glm5': { name: 'GLM-5.1', apiUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
    'volcengine-ark-code': { name: 'ark-code-latest', apiUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'ark-code-latest' },
    'minimax-m2.7': { name: 'MiniMax M2.7', apiUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-M2.7' }
  };

  document.addEventListener('DOMContentLoaded', init);

  /**
   * Initialize the popup: load config and bind events.
   */
  function init() {
    loadConfig();
    var versionSpan = document.querySelector('.app-info span:nth-child(2)');
    if (versionSpan) {
      versionSpan.textContent = '版本: v' + chrome.runtime.getManifest().version;
    }
    document.getElementById('add-model').addEventListener('click', function () {
      showModal();
    });
    document.getElementById('test-all').addEventListener('click', testAllModels);
    document.getElementById('confirm').addEventListener('click', saveConfig);
    document.getElementById('modal-cancel').addEventListener('click', hideModal);
    document.getElementById('modal-save').addEventListener('click', saveModelFromModal);
    document.getElementById('model-preset-select').addEventListener('change', function () {
      var presetKey = this.value;
      if (!presetKey || !MODEL_PRESETS[presetKey]) return;
      var preset = MODEL_PRESETS[presetKey];
      document.getElementById('model-name-input').value = preset.name;
      document.getElementById('model-url-input').value = preset.apiUrl;
      document.getElementById('model-id-input').value = preset.model;
      document.getElementById('model-key-input').focus();
    });
  }

  /**
   * Load configuration from chrome.storage.
   */
  function loadConfig() {
    chrome.runtime.sendMessage({ type: 'getConfig' }, function (response) {
      if (response) {
        currentModels = response.models || [];
        // 记录读取时的配置版本号，用于保存时的多窗口冲突检测
        loadedConfigVersion = response.configVersion || 0;
        // 记录加载时的模型与设置快照，用于保存时判断是否有实际变更（dirty check）
        loadedModelsSnapshot = stringifyModelsForCompare(currentModels);
        loadedSettingsSnapshot = JSON.stringify({
          language: response.language || 'en-zh',
          timeout: response.timeout || 120,
          selectionTranslate: response.selectionTranslate !== false
        });
        var timeoutVal = response.timeout || 120;
        var timeoutInput = document.getElementById('timeout-input');
        if (timeoutInput) timeoutInput.value = timeoutVal;
        var selToggle = document.getElementById('selection-toggle');
        if (selToggle) selToggle.checked = response.selectionTranslate !== false;
        var langSelect = document.getElementById('lang-select');
        if (langSelect) langSelect.value = response.language || 'en-zh';
        renderModelList();
      }
    });
  }

  /**
   * Render the model list in the popup.
   */
  function renderModelList() {
    var container = document.getElementById('model-list');
    if (!container) return;

    if (currentModels.length === 0) {
      container.innerHTML = '<div class="empty-tip">暂无模型，请点击"添加模型"</div>';
      return;
    }

    var html = '';
    currentModels.forEach(function (model) {
      // 向后兼容：旧数据只有 isDefault，映射到 isDefaultText
      var isDefaultText = model.isDefaultText !== undefined ? model.isDefaultText : !!model.isDefault;
      var isDefaultPic = !!model.isDefaultPic;
      var isAnyDefault = isDefaultText || isDefaultPic;
      html +=
        '<div class="model-item' + (isAnyDefault ? ' model-default' : '') + '" data-id="' + model.id + '">' +
        '<div class="model-name">' +
        escapeHtml(model.name) +
        (isDefaultText ? '<span class="default-badge">默认文本</span>' : '') +
        (isDefaultPic ? '<span class="pic-badge">默认PIC</span>' : '') +
        (model.vision ? '<span class="vision-badge">多模态</span>' : '') +
        '</div>' +
        '<div class="model-info">' +
        '<span>延时: ' + (model.latency != null ? model.latency + 'ms' : '未测试') + '</span>' +
        '<span>测试时间: ' + (model.testTime || '未测试') + '</span>' +
        '</div>';

      if (model.returnContent) {
        html += '<div class="model-return-content">' + escapeHtml(model.returnContent.substring(0, 80)) + '</div>';
      }

      html +=
        '<div class="model-actions-row">' +
        '<button class="btn-default' + (isDefaultText ? ' btn-default-active' : '') + '" data-action="defaultText" data-id="' + model.id + '">' +
        (isDefaultText ? '默认文本' : '默认文本') +
        '</button>' +
        '<button class="btn-default' + (isDefaultPic ? ' btn-default-active' : '') + '" data-action="defaultPic" data-id="' + model.id + '"' +
        (model.vision ? '' : ' disabled title="非多模态模型不能设为PIC默认"') + '>' +
        (isDefaultPic ? '默认PIC' : '默认PIC') +
        '</button>' +
        '<button class="btn-test" data-action="test" data-id="' + model.id + '">测试</button>' +
        '<button class="btn-edit" data-action="edit" data-id="' + model.id + '">编辑</button>' +
        '<button class="btn-delete" data-action="delete" data-id="' + model.id + '">删除</button>' +
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
   * Handle model actions: set default, edit, delete, test.
   * @param {string} action - The action to perform.
   * @param {string} id - The model ID.
   */
  function handleModelAction(action, id) {
    switch (action) {
      case 'defaultText':
        // toggle 逻辑：如果目标模型已是默认文本，则取消；否则设为默认并取消其他
        var targetTextModel = currentModels.find(function (m) { return m.id === id; });
        var isAlreadyTextDefault = targetTextModel && targetTextModel.isDefaultText;
        currentModels.forEach(function (m) {
          if (isAlreadyTextDefault) {
            if (m.id === id) m.isDefaultText = false;
          } else {
            m.isDefaultText = (m.id === id);
          }
          delete m.isDefault;
        });
        renderModelList();
        break;
      case 'defaultPic':
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
        renderModelList();
        break;
      case 'edit':
        var editModel = currentModels.find(function (m) { return m.id === id; });
        if (editModel) showModal(editModel);
        break;
      case 'delete':
        if (!window.confirm('确定要删除这个模型配置吗？')) break;
        currentModels = currentModels.filter(function (m) { return m.id !== id; });
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
      testBtn.innerHTML = '<span class="testing-indicator"></span>';
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
    showToast('测试完成', 'success');
  }

  /**
   * Show the add/edit model modal.
   * @param {Object} [model] - Existing model for editing.
   */
  function showModal(model) {
    var overlay = document.getElementById('modal-overlay');
    var title = document.getElementById('modal-title');
    var nameInput = document.getElementById('model-name-input');
    var urlInput = document.getElementById('model-url-input');
    var keyInput = document.getElementById('model-key-input');
    var idInput = document.getElementById('model-id-input');
    var presetSelect = document.getElementById('model-preset-select');
    var thinkingInput = document.getElementById('model-thinking-input');
    var visionInput = document.getElementById('model-vision-input');

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

    overlay.classList.remove('hidden');
    nameInput.focus();
  }

  /**
   * Hide the modal dialog.
   */
  function hideModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    editingModelId = null;
  }

  /**
   * Save model from the modal form.
   */
  function saveModelFromModal() {
    var name = document.getElementById('model-name-input').value.trim();
    var apiUrl = document.getElementById('model-url-input').value.trim();
    var apiKey = document.getElementById('model-key-input').value.trim();
    var model = document.getElementById('model-id-input').value.trim();
    var thinkingInput = document.getElementById('model-thinking-input');
    var thinking = thinkingInput ? thinkingInput.checked : false;
    var visionInput = document.getElementById('model-vision-input');
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
    hideModal();
    showToast(editingModelId ? '模型已更新' : '模型已添加', 'success');
  }

  /**
   * Test all configured models.
   */
  async function testAllModels() {
    if (currentModels.length === 0) {
      showToast('请先添加模型', 'error');
      return;
    }

    var testBtn = document.getElementById('test-all');
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="testing-indicator"></span>测试中...';

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
              model: m.model
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
   * Save configuration to chrome.storage.
   * 保存前先做 dirty check：模型与设置项均无实际变更时不写存储、不递增版本号，
   * 避免"未修改任何配置却点确认"导致旧快照覆盖其他窗口刚保存的配置。
   */
  function saveConfig() {
    var timeoutInput = document.getElementById('timeout-input');
    var timeoutVal = parseInt(timeoutInput ? timeoutInput.value : '120', 10);
    if (isNaN(timeoutVal) || timeoutVal < 30) timeoutVal = 30;
    if (timeoutVal > 600) timeoutVal = 600;

    var selToggle = document.getElementById('selection-toggle');
    var selEnabled = selToggle ? selToggle.checked : true;

    var langSelect = document.getElementById('lang-select');
    var langVal = langSelect ? langSelect.value : 'en-zh';

    // dirty check：对比当前配置与打开时加载的快照
    var modelsChanged = stringifyModelsForCompare(currentModels) !== loadedModelsSnapshot;
    var settingsChanged = loadedSettingsSnapshot !== JSON.stringify({
      language: langVal,
      timeout: timeoutVal,
      selectionTranslate: selEnabled
    });
    if (!modelsChanged && !settingsChanged) {
      showToast('配置未变更，无需保存', 'info');
      return;
    }

    sendConfigToStorage(false, {
      models: currentModels,
      language: langVal,
      timeout: timeoutVal,
      selectionTranslate: selEnabled
    });
  }

  /**
   * Send the saveConfig message to the background worker with conflict detection.
   * @param {boolean} force - true 表示用户已确认强制覆盖其他窗口的修改。
   * @param {Object} configData - { models, language, timeout, selectionTranslate }
   */
  function sendConfigToStorage(force, configData) {
    chrome.runtime.sendMessage({
      type: 'saveConfig',
      data: Object.assign({}, configData, {
        baseVersion: loadedConfigVersion,
        force: !!force
      })
    }, function (response) {
      if (response && response.conflict) {
        var overwrite = window.confirm(
          '检测到配置已在其他窗口/页面修改并保存。\n\n' +
          '【确定】用当前窗口的配置覆盖（其他窗口的修改将丢失）\n' +
          '【取消】放弃本次修改，并加载最新配置'
        );
        if (overwrite) {
          sendConfigToStorage(true, configData);
        } else {
          loadConfig();
          showToast('已放弃本次修改，加载最新配置', 'info');
        }
        return;
      }
      if (response && response.success) {
        // 保存成功后同步本地版本号与快照，避免后续保存误报冲突/误判变更
        loadedConfigVersion = response.configVersion != null ? response.configVersion : loadedConfigVersion;
        loadedModelsSnapshot = stringifyModelsForCompare(configData.models || []);
        loadedSettingsSnapshot = JSON.stringify({
          language: configData.language,
          timeout: configData.timeout,
          selectionTranslate: configData.selectionTranslate
        });
        showToast('配置已保存', 'success');
      } else {
        showToast('保存失败', 'error');
      }
    });
  }

  /**
   * Show a toast notification.
   * @param {string} message - The message to display.
   * @param {string} type - 'error' or 'success'.
   */
  function showToast(message, type) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast toast-' + type + ' show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2500);
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
})();