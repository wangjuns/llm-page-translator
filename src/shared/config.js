/**
 * 配置层：所有上下文（service worker / popup / options）共用的读写逻辑。
 *
 * - 非敏感配置存 chrome.storage.sync，登录同一 Chrome 账号的设备自动同步。
 * - API Key 默认也随 sync 同步（用户可在设置里改为仅本机保存）。
 */

export const CONFIG_KEY = 'config';
export const SECRET_KEY = 'localSecrets';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  endpoint: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
  targetLang: '简体中文',
  sourceLang: '自动检测',
  temperature: 0.2,
  maxTokens: 4096,
  batchChars: 1800,
  concurrency: 2,
  timeoutMs: 90000,
  extraHeaders: '',
  extraBody: '',
  systemPrompt: '',
  displayMode: 'bilingual', // bilingual | reader
  autoRestore: true,
  storeKeyLocally: false
});

export const TARGET_LANGS = [
  '简体中文',
  '繁體中文',
  'English',
  '日本語',
  '한국어',
  'Français',
  'Deutsch',
  'Español',
  'Русский'
];

export async function getConfig() {
  let syncCfg = {};
  try {
    syncCfg = (await chrome.storage.sync.get(CONFIG_KEY))[CONFIG_KEY] || {};
  } catch (err) {
    console.warn('[LLMT] 读取 sync 配置失败，回退到默认值', err);
  }
  let localSecrets = {};
  try {
    localSecrets = (await chrome.storage.local.get(SECRET_KEY))[SECRET_KEY] || {};
  } catch {
    /* ignore */
  }
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...syncCfg });
  if (cfg.storeKeyLocally) {
    cfg.apiKey = localSecrets.apiKey || '';
  }
  return cfg;
}

export function normalizeConfig(cfg) {
  const out = { ...DEFAULT_CONFIG, ...cfg };
  out.endpoint = String(out.endpoint || '').trim();
  out.model = String(out.model || '').trim();
  out.apiKey = String(out.apiKey || '');
  out.targetLang = String(out.targetLang || DEFAULT_CONFIG.targetLang).trim();
  out.sourceLang = String(out.sourceLang || DEFAULT_CONFIG.sourceLang).trim();
  out.temperature = clampNumber(out.temperature, 0, 2, DEFAULT_CONFIG.temperature);
  out.maxTokens = Math.round(clampNumber(out.maxTokens, 0, 200000, DEFAULT_CONFIG.maxTokens));
  out.batchChars = Math.round(clampNumber(out.batchChars, 200, 12000, DEFAULT_CONFIG.batchChars));
  out.concurrency = Math.round(clampNumber(out.concurrency, 1, 6, DEFAULT_CONFIG.concurrency));
  out.timeoutMs = Math.round(clampNumber(out.timeoutMs, 5000, 600000, DEFAULT_CONFIG.timeoutMs));
  out.extraHeaders = String(out.extraHeaders || '');
  out.extraBody = String(out.extraBody || '');
  out.systemPrompt = String(out.systemPrompt || '');
  out.displayMode = out.displayMode === 'reader' ? 'reader' : 'bilingual';
  out.autoRestore = Boolean(out.autoRestore);
  out.storeKeyLocally = Boolean(out.storeKeyLocally);
  return out;
}

export function isConfigured(cfg) {
  return Boolean(cfg && cfg.endpoint && cfg.model);
}

/**
 * 合并保存配置。API Key 按 storeKeyLocally 决定进 sync 还是 local。
 * @param {object} patch 需要更新的字段
 */
export async function saveConfig(patch = {}) {
  const current = await getConfig();
  const next = normalizeConfig({ ...current, ...patch });

  const syncCfg = { ...next, apiKey: next.storeKeyLocally ? '' : next.apiKey };
  await chrome.storage.sync.set({ [CONFIG_KEY]: syncCfg });

  if (next.storeKeyLocally) {
    await chrome.storage.local.set({ [SECRET_KEY]: { apiKey: next.apiKey } });
  } else {
    await chrome.storage.local.remove(SECRET_KEY);
  }
  return next;
}

export async function getSyncUsage() {
  try {
    const bytes = await chrome.storage.sync.getBytesInUse(null);
    return { bytes, quota: chrome.storage.sync.QUOTA_BYTES };
  } catch {
    return { bytes: 0, quota: chrome.storage.sync.QUOTA_BYTES };
  }
}

export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 10) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
