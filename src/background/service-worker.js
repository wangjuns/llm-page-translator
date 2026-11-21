/**
 * Service worker：注入内容脚本、调度翻译、读写缓存、右键菜单 / 快捷键入口。
 */

import { getConfig, normalizeConfig } from '../shared/config.js';
import { chatEndpoint, groupByChars, testConnection, translateTexts } from './llm.js';
import * as cache from './cache.js';

const CONTENT_SCRIPTS = [
  'src/content/extract.js',
  'src/content/render.js',
  'src/content/main.js'
];
const CONTENT_CSS = 'src/content/content.css';
const PORT_NAME = 'llmt';
const MENU_ID = 'llmt-translate-page';


/* ---------------------------------- 消息 ---------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('llmt:')) return false;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: friendlyError(err), detail: err?.detail || '' }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'llmt:toggle':
    case 'llmt:start': {
      const tab = await resolveTab(message.tabId ?? sender?.tab?.id);
      assertTranslatable(tab);
      await ensureContent(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        type: message.type === 'llmt:start' ? 'llmt:start' : 'llmt:toggle',
        options: message.options || {}
      });
      return { tabId: tab.id };
    }
    case 'llmt:clear': {
      const tab = await resolveTab(message.tabId ?? sender?.tab?.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'llmt:clear' }).catch(() => {});
      return { tabId: tab.id };
    }
    case 'llmt:set-mode': {
      const tab = await resolveTab(message.tabId ?? sender?.tab?.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'llmt:mode', mode: message.mode }).catch(() => {});
      return { tabId: tab.id };
    }
    case 'llmt:test': {
      const base = await getConfig();
      const cfg = normalizeConfig({ ...base, ...(message.config || {}) });
      if (!cfg.endpoint) throw new Error('请先填写 endpoint');
      if (!cfg.model) throw new Error('请先填写模型 ID');
      const controller = new AbortController();
      const result = await testConnection(cfg, controller.signal);
      return { result, endpoint: chatEndpoint(cfg.endpoint) };
    }
    case 'llmt:stats':
      return { stats: await cache.getCacheStats() };
    case 'llmt:clear-cache':
      return { removed: await cache.clearCache() };
    case 'llmt:open-options':
      await chrome.runtime.openOptionsPage();
      return {};
    default:
      throw new Error(`未知消息：${message.type}`);
  }
}

/* --------------------------------- 翻译任务 -------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controller = new AbortController();
  const tabId = port.sender?.tab?.id;
  let running = false;

  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'cancel') {
      controller.abort();
      return;
    }
    if (message.type !== 'translate' || running) return;
    running = true;
    runJob(port, message, controller, tabId)
      .catch((err) => {
        if (isAbort(err)) {
          post(port, { type: 'cancelled' });
          return;
        }
        post(port, { type: 'error', message: friendlyError(err), status: err?.status || 0 });
      })
      .finally(() => {
        running = false;
        setBadge(tabId, '');
      });
  });
});

async function runJob(port, job, controller, tabId) {
  const started = Date.now();
  const cfg = await getConfig();
  if (!cfg.endpoint) throw new Error('尚未配置 LLM：请先在设置中填写 endpoint');
  if (!cfg.model) throw new Error('尚未配置 LLM：请先在设置中填写模型 ID');

  const items = (Array.isArray(job.blocks) ? job.blocks : []).filter(
    (item) => item && typeof item.text === 'string' && item.text.trim()
  );
  if (!items.length) throw new Error('没有找到可翻译的正文');

  const total = items.length;
  post(port, {
    type: 'meta',
    total,
    model: cfg.model,
    endpoint: chatEndpoint(cfg.endpoint),
    targetLang: cfg.targetLang
  });
  setBadge(tabId, '0%');

  const keyed = await Promise.all(
    items.map(async (item) => ({ ...item, key: await cache.segmentKey(item.text, cfg) }))
  );
  const cachedMap = await cache.getSegments(keyed.map((item) => item.key));

  const translations = new Map();
  const hits = [];
  const pending = [];
  for (const item of keyed) {
    const hit = cachedMap[item.key];
    if (typeof hit === 'string') {
      translations.set(item.i, hit);
      hits.push({ i: item.i, text: hit });
    } else {
      pending.push(item);
    }
  }
  sendBatches(port, hits);

  const groups = groupByChars(pending, cfg.batchChars);
  let done = hits.length;
  let translated = 0;
  let failed = 0;
  post(port, { type: 'progress', done, total });

  const groupsWithIndex = groups.map((group, index) => ({ group, index }));
  const concurrency = Math.max(1, Math.min(cfg.concurrency, groupsWithIndex.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < groupsWithIndex.length) {
      const current = groupsWithIndex[cursor++];
      if (controller.signal.aborted) return;
      const group = current.group;
      try {
        const result = await translateTexts(group.map((item) => item.text), cfg, controller.signal);
        const patch = {};
        const out = [];
        group.forEach((item, idx) => {
          const text = String(result[idx] ?? '');
          translations.set(item.i, text);
          patch[item.key] = text;
          out.push({ i: item.i, text });
        });
        await cache.setSegments(patch);
        translated += group.length;
        post(port, { type: 'batch', items: out });
      } catch (err) {
        if (isAbort(err)) return;
        failed += group.length;
        post(port, {
          type: 'failed',
          items: group.map((item) => item.i),
          message: friendlyError(err)
        });
      } finally {
        done += group.length;
        const percent = Math.round((done / total) * 100);
        post(port, { type: 'progress', done, total });
        setBadge(tabId, `${percent}%`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

  if (job.url && translations.size) {
    const entries = [];
    for (const item of items) {
      const translation = translations.get(item.i);
      if (translation) entries.push([item.text, translation]);
    }
    await cache.savePage({
      url: job.url,
      title: job.title || '',
      entries,
      signature: cache.pageSignature(cfg)
    });
  }

  post(port, {
    type: 'done',
    stats: { total, cached: hits.length, translated, failed, ms: Date.now() - started }
  });
  setBadge(tabId, '');
  cache.pruneIfNeeded().catch(() => {});
}

function sendBatches(port, items) {
  for (let i = 0; i < items.length; i += 30) {
    post(port, { type: 'batch', items: items.slice(i, i + 30) });
  }
}

/* -------------------------------- 页面注入 -------------------------------- */

async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'llmt:ping' });
    if (pong?.ok) return;
  } catch {
    /* 尚未注入，继续 */
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
  } catch (err) {
    throw new Error(`无法在此页面注入脚本：${err?.message || err}`);
  }
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'llmt:ping' });
  if (!pong?.ok) throw new Error('内容脚本注入失败');
}

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('找不到当前标签页');
  return tab;
}

function assertTranslatable(tab) {
  const url = tab?.url || '';
  if (/^(https?|file):/i.test(url)) return;
  throw new Error('浏览器内部页面（chrome://、扩展商店等）不支持翻译');
}

/* -------------------------------- 入口注册 -------------------------------- */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '翻译此页正文（LLM）',
      contexts: ['page', 'selection']
    });
  });
  if (reason === 'install') chrome.runtime.openOptionsPage();
  cache.pruneIfNeeded().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  startOnTab(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) startOnTab(tab.id);
});

chrome.runtime.onStartup.addListener(() => {
  cache.pruneIfNeeded().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab?.url;
  if (!url || !/^https?:/i.test(url)) return;
  try {
    const cfg = await getConfig();
    if (!cfg.autoRestore) return;
    const page = await cache.getPage(url, cache.pageSignature(cfg));
    if (!page || !page.entries.size) return;
    await ensureContent(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: 'llmt:restore',
      page: {
        url: page.url,
        title: page.title,
        entries: Array.from(page.entries)
      }
    });
  } catch {
    /* 页面不可注入等情况直接忽略 */
  }
});

async function startOnTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    assertTranslatable(tab);
    await ensureContent(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'llmt:toggle' });
  } catch (err) {
    setBadge(tabId, '!');
    setTimeout(() => setBadge(tabId, ''), 3000);
    console.warn('[LLMT]', friendlyError(err));
  }
}

/* --------------------------------- 工具 --------------------------------- */

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    /* 端口已断开 */
  }
}

function setBadge(tabId, text) {
  if (!Number.isInteger(tabId)) return;
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#6558f5' });
    chrome.action.setBadgeText({ tabId, text: text || '' });
  } catch {
    /* ignore */
  }
}

function isAbort(err) {
  return err?.name === 'AbortError' || err?.message === 'Aborted';
}

function friendlyError(err) {
  if (!err) return '未知错误';
  if (isAbort(err)) return '已取消';
  let message = err.message || String(err);
  if (err.detail) message += `\n${String(err.detail).slice(0, 200)}`;
  return message;
}
