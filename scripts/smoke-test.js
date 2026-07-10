// ── 冒烟测试：验证所有核心 IPC 通道可用 ──────────────────────────────────────
// 用法：npm run dev 启动后，另开终端运行 node scripts/smoke-test.js

const { spawn } = require("child_process");
const http = require("http");

const BASE = "http://localhost:5173"; // dev server
const results = [];

function test(name, fn) {
  return fn()
    .then(() => results.push({ name, ok: true }))
    .catch((e) => results.push({ name, ok: false, error: e.message }));
}

async function run() {
  console.log("🔍 冒烟测试开始...\n");

  // API 健康检查
  await test("API health", async () => {
    const r = await fetch("http://127.0.0.1:9527/api/health");
    const d = await r.json();
    if (!d.ok) throw new Error("API 不健康");
  });

  // 数据库连接
  await test("SQLite 连接", async () => {
    const db = require("../electron/modules/services/db").getDb();
    const n = db.prepare("SELECT COUNT(*) as n FROM contacts").get().n;
    if (n < 1000) throw new Error(`联系人数量异常: ${n}`);
    console.log(`  联系人: ${n} 条`);
    const s = db.prepare("SELECT COUNT(*) as n FROM send_log").get().n;
    console.log(`  发送日志: ${s} 条`);
    const i = db.prepare("SELECT COUNT(*) as n FROM inbox").get().n;
    console.log(`  收件箱: ${i} 封`);
  });

  // 联系人 CRUD
  await test("联系人查询", () => {
    const db = require("../electron/modules/services/contacts-db");
    const all = db.listAll();
    if (!all.length) throw new Error("联系人列表为空");
    const one = db.getByEmail(all[0].email);
    if (!one) throw new Error("按邮箱查失败");
  });

  // 阶段推进
  await test("阶段门控", () => {
    const db = require("../electron/modules/services/contacts-db");
    const all = db.listAll();
    const testContact = all[0];
    const origStage = testContact.stage || "cold";
    // 向前推进应该成功
    const next = { cold: "f1", f1: "f2", f2: "f3", f3: "f4", f4: "f4" }[origStage];
    db.setStage(testContact.id, next, "smoke-test");
    const after = db.getById(testContact.id);
    if (after.stage !== next) throw new Error(`阶段未推进: ${origStage}→${after.stage}`);
    // 恢复
    db.update(testContact.id, { stage: origStage });
    console.log(`  阶段测试: ${origStage}→${next}→${origStage} ✅`);
  });

  // 标签操作
  await test("标签门控", () => {
    const db = require("../electron/modules/services/contacts-db");
    const all = db.listAll();
    const testContact = all[0];
    db.addTag(testContact.id, "reached");
    const after = db.getById(testContact.id);
    if (!after.tags.includes("reached")) throw new Error("标签未添加");
    db.removeTag(testContact.id, "reached");
    console.log("  标签测试: 添加→验证→移除 ✅");
  });

  // 导出
  await test("数据导出", () => {
    const contactsDb = require("../electron/modules/services/contacts-db");
    const data = contactsDb.listAll();
    if (!Array.isArray(data)) throw new Error("listAll 返回非数组");
    if (!data[0].email) throw new Error("联系人缺 email 字段");
  });

  // 仪表盘统计
  await test("仪表盘统计", () => {
    const dashboard = require("../electron/modules/services/dashboard-service");
    const stats = dashboard.getStats({ sendQueue: [] });
    if (typeof stats.sentToday !== "number") throw new Error("sentToday 不是数字");
    if (typeof stats.dailyLimit !== "number") throw new Error("dailyLimit 不是数字");
    console.log(`  今日已发: ${stats.sentToday} / ${stats.dailyLimit}`);
  });

  // 阶段/标签服务
  await test("contacts-service 工具函数", () => {
    const svc = require("../electron/modules/services/contacts-service");
    const r = svc.splitName("Carlos Ruiz");
    if (r.firstName !== "Carlos" || r.lastName !== "Ruiz") throw new Error("姓名拆分失败");
    const c = svc.normalizeCountry("巴西");
    if (c !== "Brazil") throw new Error("国家标准化失败");
    console.log(`  拆分: Carlos Ruiz → ${r.firstName} ${r.lastName}, 巴西 → ${c} ✅`);
  });

  // 结果
  console.log("\n─── 结果 ───");
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  console.log(`✅ ${ok.length} 通过`);
  console.log(`❌ ${fail.length} 失败`);
  fail.forEach((f) => console.log(`   - ${f.name}: ${f.error}`));
  process.exit(fail.length > 0 ? 1 : 0);
}

run();
