/**
 * 轻量静态检查：所有 JS 过一遍 node --check，manifest 与 package.json 过一遍 JSON.parse。
 * 无需构建，直接可跑。
 */

import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = await walk(root);
const jsFiles = files.filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
const jsonFiles = files.filter((file) => file.endsWith('.json') && !file.endsWith('package-lock.json'));

let failures = 0;
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures += 1;
    console.error(`✗ ${path.relative(root, file)}`);
    console.error(String(err.stderr || err.message).trim());
  }
}
for (const file of jsonFiles) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    failures += 1;
    console.error(`✗ ${path.relative(root, file)}: ${err.message}`);
  }
}

if (failures) {
  console.error(`\n${failures} 个文件未通过检查`);
  process.exit(1);
}
console.log(`✓ ${jsFiles.length} 个 JS 文件、${jsonFiles.length} 个 JSON 文件检查通过`);
