// ── Prospector — 互动记录 ───────────────────────────────────────────────────
"use strict";

const { getDb } = require("./db");

function add(data) {
  if (!data.contact_id) return null;
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .prepare(`INSERT INTO interactions (contact_id, company_id, type, direction, subject, snippet, email_uid, email_account, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(data.contact_id, data.company_id || "", data.type || "noted", data.direction || "", data.subject || "", data.snippet || "", data.email_uid || "", data.email_account || "", now);
}

function list({ contact_id, limit } = {}) {
  const db = getDb();
  if (contact_id) {
    return db.prepare("SELECT * FROM interactions WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?").all(contact_id, limit || 50);
  }
  return db.prepare("SELECT * FROM interactions ORDER BY created_at DESC LIMIT ?").all(limit || 100);
}

// 启动迁移：补齐旧 sent 记录的 email_uid/email_account（从 send_log 反查）
function backfillSentEmailRefs() {
  try {
    const db = getDb();
    const result = db.prepare(
      `UPDATE interactions
       SET email_uid = COALESCE(
         (SELECT sl.message_id FROM send_log sl
          JOIN contacts c ON lower(c.email) = lower(sl.to_email)
          WHERE c.id = interactions.contact_id AND sl.subject = interactions.subject
          ORDER BY sl.time DESC LIMIT 1),
         email_uid
       ),
       email_account = COALESCE(
         (SELECT sl.account_id FROM send_log sl
          JOIN contacts c ON lower(c.email) = lower(sl.to_email)
          WHERE c.id = interactions.contact_id AND sl.subject = interactions.subject
          ORDER BY sl.time DESC LIMIT 1),
         email_account
       )
       WHERE interactions.type = 'sent'
         AND (interactions.email_uid IS NULL OR interactions.email_uid = '')`
    ).run();
    if (result.changes > 0) {
      const { Log } = require("../core/logger");
      Log.info("DB", `interactions 回填: ${result.changes} 条 sent 记录补全了 email_uid`);
    }
  } catch (e) {
    // 静默 — 回填失败不影响主流程
  }
}

module.exports = { add, list, backfillSentEmailRefs };
