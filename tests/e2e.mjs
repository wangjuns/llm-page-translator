/**
 * 端到端验证（真实 Chromium + 真实扩展 + 本地假 LLM 服务）：
 *
 * 1. 在设置页保存配置（并确认写入 chrome.storage.sync）
 * 2. 打开文章页，触发翻译（走 popup → background → content 的同一链路）
 * 3. 校验译文注入 DOM、请求参数、正文提取（导航/评论/代码块被排除）
 * 4. 刷新页面，验证译文从本地缓存自动恢复，且没有新的模型请求
 * 5. 切换到阅读器模式，校验浮层渲染
 * 6. 错误路径：错误 endpoint → 友好报错
 * 7. API Key 改存本机 → sync 中无 Key、local 中有 Key
 * 8. 清空缓存后刷新，确认不再自动恢复
 */

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, access, mkdir } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '..');
const FIXTURE = await readFile(path.join(here, 'fixtures/article.html'));
const SHOT_DIR = path.join(os.tmpdir(), 'llmt-e2e-shots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------- 测试服务 -------------------------------- */

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

async function startStaticServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/article.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/article.html`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function startMockLlm() {
  const state = { requests: 0, bodies: [], headers: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock: unknown path' } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.requests += 1;
    state.headers.push(req.headers);
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    state.bodies.push(parsed);
    const userMessage = parsed.messages?.find((m) => m.role === 'user')?.content || '{}';
    let segments = [];
    try {
      segments = JSON.parse(userMessage).segments || [];
    } catch {
      /* ignore */
    }
    const translations = segments.map((segment) => `【译】${segment}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-completion',
        model: parsed.model || 'mock-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ translations }) },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
      })
    );
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/* -------------------------------- 浏览器工具 ------------------------------- */

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const revisions = ['1255', '1243', '1237', '1234', '1228', '1223', '1217'];
  for (const revision of revisions) {
    const candidate = path.join(
      cache,
      `chromium-${revision}`,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  const bundled = chromium.executablePath();
  try {
    await access(bundled);
    return bundled;
  } catch {
    return undefined;
  }
}

/* ---------------------------------- 主流程 --------------------------------- */

const mock = await startMockLlm();
const site = await startStaticServer();
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'llmt-e2e-'));
await mkdir(SHOT_DIR, { recursive: true });

const checks = [];
function ok(name, detail = '') {
  checks.push({ name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

let context;
const pageErrors = [];

try {
  const executablePath = await findChromium();
  if (!executablePath) {
    throw new Error(
      '找不到可用的 Chromium。请设置 CHROMIUM_PATH，或运行 npx playwright install chromium。'
    );
  }
  console.log(`Chromium: ${executablePath}`);

  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling'
    ]
  });
  context.on('page', (page) => {
    page.on('pageerror', (err) => pageErrors.push(`${page.url()}: ${err.message}`));
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;
  ok('扩展加载', `id=${extensionId}`);

  async function evalSw(fn, arg) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await sw.evaluate(fn, arg);
      } catch (err) {
        lastError = err;
        await sleep(400);
      }
    }
    throw lastError;
  }

  /* 1. 设置页保存配置 */
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.fill('#endpoint', mock.url);
  await options.fill('#apiKey', 'test-key');
  await options.fill('#model', 'mock-model');
  await options.click('#save');
  await options.waitForSelector('#status.ok', { timeout: 8000 });
  const saveStatus = (await options.textContent('#status')) || '';
  assert.match(saveStatus, /已保存/);

  const savedConfig = await evalSw(async () => (await chrome.storage.sync.get('config')).config);
  assert.equal(savedConfig.endpoint, mock.url);
  assert.equal(savedConfig.model, 'mock-model');
  assert.equal(savedConfig.apiKey, 'test-key');
  assert.equal(savedConfig.displayMode, 'bilingual');
  await options.screenshot({ path: path.join(SHOT_DIR, 'options.png'), fullPage: false });
  ok('设置页保存配置并写入 chrome.storage.sync', `endpoint=${savedConfig.endpoint}`);

  /* 2. 打开文章页并触发翻译 */
  const article = await context.newPage();
  await article.goto(site.url, { waitUntil: 'load' });
  await article.bringToFront();

  const tabId = await evalSw(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, site.url);
  assert.ok(tabId, '未找到文章标签页');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForFunction(
    () => (document.getElementById('config-text')?.textContent || '').includes('mock-model'),
    { timeout: 6000 }
  );
  await popup.screenshot({ path: path.join(SHOT_DIR, 'popup.png'), fullPage: false });
  ok('popup 显示已配置的模型');

  const toggleResponse = await popup.evaluate(
    async (id) => chrome.runtime.sendMessage({ type: 'llmt:toggle', tabId: id }),
    tabId
  );
  assert.equal(toggleResponse.ok, true, toggleResponse.error);

  await article.waitForFunction(() => document.querySelectorAll('.llmt-tr').length > 0, {
    timeout: 25000
  });
  const status = await (async () => {
    const deadline = Date.now() + 25000;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await evalSw(async (id) => {
        try {
          return await chrome.tabs.sendMessage(id, { type: 'llmt:status' });
        } catch {
          return null;
        }
      }, tabId);
      if (latest?.status === 'done') return latest;
      await sleep(150);
    }
    throw new Error(`等待翻译完成超时，最后状态 ${JSON.stringify(latest)}`);
  })();
  ok('翻译任务完成', `total=${status.total} 段`);

  await article.waitForFunction(
    (total) => document.querySelectorAll('.llmt-tr').length === total,
    status.total,
    { timeout: 10000 }
  );
  const translations = await article.$$eval('.llmt-tr', (nodes) =>
    nodes.map((node) => node.textContent)
  );
  assert.equal(translations.length, status.total);
  assert.ok(translations.every((text) => text.startsWith('【译】')), '存在未按 mock 返回的译文');
  assert.ok(status.total >= 10, `提取到的段落过少：${status.total}`);
  ok('译文逐段注入 DOM', `${translations.length} 段，均来自模型返回`);

  /* 3. 请求参数与正文提取质量断言 */
  assert.ok(mock.state.requests >= 1, '没有向假 LLM 发起请求');
  assert.equal(mock.state.headers[0].authorization, 'Bearer test-key');
  assert.equal(mock.state.bodies[0].model, 'mock-model');
  assert.match(mock.state.bodies[0].messages[0].content, /简体中文/);
  const allTranslatedText = translations.join('\n');
  assert.ok(!allTranslatedText.includes('SolidStateCell'), '代码块不应被翻译');
  assert.ok(!allTranslatedText.includes('Comments (3)'), '评论区不应被翻译');
  assert.ok(!allTranslatedText.includes('Related stories'), '侧栏不应被翻译');
  assert.ok(allTranslatedText.includes('Solid-State Batteries') || allTranslatedText.includes('固态'));
  ok('请求携带 Authorization / model / 目标语言', `${mock.state.requests} 次批量请求`);
  ok('正文提取排除了代码块、评论区和侧栏');

  await sleep(800);
  await mkdir(SHOT_DIR, { recursive: true });
  await article.screenshot({ path: path.join(SHOT_DIR, 'bilingual.png'), fullPage: false });
  ok('截图：双语对照', path.join(SHOT_DIR, 'bilingual.png'));

  /* 4. 刷新后自动恢复（不再请求模型） */
  const requestsBeforeReload = mock.state.requests;
  await article.reload({ waitUntil: 'load' });
  await article.waitForFunction(
    (total) => document.querySelectorAll('.llmt-tr').length === total,
    status.total,
    { timeout: 25000 }
  );
  assert.equal(mock.state.requests, requestsBeforeReload, '刷新后不应重新请求模型');
  ok('刷新后自动恢复全部译文', `零新增请求，${status.total} 段来自本地缓存`);

  /* 5. 阅读器模式 */
  await popup.bringToFront();
  await popup.click('.seg button[data-mode="reader"]');
  await popup.waitForFunction(
    () => document.querySelector('.seg button[data-mode="reader"]')?.classList.contains('active'),
    { timeout: 5000 }
  );
  const modeConfig = await evalSw(async () => (await chrome.storage.sync.get('config')).config.displayMode);
  assert.equal(modeConfig, 'reader');
  ok('popup 切换显示模式并持久化到 sync');

  await popup.evaluate(
    async ({ id }) => chrome.runtime.sendMessage({ type: 'llmt:set-mode', tabId: id, mode: 'reader' }),
    { id: tabId }
  );
  await article.waitForSelector('#llmt-host .reader', { state: 'visible', timeout: 8000 });
  await article.waitForFunction(
    (total) => {
      const host = document.getElementById('llmt-host');
      const root = host?.shadowRoot;
      if (!root) return false;
      return root.querySelectorAll('.reader .item .dst:not(.pending)').length === total;
    },
    status.total,
    { timeout: 8000 }
  );
  const readerItems = await article.evaluate(() => {
    const root = document.getElementById('llmt-host')?.shadowRoot;
    return root ? root.querySelectorAll('.reader .item').length : 0;
  });
  assert.equal(readerItems, status.total);
  await sleep(900);
  await article.screenshot({ path: path.join(SHOT_DIR, 'reader.png'), fullPage: false });
  ok('阅读器浮层渲染全部译文', `${readerItems} 段`);

  const readerDark = await article.evaluate(
    () => document.documentElement.classList.contains('llmt-dark')
  );
  ok('主题检测完成', readerDark ? '跟随深色页面' : '浅色页面');

  /* 6. 刷新后按阅读器模式恢复 */
  await article.reload({ waitUntil: 'load' });
  await article.waitForSelector('#llmt-host .reader', { state: 'visible', timeout: 25000 });
  const restoredReaderItems = await article.evaluate(() => {
    const root = document.getElementById('llmt-host')?.shadowRoot;
    return root ? root.querySelectorAll('.reader .item').length : 0;
  });
  assert.equal(restoredReaderItems, status.total);
  ok('刷新后按阅读器模式自动恢复');

  await article.locator('#llmt-host .modebtn').click();
  await article.waitForFunction(
    () => {
      const root = document.getElementById('llmt-host')?.shadowRoot;
      const reader = root?.querySelector('.reader');
      return Boolean(reader?.hidden);
    },
    { timeout: 5000 }
  );
  await article.waitForFunction(
    (total) => document.querySelectorAll('.llmt-tr').length === total,
    status.total,
    { timeout: 5000 }
  );
  ok('阅读器内「双语」按钮切回行内模式');

  /* 7. 错误 endpoint 的友好报错 */
  await options.bringToFront();
  await options.fill('#endpoint', `http://127.0.0.1:${mock.port}/nope`);
  await options.click('#test');
  await options.waitForSelector('#status.error', { timeout: 20000 });
  const errorText = (await options.textContent('#status')) || '';
  assert.match(errorText, /404|接口路径不存在/);
  ok('错误 endpoint 返回可读报错', errorText.split('\n')[0]);

  await options.fill('#endpoint', mock.url);
  await options.click('#save');
  await options.waitForSelector('#status.ok', { timeout: 8000 });

  /* 8. API Key 仅本机保存 */
  await options.check('#storeKeyLocally');
  await options.click('#save');
  await options.waitForSelector('#status.ok', { timeout: 8000 });
  const secretSplit = await evalSw(async () => ({
    sync: (await chrome.storage.sync.get('config')).config,
    local: (await chrome.storage.local.get('localSecrets')).localSecrets
  }));
  assert.equal(secretSplit.sync.apiKey, '');
  assert.equal(secretSplit.local?.apiKey, 'test-key');
  ok('Key 本机保存：sync 不含 Key、local 含 Key');

  await options.uncheck('#storeKeyLocally');
  await options.click('#save');
  await options.waitForSelector('#status.ok', { timeout: 8000 });
  const syncedKey = await evalSw(async () => (await chrome.storage.sync.get('config')).config.apiKey);
  assert.equal(syncedKey, 'test-key');

  /* 9. 清空缓存后刷新不再自动恢复 */
  await popup.bringToFront();
  popup.on('dialog', (dialog) => dialog.accept());
  await popup.click('#clear-cache');
  await popup.waitForFunction(
    () => (document.getElementById('cache-info')?.textContent || '').includes('0 B'),
    { timeout: 10000 }
  );
  ok('清空本地缓存');

  await article.bringToFront();
  await article.reload({ waitUntil: 'load' });
  await sleep(2500);
  const afterClear = await article.$$eval('.llmt-tr', (nodes) => nodes.length);
  const readerAfterClear = await article.evaluate(() => {
    const root = document.getElementById('llmt-host')?.shadowRoot;
    return root ? root.querySelectorAll('.reader .item').length : 0;
  });
  assert.equal(afterClear, 0);
  assert.equal(readerAfterClear, 0);
  ok('清空缓存后刷新不再自动恢复');

  assert.deepEqual(pageErrors, [], `页面出现未捕获错误：\n${pageErrors.join('\n')}`);

  console.log(`\n全部通过：${checks.length} 项检查\n`);
} catch (err) {
  console.error('\n❌ E2E 失败');
  console.error(err);
  if (pageErrors.length) console.error('页面错误：\n' + pageErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await Promise.all([mock.close(), site.close()]);
  await rm(userDataDir, { recursive: true, force: true });
}
