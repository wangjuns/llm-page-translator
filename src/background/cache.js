/**
 * 本地缓存：
 * - 段级缓存：同一段原文 + 模型 + 目标语言只翻一次，刷新后可直接复用。
 * - 页面缓存：按 URL 记录整页译文，用于刷新后自动恢复（无需再点翻译）。
 *
 * 使用 chrome.storage.local（unlimitedStorage），不随 Chrome 同步。
 */

const SEG_PREFIX = 'seg:';
const PAGE_PREFIX = 'page:';
const LAST_PRUNE_KEY = 'cache:lastPrune';

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_THRESHOLD_BYTES = 40 * 1024 * 1024;
const KEEP_RATIO = 0.65;

const MAX_PAGE_ENTRIES = 400;
const MAX_PAGE_CHARS = 240000;
const MAX_PAGES = 40;

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function segmentKey(text, cfg) {
  const material = `${cfg.endpoint}\u0000${cfg.model}\u0000${cfg.targetLang}\u0000${text}`;
  return SEG_PREFIX + (await sha256Hex(material));
}

/** 批量读段缓存，返回 { [key]: translation } */
export async function getSegments(keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const found = await chrome.storage.local.get(chunk);
    for (const key of chunk) {
      const value = found[key];
      if (value && typeof value.t === 'string' && value.t.trim()) out[key] = value.t;
    }
  }
  return out;
}

/** 批量写段缓存 */
export async function setSegments(map) {
  const entries = Object.entries(map);
  if (!entries.length) return;
  const payload = {};
  const now = Date.now();
  for (const [key, value] of entries) {
    if (!value || !String(value).trim()) continue;
    payload[key] = { t: String(value), ts: now };
  }
  if (!Object.keys(payload).length) return;
  for (let i = 0; i < Object.keys(payload).length; i += 200) {
    const keys = Object.keys(payload).slice(i, i + 200);
    const chunk = {};
    for (const key of keys) chunk[key] = payload[key];
    await chrome.storage.local.set(chunk);
  }
}

/** 页面缓存的配置签名：模型 / endpoint / 目标语言变化时，旧翻译不再复用 */
export function pageSignature(cfg) {
  return `${cfg.endpoint}|${cfg.model}|${cfg.targetLang}`;
}

export async function getPage(url, signature = '') {
  if (!url) return null;
  const key = PAGE_PREFIX + (await sha256Hex(url));
  const found = (await chrome.storage.local.get(key))[key];
  if (!found || !Array.isArray(found.entries)) return null;
  if (signature && found.signature !== signature) return null;
  return {
    url: found.url,
    title: found.title || '',
    ts: found.ts || 0,
    entries: new Map(found.entries)
  };
}

export async function savePage({ url, title, entries, signature = '' }) {
  if (!url || !entries) return;
  const list = [];
  let chars = 0;
  for (const [text, translation] of entries) {
    if (!text || !translation) continue;
    chars += text.length + translation.length;
    if (chars > MAX_PAGE_CHARS || list.length >= MAX_PAGE_ENTRIES) break;
    list.push([text, translation]);
  }
  if (!list.length) return;
  const key = PAGE_PREFIX + (await sha256Hex(url));
  await chrome.storage.local.set({
    [key]: { url, title: title || '', ts: Date.now(), entries: list, signature }
  });
  await prunePages();
}

export async function deletePage(url) {
  if (!url) return;
  const key = PAGE_PREFIX + (await sha256Hex(url));
  await chrome.storage.local.remove(key);
}

async function prunePages() {
  const keys = await listKeys(PAGE_PREFIX);
  if (keys.length <= MAX_PAGES) return;
  const found = await chrome.storage.local.get(keys);
  const pages = keys
    .map((key) => ({ key, ts: found[key]?.ts || 0 }))
    .sort((a, b) => b.ts - a.ts);
  const remove = pages.slice(MAX_PAGES).map((page) => page.key);
  if (remove.length) await chrome.storage.local.remove(remove);
}

async function listKeys(prefix) {
  try {
    const keys = await chrome.storage.local.getKeys();
    return keys.filter((key) => key.startsWith(prefix));
  } catch {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((key) => key.startsWith(prefix));
  }
}

export async function getCacheStats() {
  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    /* ignore */
  }
  const pages = (await listKeys(PAGE_PREFIX)).length;
  const segments = (await listKeys(SEG_PREFIX)).length;
  return { bytes, pages, segments };
}

export async function clearCache() {
  const keys = [...(await listKeys(SEG_PREFIX)), ...(await listKeys(PAGE_PREFIX))];
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove(LAST_PRUNE_KEY);
  return keys.length;
}

/** 缓存超过阈值时按时间清掉一部分旧数据（最多每 6 小时一次） */
export async function pruneIfNeeded() {
  const last = Number((await chrome.storage.local.get(LAST_PRUNE_KEY))[LAST_PRUNE_KEY] || 0);
  if (Date.now() - last < PRUNE_INTERVAL_MS) return;
  await chrome.storage.local.set({ [LAST_PRUNE_KEY]: Date.now() });

  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    return;
  }
  if (bytes < PRUNE_THRESHOLD_BYTES) return;

  const keys = await listKeys(SEG_PREFIX);
  if (keys.length < 100) return;
  const found = await chrome.storage.local.get(keys);
  const ordered = keys
    .map((key) => ({ key, ts: found[key]?.ts || 0 }))
    .sort((a, b) => a.ts - b.ts);
  const remove = ordered
    .slice(0, Math.max(1, Math.floor(ordered.length * (1 - KEEP_RATIO))))
    .map((item) => item.key);
  if (remove.length) await chrome.storage.local.remove(remove);
}
