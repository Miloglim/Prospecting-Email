// 一次性修复：清除非 cold 阶段联系人的 last_sent_at / last_sent_acct
// 用法：node scripts/fix-last-sent.js
// 背景：阶段推进时遗漏清除发送标记，导致下一阶段无法加入队列

const path = require('path');
const fs = require('fs');

// 找 APP_ROOT
function findAppRoot() {
  // 打包模式
  if (__dirname.includes('.asar')) {
    return path.dirname(require('electron').app.getPath('exe'));
  }
  // 开发模式 — 向上找项目根
  return path.resolve(__dirname, '..');
}

const APP_ROOT = findAppRoot();
const dbPath = path.join(APP_ROOT, 'data', 'prospector.db');

if (!fs.existsSync(dbPath)) {
  console.error('❌ 数据库不存在:', dbPath);
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(dbPath);

// 查看受影响的数据
const affected = db.prepare(
  "SELECT id, email, stage, last_sent_at, last_sent_acct FROM contacts WHERE stage != 'cold' AND stage != '' AND (last_sent_at != '' OR last_sent_acct != '')"
).all();

console.log(`找到 ${affected.length} 个需要修复的联系人：`);
for (const c of affected) {
  console.log(`  ${c.email} | stage=${c.stage} | last_sent_at=${c.last_sent_at?.slice(0,10) || '-'} | acct=${c.last_sent_acct || '-'}`);
}

if (!affected.length) {
  console.log('无需修复，退出。');
  db.close();
  process.exit(0);
}

// 执行修复
const result = db.prepare(
  "UPDATE contacts SET last_sent_at = '', last_sent_acct = '' WHERE stage != 'cold' AND stage != '' AND (last_sent_at != '' OR last_sent_acct != '')"
).run();

console.log(`\n✅ 已修复 ${result.changes} 条记录`);

// WAL checkpoint
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
