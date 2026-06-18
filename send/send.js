// ── 开发信自动化发送脚本 ──────────────────────────────────────────────
// 用法: node send/send.js send/send-batch.json
// 特性: 随机延迟(模拟人工) · 工作时间窗口 · 每日限额 · 发送日志

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

// ── 加载配置 ──────────────────────────────────────────────────────────
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

// 安全：SMTP 密码优先从环境变量读取
if (process.env.SMTP_PASS) {
  config.smtp.pass = process.env.SMTP_PASS;
}

// ── 命令行参数 ────────────────────────────────────────────────────────
const batchFile = process.argv[2];
if (!batchFile) {
  console.error("用法: node send/send.js <batch-json-file>");
  console.error("示例: node send/send.js send/send-batch.json");
  process.exit(1);
}

const batch = JSON.parse(fs.readFileSync(batchFile, "utf-8"));
const emails = batch.emails || [];
if (emails.length === 0) {
  console.log("没有待发送邮件。");
  process.exit(0);
}

// ── 每日限额检查 ──────────────────────────────────────────────────────
const logFile = path.join(__dirname, config.tracking.file);
let log = { sent: [], daily_count: 0, last_date: "" };
if (fs.existsSync(logFile)) {
  log = JSON.parse(fs.readFileSync(logFile, "utf-8"));
}
const today = new Date().toISOString().slice(0, 10);
if (log.last_date !== today) {
  log.daily_count = 0;
  log.last_date = today;
}
if (log.daily_count >= config.schedule.max_per_day) {
  console.log(`今日已达上限 (${config.schedule.max_per_day}封)，停止发送。`);
  process.exit(0);
}

// ── SMTP 连接 ──────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: { user: config.smtp.user, pass: config.smtp.pass },
  tls: { rejectUnauthorized: false },
});

// ── 时间窗口检查 ──────────────────────────────────────────────────────
function inSendWindow() {
  const now = new Date();
  const beijingHour = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  ).getHours();
  const start = config.schedule.start_hour_beijing;
  const end = config.schedule.end_hour_beijing;
  if (start < end) return beijingHour >= start && beijingHour < end;
  return beijingHour >= start || beijingHour < end; // 跨午夜
}

// ── 随机延迟 ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomDelay() {
  const min = config.schedule.min_delay_seconds * 1000;
  const max = config.schedule.max_delay_seconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── 加载签名 ──────────────────────────────────────────────────────────
const sigHtmlPath = path.join(__dirname, "signature.html");
let signatureHtml = "";
let signatureText = "";
let hasSigImage = false;
let sigImageCid = "";

if (fs.existsSync(sigHtmlPath)) {
  signatureHtml = fs.readFileSync(sigHtmlPath, "utf-8");
  // 替换变量
  signatureHtml = signatureHtml
    .replace(/\{\{name\}\}/g, config.sender.name)
    .replace(/\{\{email\}\}/g, config.sender.email)
    .replace(/\{\{phone\}\}/g, config.sender.phone || "+86 18487665870")
    .replace(/\{\{website\}\}/g, config.sender.website || "www.yqn.com")
    .replace(/\{\{imageUrl\}\}/g, config.signature?.imageUrl || "");
}

// 文本签名（来自 config）
signatureText = config.signature?.text || "";

// 检查本地签名图
const sigImagePath = path.join(__dirname, "signature.png");
if (fs.existsSync(sigImagePath)) {
  hasSigImage = true;
  sigImageCid = "signature@yqn";
}

// ── 构建邮件体（text + html 双格式）─────────────────────────────────
function buildMailContent(bodyText) {
  // 纯文本：正文 + 分隔线 + 文本签名
  const textBody = bodyText + "\n--\n" + signatureText;

  // HTML：正文转段落
  const htmlBody = bodyText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "<br>";
      if (trimmed === "--" || trimmed === "---") return "<br>";
      return `<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${trimmed}</p>`;
    })
    .join("\n");

  // 拼接签名（如果正文已有 -- 分隔线则不再加）
  const sigBlock = hasSigImage
    ? `<br><img src="cid:${sigImageCid}" style="max-width:200px;height:auto" alt=""><br>` + signatureHtml
    : signatureHtml;

  const fullHtml = htmlBody + "\n" + sigBlock;

  return { text: textBody, html: fullHtml };
}

// ── 发送单封 ──────────────────────────────────────────────────────────
async function sendOne(email, index, total) {
  const { text, html } = buildMailContent(email.body);

  const mailOptions = {
    from: `"${config.sender.name}" <${config.sender.email}>`,
    to: email.to,
    subject: email.subject,
    text: text,
    html: html,
  };

  // 如果有本地签名图，作为内嵌附件
  if (hasSigImage) {
    mailOptions.attachments = [
      {
        filename: "signature.png",
        path: sigImagePath,
        cid: sigImageCid,
      },
    ];
  }
  try {
    const info = await transporter.sendMail(mailOptions);
    const record = {
      index,
      to: email.to,
      company: email.company || "",
      subject: email.subject,
      messageId: info.messageId,
      time: new Date().toISOString(),
      status: "sent",
    };
    log.sent.push(record);
    log.daily_count++;
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    console.log(
      `[${index}/${total}] ✅ ${email.company || email.to} → ${info.messageId}`
    );
    return record;
  } catch (err) {
    const record = {
      index,
      to: email.to,
      company: email.company || "",
      subject: email.subject,
      time: new Date().toISOString(),
      status: "failed",
      error: err.message,
    };
    log.sent.push(record);
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    console.error(`[${index}/${total}] ❌ ${email.company || email.to}: ${err.message}`);
    return record;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`准备发送 ${emails.length} 封邮件...`);
  console.log(`今日已发: ${log.daily_count}/${config.schedule.max_per_day}`);
  console.log("");

  let sent = 0;
  for (let i = 0; i < emails.length; i++) {
    // 检查每日限额
    if (log.daily_count >= config.schedule.max_per_day) {
      console.log(`已达每日上限 (${config.schedule.max_per_day})，剩余 ${emails.length - i} 封将在下次运行发送。`);
      break;
    }

    // 等待进入发送窗口
    while (!inSendWindow()) {
      const waitMin = 5;
      console.log(`⏳ 不在发送窗口，${waitMin}分钟后重试...`);
      await sleep(waitMin * 60 * 1000);
    }

    const email = emails[i];
    const displayIndex = log.daily_count + 1;
    console.log(
      `[${displayIndex}/${config.schedule.max_per_day}] → ${email.company || email.to}`
    );

    await sendOne(email, displayIndex, config.schedule.max_per_day);
    sent++;

    // 最后一封不需要延迟
    if (i < emails.length - 1 && log.daily_count < config.schedule.max_per_day) {
      const delay = randomDelay();
      const sec = Math.round(delay / 1000);
      console.log(`   ⏱ 等待 ${sec}秒...`);
      await sleep(delay);
    }
  }

  console.log("");
  console.log(`发送完成。本轮: ${sent}封 | 今日累计: ${log.daily_count}封`);

  // 关闭连接
  await transporter.close();
}

main().catch((err) => {
  console.error("发送脚本错误:", err);
  process.exit(1);
});
