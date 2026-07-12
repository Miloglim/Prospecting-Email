// ── Prospector — 发送日志 SQLite CRUD ────────────────────────────────────────
"use strict";

const { getDb } = require("./db");
const { Log } = require("../core/logger");

function add(record) {
  const db = getDb();
  return db.prepare(`INSERT INTO send_log (row_index, to_email, company, subject, message_id, count, body_id, stage, lang, client_type, country, tpl_info, template_source, template_label, batch_label, time, time_beijing, status, error, test_mode, account_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    record.index || 0, record.to || "", record.company || "", record.subject || "",
    record.messageId || "", record.count || 1, record.bodyId || "",
    record._stage || "", record._lang || "", record._type || "",
    record._country || "", record._tplInfo || "", record._templateSource || "",
    record._templateLabel || "", record._batchLabel || "",
    record.time || "", record.time_beijing || "", record.status || "sent",
    record.error || "", record._test ? 1 : 0, record._accountId || "",
  );
}

function list({ limit, offset, search, type, lang, country, stage, date } = {}) {
  const db = getDb();
  const conds = []; const params = [];
  if (search) { conds.push("(lower(company) LIKE ? OR lower(subject) LIKE ?)"); params.push("%" + search.toLowerCase() + "%", "%" + search.toLowerCase() + "%"); }
  if (type) { conds.push("client_type = ?"); params.push(type); }
  if (lang) { conds.push("lang = ?"); params.push(lang); }
  if (country) { conds.push("country = ?"); params.push(country); }
  if (stage) { conds.push("stage = ?"); params.push(stage); }
  if (date) { conds.push("time_beijing LIKE ?"); params.push(date + "%"); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) as n FROM send_log ${where}`).get(...params).n;
  const records = db.prepare(`SELECT * FROM send_log ${where} ORDER BY time DESC LIMIT ? OFFSET ?`).all(...params, limit || 500, offset || 0);
  return { total, records: records.map(r => ({
    index: r.row_index, to: r.to_email, company: r.company, subject: r.subject,
    messageId: r.message_id, count: r.count, bodyId: r.body_id,
    _stage: r.stage, _lang: r.lang, _type: r.client_type, _country: r.country,
    _tplInfo: r.tpl_info, _templateSource: r.template_source,
    _templateLabel: r.template_label, _batchLabel: r.batch_label,
    time: r.time, time_beijing: r.time_beijing, status: r.status,
    error: r.error, _test: !!r.test_mode, _accountId: r.account_id,
  })) };
}

function getDates() {
  const db = getDb();
  return db.prepare("SELECT time_beijing as date, COUNT(*) as count FROM send_log WHERE time_beijing != '' GROUP BY substr(time_beijing,1,10) ORDER BY date DESC").all();
}

function getBody(bodyId) {
  if (!bodyId) return "";
  const bpath = require("path").join(require("../config").APP_ROOT, "data", "send-bodies.json");
  try {
    const bodies = JSON.parse(require("fs").readFileSync(bpath, "utf-8"));
    return bodies[bodyId] || "";
  } catch { return ""; }
}

// 迁移：从 send-log.json 导入
function migrateFromJson(logPath) {
  const fs = require("fs");
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) as n FROM send_log").get().n;
  if (existing > 0) return { migrated: 0, message: "已有数据" };
  if (!fs.existsSync(logPath)) return { migrated: 0, message: "文件不存在" };
  try {
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const entries = log.sent || [];
    const insert = db.prepare(`INSERT INTO send_log (row_index, to_email, company, subject, message_id, count, body_id, stage, lang, client_type, country, tpl_info, template_source, template_label, batch_label, time, time_beijing, status, error, test_mode, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const batch = db.transaction(() => {
      for (const r of entries) {
        insert.run(
          r.index || 0, r.to || "", r.company || "", r.subject || "",
          r.messageId || "", r.count || 1, r.bodyId || "",
          r._stage || "", r._lang || "", r._type || "",
          r._country || "", r._tplInfo || "", r._templateSource || "",
          r._templateLabel || "", r._batchLabel || "",
          r.time || "", r.time_beijing || "", r.status || "sent",
          r.error || "", r._test ? 1 : 0, r._accountId || "",
        );
      }
    });
    batch();
    Log.info("DB", `send-log 迁移: ${entries.length} 条`);
    return { migrated: entries.length };
  } catch (e) { Log.error("DB", "send-log 迁移失败", e.stack); return { migrated: 0, error: e.message }; }
}

module.exports = { add, list, getDates, getBody, migrateFromJson };
