/**
 * 正文提取：在页面里跑，用启发式挑出「主内容容器」，再按块级元素切成可翻译片段。
 * 不修改页面 DOM。
 */

(() => {
  if (window.__llmtExtract) return;

  const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt';
  const NOISE_TAGS = new Set([
    'NAV', 'ASIDE', 'FOOTER', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME',
    'SVG', 'CANVAS', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'LINK', 'META', 'DIALOG'
  ]);
  const NOISE_ROLES = /^(navigation|banner|complementary|contentinfo|dialog|search|menu|menubar|toolbar|alertdialog)$/i;
  const NOISE_RE = /(^|[\s_-])(ad|ads|advert|advertisement|adsbygoogle|banner|breadcrumb|comment|comments|cookie|footer|header|menu|nav|navbar|newsletter|popup|promo|related|share|sharing|sidebar|social|sponsor|subscribe|subscription|toolbar|pagination|recommend|modal|overlay|signup|login|paywall|masthead|search)([\s_-]|$)/i;

  const MAX_BLOCKS = 500;
  const MAX_CHARS = 80000;
  const MIN_CONTAINER_SCORE = 250;

  function norm(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isHidden(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return true;
    const view = el.ownerDocument?.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  }

  function inNoise(el, root) {
    let node = el;
    while (node && node !== root && node.nodeType === 1) {
      if (NOISE_TAGS.has(node.tagName)) return true;
      const role = node.getAttribute?.('role');
      if (role && NOISE_ROLES.test(role)) return true;
      if (node.getAttribute?.('aria-hidden') === 'true') return true;
      const id = node.id || '';
      const cls = typeof node.className === 'string' ? node.className : '';
      if (NOISE_RE.test(id) || NOISE_RE.test(cls)) return true;
      node = node.parentElement;
    }
    if (root && root !== el && (NOISE_TAGS.has(root.tagName) || NOISE_RE.test(root.id || '') || NOISE_RE.test(typeof root.className === 'string' ? root.className : ''))) {
      return true;
    }
    return false;
  }

  function linkLength(el) {
    let len = 0;
    for (const a of el.querySelectorAll('a')) len += norm(a.textContent).length;
    return len;
  }

  function linkDensity(el, textLength) {
    const total = textLength ?? norm(el.textContent).length;
    if (!total) return 1;
    return linkLength(el) / total;
  }

  /**
   * 单次遍历打分：每个「像正文的块」把权重分摊给它上方的若干层容器，
   * 越靠近段落的容器权重越高；article/main 有额外加成。O(n) 而不是 O(n²)。
   */
  function pickContainer() {
    const scores = new Map();
    const nodes = document.querySelectorAll('p, li, blockquote, pre, h2, h3');
    for (const node of nodes) {
      if (node.tagName === 'PRE') continue;
      if (inNoise(node, document.documentElement)) continue;
      if (isHidden(node)) continue;
      const text = norm(node.textContent);
      if (text.length < 40) continue;
      const density = linkDensity(node, text.length);
      if (density > 0.6) continue;
      const weight = Math.min(text.length, 800) * (1 - density);

      let el = node.parentElement;
      let depth = 0;
      while (el && el !== document.documentElement && depth < 6) {
        scores.set(el, (scores.get(el) || 0) + weight / (1 + depth * 0.5));
        el = el.parentElement;
        depth += 1;
      }
    }

    let best = null;
    let bestScore = 0;
    for (const [el, score] of scores) {
      if (el === document.body) continue;
      let bonus = 0;
      if (el.tagName === 'ARTICLE') bonus = 300;
      else if (el.tagName === 'MAIN') bonus = 250;
      else if (el.getAttribute('role') === 'main') bonus = 250;
      else if (el.tagName === 'SECTION') bonus = 60;
      const total = score + bonus;
      if (total > bestScore) {
        bestScore = total;
        best = el;
      }
    }
    if (!best || bestScore < MIN_CONTAINER_SCORE) return document.body;
    return best;
  }

  function pickTitle(container) {
    const meta =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content;
    const h1 = container.querySelector('h1');
    const h1Text = h1 ? norm(h1.textContent) : '';
    if (h1Text && h1Text.length <= 160) return h1Text;
    const title = norm(document.title);
    if (title) return title;
    return norm(meta || '');
  }

  function extractArticle() {
    const container = pickContainer();
    const candidates = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
    const candidateSet = new Set(candidates);
    const blocks = [];
    const seen = new Set();
    let totalChars = 0;

    for (const el of candidates) {
      if (blocks.length >= MAX_BLOCKS || totalChars >= MAX_CHARS) break;
      if (el.tagName === 'PRE') continue;
      if (inNoise(el, container)) continue;
      if (el.closest('[hidden], [aria-hidden="true"]')) continue;

      // 跳过嵌套块：由外层块统一承载文本（如 blockquote > p，li > p）
      let ancestor = el.parentElement;
      let nested = false;
      while (ancestor && ancestor !== container) {
        if (candidateSet.has(ancestor)) {
          nested = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (nested) continue;

      if (isHidden(el)) continue;

      const text = norm(el.textContent);
      if (text.length < 2) continue;
      if (text.length < 120 && linkDensity(el, text.length) > 0.5) continue;
      if (seen.has(text)) continue;
      if (/^(广告|分享|收藏|点赞|评论|advertisement|share|tweet|print)$/i.test(text)) continue;

      seen.add(text);
      totalChars += text.length;
      blocks.push({
        i: blocks.length,
        tag: el.tagName.toLowerCase(),
        text,
        el
      });
    }

    return {
      title: pickTitle(container),
      url: location.href,
      siteName: location.hostname,
      lang: document.documentElement.lang || '',
      container,
      blocks,
      truncated: blocks.length >= MAX_BLOCKS || totalChars >= MAX_CHARS
    };
  }

  window.__llmtExtract = { extractArticle };
})();
