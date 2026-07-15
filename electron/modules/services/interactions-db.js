// ── Outreacher — 互动记录 ───────────────────────────────────────────────────
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

module.exports = { add, list };
