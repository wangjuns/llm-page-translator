/**
 * LLM 调用层：只依赖 fetch，可在 service worker / Node 测试中复用。
 * 约定 OpenAI 兼容的 /chat/completions 接口。
 */

export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

class CountMismatchError extends Error {
  constructor(expected, actual) {
    super(`译文条数不匹配（期望 ${expected}，实际 ${actual}）`);
    this.name = 'CountMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

class TruncatedError extends Error {
  constructor() {
    super('模型输出被截断（finish_reason=length）');
    this.name = 'TruncatedError';
  }
}

const STATUS_HINTS = {
  400: '请求被拒绝（400）：检查模型名、请求参数或「额外请求参数」',
  401: 'API Key 无效或未授权（401）',
  403: '没有访问该模型 / 接口的权限（403）',
  404: '接口路径不存在（404）：endpoint 通常应形如 https://host/v1',
  408: '请求超时（408）',
  413: '请求体过大（413）：调小「每次字符上限」',
  422: '请求参数不合法（422）',
  429: '触发限流或额度不足（429）',
  500: '服务端错误（500）',
  502: '网关错误（502）',
  503: '服务暂不可用（503）',
  504: '网关超时（504）'
};

/** 把用户填写的 endpoint 规范成 chat/completions 地址 */
export function chatEndpoint(base) {
  let e = String(base || '').trim().replace(/\/+$/, '');
  if (!e) throw new LlmError('尚未配置 endpoint');
  if (!/^https?:\/\//i.test(e)) throw new LlmError('endpoint 必须以 http:// 或 https:// 开头');
  if (/\/chat\/completions$/i.test(e)) return e;
  return `${e}/chat/completions`;
}

export function buildSystemPrompt(cfg) {
  const custom = String(cfg.systemPrompt || '').trim();
  if (custom) {
    return custom
      .replaceAll('{target}', cfg.targetLang)
      .replaceAll('{source}', cfg.sourceLang);
  }
  const source = cfg.sourceLang && cfg.sourceLang !== '自动检测'
    ? `源语言：${cfg.sourceLang}。`
    : '源语言请根据文本自行判断。';
  return [
    `你是专业翻译引擎，把给定的文本片段翻译成「${cfg.targetLang}」。${source}`,
    '输入是 JSON 对象：{"segments":["片段1","片段2", ...]}。',
    '只输出一个 JSON 对象：{"translations":["译文1","译文2", ...]}。',
    '硬性要求：',
    '1. translations 的数量和顺序必须与 segments 完全一致，逐段翻译；不得合并、拆分、省略或增补。',
    '2. 每个片段可能是一个段落、标题、列表项或半句话；请结合整体语境，但只输出该片段自身的译文。',
    '3. 保留数字、单位、代码、公式、URL、人名和品牌名；不要添加解释、注释、标题或前后缀。',
    '4. 译文使用目标语言的书面表达，不要保留原文句子结构。',
    '5. 只输出 JSON 本身。'
  ].join('\n');
}

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(s.slice(objStart, objEnd + 1));
    } catch {
      /* fall through */
    }
  }
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(s.slice(arrStart, arrEnd + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

/** 解析模型返回的译文数组；失败时抛错，让上层拆分重试 */
export function parseTranslations(content, expectedCount) {
  const raw = String(content ?? '').trim();
  if (!raw) throw new Error('模型返回了空内容');

  const parsed = parseJsonLoose(raw);
  let arr;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.translations)) arr = parsed.translations;
  else if (parsed && Array.isArray(parsed.segments)) arr = parsed.segments;

  if (!arr) {
    // 兜底：按行解析（有些模型会逐行输出，每行一条）
    const lines = raw
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\d+\s*[.)、:：]|[-*•])\s*/, '').trim())
      .filter(Boolean);
    if (lines.length === expectedCount) arr = lines;
  }
  if (!arr) throw new Error('模型返回内容不是可解析的 JSON 译文数组');

  const list = arr.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      return String(item.translation ?? item.text ?? item.target ?? item.zh ?? '');
    }
    return String(item ?? '');
  });

  if (list.length !== expectedCount) throw new CountMismatchError(expectedCount, list.length);
  if (list.every((t) => !String(t).trim())) throw new Error('模型返回的译文全为空');
  return list;
}

async function fetchWithTimeout(url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new LlmError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, { retryable: true });
    }
    if (outerSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (err?.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
    throw new LlmError(`无法连接 endpoint：${err?.message || err}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

function parseExtraJson(text, fieldName) {
  const s = String(text || '').trim();
  if (!s) return {};
  let value;
  try {
    value = JSON.parse(s);
  } catch {
    throw new LlmError(`「${fieldName}」不是合法 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`「${fieldName}」必须是 JSON 对象`);
  }
  return value;
}

/** 发送一批文本，返回与输入等长的译文数组 */
export async function requestBatch(texts, cfg, signal) {
  const url = chatEndpoint(cfg.endpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  Object.assign(headers, parseExtraJson(cfg.extraHeaders, '额外请求头'));

  const payload = {
    model: cfg.model,
    temperature: Number(cfg.temperature) || 0,
    messages: [
      { role: 'system', content: buildSystemPrompt(cfg) },
      { role: 'user', content: JSON.stringify({ segments: texts }) }
    ]
  };
  if (Number(cfg.maxTokens) > 0) payload.max_tokens = Number(cfg.maxTokens);
  Object.assign(payload, parseExtraJson(cfg.extraBody, '额外请求参数'));

  const started = Date.now();
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    cfg.timeoutMs,
    signal
  );

  const rawText = await res.text();
  if (!res.ok) {
    const hint = STATUS_HINTS[res.status] || `请求失败（HTTP ${res.status}）`;
    throw new LlmError(hint, {
      status: res.status,
      retryable: res.status === 429 || res.status === 408 || res.status >= 500,
      detail: rawText.slice(0, 600)
    });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new LlmError('接口返回的不是 JSON，请确认 endpoint 是否是 OpenAI 兼容接口', {
      detail: rawText.slice(0, 300)
    });
  }

  const choice = data?.choices?.[0];
  const message = choice?.message;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  if (typeof content !== 'string') {
    const errMsg = data?.error?.message || '接口返回结构不正确（缺少 choices[0].message.content）';
    throw new LlmError(errMsg, { retryable: false, detail: rawText.slice(0, 600) });
  }
  if (choice?.finish_reason === 'length') throw new TruncatedError();

  const translations = parseTranslations(content, texts.length);
  return {
    translations,
    usage: data?.usage || null,
    model: data?.model || cfg.model,
    ms: Date.now() - started
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(texts, cfg, signal, depth) {
  try {
    const result = await requestBatch(texts, cfg, signal);
    return result.translations;
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');

    const splittable = err instanceof CountMismatchError || err instanceof TruncatedError;
    if (splittable && texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const [a, b] = await Promise.all([
        attempt(texts.slice(0, mid), cfg, signal, depth + 1),
        attempt(texts.slice(mid), cfg, signal, depth + 1)
      ]);
      return [...a, ...b];
    }
    if (err?.retryable && depth < 3) {
      await sleep(700 * 2 ** depth + Math.random() * 400);
      return attempt(texts, cfg, signal, depth + 1);
    }
    throw err;
  }
}

/** 翻译一组文本：内部处理拆分、重试、条数校验 */
export async function translateTexts(texts, cfg, signal) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  return attempt(texts, cfg, signal, 0);
}

/** 按字符预算把待翻译段落分组 */
export function groupByChars(items, maxChars, maxItems = 24) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const len = String(item.text || '').length;
    if (current.length > 0 && (chars + len > maxChars || current.length >= maxItems)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 连接测试：用一条短文本走完整链路 */
export async function testConnection(cfg, signal) {
  const sample = 'Hello, world!';
  const result = await requestBatch([sample], cfg, signal);
  return {
    sample,
    translation: result.translations[0],
    model: result.model,
    ms: result.ms,
    usage: result.usage
  };
}
