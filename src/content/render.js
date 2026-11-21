/**
 * 页面内 UI：
 * - 右上角状态条（进度 / 模式切换 / 关闭）
 * - 阅读器浮层（仅译文模式）：自带排版，完全隔离页面样式
 * - 行内译文块（双语模式）：插入到原文块后面
 *
 * 状态条和阅读器都在 shadow DOM 中，避免被站点 CSS 干扰。
 */

(() => {
  if (window.__llmtRender) return;

  const HOST_ID = 'llmt-host';
  const INLINE_CLASS = 'llmt-tr';
  const DARK_CLASS = 'llmt-dark';
  const READER_CLASS = 'llmt-reader-open';

  const SHADOW_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .bar {
      position: absolute;
      top: 14px;
      right: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: min(520px, calc(100vw - 28px));
      padding: 8px 10px 8px 12px;
      border-radius: 999px;
      background: rgba(20, 21, 28, 0.94);
      color: #f2f3f8;
      font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(14px);
      pointer-events: auto;
      z-index: 3;
      animation: llmt-in 0.18s ease-out;
    }
    .bar .dot {
      width: 9px;
      height: 9px;
      flex: none;
      border-radius: 50%;
      background: #8f7dff;
    }
    .bar .dot.spin {
      width: 12px;
      height: 12px;
      background: none;
      border: 2px solid rgba(255, 255, 255, 0.22);
      border-top-color: #a99bff;
      animation: llmt-spin 0.8s linear infinite;
    }
    .bar .txt {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #e9eaf3;
    }
    .bar .prog {
      flex: none;
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      color: #cfd2e6;
      font-variant-numeric: tabular-nums;
      font-size: 11.5px;
    }
    .bar .btn {
      flex: none;
      appearance: none;
      border: 0;
      margin: 0;
      padding: 5px 9px;
      border-radius: 999px;
      background: transparent;
      color: #cfd2e6;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      line-height: 1;
    }
    .bar .btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
    .bar .btn.mode { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
    .bar .btn.close { padding: 5px 8px; font-size: 13px; }

    .toast {
      position: absolute;
      left: 50%;
      bottom: 26px;
      transform: translateX(-50%);
      max-width: min(560px, calc(100vw - 40px));
      padding: 11px 16px;
      border-radius: 12px;
      background: rgba(24, 25, 33, 0.96);
      color: #eef0f7;
      font: 500 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.32), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      pointer-events: auto;
      z-index: 5;
      animation: llmt-in 0.18s ease-out;
    }
    .toast.error { background: rgba(78, 24, 30, 0.97); color: #ffd9da; }

    .reader {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: stretch;
      justify-content: center;
      pointer-events: auto;
      z-index: 4;
      animation: llmt-fade 0.2s ease-out;
    }
    .reader .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(9, 10, 15, 0.55);
      backdrop-filter: blur(6px);
    }
    .reader .panel {
      position: relative;
      width: min(920px, 100%);
      height: 100%;
      display: flex;
      flex-direction: column;
      background: #fcfcfe;
      color: #1b1d26;
      box-shadow: 0 0 60px rgba(0, 0, 0, 0.35);
      animation: llmt-rise 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .reader.dark .panel { background: #14151b; color: #e8eaf2; }

    .reader header {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 22px;
      border-bottom: 1px solid rgba(128, 128, 150, 0.18);
      background: inherit;
    }
    .reader .brand {
      flex: none;
      width: 26px;
      height: 26px;
      border-radius: 8px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font: 700 15px/26px "Hiragino Sans GB", "PingFang SC", sans-serif;
      text-align: center;
      user-select: none;
    }
    .reader .titles { min-width: 0; flex: 1; }
    .reader .rtitle {
      font: 600 13.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", sans-serif;
      color: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.92;
    }
    .reader .rmeta {
      margin-top: 2px;
      font: 400 11.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", sans-serif;
      color: #7a8095;
      font-variant-numeric: tabular-nums;
    }
    .reader.dark .rmeta { color: #8d93a8; }
    .reader .ractions { flex: none; display: flex; gap: 8px; }
    .reader .rbtn {
      appearance: none;
      border: 1px solid rgba(120, 124, 150, 0.28);
      margin: 0;
      padding: 6px 11px;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", sans-serif;
      cursor: pointer;
    }
    .reader .rbtn:hover { background: rgba(128, 130, 160, 0.12); }
    .reader .progress { flex: none; height: 2px; background: rgba(128, 128, 150, 0.16); }
    .reader .progress i {
      display: block;
      height: 100%;
      width: 0;
      background: #6c5ce7;
      transition: width 0.25s ease;
    }
    .reader.dark .progress i { background: #9c8dff; }

    .reader .content {
      flex: 1;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 40px 32px 120px;
    }
    .reader .inner { max-width: 690px; margin: 0 auto; }
    .reader h1 {
      margin: 0 0 26px;
      font: 700 27px/1.42 "Hiragino Sans GB", "PingFang SC", -apple-system, sans-serif;
      letter-spacing: 0.01em;
    }
    .reader .item { margin: 0 0 18px; }
    .reader .item .dst {
      font: 400 17.5px/1.92 "Hiragino Sans GB", "PingFang SC", -apple-system, sans-serif;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .reader .item.h2 .dst, .reader .item.h3 .dst {
      font-weight: 700;
      font-size: 20px;
      line-height: 1.6;
      margin-top: 14px;
    }
    .reader .item.h1 .dst { font-weight: 700; font-size: 23px; line-height: 1.55; }
    .reader .item.li .dst { padding-left: 18px; position: relative; }
    .reader .item.li .dst::before {
      content: "•";
      position: absolute;
      left: 2px;
      color: #8b8fa5;
    }
    .reader .item blockquote {}
    .reader .item .src {
      display: none;
      margin: 8px 0 0;
      padding: 8px 12px;
      border-left: 2px dashed rgba(128, 130, 160, 0.45);
      font: 400 13.5px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", sans-serif;
      color: #7d8398;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .reader.show-src .item .src { display: block; }
    .reader .dst.pending { min-height: 1.4em; }
    .reader .dst.pending::after {
      content: "";
      display: block;
      height: 0.95em;
      width: min(100%, 520px);
      border-radius: 5px;
      background: linear-gradient(90deg, rgba(128, 130, 160, 0.14), rgba(128, 130, 160, 0.28), rgba(128, 130, 160, 0.14));
      background-size: 200% 100%;
      animation: llmt-shimmer 1.2s linear infinite;
    }
    .reader .dst.failed { color: #c0454a; font-size: 13px; }
    .reader.dark .dst.failed { color: #ff9a9d; }

    @keyframes llmt-spin { to { transform: rotate(360deg); } }
    @keyframes llmt-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    @keyframes llmt-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes llmt-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes llmt-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  `;

  const TEMPLATE = `
    <div class="bar" hidden>
      <span class="dot"></span>
      <span class="txt">准备中…</span>
      <span class="prog" hidden></span>
      <button class="btn mode" type="button" title="切换显示模式">双语</button>
      <button class="btn close" type="button" title="停止并还原">✕</button>
    </div>
    <div class="toast" hidden></div>
    <div class="reader" hidden>
      <div class="backdrop"></div>
      <div class="panel">
        <header>
          <div class="brand">译</div>
          <div class="titles">
            <div class="rtitle">译文</div>
            <div class="rmeta">准备中…</div>
          </div>
          <div class="ractions">
            <button class="rbtn modebtn" type="button" title="切回双语对照">双语</button>
            <button class="rbtn srcbtn" type="button">原文</button>
            <button class="rbtn closebtn" type="button">关闭</button>
          </div>
        </header>
        <div class="progress"><i></i></div>
        <div class="content"><div class="inner"></div></div>
      </div>
    </div>
  `;

  const inlineNodes = new Set();
  let host = null;
  let shadow = null;
  let bar = null;
  let barText = null;
  let barDot = null;
  let barProg = null;
  let barModeBtn = null;
  let toastEl = null;
  let toastTimer = null;
  let reader = null;
  let readerTitle = null;
  let readerMeta = null;
  let readerInner = null;
  let readerProgress = null;
  let readerSrcBtn = null;
  let readerItems = new Map();
  let readerDark = false;
  let showSource = false;
  let callbacks = { onMode: null, onBarClose: null, onReaderClose: null };

  function mount(options = {}) {
    callbacks = { ...callbacks, ...options };
    ensureHost();
    return shadow;
  }

  function ensureHost() {
    if (shadow) return shadow;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      (document.body || document.documentElement).appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    applyShadowStyles();
    shadow.innerHTML = TEMPLATE;

    bar = shadow.querySelector('.bar');
    barText = shadow.querySelector('.bar .txt');
    barDot = shadow.querySelector('.bar .dot');
    barProg = shadow.querySelector('.bar .prog');
    barModeBtn = shadow.querySelector('.bar .btn.mode');
    toastEl = shadow.querySelector('.toast');
    reader = shadow.querySelector('.reader');
    readerTitle = shadow.querySelector('.rtitle');
    readerMeta = shadow.querySelector('.rmeta');
    readerInner = shadow.querySelector('.inner');
    readerProgress = shadow.querySelector('.reader .progress i');
    readerSrcBtn = shadow.querySelector('.srcbtn');

    barModeBtn.addEventListener('click', () => callbacks.onMode?.());
    shadow.querySelector('.bar .btn.close').addEventListener('click', () => callbacks.onBarClose?.());
    shadow.querySelector('.closebtn').addEventListener('click', () => callbacks.onReaderClose?.());
    shadow.querySelector('.modebtn').addEventListener('click', () => callbacks.onMode?.());
    readerSrcBtn.addEventListener('click', () => {
      showSource = !showSource;
      reader.classList.toggle('show-src', showSource);
      readerSrcBtn.textContent = showSource ? '隐藏原文' : '原文';
    });
    return shadow;
  }

  function applyShadowStyles() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHADOW_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = SHADOW_CSS;
      shadow.appendChild(style);
    }
  }

  function detectDark() {
    const pick = (el) => {
      if (!el) return null;
      const bg = getComputedStyle(el).backgroundColor || '';
      const match = bg.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((n) => Number.parseFloat(n.trim()));
      if (parts.length < 3) return null;
      const alpha = parts.length > 3 ? parts[3] : 1;
      if (alpha < 0.2) return null;
      const [r, g, b] = parts;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const bodyLum = pick(document.body);
    const htmlLum = pick(document.documentElement);
    const lum = bodyLum ?? htmlLum ?? 1;
    return lum < 0.42;
  }

  function applyTheme() {
    const dark = detectDark();
    document.documentElement.classList.toggle(DARK_CLASS, dark);
    if (reader) reader.classList.toggle('dark', dark);
    readerDark = dark;
    return dark;
  }

  function showBar() {
    ensureHost();
    bar.hidden = false;
  }

  function hideBar() {
    if (bar) bar.hidden = true;
  }

  function setStatus(text, { spinner = false, progress = null } = {}) {
    ensureHost();
    if (!readerIsOpen()) showBar();
    barText.textContent = text;
    barDot.classList.toggle('spin', Boolean(spinner));
    if (progress) {
      barProg.hidden = false;
      barProg.textContent = `${progress.done}/${progress.total}`;
    } else {
      barProg.hidden = true;
    }
  }

  function setProgress(done, total) {
    ensureHost();
    barProg.hidden = false;
    barProg.textContent = `${done}/${total}`;
    if (readerProgress) readerProgress.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    if (readerMeta && reader && !reader.hidden) {
      readerMeta.textContent = `翻译中 ${done} / ${total} 段`;
    }
  }

  function setModeLabel(mode) {
    ensureHost();
    barModeBtn.textContent = mode === 'reader' ? '译文' : '双语';
  }

  function setReaderMeta(text) {
    ensureHost();
    if (readerMeta) readerMeta.textContent = text;
  }

  function toast(message, { error = false, duration = 5200 } = {}) {
    ensureHost();
    toastEl.textContent = String(message || '');
    toastEl.classList.toggle('error', Boolean(error));
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, duration);
  }

  /* ------------------------------- 行内译文 ------------------------------- */

  function inlineAdd(el, text, { failed = false, index = null } = {}) {
    if (!el || !el.isConnected) return;
    const node = document.createElement('div');
    node.className = `${INLINE_CLASS}${failed ? ' llmt-failed' : ''}`;
    if (index !== null) node.dataset.llmtI = String(index);
    node.setAttribute('dir', 'auto');
    node.textContent = failed ? '⚠ 本段翻译失败' : text;
    const tag = el.tagName;
    if (tag === 'LI' || tag === 'DT' || tag === 'DD' || tag === 'TD' || tag === 'TH') {
      el.appendChild(node);
    } else {
      el.insertAdjacentElement('afterend', node);
    }
    inlineNodes.add(node);
  }

  function inlineClear() {
    for (const node of inlineNodes) node.remove();
    inlineNodes.clear();
  }

  function hasInline() {
    return inlineNodes.size > 0;
  }

  /* -------------------------------- 阅读器 -------------------------------- */

  function readerOpen({ title, blocks, dark = null }) {
    ensureHost();
    bar.hidden = true;
    const isDark = dark ?? readerDark ?? applyTheme();
    reader.classList.toggle('dark', isDark);
    reader.hidden = false;
    reader.classList.toggle('show-src', showSource);
    readerSrcBtn.textContent = showSource ? '隐藏原文' : '原文';
    readerTitle.textContent = title || '译文';
    readerMeta.textContent = `准备中… · ${blocks.length} 段`;
    readerProgress.style.width = '0%';
    readerInner.textContent = '';
    readerItems = new Map();

    for (const block of blocks) {
      const item = document.createElement('section');
      const tag = String(block.tag || 'p');
      item.className = `item ${tag.match(/^h[1-6]$/) ? tag : tag === 'li' ? 'li' : 'p'}`;
      item.dataset.i = String(block.i);
      const dst = document.createElement('div');
      dst.className = 'dst pending';
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = block.text;
      item.append(dst, src);
      readerInner.appendChild(item);
      readerItems.set(block.i, { item, dst });
    }
    document.documentElement.classList.add(READER_CLASS);
    if (readerDark) document.documentElement.classList.add(DARK_CLASS);
    reader.querySelector('.content').scrollTop = 0;
  }

  function readerUpdate(i, text, { failed = false } = {}) {
    const entry = readerItems.get(i);
    if (!entry) return;
    entry.dst.classList.remove('pending');
    entry.dst.classList.toggle('failed', Boolean(failed));
    entry.dst.textContent = failed ? '⚠ 本段翻译失败' : text;
  }

  function readerSetDone(metaText) {
    if (!reader || reader.hidden) return;
    if (metaText) readerMeta.textContent = metaText;
    readerProgress.style.width = '100%';
  }

  function readerHasItem(i) {
    return readerItems.has(i);
  }

  function readerIsOpen() {
    return Boolean(reader && !reader.hidden);
  }

  function readerClose() {
    if (!reader) return;
    reader.hidden = true;
    document.documentElement.classList.remove(READER_CLASS);
    readerItems = new Map();
  }

  function isReaderDark() {
    return readerDark;
  }

  window.__llmtRender = {
    mount,
    showBar,
    hideBar,
    setStatus,
    setProgress,
    setModeLabel,
    setReaderMeta,
    toast,
    inlineAdd,
    inlineClear,
    hasInline,
    readerOpen,
    readerUpdate,
    readerSetDone,
    readerHasItem,
    readerIsOpen,
    readerClose,
    isReaderDark,
    detectDark
  };
})();
