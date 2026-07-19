// ── Prospector — CRM 客户跟进服务 ─────────────────────────────────────────
"use strict";

const contactsDb = require("./contacts-db");
const interactionsDb = require("./interactions-db");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

// ── 统一标签映射：DB 存英文 key，界面显示中文 label ──────────────────────

const TAG = {
  replied:     { key: "replied",     label: "有回复",   color: "#22a644", alias: ["有回复"] },
  autoreply:   { key: "autoreply",   label: "自动回复", color: "#e6a817", alias: ["自动回复", "auto_reply"] },
  bounced:     { key: "bounced",     label: "退信",     color: "#d93025", alias: ["bounced_by_contact", "退信"] },
  reached:     { key: "reached",     label: "已触达",   color: "#3b82f6", alias: ["已触达"] },
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
            c.phone, c.linkedin, c.position, c.contact_name,
            c.client_type, c.stage, c.tags,
            c._extra, c.last_sent_at,
            co.name as company_name, co.country as company_country, co.website as company_website
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE ${where}
     ORDER BY c.last_sent_at DESC`
  ).all(...params).map(_normalizeRow);

  // 入口筛选：有 replied/reached，或有任意管线标签
  const isEntry = (tags) => {
    // 门票：replied 或 reached
    if (tags.some(x => [TAG.replied, TAG.reached].some(t => x === t.key || (t.alias || []).includes(x)))) return true;
    // 已有管线阶段标签的直接进
    if (tags.some(x => PIPELINE_KEYS.some(k => x === k || Object.values(TAG).find(t => t.key === k)?.alias?.includes(x)))) return true;
    return false;
  };
  const entered = allContacts.filter(c => isEntry(c.tags || []));

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

// ── 邮件正文查询 ──────────────────────────────────────────────────────────────

function getEmailBody(uid, accountId) {
  if (!uid) return { ok: false, error: "参数缺失" };
  const db = getDb();
  let row;
  if (accountId) {
    row = db.prepare("SELECT subject, from_addr, from_name, date, body, type FROM inbox WHERE uid = ? AND account_id = ?").get(uid, accountId);
  }
  if (!row) {
    row = db.prepare("SELECT subject, from_addr, from_name, date, body, type FROM inbox WHERE uid = ? LIMIT 1").get(uid);
  }
  if (!row) return { ok: false, error: "邮件不存在" };
  return { ok: true, data: row };
}

module.exports = { listPipeline, setStage, updateExtra, getDetail, saveNote, checkReminders, getEmailBody, PIPELINE_STAGES, TAG };
