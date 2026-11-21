/**
 * 内容脚本主流程：提取 → 建立到 service worker 的端口 → 边收边渲染 → 缓存恢复。
 */

(() => {
  if (window.__llmtMainLoaded) return;
  window.__llmtMainLoaded = true;

  const E = window.__llmtExtract;
  const R = window.__llmtRender;

  const state = {
    status: 'idle', // idle | running | done | stopped | error
    mode: 'bilingual',
    blocks: [],
    translations: new Map(),
    failed: new Set(),
    port: null,
    title: '',
    url: location.href,
    total: 0,
    done: 0,
    hideTimer: null
  };

  R.mount({
    onMode: () => {
      if (!state.blocks.length) return;
      setMode(state.mode === 'reader' ? 'bilingual' : 'reader');
    },
    onBarClose: () => {
      if (state.status === 'running') {
        stop('已停止');
      } else {
        clearAll();
      }
    },
    onReaderClose: () => {
      if (state.status === 'running') stop('已停止');
      R.readerClose();
      R.hideBar();
    }
  });

  /* -------------------------------- 对外消息 -------------------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === 'llmt:ping') {
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === 'llmt:toggle') {
      toggle()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (message.type === 'llmt:start') {
      start({ mode: message.options?.mode })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (message.type === 'llmt:clear') {
      clearAll();
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === 'llmt:mode') {
      if (message.mode) setMode(message.mode);
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === 'llmt:restore') {
      restore(message.page)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (message.type === 'llmt:status') {
      sendResponse({
        ok: true,
        status: state.status,
        mode: state.mode,
        total: state.total,
        done: state.done
      });
      return undefined;
    }
    return undefined;
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !R.readerIsOpen()) return;
      event.preventDefault();
      if (state.status === 'running') stop('已停止');
      R.readerClose();
      R.hideBar();
    },
    true
  );

  /* --------------------------------- 主流程 --------------------------------- */

  async function toggle() {
    if (state.status === 'running') {
      stop('已停止');
      return;
    }
    const visible = state.mode === 'reader' ? R.readerIsOpen() : R.hasInline();
    if (state.translations.size > 0 && visible) {
      clearAll();
      return;
    }
    if (state.translations.size > 0 && state.blocks.length > 0) {
      renderAll();
      return;
    }
    await start();
  }

  async function start(options = {}) {
    if (state.status === 'running') return;
    const cfg = await readConfig();
    state.mode = options.mode || (cfg.displayMode === 'reader' ? 'reader' : 'bilingual');

    R.mount();
    R.showBar();
    R.setModeLabel(state.mode);
    R.setStatus('提取正文…', { spinner: true });

    let article;
    try {
      article = E.extractArticle();
    } catch (err) {
      R.toast(`提取正文失败：${err?.message || err}`, { error: true });
      R.setStatus('提取失败');
      return;
    }
    if (!article.blocks.length) {
      R.toast('没有在这个页面找到可翻译的正文。', { error: true });
      R.setStatus('未找到正文');
      return;
    }

    state.blocks = article.blocks;
    state.translations = new Map();
    state.failed = new Set();
    state.title = article.title;
    state.url = article.url;
    state.total = article.blocks.length;
    state.done = 0;
    state.status = 'running';

    if (state.mode === 'reader') {
      R.readerOpen({ title: article.title, blocks: article.blocks, dark: R.detectDark() });
      R.setReaderMeta(`准备翻译 · ${article.blocks.length} 段`);
    } else {
      R.setStatus('翻译中…', { spinner: true, progress: { done: 0, total: state.total } });
    }

    if (article.truncated) {
      R.toast('正文较长，已截取前 500 段进行翻译。', { duration: 6000 });
    }

    openPort({
      blocks: article.blocks.map((block) => ({ i: block.i, text: block.text })),
      url: article.url,
      title: article.title
    });
  }

  function openPort(payload) {
    closePort();
    let port;
    try {
      port = chrome.runtime.connect({ name: 'llmt' });
    } catch (err) {
      state.status = 'error';
      R.toast(`无法连接扩展后台：${err?.message || err}`, { error: true });
      R.setStatus('连接失败');
      return;
    }
    state.port = port;
    const jobId = Date.now();
    port.onMessage.addListener((message) => onPortMessage(message, jobId));
    port.onDisconnect.addListener(() => {
      if (state.port !== port) return;
      state.port = null;
      if (state.status === 'running') {
        state.status = 'stopped';
        R.setStatus('连接已断开');
        R.toast('扩展后台连接中断（可能被浏览器回收），请重新翻译。', { error: true, duration: 7000 });
      }
    });
    port.postMessage({ type: 'translate', ...payload });
  }

  function onPortMessage(message, jobId) {
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'meta': {
        state.total = message.total || state.total;
        if (state.total) {
          R.setStatus('翻译中…', {
            spinner: true,
            progress: { done: state.done, total: state.total }
          });
        }
        break;
      }
      case 'batch': {
        for (const item of message.items || []) {
          applyTranslation(item.i, item.text);
        }
        break;
      }
      case 'progress': {
        state.done = message.done ?? state.done;
        state.total = message.total || state.total;
        R.setProgress(state.done, state.total);
        if (state.status === 'running' && state.mode === 'reader') {
          R.setReaderMeta(`翻译中 ${state.done} / ${state.total} 段`);
        }
        break;
      }
      case 'failed': {
        for (const i of message.items || []) {
          state.failed.add(i);
          if (state.mode === 'reader') {
            R.readerUpdate(i, '', { failed: true });
          } else {
            const block = state.blocks.find((b) => b.i === i);
            if (block) R.inlineAdd(block.el, '', { failed: true, index: i });
          }
        }
        R.toast(`部分段落翻译失败：${message.message}`, { error: true, duration: 8000 });
        break;
      }
      case 'done': {
        const stats = message.stats || {};
        state.status = 'done';
        state.done = state.total;
        R.setProgress(state.total, state.total);
        const cachedText = stats.cached ? ` · 缓存命中 ${stats.cached}` : '';
        const failText = stats.failed ? ` · 失败 ${stats.failed}` : '';
        R.setStatus(`完成 · ${stats.total || state.total} 段${cachedText}${failText}`, {
          spinner: false
        });
        if (state.mode === 'reader') {
          R.readerSetDone(
            `完成 · ${stats.total || state.total} 段${cachedText}${failText}`
          );
        }
        state.port?.disconnect();
        state.port = null;
        scheduleBarHide(9000);
        break;
      }
      case 'cancelled': {
        state.status = 'stopped';
        R.setStatus('已停止');
        break;
      }
      case 'error': {
        state.status = 'error';
        R.setStatus('翻译失败');
        R.toast(message.message || '翻译失败', { error: true, duration: 10000 });
        state.port?.disconnect();
        state.port = null;
        break;
      }
      default:
        break;
    }
  }

  function applyTranslation(i, text) {
    if (typeof text !== 'string') return;
    state.translations.set(i, text);
    if (state.mode === 'reader') {
      R.readerUpdate(i, text);
      return;
    }
    const block = state.blocks.find((b) => b.i === i);
    if (block) R.inlineAdd(block.el, text, { index: i });
  }

  function renderAll() {
    R.showBar();
    R.setModeLabel(state.mode);
    if (state.mode === 'reader') {
      if (!R.readerIsOpen()) {
        R.readerOpen({ title: state.title, blocks: state.blocks, dark: R.detectDark() });
      }
      for (const [i, text] of state.translations) {
        R.readerUpdate(i, text, { failed: state.failed.has(i) });
      }
      R.readerSetDone(`已恢复译文 · ${state.translations.size} 段`);
    } else {
      R.inlineClear();
      for (const block of state.blocks) {
        const text = state.translations.get(block.i);
        if (text) R.inlineAdd(block.el, text, { index: block.i });
      }
    }
    R.setStatus(`已恢复译文 · ${state.translations.size} 段`);
    scheduleBarHide(8000);
  }

  async function restore(page) {
    if (!page || !Array.isArray(page.entries) || !page.entries.length) return;
    if (state.status === 'running') return;

    const cfg = await readConfig();
    state.mode = cfg.displayMode === 'reader' ? 'reader' : 'bilingual';

    let article;
    try {
      article = E.extractArticle();
    } catch {
      return;
    }
    if (!article.blocks.length) return;

    const table = new Map(page.entries);
    const blocks = article.blocks.filter((block) => table.has(block.text));
    if (!blocks.length) return;

    state.blocks = blocks;
    state.title = article.title || page.title || '';
    state.url = article.url;
    state.translations = new Map();
    state.failed = new Set();
    for (const block of blocks) {
      const text = table.get(block.text);
      if (text) state.translations.set(block.i, text);
    }
    state.total = blocks.length;
    state.done = blocks.length;
    state.status = 'done';

    R.mount();
    R.detectDark();
    renderAll();
    R.setStatus(`已恢复缓存译文 · ${blocks.length} 段`, { spinner: false });
  }

  function setMode(next) {
    const mode = next === 'reader' ? 'reader' : 'bilingual';
    if (mode === state.mode) return;
    state.mode = mode;
    R.setModeLabel(mode);
    persistMode(mode);

    if (mode === 'reader') {
      R.inlineClear();
      if (!state.blocks.length) return;
      R.readerOpen({ title: state.title, blocks: state.blocks, dark: R.detectDark() });
      for (const [i, text] of state.translations) {
        R.readerUpdate(i, text, { failed: state.failed.has(i) });
      }
      if (state.status === 'done' && state.translations.size) {
        R.readerSetDone(`已恢复译文 · ${state.translations.size} 段`);
      } else if (state.total) {
        R.setReaderMeta(`翻译中 ${Math.min(state.done, state.total)} / ${state.total} 段`);
      }
    } else {
      R.readerClose();
      R.showBar();
      R.inlineClear();
      for (const block of state.blocks) {
        const text = state.translations.get(block.i);
        if (text) {
          R.inlineAdd(block.el, text, { index: block.i, failed: state.failed.has(block.i) });
        } else if (state.failed.has(block.i)) {
          R.inlineAdd(block.el, '', { index: block.i, failed: true });
        }
      }
    }
  }

  function stop(reason) {
    closePort();
    state.status = 'stopped';
    R.setStatus(reason || '已停止', { spinner: false });
  }

  function clearAll() {
    closePort();
    R.inlineClear();
    R.readerClose();
    R.hideBar();
    state.status = 'idle';
    state.blocks = [];
    state.translations = new Map();
    state.failed = new Set();
    state.total = 0;
    state.done = 0;
    clearTimeout(state.hideTimer);
  }

  function closePort() {
    if (!state.port) return;
    const port = state.port;
    state.port = null;
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
  }

  function scheduleBarHide(ms) {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => R.hideBar(), ms);
  }

  async function readConfig() {
    try {
      const stored = (await chrome.storage.sync.get('config')).config || {};
      return {
        displayMode: stored.displayMode === 'reader' ? 'reader' : 'bilingual'
      };
    } catch {
      return { displayMode: 'bilingual' };
    }
  }

  function persistMode(mode) {
    try {
      chrome.storage.sync.get('config', (data) => {
        const config = data?.config || {};
        config.displayMode = mode;
        chrome.storage.sync.set({ config }).catch(() => {});
      });
    } catch {
      /* ignore */
    }
  }
})();
