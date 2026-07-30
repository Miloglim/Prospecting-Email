// ── 仪表盘统计服务 ──────────────────────────────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { APP_ROOT } = require("../config");
const { beijingToday } = require("../utils");

async function getStats(deps) {
  let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500, firstSendAt = 0;
  // 从 SQLite 读取今日已发
  try {
    const db = require("./db").getDb();
    const today = beijingToday();
    const row = db.prepare("SELECT COUNT(*) as n, MIN(time) as first_time FROM send_log WHERE status = 'sent' AND time_beijing LIKE ?").get(today + '%');
    sentToday = row?.n || 0;
    if (row?.first_time) firstSendAt = new Date(row.first_time).getTime();
  } catch { /* 降级 */ }

  // 24h 到期自动生成昨日报告（不依赖用户手动发信触发）
  try {
    const logPath = path.join(APP_ROOT, 'send', 'send-log.json');
    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      const firstAt = log.first_send_at || 0;
      if (firstAt > 0 && (Date.now() - firstAt) > 24 * 3600 * 1000) {
        const reportService = require("./report-service");
        const result = await reportService.generate(null, { isAuto: true });
        reportService.saveToDb(result.data);
        log.first_send_at = 0;
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
        // 自动生成 PDF
        try {
          const { BrowserWindow } = require("electron");
          const win = new BrowserWindow({ width: 800, height: 1000, show: false });
          await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(result.html));
          const today = new Date().toISOString().slice(0, 10);
          const pdfPath = path.join(APP_ROOT, "send", "reports", `今日报告-${today}-auto.pdf`);
          const dir = path.dirname(pdfPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const pdfData = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
          fs.writeFileSync(pdfPath, pdfData);
          win.close();
        } catch { /* PDF 生成失败不影响主流程 */ }
      }
    }
  } catch { /* 降级 */ }
  try {
    const sendLog = require("./send-log-db");
    totalSent = sendLog.list({ limit: 100000 }).total;
    // failed count approximate
    const failed = require("./db").getDb().prepare("SELECT COUNT(*) as n FROM send_log WHERE status = 'failed'").get();
    totalFailed = failed?.n || 0;
  } catch { /* 降级 */ }
  try {
    const cp = path.join(APP_ROOT, "send", "config.json");
    if (fs.existsSync(cp)) {
      const config = JSON.parse(fs.readFileSync(cp, "utf-8"));
      const accounts = config.smtpAccounts || [];
      if (accounts.length > 0) {
        dailyLimit = accounts.filter((a) => a.active !== false).reduce((sum, a) => sum + (a.dailyLimit || 500), 0);
      } else {
        dailyLimit = config.schedule?.max_per_day || 500;
      }
    }
  } catch { /* 降级 */ }
  return { sentToday, dailyLimit, remaining: Math.max(0, dailyLimit - sentToday), totalSent, totalFailed, queueLength: deps?.sendQueue?.length || 0, firstSendAt };
}

module.exports = { getStats };
