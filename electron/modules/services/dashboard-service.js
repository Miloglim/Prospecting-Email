// ── 仪表盘统计服务 ──────────────────────────────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { APP_ROOT } = require("../config");

function beijingToday() {
  const [d] = new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false }).split(", ");
  const [m, day, y] = d.split("/");
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function getStats(deps) {
  const t = beijingToday();
  let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500;
  try {
    const sendLog = require("./send-log-db");
    sentToday = sendLog.list({ date: t, limit: 100000 }).total;
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
  return { sentToday, dailyLimit, remaining: Math.max(0, dailyLimit - sentToday), totalSent, totalFailed, queueLength: deps?.sendQueue?.length || 0 };
}

module.exports = { getStats };
