// ── 仪表盘统计服务 ──────────────────────────────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { APP_ROOT } = require("../config");
const { beijingToday } = require("../utils");

function getStats(deps) {
  let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500, firstSendAt = 0;
  // 从 SQLite 读取今日已发（send-engine 已迁移到 SQLite，JSON 文件不再更新）
  try {
    const db = require("./db").getDb();
    const today = beijingToday();
    const row = db.prepare("SELECT COUNT(*) as n, MIN(time) as first_time FROM send_log WHERE status = 'sent' AND time_beijing LIKE ?").get(today + '%');
    sentToday = row?.n || 0;
    if (row?.first_time) firstSendAt = new Date(row.first_time).getTime();
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
