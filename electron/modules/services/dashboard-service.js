// ── 仪表盘统计服务 ──────────────────────────────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { APP_ROOT } = require("../config");

function getStats(deps) {
  let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500, firstSendAt = 0;
  try {
    const lp = path.join(APP_ROOT, "send", "send-log.json");
    if (fs.existsSync(lp)) {
      const log = JSON.parse(fs.readFileSync(lp, "utf-8"));
      const fsAt = log.first_send_at || 0;
      // 24h窗口内才统计今日发送，过期则归零
      if (fsAt > 0 && (Date.now() - fsAt) <= 24 * 3600 * 1000) {
        sentToday = log.daily_count || 0;
        firstSendAt = fsAt;
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
