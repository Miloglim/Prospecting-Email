// ── Prospector — CRM 客户跟进服务 ─────────────────────────────────────────
"use strict";

const contactsDb = require("./contacts-db");
const interactionsDb = require("./interactions-db");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

// ── CRM 邮件本地缓存（独立于 inbox，永久保留）────────────────────────────
function _ensureEmailCache() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS crm_email_cache (
    account_id TEXT NOT NULL, uid TEXT NOT NULL,
    subject TEXT, from_addr TEXT, from_name TEXT, date TEXT, body TEXT,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (account_id, uid)
  )`);
}

// ── 统一标签映射：DB 存英文 key，界面显示中文 label ──────────────────────

const TAG = {
  // ponytail: replied/autoreply/bounced 已迁移到 _status 字段，tags 只保留CRM管线标签
  reached:     { key: "reached",     label: "已触达",   color: "#3b82f6", alias: [] },
  quoting:     { key: "quoting",     label: "报价中",   color: "#2196f3", alias: ["报价中"] },
  trial:       { key: "trial",       label: "试单",     color: "#8e24aa", alias: ["试单"] },
  cooperating: { key: "cooperating", label: "合作中",   color: "#4caf50", alias: ["合作中"] },
  lost:        { key: "lost",        label: "已流失",   color: "#b0b0b0", alias: ["已流失"] },
  reaching:    { key: "reaching",    label: "触达中",   color: "#ff9800", alias: ["触达中"] },
};

// 管线阶段（优先级从高到低）
const PIPELINE_STAGES = [
  { key: TAG.reaching.key,    label: TAG.reaching.label,    color: TAG.reaching.color },
  { key: TAG.quoting.key,     label: TAG.quoting.label,     color: TAG.quoting.color },
  { key: TAG.trial.key,       label: TAG.trial.label,       color: TAG.trial.color },
  { key: TAG.cooperating.key, label: TAG.cooperating.label, color: TAG.cooperating.color },
  { key: TAG.lost.key,        label: TAG.lost.label,        color: TAG.lost.color },
];

const PIPELINE_KEYS = PIPELINE_STAGES.map(s => s.key);

/** _extra.crmPreferences 白名单 */
const PREFERENCE_KEYS = [
  "preferredRoutes", "cargoTypes", "decisionRole",
  "priceSensitivity", "preferredPorts", "annualVolume", "memo",
];

const REMINDER_KEYS = ["nextFollowupAt", "followupNote"];

// ── 管道查询 ──────────────────────────────────────────────────────────────────

function listPipeline(filters = {}) {
  const db = getDb();
  const params = [];
  let where = "1=1";
  if (filters.search) {
    const q = `%${filters.search.toLowerCase()}%`;
    where += ` AND (lower(co.name) LIKE ? OR lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ? OR lower(c.email) LIKE ?)`;
    params.push(q, q, q, q);
  }
  if (filters.country) {
    where += ` AND co.country = ?`;
    params.push(filters.country);
  }

  const allContacts = db.prepare(
    `SELECT c.id, c.company_id, c.email, c.first_name, c.last_name, c.title,
            c.phone, c.linkedin, c.contact_name,
            c.client_type, c.stage, c.tags, c._status,
            c._extra, c.last_sent_at,
            co.name as company_name, co.country as company_country, co.website as company_website,
            (SELECT MAX(cn.created_at) FROM contact_notes cn WHERE cn.contact_id = c.id) as last_note_at
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE ${where}
     ORDER BY c.last_sent_at DESC`
  ).all(...params).map(_normalizeRow);

  // 入口筛选：_status 为 replied/reached，或 tags 含 reached，或已有管线标签
  const isEntry = (row) => {
    // 自动回复硬排除：即使有管线标签也不进管道
    if (row._status === 'autoreply') return false;
    const tags = row.tags || [];
    // 门票：replied（来自 _status，兼容中英文）
    if (row._status === 'replied') return true;
    if (tags.some(x => TAG.reached.key === x || (TAG.reached.alias || []).includes(x))) return true;
    // 已有管线阶段标签的直接进
    if (tags.some(x => PIPELINE_KEYS.some(k => x === k || Object.values(TAG).find(t => t.key === k)?.alias?.includes(x)))) return true;
    return false;
  };
  const entered = allContacts.filter(c => isEntry(c));

  // 按管线阶段分类
  const columns = PIPELINE_STAGES.map(s => ({ key: s.key, label: s.label, color: s.color, contacts: [] }));
  const defaultCol = columns.find(x => x.key === TAG.reaching.key);
  const matchKey = (tags, stageDef) => {
    const keys = [stageDef.key, ...Object.values(TAG).find(t => t.key === stageDef.key)?.alias || []];
    return tags.some(t => keys.includes(t));
  };
  for (const c of entered) {
    const tags = c.tags || [];
    let matched = false;
    for (const s of PIPELINE_STAGES) {
      if (matchKey(tags, s)) {
        columns.find(x => x.key === s.key)?.contacts.push(c);
        matched = true;
        break;
      }
    }
    if (!matched && defaultCol) { defaultCol.contacts.push(c); }
  }

  Log.info("CRM", `入口: ${entered.length}人 列: ${columns.map(c => c.label + '(' + c.contacts.length + ')').join(' ')}`);
  return { columns };
}

// ── 阶段切换 ──────────────────────────────────────────────────────────────────

function setStage(contactId, newKey) {
  if (!PIPELINE_KEYS.includes(newKey)) {
    return { ok: false, error: `无效阶段: ${newKey}` };
  }

  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  // 清除旧管线标签，写入新标签
  const oldTags = contact.tags || [];
  const newTags = [...new Set([...oldTags.filter(t => !PIPELINE_KEYS.includes(t)), newKey])];

  contactsDb.update(contactId, { tags: newTags });

  try {
    interactionsDb.add({
      contact_id: contactId, company_id: contact.company_id || "",
      type: "stage_changed", direction: "internal",
      subject: "阶段变更", snippet: `${oldTags.join(',') || '无'} → ${newKey}`,
    });
  } catch (e) { Log.error("CRM", "写审计记录失败", e.stack); }

  Log.info("CRM", "阶段变更", { contactId, newKey });
  return { ok: true, data: { id: contactId, tags: newTags } };
}

// ── 扩展字段更新 ──────────────────────────────────────────────────────────────

function updateExtra(contactId, patch) {
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const extra = contact._extra || {};

  if (patch.crmPreferences) {
    const prefs = {};
    for (const k of PREFERENCE_KEYS) {
      if (k in patch.crmPreferences) prefs[k] = patch.crmPreferences[k];
    }
    extra.crmPreferences = { ...(extra.crmPreferences || {}), ...prefs };
  }

  if (patch.crmReminder) {
    const reminder = {};
    for (const k of REMINDER_KEYS) {
      if (k in patch.crmReminder) reminder[k] = patch.crmReminder[k];
    }
    extra.crmReminder = { ...(extra.crmReminder || {}), ...reminder };
  }

  contactsDb.update(contactId, { _extra: extra });
  return { ok: true, data: { id: contactId, _extra: extra } };
}

// ── 联系人详情 ────────────────────────────────────────────────────────────────

function getDetail(contactId) {
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const db = getDb();
  const notes = db.prepare("SELECT id, content, created_at, updated_at FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC").all(contactId);
  const interactions = interactionsDb.list({ contact_id: contactId, limit: 100 });

  return { ok: true, data: { contact, notes, interactions } };
}

// ── 跟进备注 ──────────────────────────────────────────────────────────────────

function saveNote(contactId, content) {
  if (!content || !content.trim()) return { ok: false, error: "内容不能为空" };
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const { randomUUID: uuid } = require("crypto");
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO contact_notes (id, contact_id, content, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, contactId, content.trim(), now, now);

  Log.info("CRM", "跟进备注已保存", { contactId, noteId: id });
  return { ok: true, data: { id, contact_id: contactId, content: content.trim(), created_at: now, updated_at: now } };
}

// ── 到期提醒检查 ──────────────────────────────────────────────────────────────

function checkReminders() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.id, c.first_name, c.last_name, c.email, c._extra, c.tags,
            co.name as company_name, co.country as company_country
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE c._extra LIKE '%nextFollowupAt%'`
  ).all().map(r => {
    try { r._extra = JSON.parse(r._extra || "{}"); } catch { r._extra = {}; }
    return r;
  });

  const due = []; const overdue = [];
  for (const r of rows) {
    const reminder = r._extra?.crmReminder;
    if (!reminder?.nextFollowupAt) continue;
    const t = new Date(reminder.nextFollowupAt).getTime();
    if (isNaN(t)) continue;
    if (t <= Date.now()) overdue.push(r);
    else if (t <= Date.now() + 24 * 3600 * 1000) due.push(r);
  }
  return { ok: true, data: { due, overdue } };
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function _normalizeRow(r) {
  if (!r) return r;
  if (typeof r.tags === 'string') { try { r.tags = JSON.parse(r.tags || "[]"); } catch { r.tags = []; } }
  if (!Array.isArray(r.tags)) r.tags = [];
  try { r._extra = JSON.parse(r._extra || "{}"); } catch { r._extra = {}; }
  r.company = r.company_name || "";
  r.country = r.company_country || "";
  r.firstName = r.first_name || "";
  r.lastName = r.last_name || "";
  return r;
}

// ── 邮件查询 ──────────────────────────────────────────────────────────────────

function getContactEmails(contactId) {
  if (!contactId) return { ok: false, error: "参数缺失" };
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };
  const db = getDb();
  const rows = db.prepare(
    `SELECT uid, subject, from_addr, from_name, date, body, type FROM inbox
     WHERE from_addr = ? OR contact_db_id = ? OR contact_id = ?
     ORDER BY date DESC LIMIT 50`
  ).all(contact.email, contactId, contactId);
  return { ok: true, data: rows };
}

function getEmailBody(uid, accountId) {
  if (!uid) return { ok: false, error: "参数缺失" };
  _ensureEmailCache();
  const db = getDb();

  // 1. 先查本地永久缓存
  const cached = db.prepare("SELECT subject, from_addr, from_name, date, body FROM crm_email_cache WHERE uid = ? AND account_id = ?").get(uid, accountId || '');
  if (cached) return { ok: true, data: cached };

  // 2. 缓存未命中 → 查 inbox
  let row;
  if (accountId) {
    row = db.prepare("SELECT subject, from_addr, from_name, date, body, type FROM inbox WHERE uid = ? AND account_id = ?").get(uid, accountId);
  }
  if (!row) {
    row = db.prepare("SELECT subject, from_addr, from_name, date, body, type FROM inbox WHERE uid = ? LIMIT 1").get(uid);
  }
  if (!row) return { ok: false, error: "邮件不存在" };

  // 3. 写入永久缓存（异步，不阻塞返回）
  try {
    db.prepare("INSERT OR IGNORE INTO crm_email_cache (account_id, uid, subject, from_addr, from_name, date, body, cached_at) VALUES (?,?,?,?,?,?,?,?)").run(
      accountId || '', uid, row.subject, row.from_addr, row.from_name, row.date, row.body, new Date().toISOString());
  } catch { /* 缓存写入失败不影响主流程 */ }

  return { ok: true, data: row };
}

module.exports = { listPipeline, setStage, updateExtra, getDetail, saveNote, checkReminders, getContactEmails, getEmailBody, PIPELINE_STAGES, TAG };
