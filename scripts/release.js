// ── 自动发布脚本 ──────────────────────────────────────────────────────────
// 用法: node scripts/release.js
// 自动完成: 构建 → 打tag → 推送 → 创建GitHub Release → 上传文件

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, '..', 'dist-release');

// 1. 读取版本号
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
console.log(`\n📦 当前版本: v${version}`);

// 2. 确认 dist-release 存在
if (!fs.existsSync(DIST)) {
  console.error('❌ dist-release 目录不存在，请先运行 npm run ship');
  process.exit(1);
}

// 3. 检查文件
const files = fs.readdirSync(DIST).filter(f => f.endsWith('.exe') || f.endsWith('.blockmap') || f.endsWith('.yml'));
if (!files.length) {
  console.error('❌ dist-release 目录为空');
  process.exit(1);
}
console.log(`📁 找到 ${files.length} 个文件:`);
files.forEach(f => console.log(`   ${f}`));

// 4. 打 tag
const tag = `v${version}`;
console.log(`\n🏷 创建 tag: ${tag}`);
execSync(`git tag ${tag}`, { cwd: ROOT, stdio: 'inherit' });

// 5. 推送 tag
console.log(`📤 推送 tag...`);
execSync(`git push origin ${tag}`, { cwd: ROOT, stdio: 'inherit' });

// 6. 创建 GitHub Release
const notes = process.argv.slice(2).join(' ') || '更新说明';
const fileArgs = files.map(f => `"${path.join(DIST, f)}"`).join(' ');
const cmd = `gh release create ${tag} ${fileArgs} --title "${tag}" --notes "${notes}"`;
console.log(`\n🚀 创建 Release...`);
try {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  console.log(`\n✅ 发布完成: https://github.com/Miloglim/Prospecting-Email/releases/tag/${tag}`);
} catch (e) {
  console.error('❌ 发布失败，请检查 GitHub 连接和权限');
  process.exit(1);
}
