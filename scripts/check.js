// 发布前语法检查 — 扫描所有主进程 JS 文件, node --check 验证
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['electron/modules', 'electron/modules/core', 'electron/modules/services', 'electron/modules/ipc', 'electron/modules/auto-send', 'electron/modules/auto-send/services'];
const EXCLUDE = ['node_modules'];

let ok = 0, fail = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (EXCLUDE.some(x => fp.includes(x))) continue;
    if (e.isDirectory()) { walk(fp); continue; }
    if (!e.name.endsWith('.js')) continue;
    try {
      execSync(`node --check "${fp}"`, { stdio: 'pipe', timeout: 5000 });
      ok++;
    } catch (err) {
      console.log(`  ✗ ${path.relative(ROOT, fp)}`);
      fail++;
    }
  }
}

console.log('\n🔍 语法检查...\n');
for (const d of DIRS) {
  const dp = path.join(ROOT, d);
  if (fs.existsSync(dp)) walk(dp);
}

// IPC 契约检查: contract.js 的通道常量是否被 preload.js 双向引用
console.log('');
const contract = require('../electron/modules/core/contract');
const preloadPath = path.join(ROOT, 'electron/preload.js');
if (fs.existsSync(preloadPath)) {
  const preloadSrc = fs.readFileSync(preloadPath, 'utf-8');
  const allChannels = [];
  for (const [domain, channels] of Object.entries(contract.IPC)) {
    for (const [name, channel] of Object.entries(channels)) {
      if (typeof channel === 'string' && channel.includes(':')) allChannels.push(channel);
    }
  }
  const missing = allChannels.filter(ch => !preloadSrc.includes(ch));
  if (missing.length) {
    console.log(`  ⚠ IPC 契约缺失: preload.js 未引用 ${missing.length} 个通道`);
    missing.slice(0, 10).forEach(ch => console.log(`    - ${ch}`));
  } else {
    console.log('  ✓ IPC 契约: preload.js 双向对齐');
  }
}

console.log(`\n${ok + fail} 文件: ${ok} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
