/**
 * 打 Chrome 扩展发布包：dist/llm-page-translator-v<version>.zip
 * 只包含运行所需文件（manifest.json、src、icons、README），不含测试与开发依赖。
 *
 *   node scripts/package.mjs
 *   node scripts/package.mjs --expect-version=v0.1.0   # tag 与 manifest 版本不一致时失败
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

const expectArg = process.argv.find((arg) => arg.startsWith('--expect-version='));
const expected = (expectArg ? expectArg.split('=').slice(1).join('=') : process.env.RELEASE_TAG || '')
  .trim()
  .replace(/^v/i, '');
if (expected && expected !== version) {
  console.error(`✗ tag 版本 ${expected} 与 manifest.json 的 ${version} 不一致`);
  process.exit(1);
}

const distDir = path.join(root, 'dist');
const zipName = `llm-page-translator-v${version}.zip`;
const zipPath = path.join(distDir, zipName);
const include = ['manifest.json', 'src', 'icons', 'README.md'];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

try {
  execFileSync(
    'zip',
    [
      '-r',
      '-q',
      zipPath,
      ...include,
      '-x',
      '*.DS_Store',
      '-x',
      '*/node_modules/*',
      '-x',
      '*.map'
    ],
    { cwd: root, stdio: 'inherit' }
  );
} catch (err) {
  console.error('✗ 打包失败，需要系统 zip 命令：', err.message);
  process.exit(1);
}

const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
if (!entries.includes('manifest.json')) {
  console.error('✗ zip 根目录缺少 manifest.json');
  process.exit(1);
}
if (!entries.some((entry) => entry.startsWith('src/background/service-worker.js'))) {
  console.error('✗ zip 内缺少 service worker');
  process.exit(1);
}

const bytes = await readFile(zipPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);

console.log(`✓ dist/${zipName}`);
console.log(`  ${(bytes.length / 1024).toFixed(1)} KB · ${entries.length} 个文件`);
console.log(`  sha256 ${sha256}`);
