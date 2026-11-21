/**
 * 生成 README 用的界面截图：真实 Chromium + 真实扩展，模型用本地假服务，
 * 译文来自下方的人工映射（未命中的段落回退为「译：…」）。
 *
 *   node tests/screenshots.mjs
 */

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, access, mkdir } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '..');
const FIXTURE = await readFile(path.join(here, 'fixtures/article.html'));
const SHOT_DIR = path.join(EXT_DIR, 'docs/screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_ENDPOINT = 'https://api.deepseek.com/v1';
const DEMO_MODEL = 'deepseek-chat';

const TABLE = [
  ['ENERGY · 12 MIN READ', '能源 · 12 分钟阅读'],
  ['The Quiet Rise of Solid-State Batteries', '固态电池的悄然崛起'],
  ['By Ada Chen', '作者：Ada Chen · 2026 年 11 月 20 日'],
  [
    'For more than a decade, solid-state batteries',
    '十多年来，固态电池一直被描绘成这样一种技术：它终将让电动车变得便宜、安全、充电迅速。这个承诺听上去始终很简单——把传统电芯里易燃的液体电解液，换成一种能传导离子却不会燃烧的固体材料。'
  ],
  [
    'That simplicity has proved deceptive',
    '但这种简单其实是假象。多年来，工程师们一直在与枝晶、界面电阻和良率作斗争。然而过去十八个月里，情况发生了变化：中试线的电芯产出速度，放在 2023 年几乎不可想象；几家车企也已悄然把固态电池项目从研究推进到整车级测试。'
  ],
  ['Why the chemistry is hard', '难在化学'],
  [
    'A battery is a machine for moving ions',
    '电池是一台搬运离子的机器。在传统锂离子电芯中，离子穿行于液体之中，因此电极与电解液之间的界面相当宽容。固体电解质去掉了液体，也去掉了对瑕疵的容忍度：每一处微观缝隙都会成为瓶颈，每一个不规则表面都可能让锂金属长成针状枝晶。'
  ],
  [
    'Manufacturers have attacked the problem',
    '制造商从两个方向攻克这一难题。一些厂商采用硫化物电解质，这种材料可以在室温下压成致密薄片；另一些则坚持氧化物与聚合物复合路线，接受较低的电导率，换取更简单的工艺。两条路线孰优孰劣并不明显，业界仍在两边下注。'
  ],
  [
    '“The question is no longer',
    '“问题已不再是固态电芯能否在实验室里工作，而是我们能否以和今天电芯相当的成本，造出一百万颗。”'
  ],
  ['What changed this year', '今年改变了什么'],
  [
    'Three developments stand out',
    '有三项进展值得注意。首先，借自显示产业的涂布设备降低了超薄电解质膜的成本。其次，机器视觉系统如今能以足够精细的分辨率检测电极表面，捕捉那些会诱发枝晶的缺陷。第三点也最重要：电芯设计者不再执着于彻底取消压力堆叠，而是在电池包内施加温和而均匀的压力，既不增加多少重量，又能抑制枝晶生长。'
  ],
  [
    'The result is a cell',
    '结果是：这种电芯的成本尚未低于传统电芯，但已经接近到车企可以据此做规划的程度。几家车企宣布将在 2028 年为高端车型进行小批量生产，而大众市场车型能否跟进，取决于良率能否继续提升。'
  ],
  [
    'The most likely outcome',
    '最可能的结果不是液体电解质被突然取代，而是市场逐渐分层：高端车先用上固态电芯，因为它们的买家愿意为续航和安全付钱；客车与卡车随后跟进，因为它们的运营周期更看重寿命而非能量密度。大众市场车型可能要到 2030 年代仍在使用液体电解质。'
  ]
];

function demoTranslate(text) {
  const hit = TABLE.find(([prefix]) => text.startsWith(prefix));
  return hit ? hit[1] : `译：${text}`;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const revision of ['1255', '1243', '1237', '1234', '1228', '1223', '1217']) {
    const candidate = path.join(
      cache,
      `chromium-${revision}`,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return chromium.executablePath();
}

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let segments = [];
  try {
    const body = JSON.parse(raw);
    segments = JSON.parse(body.messages.find((m) => m.role === 'user').content).segments;
  } catch {
    /* ignore */
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      model: DEMO_MODEL,
      choices: [
        {
          message: { role: 'assistant', content: JSON.stringify({ translations: segments.map(demoTranslate) }) },
          finish_reason: 'stop'
        }
      ]
    })
  );
});

const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});

await mkdir(SHOT_DIR, { recursive: true });
const mockPort = await listen(mock);
const sitePort = await listen(site);
const articleUrl = `http://127.0.0.1:${sitePort}/article.html`;
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'llmt-shots-'));
const executablePath = await findChromium();

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run']
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = new URL(sw.url()).host;

  await sw.evaluate(
    async ({ endpoint, model }) => {
      await chrome.storage.sync.set({
        config: {
          endpoint,
          model,
          apiKey: 'sk-demo-0000000000000000',
          targetLang: '简体中文',
          displayMode: 'bilingual',
          autoRestore: true
        }
      });
    },
    { endpoint: `http://127.0.0.1:${mockPort}/v1`, model: DEMO_MODEL }
  );

  const page = await context.newPage();
  await page.goto(articleUrl);
  await page.bringToFront();
  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, articleUrl);

  await sw.evaluate(async (id) => {
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['src/content/content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: ['src/content/extract.js', 'src/content/render.js', 'src/content/main.js']
    });
    await chrome.tabs.sendMessage(id, { type: 'llmt:toggle' });
  }, tabId);

  await page.waitForFunction(() => document.querySelectorAll('.llmt-tr').length > 5, { timeout: 20000 });
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'bilingual.png') });

  await sw.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id, { type: 'llmt:mode', mode: 'reader' });
  }, tabId);
  await page.waitForSelector('#llmt-host .reader', { state: 'visible', timeout: 8000 });
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOT_DIR, 'reader.png') });
  await page.keyboard.press('Escape');
  await sleep(300);

  // 设置页：展示更真实的 endpoint / 模型
  await sw.evaluate(async (endpoint) => {
    const config = (await chrome.storage.sync.get('config')).config;
    await chrome.storage.sync.set({ config: { ...config, endpoint } });
  }, DEMO_ENDPOINT);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(
    () => document.getElementById('endpoint')?.value === 'https://api.deepseek.com/v1',
    { timeout: 5000 }
  );
  await sleep(300);
  await options.screenshot({ path: path.join(SHOT_DIR, 'options.png') });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForFunction(
    (model) => (document.getElementById('config-text')?.textContent || '').includes(model),
    DEMO_MODEL,
    { timeout: 5000 }
  );
  await popup.evaluate(() => {
    const msg = document.getElementById('msg');
    if (msg) msg.hidden = true;
  });
  await popup.locator('body').screenshot({ path: path.join(SHOT_DIR, 'popup.png') });

  console.log('截图已生成：', SHOT_DIR);
} finally {
  await context.close();
  mock.close();
  site.close();
  await rm(userDataDir, { recursive: true, force: true });
}
