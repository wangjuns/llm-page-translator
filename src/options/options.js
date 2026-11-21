import {
  DEFAULT_CONFIG,
  TARGET_LANGS,
  getConfig,
  getSyncUsage,
  saveConfig
} from '../shared/config.js';

const $ = (id) => document.getElementById(id);
const CUSTOM_LANG = '__custom__';

let dirty = false;
let current = null;

init();

async function init() {
  buildLangOptions();
  bindEvents();
  await load();
  await refreshSyncUsage();
  watchSyncChanges();
}

function buildLangOptions() {
  const select = $('targetLang');
  select.innerHTML =
    TARGET_LANGS.map((lang) => `<option value="${lang}">${lang}</option>`).join('') +
    `<option value="${CUSTOM_LANG}">自定义…</option>`;
}

function bindEvents() {
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('clear-cache').addEventListener('click', clearCache);
  $('reset-params').addEventListener('click', resetParams);
  $('toggleKey').addEventListener('click', toggleKeyVisibility);
  $('targetLang').addEventListener('change', syncCustomLangField);
  $('storeKeyLocally').addEventListener('change', updateKeyHint);
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function load() {
  current = await getConfig();
  fillForm(current);
  dirty = false;
  updateKeyHint();
}

function fillForm(cfg) {
  $('endpoint').value = cfg.endpoint || '';
  $('apiKey').value = cfg.apiKey || '';
  $('model').value = cfg.model || '';
  $('extraHeaders').value = cfg.extraHeaders || '';
  $('extraBody').value = cfg.extraBody || '';
  $('sourceLang').value = cfg.sourceLang || '自动检测';
  $('temperature').value = cfg.temperature;
  $('maxTokens').value = cfg.maxTokens;
  $('batchChars').value = cfg.batchChars;
  $('concurrency').value = cfg.concurrency;
  $('timeoutMs').value = cfg.timeoutMs;
  $('systemPrompt').value = cfg.systemPrompt || '';
  $('displayMode').value = cfg.displayMode;
  $('autoRestore').checked = Boolean(cfg.autoRestore);
  $('storeKeyLocally').checked = Boolean(cfg.storeKeyLocally);

  if (TARGET_LANGS.includes(cfg.targetLang)) {
    $('targetLang').value = cfg.targetLang;
    $('customLang').value = '';
  } else {
    $('targetLang').value = CUSTOM_LANG;
    $('customLang').value = cfg.targetLang || '';
  }
  syncCustomLangField();
}

function syncCustomLangField() {
  $('custom-lang-field').hidden = $('targetLang').value !== CUSTOM_LANG;
}

function markDirty() {
  dirty = true;
}

function collect() {
  const targetLang =
    $('targetLang').value === CUSTOM_LANG
      ? $('customLang').value.trim()
      : $('targetLang').value.trim();
  return {
    endpoint: $('endpoint').value.trim(),
    apiKey: $('apiKey').value,
    model: $('model').value.trim(),
    targetLang,
    sourceLang: $('sourceLang').value.trim() || DEFAULT_CONFIG.sourceLang,
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value),
    batchChars: Number($('batchChars').value),
    concurrency: Number($('concurrency').value),
    timeoutMs: Number($('timeoutMs').value),
    extraHeaders: $('extraHeaders').value.trim(),
    extraBody: $('extraBody').value.trim(),
    systemPrompt: $('systemPrompt').value,
    displayMode: $('displayMode').value,
    autoRestore: $('autoRestore').checked,
    storeKeyLocally: $('storeKeyLocally').checked
  };
}

function validate(cfg) {
  if (!cfg.endpoint) return '请填写 endpoint';
  try {
    const url = new URL(cfg.endpoint);
    if (!/^https?:$/.test(url.protocol)) return 'endpoint 必须是 http(s) 地址';
  } catch {
    return 'endpoint 不是合法的 URL';
  }
  if (!cfg.model) return '请填写模型 ID';
  if (!cfg.targetLang) return '请选择或填写目标语言';
  if (!Number.isFinite(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 2) {
    return '温度需要在 0–2 之间';
  }
  if (!Number.isFinite(cfg.maxTokens) || cfg.maxTokens < 0) return '最大输出 tokens 不合法';
  if (!Number.isFinite(cfg.batchChars) || cfg.batchChars < 200) return '每次请求字符上限至少 200';
  if (!Number.isFinite(cfg.concurrency) || cfg.concurrency < 1) return '并发请求数至少为 1';
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 5000) return '超时至少 5000 毫秒';
  for (const [name, raw] of [
    ['额外请求头', cfg.extraHeaders],
    ['额外请求参数', cfg.extraBody]
  ]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return `${name}必须是 JSON 对象`;
      }
    } catch {
      return `${name}不是合法 JSON`;
    }
  }
  return '';
}

async function save() {
  hideStatus();
  const patch = collect();
  const problem = validate(patch);
  if (problem) {
    showStatus(problem, 'error');
    return;
  }
  $('save').disabled = true;
  try {
    const saved = await saveConfig(patch);
    current = saved;
    fillForm(saved);
    dirty = false;
    updateKeyHint();
    await refreshSyncUsage();
    showStatus(
      saved.storeKeyLocally
        ? '已保存。API Key 仅写入本机；其余配置随 Chrome 同步。'
        : '已保存，配置会随 Chrome 同步到其他设备。',
      'ok'
    );
  } catch (err) {
    showStatus(`保存失败：${err?.message || err}`, 'error');
  } finally {
    $('save').disabled = false;
  }
}

async function test() {
  hideStatus();
  const cfg = collect();
  const problem = validate(cfg);
  if (problem) {
    showStatus(problem, 'error');
    return;
  }
  const button = $('test');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'llmt:test', config: cfg });
    if (!response?.ok) throw new Error(response?.error || '测试失败');
    const result = response.result || {};
    showStatus(
      `连接成功（${result.ms} ms）\n模型：${result.model || cfg.model}\n原文：${result.sample}\n译文：${result.translation}`,
      'ok'
    );
  } catch (err) {
    showStatus(`连接失败：${err?.message || err}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function clearCache() {
  if (!window.confirm('清空所有本地译文与页面缓存？已翻译的页面需要重新请求模型。')) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'llmt:clear-cache' });
    if (!response?.ok) throw new Error(response?.error || '清理失败');
    await refreshSyncUsage();
    showStatus(`已清理 ${response.removed ?? 0} 条缓存。`, 'ok');
  } catch (err) {
    showStatus(`清理失败：${err?.message || err}`, 'error');
  }
}

function resetParams() {
  $('temperature').value = DEFAULT_CONFIG.temperature;
  $('maxTokens').value = DEFAULT_CONFIG.maxTokens;
  $('batchChars').value = DEFAULT_CONFIG.batchChars;
  $('concurrency').value = DEFAULT_CONFIG.concurrency;
  $('timeoutMs').value = DEFAULT_CONFIG.timeoutMs;
  $('systemPrompt').value = '';
  $('extraHeaders').value = '';
  $('extraBody').value = '';
  $('displayMode').value = DEFAULT_CONFIG.displayMode;
  $('autoRestore').checked = DEFAULT_CONFIG.autoRestore;
  dirty = true;
  showStatus('已填入默认翻译参数（服务配置保持不变），点击「保存设置」生效。', 'ok');
}

function toggleKeyVisibility() {
  const input = $('apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
}

function updateKeyHint() {
  const local = $('storeKeyLocally').checked;
  $('key-hint').textContent = local
    ? 'Key 只写入 chrome.storage.local，不随 Chrome 同步；换设备需要重新填写。'
    : 'Key 会随 Chrome 同步（Chrome 同步数据在服务端加密，建议开启同步密码短语）。';
}

async function refreshSyncUsage() {
  const { bytes, quota } = await getSyncUsage();
  $('sync-usage').textContent = `Chrome 同步空间占用：${formatBytes(bytes)} / ${formatBytes(quota)}`;
  $('sync-badge').textContent = $('storeKeyLocally').checked
    ? 'Key 仅本机'
    : '配置随 Chrome 同步';
}

function watchSyncChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.config || dirty) return;
    load().then(() => showStatus('配置已从其他设备同步，页面已刷新。', 'ok'));
    refreshSyncUsage();
  });
}

function showStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hideStatus() {
  $('status').hidden = true;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
