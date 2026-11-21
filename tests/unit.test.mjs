import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatEndpoint,
  groupByChars,
  parseTranslations,
  translateTexts
} from '../src/background/llm.js';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/shared/config.js';

test('parseTranslations 解析标准对象', () => {
  assert.deepEqual(
    parseTranslations('{"translations":["你好","世界"]}', 2),
    ['你好', '世界']
  );
});

test('parseTranslations 容忍代码块与前后说明文字', () => {
  const raw = '好的，结果如下：\n```json\n{"translations":["甲","乙"]}\n```\n以上。';
  assert.deepEqual(parseTranslations(raw, 2), ['甲', '乙']);
});

test('parseTranslations 支持直接数组与对象元素', () => {
  assert.deepEqual(parseTranslations('["A","B"]', 2), ['A', 'B']);
  assert.deepEqual(
    parseTranslations('{"translations":[{"translation":"甲"},{"text":"乙"}]}', 2),
    ['甲', '乙']
  );
});

test('parseTranslations 行式兜底', () => {
  const raw = '1. 第一段\n2) 第二段\n- 第三段';
  assert.deepEqual(parseTranslations(raw, 3), ['第一段', '第二段', '第三段']);
});

test('parseTranslations 条数不匹配时抛错', () => {
  assert.throws(() => parseTranslations('{"translations":["只有一条"]}', 3), /条数不匹配/);
  assert.throws(() => parseTranslations('', 1), /空内容/);
});

test('chatEndpoint 自动补全路径', () => {
  assert.equal(chatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    chatEndpoint('http://127.0.0.1:11434/v1/chat/completions'),
    'http://127.0.0.1:11434/v1/chat/completions'
  );
  assert.throws(() => chatEndpoint(''), /endpoint/);
  assert.throws(() => chatEndpoint('ftp://x'), /http/);
});

test('groupByChars 按预算分组且保持顺序', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ i, text: 'x'.repeat(100) }));
  const groups = groupByChars(items, 250);
  assert.deepEqual(groups.map((g) => g.map((x) => x.i)), [[0, 1], [2, 3], [4, 5], [6]]);
  assert.ok(groupByChars(items, 250, 3).every((g) => g.length <= 3));
});

test('normalizeConfig 收敛非法数值与默认值', () => {
  const cfg = normalizeConfig({
    endpoint: ' https://x.test/v1 ',
    concurrency: 99,
    batchChars: 10,
    temperature: 9,
    displayMode: 'nope',
    autoRestore: 1
  });
  assert.equal(cfg.endpoint, 'https://x.test/v1');
  assert.equal(cfg.concurrency, 6);
  assert.equal(cfg.batchChars, 200);
  assert.equal(cfg.temperature, 2);
  assert.equal(cfg.displayMode, 'bilingual');
  assert.equal(cfg.autoRestore, true);
  assert.equal(normalizeConfig({}).maxTokens, DEFAULT_CONFIG.maxTokens);
});

test('translateTexts 在条数不匹配时自动拆分重试', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const segments = JSON.parse(body.messages[1].content).segments;
    calls.push(segments.length);
    // 第一次故意少返回一条，模拟模型合并段落
    const translations = segments.length > 1 ? segments.slice(0, -1).map((s) => `译:${s}`) : [`译:${segments[0]}`];
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: 'stop' }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const result = await translateTexts(['a', 'b', 'c'], normalizeConfig({ endpoint: 'http://x/v1', model: 'm' }));
    assert.deepEqual(result, ['译:a', '译:b', '译:c']);
    assert.ok(calls.includes(3), '应先尝试整批');
    assert.ok(calls.filter((n) => n === 1).length >= 3, '应拆分到单段');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translateTexts 对 429 重试后成功', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"translations":["ok"]}' }, finish_reason: 'stop' }] }),
      { status: 200 }
    );
  };
  try {
    const result = await translateTexts(['hi'], normalizeConfig({ endpoint: 'http://x/v1', model: 'm' }));
    assert.deepEqual(result, ['ok']);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
