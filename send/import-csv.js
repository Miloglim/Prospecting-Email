// ── CSV → 发送模板 JSON ─────────────────────────────────────────────
// 用法: node send/import-csv.js <客户表.csv> > send/template.json
//
// CSV 要求列（列名不区分大小写，自动识别）:
//   必填: to/邮箱/Email/收件人
//   可选: company/公司/Company, subject/主题/Subject, body/正文/Body
//
// 如果 CSV 只有邮箱+公司名，会自动用占位符填充 subject 和 body
// 适合从飞书/Excel 导出的客户表快速生成发送清单

const fs = require("fs");
const path = require("path");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("用法: node send/import-csv.js <客户表.csv>");
  console.error("CSV 必填列: 邮箱/收件人");
  console.error("CSV 可选列: 公司, 主题, 正文");
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, "utf-8");

// ── 简易 CSV 解析 ───────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

// ── 列名映射 ─────────────────────────────────────────────────────────
function findColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase());
    if (idx >= 0) return headers[idx];
  }
  return null;
}

const { headers, rows } = parseCSV(csv);

const colTo = findColumn(headers, ["to", "邮箱", "email", "收件人", "mail"]);
const colCompany = findColumn(headers, ["company", "公司", "公司名", "公司名称", "empresa"]);
const colSubject = findColumn(headers, ["subject", "主题", "标题", "asunto", "assunto"]);
const colBody = findColumn(headers, ["body", "正文", "内容", "corpo"]);

if (!colTo) {
  console.error("❌ CSV 缺少邮箱列。请确保有一列为: 邮箱/Email/收件人");
  process.exit(1);
}

// ── 默认签名档 ───────────────────────────────────────────────────────
const SIGNATURE =
  "\n\n---\n金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\n📧 zayne_jin@trimanshipping.com | 📱 +86 18487665870 | 🌐 www.yqn.com";

// ── 生成 ──────────────────────────────────────────────────────────────
const emails = [];
let placeholderCount = 0;

for (const row of rows) {
  const to = row[colTo];
  if (!to || !to.includes("@")) continue;

  const company = colCompany ? row[colCompany] : "";
  let subject = colSubject ? row[colSubject] : "";
  let body = colBody ? row[colBody] : "";

  // 缺主题/正文时用占位符标记，发送前需人工替换
  if (!subject) {
    subject = `[待填写主题 — ${company || to}]`;
    placeholderCount++;
  }
  if (!body) {
    body = `[待填写正文 — ${company || to}]` + SIGNATURE;
    placeholderCount++;
  }

  emails.push({ to, company: company || "", subject, body });
}

const batch = {
  source: csvPath,
  generated: new Date().toISOString(),
  total: emails.length,
  emails,
};

console.log(JSON.stringify(batch, null, 2));

// stderr 输出统计信息
console.error("═══════════════════════════════════════");
console.error(`📊 CSV 导入结果`);
console.error("═══════════════════════════════════════");
console.error(`  ✅ 导入: ${emails.length} 封`);
if (placeholderCount > 0) {
  console.error(`  ⚠️ 占位符: ${placeholderCount} 处（标记 [待填写...]，发送前请替换）`);
}
console.error(`  💡 保存: node send/import-csv.js file.csv > send/template.json`);
