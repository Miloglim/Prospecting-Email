// ── 发送状态查询 ──────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "send-log.json");

if (!fs.existsSync(logFile)) {
  console.log("尚无发送记录。");
  process.exit(0);
}

const log = JSON.parse(fs.readFileSync(logFile, "utf-8"));

const today = new Date().toISOString().slice(0, 10);
const todaySent = log.sent.filter((r) => r.time.startsWith(today));

const succeeded = log.sent.filter((r) => r.status === "sent");
const failed = log.sent.filter((r) => r.status === "failed");

console.log("═══════════════════════════════════════");
console.log("📊 发送统计");
console.log("═══════════════════════════════════════");
console.log(`  今日已发: ${todaySent.length} 封`);
console.log(`  累计成功: ${succeeded.length} 封`);
console.log(`  累计失败: ${failed.length} 封`);
console.log(`  今日日期: ${log.last_date}`);
console.log("");

if (failed.length > 0) {
  console.log("❌ 失败记录:");
  failed.forEach((r) => {
    console.log(`  - ${r.company || r.to}: ${r.error}`);
  });
}

if (todaySent.length > 0) {
  console.log("✅ 今日已发:");
  todaySent.forEach((r) => {
    console.log(`  - ${r.company || r.to} [${r.status}] ${r.time.slice(11, 19)}`);
  });
}
