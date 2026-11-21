import { getConfig, saveConfig, isConfigured } from '../shared/config.js';

const $ = (id) => document.getElementById(id);
let config = null;
let activeTab = null;

init();

async function init() {
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `v${manifest.version} · 正文整页翻译`;
  bindEvents();
  config = await getConfig();
  renderConfig();
  renderMode();
  await loadTab();
  refreshStats();
}

function bindEvents() {
  $('translate').addEventListener('click', translateCurrent);
  $('settings').addEventListener('click', openOptions);
  $('config-line').addEventListener('click', openOptions);
  $('clear').addEventListener('click', clearPage);
  $('clear-cache').addEventListener('click', clearCache);
  document.querySelectorAll('.seg button').forEach((button) => {
    button.addEventListener('click', () => switchMode(button.dataset.mode));
  });
}

function renderConfig() {
  const line = $('config-line');
  const text = $('config-text');
  if (isConfigured(config)) {
    line.classList.add('ok');
    const host = safeHost(config.endpoint);
    text.textContent = `${config.model} · ${host}`;
    line.title = `${config.endpoint}\n${config.storeKeyLocally ? 'API Key 仅保存在本机' : 'API Key 随 Chrome 同步'}`;
    $('translate').disabled = false;
  } else {
    line.classList.remove('ok');
    text.textContent = '未配置 LLM 服务，点击设置';
    line.title = '需要填写 endpoint 与模型 ID';
    $('translate').disabled = false;
  }
}

function renderMode() {
  document.querySelectorAll('.seg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === config.displayMode);
  });
}

async function loadTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    if (!tab) return;
    const supported = /^(https?|file):/i.test(tab.url || '');
    $('translate').disabled = !supported;
    if (!supported) {
      showMessage('当前页面不支持翻译（浏览器内部页面）');
    } else {
      hideMessage();
      $('translate').disabled = false;
    }
  } catch {
    activeTab = null;
  }
}

async function translateCurrent() {
  setBusy(true);
  hideMessage();
  try {
    const tab = activeTab || (await getActiveTab());
    if (!tab) throw new Error('找不到当前标签页');
    if (!/^(https?|file):/i.test(tab.url || '')) {
      throw new Error('浏览器内部页面不支持翻译');
    }
    await send({ type: 'llmt:toggle', tabId: tab.id });
    setTimeout(() => window.close(), 120);
  } catch (err) {
    showMessage(err?.message || String(err));
    setBusy(false);
  }
}

async function clearPage() {
  try {
    const tab = activeTab || (await getActiveTab());
    if (tab) await send({ type: 'llmt:clear', tabId: tab.id });
    showMessage('已移除页面上的译文');
  } catch (err) {
    showMessage(err?.message || String(err));
  }
}

async function switchMode(mode) {
  config = await saveConfig({ displayMode: mode === 'reader' ? 'reader' : 'bilingual' });
  renderMode();
  try {
    const tab = activeTab || (await getActiveTab());
    if (tab) await send({ type: 'llmt:set-mode', tabId: tab.id, mode: config.displayMode });
  } catch {
    /* 页面还没注入内容脚本时忽略 */
  }
}

async function clearCache() {
  if (!window.confirm('清空所有本地译文缓存？已翻译的页面需要重新请求模型。')) return;
  try {
    const result = await send({ type: 'llmt:clear-cache' });
    showMessage(`已清理 ${result.removed ?? 0} 条缓存`);
    await refreshStats();
  } catch (err) {
    showMessage(err?.message || String(err));
  }
}

async function refreshStats() {
  try {
    const { stats } = await send({ type: 'llmt:stats' });
    const size = formatBytes(stats?.bytes || 0);
    $('cache-info').textContent = `缓存 ${size} · ${stats?.pages || 0} 个页面`;
  } catch {
    $('cache-info').textContent = '缓存：读取失败';
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  return activeTab;
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('扩展后台未响应');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response;
}

function setBusy(busy) {
  const button = $('translate');
  button.disabled = busy;
  button.textContent = busy ? '处理中…' : '翻译当前页面';
}

function showMessage(text) {
  const el = $('msg');
  el.textContent = text;
  el.hidden = false;
}

function hideMessage() {
  $('msg').hidden = true;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
