// ── Prospector — 联系人 SQLite CRUD（替换 contacts.json）─────────────────────
"use strict";

const { getDb } = require("./db");
const { v4: uuid } = require("uuid");
const { Log } = require("../core/logger");

const CONTACT_SELECT = `
  c.id, c.company_id, c.email, c.first_name, c.last_name, c.title,
  c.phone, c.linkedin, c.position, c.contact_name,
  c.client_type, c.category, c.stage, c.last_sent_at, c.last_sent_acct,
  c.is_bounced, c.bounce_type, c.bounce_reason, c.bounced_at,
  c.tags, c.opp_stage, c._suspicious, c.followup_note,
  c.created_at, c.updated_at,
  co.name as company_name, co.country as company_country,
  co.website as company_website
`;

const CONTACT_FROM = `contacts c LEFT JOIN companies co ON co.id = c.company_id`;

function _row(r) {
  if (!r) return null;
  try { r.tags = JSON.parse(r.tags || "[]"); } catch { r.tags = []; }
  // 兼容旧字段名（渲染层和旧 IPC 接口依赖这些别名）
  r.company = r.company_name || "";
  r.country = r.company_country || "";
  r.website = r.company_website || "";
  r.contactName = r.contact_name || "";
  r.firstName = r.first_name || "";
  r.lastName = r.last_name || "";
  r.bounced = !!r.is_bounced;
  r._sentBy = r.last_sent_acct || "";
  r._sentAt = r.last_sent_at || "";
  r._sentAccount = r.last_sent_acct || "";
  r.clientType = r.client_type || "unlabeled";
  r.bounceType = r.bounce_type || "";
  r.bounceReason = r.bounce_reason || "";
  return r;
}

// ── 查询（对齐旧 contacts.json 接口）──────────────────────────────────────────

/** 全部联系人列表 */
function listAll() {
  const db = getDb();
  return db.prepare(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} ORDER BY c.created_at DESC`).all().map(_row);
}

/** 按条件查询 */
function query({ stage, client_type, company_id, is_bounced, limit, offset } = {}) {
  const db = getDb();
  const conds = []; const params = [];
  if (stage) { conds.push("c.stage = ?"); params.push(stage); }
  if (client_type) { conds.push("c.client_type = ?"); params.push(client_type); }
  if (company_id) { conds.push("c.company_id = ?"); params.push(company_id); }
  if (is_bounced !== undefined) { conds.push("c.is_bounced = ?"); params.push(is_bounced ? 1 : 0); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return db.prepare(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit || 10000, offset || 0).map(_row);
}

function getByEmail(email) {
  const db = getDb();
  return _row(db.prepare(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} WHERE c.email = ?`).get((email || "").toLowerCase().trim()));
}

function getById(id) {
  const db = getDb();
  return _row(db.prepare(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} WHERE c.id = ?`).get(id));
}

function search(q) {
  const db = getDb();
  const ql = `%${(q || "").toLowerCase()}%`;
  return db.prepare(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} WHERE lower(c.email) LIKE ? OR lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ? OR lower(c.contact_name) LIKE ? OR lower(co.name) LIKE ? LIMIT 200`)
    .all(ql, ql, ql, ql, ql).map(_row);
}

// ── 写入 ──────────────────────────────────────────────────────────────────────

function upsert(data) {
  const db = getDb();
  const email = (data.email || "").toLowerCase().trim();
  if (!email) return null;

  // 处理公司：有 company 名但无 company_id → 自动创建公司
  let companyId = data.company_id || data.companyId || "";
  const companyName = data.company_name || data.company || "";
  if (!companyId && companyName) companyId = ensureCompany(companyName, { country: data.country || data.company_country || "", website: data.website || "" });

  const existing = db.prepare("SELECT id FROM contacts WHERE email = ?").get(email);
  if (existing) return update(existing.id, data);

  const id = data.id || uuid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO contacts (id,company_id,email,first_name,last_name,title,phone,linkedin,position,contact_name,client_type,category,stage,last_sent_at,last_sent_acct,is_bounced,bounce_type,bounce_reason,tags,assignee,_suspicious,followup_note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.company_id || "", email, data.first_name || "", data.last_name || "",
    data.title || "", data.phone || "", data.linkedin || "", data.position || "",
    data.contactName || data.contact_name || "",
    data.client_type || "unlabeled", data.category || "",
    data.stage || "cold", data.last_sent_at || data._sentAt || "",
    data.last_sent_acct || data._sentAccount || "",
    data.is_bounced || data.bounced ? 1 : 0,
    data.bounce_type || data.bounceType || "", data.bounce_reason || data.bounceReason || "",
    JSON.stringify(data.tags || []), data._suspicious ? 1 : 0,
    data.followup_note || "", now, now,
  );
  return getById(id);
}

function update(id, data) {
  const db = getDb();
  const now = new Date().toISOString();
  // 联系人表的实际列名
  const VALID_COLS = new Set([
    "company_id", "email", "first_name", "last_name", "title", "phone", "linkedin",
    "position", "contact_name", "client_type", "category", "stage",
    "last_sent_at", "last_sent_acct", "is_bounced", "bounce_type", "bounce_reason",
    "bounced_at", "tags", "tags_updated_at", "opp_stage", "assignee", "contact_person", "_suspicious", "followup_note",
  ]);
  const fields = []; const params = [];
  for (const [k, v] of Object.entries(data)) {
    // 跳过 id、时间戳、JOIN 来的公司字段、旧 JSON 字段名
    if (k === "id" || k === "created_at" || k === "updated_at") continue;
    if (k.startsWith("_") && k !== "_suspicious") continue; // 旧内部字段跳过，_suspicious 保留
    if (!VALID_COLS.has(k)) continue;
    if (k === "tags") { fields.push("tags = ?"); params.push(JSON.stringify(v || [])); continue; }
    if (k === "is_bounced") { fields.push("is_bounced = ?"); params.push(v ? 1 : 0); continue; }
    if (k === "_suspicious") { fields.push("_suspicious = ?"); params.push(v ? 1 : 0); continue; }
    if (k === "email") { fields.push("email = ?"); params.push((v || "").toLowerCase().trim()); continue; }
    fields.push(`${k} = ?`); params.push(v);
  }
  if (!fields.length) return getById(id);
  fields.push("updated_at = ?"); params.push(now); params.push(id);
  db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getById(id);
}

// ── 阶段：唯一写入入口 ──────────────────────────────────────────────────────

const VALID_STAGES = ["cold", "f1", "f2", "f3", "f4"];
const ALLOWED_TAGS = ["replied", "bounced_by_contact", "autoreply", "reached", "left_company"];

/**
 * 设置联系人阶段（唯一入口）。只允许向前推进，回退需加 manual: 前缀。
 * 每次变更自动记 interactions。
 */
function setStage(contactId, newStage, reason) {
  if (!VALID_STAGES.includes(newStage)) { Log.warn("DB", `无效阶段: ${newStage}`); return false; }
  const contact = getById(contactId);
  if (!contact) return false;
  const current = (contact.stage || contact._stage || "cold");
  const curIdx = VALID_STAGES.indexOf(current);
  const newIdx = VALID_STAGES.indexOf(newStage);
  if (newIdx < curIdx && !(reason || "").startsWith("manual:")) {
    Log.warn("DB", `阶段回退拦截: ${contact.email} ${current}→${newStage}`);
    return false;
  }
  update(contactId, { stage: newStage });
  try {
    const { add: addInteraction } = require("./interactions-db");
    addInteraction({ contact_id: contactId, company_id: contact.company_id || "", type: "stage_changed", snippet: `${current}→${newStage} ${reason || ""}` });
  } catch { /* 互动记录不影响主流程 */ }
  return true;
}

// ── 标签：唯一写入入口 ──────────────────────────────────────────────────────

function addTag(contactId, tag) {
  if (!ALLOWED_TAGS.includes(tag)) { Log.warn("DB", `无效标签: ${tag}`); return false; }
  const contact = getById(contactId);
  if (!contact) return false;
  const tags = contact.tags || [];
  if (tags.includes(tag)) return false;
  tags.push(tag);
  update(contactId, { tags, tags_updated_at: new Date().toISOString() });
  return true;
}

function removeTag(contactId, tag) {
  const contact = getById(contactId);
  if (!contact) return false;
  const tags = (contact.tags || []).filter((t) => t !== tag);
  update(contactId, { tags, tags_updated_at: new Date().toISOString() });
  return true;
}

function remove(id) {
  getDb().prepare("DELETE FROM contacts WHERE id = ?").run(id);
}

function removeMany(ids) {
  if (!ids?.length) return;
  const ph = ids.map(() => "?").join(",");
  getDb().prepare(`DELETE FROM contacts WHERE id IN (${ph})`).run(...ids);
}

// ── 公司 ──────────────────────────────────────────────────────────────────────

function ensureCompany(name, extra = {}) {
  if (!name?.trim()) return null;
  const db = getDb();
  const existing = db.prepare("SELECT id FROM companies WHERE name = ?").get(name.trim());
  if (existing) return existing.id;
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO companies (id,name,raw_name,country,website,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, name.trim(), name.trim(), extra.country || "", extra.website || "", now, now);
  return id;
}

function listCompanies() {
  return getDb().prepare("SELECT * FROM companies ORDER BY name").all();
}

// ── 迁移 ──────────────────────────────────────────────────────────────────────

/** 从旧的 contacts.json + send-log.json 一次性迁移到 SQLite */
function migrateFromJson(contactsPath, sendLogPath) {
  const fs = require("fs");
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) as n FROM contacts").get().n;
  if (existing > 0) return { migrated: 0, message: "已有数据，跳过迁移" };

  let contacts = [];
  try { if (fs.existsSync(contactsPath)) contacts = JSON.parse(fs.readFileSync(contactsPath, "utf-8")); } catch { return { migrated: 0, error: "contacts.json 读取失败" }; }
  if (!contacts.length) return { migrated: 0, message: "contacts.json 为空" };

  // 从 send-log 推导阶段
  let stageMap = {};
  try {
    if (fs.existsSync(sendLogPath)) {
      const log = JSON.parse(fs.readFileSync(sendLogPath, "utf-8"));
      for (const s of (log.sent || [])) {
        const email = (s.to || "").toLowerCase().trim();
        if (!email) continue;
        const cur = stageMap[email];
        const order = ["cold", "f1", "f2", "f3", "f4"];
        if (!cur || order.indexOf(s._stage || "cold") > order.indexOf(cur)) {
          stageMap[email] = s._stage || "cold";
        }
      }
    }
  } catch { /* 无 send-log 则全为 cold */ }

  const insertContact = db.prepare(`INSERT OR IGNORE INTO contacts (id,company_id,email,first_name,last_name,title,phone,linkedin,position,contact_name,client_type,category,stage,last_sent_at,last_sent_acct,is_bounced,bounce_type,bounce_reason,tags,_suspicious,followup_note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let n = 0;
  const batch = db.transaction(() => {
    for (const c of contacts) {
      if (!c.email) continue;
      const companyId = c.company ? ensureCompany(c.company, { country: c.country, website: c.website }) : null;
      const tags = Array.isArray(c.tags) ? c.tags : (typeof c.tags === "string" ? [c.tags] : []);
      const email = (c.email || "").toLowerCase().trim();
      insertContact.run(
        c.id || uuid(), companyId, email,
        c.firstName || c.first_name || "", c.lastName || c.last_name || "",
        c.title || c.position || "", c.phone || "", c.linkedin || "",
        c.position || "", c.contactName || c.contact_name || "",
        c.clientType || c.client_type || "unlabeled", c.category || "",
        stageMap[email] || c.stage || "cold",
        c._sentAt || c.last_sent_at || "",
        c._sentAccount || c._sentBy || c.last_sent_acct || "",
        c.bounced || c.is_bounced ? 1 : 0,
        c.bounceType || c.bounce_type || "", c.bounceReason || c.bounce_reason || "",
        JSON.stringify(tags),
        c._suspicious ? 1 : 0, c.followup_note || c.followupNote || "",
        c.addedAt || c.created_at || new Date().toISOString(),
      );
      n++;
    }
  });
  batch();
  Log.info("DB", `迁移完成: ${n} 条联系人`);
  return { migrated: n };
}

module.exports = { listAll, query, getById, getByEmail, search, upsert, update, setStage, addTag, removeTag, remove, removeMany, ensureCompany, listCompanies, migrateFromJson };
