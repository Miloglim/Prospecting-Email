// ── 从背调报告提取待发送邮件 → send-batch.json ─────────────────────
// 用法: node send/extract.js "reports/客户背调报告-YYYY-MM-DD.md"
// 提取规则:
//   公司名 ← ### 标题
//   收件人 ← 📧 **To:** `email` (新格式) 或 信息卡中的 📧 收件人字段
//   主题   ← **Asunto:** 或 **Assunto:**
//   正文   ← 主题之后到签名档之前

const fs = require("fs");
const path = require("path");

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("用法: node send/extract.js <报告.md>");
  process.exit(1);
}

const content = fs.readFileSync(reportPath, "utf-8");

// ── 签名档标记（在此截断正文）────────────────────────────────────────
const SIG_MARKERS = [
  "金颖哲 Zayne Jin",
  "---",
  "> 📅",
  "> 共 **20",
  "> 🔴 A 级",
];

// ── 按公司块切分（## 二级标题或 ### 三级标题）──────────────────────
const blocks = content.split(/\n(?=###?\s+#?\d+\s)/);

const emails = [];
let skippedNoEmail = 0;
let skippedNoSubject = 0;

for (const block of blocks) {
  // ── 提取公司名 ────────────────────────────────────────────────────
  const companyMatch = block.match(/^###?\s+#?\d+\s+(.+?)$/m);
  const rawCompany = companyMatch ? companyMatch[1].trim() : "";
  // 清理 emoji 和标签
  const company = rawCompany
    .replace(/[🔴🟡🟣⚫🤝⚠️⭐🏆]/g, "")
    .replace(/\s*🇧🇷\s*|\s*🇲🇽\s*/g, "")
    .replace(/\s*—.*$/, "")
    .trim();

  // 跳过信息不足的块
  if (
    block.includes("信息不足") ||
    block.includes("⚠️ 不足") ||
    !company
  ) {
    continue;
  }

  // ── 提取收件人邮箱 ────────────────────────────────────────────────
  let to = "";

  // 方式1: 新格式 📧 **To:** `email@domain.com`
  const toMatch = block.match(/📧\s*\*?\*?To:?\*?\*?\s*`?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})`?/);
  if (toMatch) {
    to = toMatch[1];
  }

  // 方式2: 信息卡中的 📧 收件人
  if (!to) {
    const cardEmailMatch = block.match(/📧\s*收件人[：:]\s*`?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})`?/);
    if (cardEmailMatch) {
      to = cardEmailMatch[1];
    }
  }

  // 方式3: 任意 `email@domain.com` 格式（取第一个）
  if (!to) {
    const anyEmail = block.match(/`([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})`/);
    if (anyEmail) {
      to = anyEmail[1];
    }
  }

  // 跳过没有收件人的
  if (!to || to.includes("待手动") || to.includes("N/A")) {
    skippedNoEmail++;
    continue;
  }

  // ── 提取主题 ──────────────────────────────────────────────────────
  const subjectMatch = block.match(/\*\*Asunto:\*\*\s*(.+?)$/m) ||
                       block.match(/\*\*Assunto:\*\*\s*(.+?)$/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : "";

  if (!subject) {
    skippedNoSubject++;
    continue;
  }

  // ── 提取正文 ──────────────────────────────────────────────────────
  // 从主题行之后开始
  const subjectPos = block.indexOf(subjectMatch[0]);
  const afterSubject = block.slice(subjectPos + subjectMatch[0].length);

  // 逐行读取，到签名档标记时停止
  const lines = afterSubject.split("\n");
  const bodyLines = [];
  let started = false;

  for (const line of lines) {
    // 跳过主题行后面的空行，等待正文开始
    if (!started && line.trim() === "") {
      started = true;
      continue;
    }
    if (!started) continue;

    // 检查签名档标记
    let hitSig = false;
    for (const marker of SIG_MARKERS) {
      if (line.includes(marker)) {
        hitSig = true;
        break;
      }
    }
    if (hitSig) break;

    bodyLines.push(line);
  }

  let body = bodyLines.join("\n").trim();

  // 追加标准签名档
  body +=
    "\n\n---\n金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\n📧 zayne_jin@trimanshipping.com | 📱 +86 18487665870 | 🌐 www.yqn.com";

  emails.push({ company, to, subject, body });
}

// ── 输出 ──────────────────────────────────────────────────────────────
const outputPath = path.join(__dirname, "send-batch.json");
const batch = {
  source: reportPath,
  generated: new Date().toISOString(),
  total: emails.length,
  emails,
};

fs.writeFileSync(outputPath, JSON.stringify(batch, null, 2));

console.log("═══════════════════════════════════════");
console.log(`📊 提取结果`);
console.log("═══════════════════════════════════════");
console.log(`  ✅ 可发送: ${emails.length} 封`);
console.log(`  ⚠️ 无邮箱跳过: ${skippedNoEmail} 家`);
console.log(`  ⚠️ 无主题跳过: ${skippedNoSubject} 家`);
console.log(`  📁 输出: ${outputPath}`);
console.log("");

if (emails.length > 0) {
  console.log("待发送清单:");
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    console.log(`  ${i + 1}. ${e.company}`);
    console.log(`     📧 ${e.to}`);
    console.log(`     📝 ${e.subject}`);
  }
}
