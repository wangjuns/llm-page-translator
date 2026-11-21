# 项目约定（LLM 网页翻译 Chrome 扩展）

## 这是什么

Manifest V3 Chrome 扩展，无构建步骤、无运行时依赖：源码即产物，`chrome://extensions` 直接「加载已解压的扩展程序」即可。

## 常用命令

```bash
npm test          # 单元测试（node:test，纯 Node，无需浏览器）
npm run check     # 语法 + JSON 校验（scripts/syntax-check.mjs）
npm run test:e2e  # Playwright + 真实 Chromium + 假 LLM 端到端（需 CHROMIUM_PATH 或已装 chromium）
node tests/screenshots.mjs   # 重新生成 docs/screenshots（改 UI 后跑）
```

## 目录 / 数据流

- `src/background/service-worker.js`：消息路由（popup/options → 注入 → content）、`onConnect('llmt')` 翻译任务、`tabs.onUpdated` 自动恢复、右键菜单、快捷键。
- `src/background/llm.js`：纯 fetch 的 OpenAI 兼容层；`parseTranslations` / `groupByChars` / `translateTexts` 可在 Node 直接测试。
- `src/background/cache.js`：`seg:` 段缓存、`page:` 页面缓存（带配置签名）、清理。
- `src/content/extract.js` → `render.js` → `main.js`：按此顺序注入，每个文件都是 IIFE + `window.__llmtXxx` 全局 + 幂等 guard，重复注入安全。
- `src/shared/config.js`：配置默认值唯一来源（`DEFAULT_CONFIG`），service worker / popup / options 共用。
- UI 全部中文；样式：行内译文用 `chrome.scripting.insertCSS` 注入（绕过页面 CSP），状态条/阅读器在 shadow DOM 内用 `adoptedStyleSheets`。

## 硬约束 / 坑

- **不要再给自动恢复加长时间 dedupe**：曾用 8 秒窗口按 URL 去重，导致翻译后 8 秒内刷新不恢复。重复的 `complete` 事件本身是幂等的（render 前会 clear），去重只允许毫秒级。
- 内容脚本里不能用 ES module `import`；与后台只能通过 `chrome.runtime.connect` 端口通信。端口断开时 service worker 会中止任务。
- `chrome.storage.sync` 单 item 上限 8KB、总 100KB；API Key 默认进 sync，用户可切换为 `localSecrets`（`storeKeyLocally`）。保存配置统一走 `saveConfig()`，不要手写 storage 逻辑。
- 缓存 key 含 endpoint/model/targetLang；页面缓存还存 `signature`，模型或语言变了要失效，否则刷新会显示旧模型的译文。
- 行内译文块插入规则：`LI/DT/DD/TD/TH` 追加到元素内部，其余块插到元素后面（`p` 里不能放 `div`）。
- 阅读器打开时隐藏状态条（`readerOpen` 里 `bar.hidden = true`），`setStatus` 在 reader 打开时不再强行显示状态条。
- popup 是真实弹窗时 `chrome.tabs.query({active:true,currentWindow:true})` 才是目标页；e2e 里 popup 作为普通标签页，因此通过消息显式传 `tabId`（后台同时支持两者）。
- 官方 Chrome 137+ 不再支持 `--load-extension`；e2e 使用 Playwright 的 Chrome for Testing。改测试启动参数时保持 `--disable-extensions-except` + `--load-extension`。
- 自动恢复会向任意 URL 注入，依赖 `<all_urls>` host 权限；新增权限需同步更新 README 的权限表。
