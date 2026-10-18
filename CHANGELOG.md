# 更新日志

本文件记录 translator-plugs 的版本变更。

> **关于 v1.1.2 – v1.1.10**：这批版本长期只在本地工作区演进，未逐版本提交 / 打 tag / 发布 Release，
> 因此无法精确还原「每个版本对应哪些改动」。下文按「可确认的版本」与「无法精确对应到单个版本的累积改动」分别列出。

## v1.1.10

### Bug 修复

- 修复整页翻译会把模型回显的字面转义（`\n`、`\t`、`\"` 等）直接显示在页面上的问题
  - **根因**：后台按 `JSON.stringify(texts)` 发送待翻译文本，文本节点里真实的换行 / 制表符在 JSON 中变成字面量 `\n` / `\t`，模型会原样回显这些转义
  - **修复**：新增 `decodeModelEscapeSequences`，整页替换模式写入 DOM 前统一解码（对照模式行为保持不变）

## v1.1.9

### Bug 修复

- 修复 Hugging Face 模型页 README 中间整块漏译的问题
  - **根因**：流式翻译通道不校验覆盖率，模型漏返回若干行也会被判定为「已完成」
  - **修复**：`translateBatchStream` 增加覆盖率复检 + 缺失子集重试（最多 2 次）

## v1.1.8

### Bug 修复

- 修复 GitHub PR 页整页翻译卡死在「翻译中」、之后点击按钮只被当成取消的问题
  - **根因**：`HTMLFormElement` 具名属性访问使 `el.id` 返回子元素对象（非字符串），`startsWith` 抛 TypeError，在文本采集阶段中断，翻译状态被永久卡住
  - **修复**：新增 `getElementIdAttr` 安全读取 id 属性；新增 `recoverFromTranslateError` 做异常兜底，异常时恢复按钮状态与进度条

## v1.1.2 – v1.1.7

以下改动在此期间累积（无法精确对应到单个版本）：

- **配置面板多窗口并发安全**：面板锁（含心跳续约）、保存时的乐观锁冲突检测、无实际变更时不写存储的 dirty check
- **划词翻译**：自动识别翻译方向
- **单词 / 汉字翻译**：模板复读检测与自动重试，提升生僻字场景的成功率
- **后台能力**：新增文本查词处理（`handleLookupText`）
- **其余健壮性与交互改进**

## v1.1.1

### Bug 修复

- 修复同一父元素下多个文本子节点只有第一个被翻译的问题
  - **根因**：`collectTextNodesRecursive` 在 parent 元素上设置 `data-translator-id` 标记，导致同一 parent 的后续文本子节点被误拒
  - **修复**：改用 `WeakSet` 跟踪文本节点本身，确保所有文本节点都能被正确收集

## v1.1.0

### 新增功能

- 版本更新自动检查：每 24 小时检查 GitHub 最新 Release
- 桌面通知提示：发现新版本时弹出系统通知，点击跳转下载页
- 红点徽章提醒：浮动面板右下角显示红色脉冲圆点
- 更新日志展示：配置面板显示当前版本、最新版本与 Markdown 渲染的 release notes
- 「忽略此版本」：可选择忽略某个版本的重复提示

### 改进

- 版本号改为从 `chrome.runtime.getManifest().version` 动态获取，不再硬编码
- 使用 `chrome.alarms` API 替代 `setInterval`，确保 service worker 被杀死后仍能定时检查

## v1.0.0

- 首个版本：整页翻译、对照翻译、划词翻译、单词翻译、PIC 图片 / PDF 翻译（需多模态模型）、双默认模型、流式翻译、多语言方向（英→中 / 中→英）、Thinking 模式开关
- API Key 仅存储于本地 `chrome.storage`；`postMessage` 使用 origin 白名单校验；翻译卡片渲染做 HTML 转义 + 链接协议白名单；外链加 `rel=noopener noreferrer`
