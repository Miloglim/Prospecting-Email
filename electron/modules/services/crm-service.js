// ── Prospector — CRM 客户跟进服务 ─────────────────────────────────────────
"use strict";

const contactsDb = require("./contacts-db");
const interactionsDb = require("./interactions-db");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 管道阶段定义 — 对齐联系人列表标签字段 + 收件箱自动标签 */
const PIPELINE_STAGES = [
  { stage: "有回复",   color: "#22a644" },
  { stage: "自动回复", color: "#e6a817" },
  { stage: "退信",     color: "#d93025" },
  { stage: "报价中",   color: "#2196f3" },
  { stage: "试单",     color: "#8e24aa" },
  { stage: "合作中",   color: "#4caf50" },
  { stage: "已流失",   color: "#b0b0b0" },
  { stage: "触达中",   color: "#ff9800" },
  { stage: "未标签",   color: "#9e9e9e" },
];

// 标签匹配优先级：收件箱标签 > 联系人面板标签 > 未标签
// tags[0] = 写入时使用的标准值（联系人面板中文）
const TAG_RULES = [
  { stage: "有回复",   tags: ["有回复", "replied"] },
  { stage: "自动回复", tags: ["自动回复", "autoreply", "auto_reply"] },
  { stage: "退信",     tags: ["退信", "bounced_by_contact"] },
  { stage: "报价中",   tags: ["报价中"] },
  { stage: "试单",     tags: ["试单"] },
  { stage: "合作中",   tags: ["合作中"] },
  { stage: "已流失",   tags: ["已流失"] },
  { stage: "触达中",   tags: ["触达中", "已触达", "reached"] },
];

/** opp_stage 手动阶段白名单 */
const MANUAL_STAGES = ["报价中", "试单", "合作中", "已流失"];

/** _extra.crmPreferences 白名单 */
const PREFERENCE_KEYS = [
  "preferredRoutes", "cargoTypes", "decisionRole",
  "priceSensitivity", "preferredPorts", "annualVolume", "memo",
];

/** _extra.crmReminder 白名单 */
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

  // 排除 opp_stage 已手动归入报价中/试单/合作中/已流失的联系人（这些由 CRM 人工管）
  const manualSet = new Set(MANUAL_STAGES);
  const allContacts = db.prepare(
    `SELECT c.id, c.company_id, c.email, c.first_name, c.last_name, c.title,
            c.phone, c.linkedin, c.position, c.contact_name,
            c.client_type, c.stage, c.tags, c.opp_stage,
            c._extra, c.last_sent_at,
            co.name as company_name, co.country as company_country, co.website as company_website
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE ${where}
     ORDER BY c.last_sent_at DESC`
  ).all(...params).map(_normalizeRow).filter(c => !manualSet.has(c.opp_stage));

  // 按标签分类
  const columns = PIPELINE_STAGES.map(s => ({ ...s, label: s.stage, contacts: [] }));
  const untagged = [];

  for (const c of allContacts) {
    const tags = c.tags || [];
    let matched = false;
    for (const rule of TAG_RULES) {
      if (tags.some(t => rule.tags.includes(t))) {
        const col = columns.find(x => x.stage === rule.stage);
        if (col) { col.contacts.push(c); matched = true; }
        break;
      }
    }
    if (!matched) untagged.push(c);
  }
  const untaggedCol = columns.find(x => x.stage === "未标签");
  if (untaggedCol) untaggedCol.contacts = untagged;

  return { columns };
}

// ── 阶段切换 ──────────────────────────────────────────────────────────────────

/**
 * 设置联系人销售阶段，同时写审计记录
 * @param {string} contactId
 * @param {string} newStage
 */
function setStage(contactId, newStage) {
  const validStages = PIPELINE_STAGES.map(s => s.stage);
  if (!validStages.includes(newStage)) {
    return { ok: false, error: `无效阶段: ${newStage}` };
  }

  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const oldTags = contact.tags || [];
  // 清除旧标签类别，写入新标签
  const ALL_TAG_VALS = TAG_RULES.flatMap(r => r.tags);
  const newTags = oldTags.filter(t => !ALL_TAG_VALS.includes(t));
  const rule = TAG_RULES.find(r => r.stage === newStage);
  if (rule) newTags.push(rule.tags[0]); // 用标准 key（英文）
  contactsDb.update(contactId, { tags: newTags });

  try {
    interactionsDb.add({
      contact_id: contactId, company_id: contact.company_id || "",
      type: "stage_changed", direction: "internal",
      subject: "标签变更", snippet: `${oldTags.join(',') || '无'} → ${newTags.join(',')}`,
    });
  } catch (e) { Log.error("CRM", "写审计记录失败", e.stack); }

  Log.info("CRM", "标签变更", { contactId, newTags });
  return { ok: true, data: { id: contactId, tags: newTags } };
}

// ── 扩展字段更新 ──────────────────────────────────────────────────────────────

/**
 * 更新联系人 _extra 中的 CRM 相关字段（白名单校验）
 * @param {string} contactId
 * @param {{ crmPreferences?: object, crmReminder?: object }} patch
 */
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
  Log.info("CRM", "扩展字段更新", { contactId });
  return { ok: true, data: { id: contactId, _extra: extra } };
}

// ── 联系人详情 ────────────────────────────────────────────────────────────────

/**
 * 获取联系人详情（含偏好、备注时间线、互动记录）
 * @param {string} contactId
 */
function getDetail(contactId) {
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const db = getDb();
  const notes = db.prepare(
    "SELECT id, content, created_at, updated_at FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC"
  ).all(contactId);

  const interactions = interactionsDb.list({ contact_id: contactId, limit: 100 });

  return { ok: true, data: { contact, notes, interactions } };
}

// ── 跟进备注 ──────────────────────────────────────────────────────────────────

/**
 * 保存跟进备注
 * @param {string} contactId
 * @param {string} content
 */
function saveNote(contactId, content) {
  if (!content || !content.trim()) return { ok: false, error: "内容不能为空" };

  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const { randomUUID: uuid } = require("crypto");
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO contact_notes (id, contact_id, content, created_at, updated_at) VALUES (?,?,?,?,?)"
  ).run(id, contactId, content.trim(), now, now);

  Log.info("CRM", "跟进备注已保存", { contactId, noteId: id });
  return { ok: true, data: { id, contact_id: contactId, content: content.trim(), created_at: now, updated_at: now } };
}

// ── 到期提醒检查 ──────────────────────────────────────────────────────────────

/**
 * 检查到期/逾期提醒
 * @returns {{ due: object[], overdue: object[] }}
 */
function checkReminders() {
  const db = getDb();

  // 查所有有 nextFollowupAt 的联系人（不限标签/阶段）
  const rows = db.prepare(
    `SELECT c.id, c.first_name, c.last_name, c.email, c._extra, c.tags, c.opp_stage,
            co.name as company_name, co.country as company_country
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE c._extra LIKE '%nextFollowupAt%'`
  ).all().map(r => {
    try { r._extra = JSON.parse(r._extra || "{}"); } catch { r._extra = {}; }
    return r;
  });

  const due = [];   // 24h 内到期
  const overdue = []; // 已逾期

  for (const r of rows) {
    const reminder = r._extra?.crmReminder;
    if (!reminder?.nextFollowupAt) continue;
    const followupTime = new Date(reminder.nextFollowupAt).getTime();
    if (isNaN(followupTime)) continue;

    if (followupTime <= Date.now()) {
      overdue.push(r);
    } else if (followupTime <= Date.now() + 24 * 3600 * 1000) {
      due.push(r);
    }
  }

  return { ok: true, data: { due, overdue } };
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function _normalizeRow(r) {
  if (!r) return r;
  if (typeof r.tags === 'string') {
    try { r.tags = JSON.parse(r.tags || "[]"); } catch { r.tags = []; }
  }
  if (!Array.isArray(r.tags)) r.tags = [];
  try { r._extra = JSON.parse(r._extra || "{}"); } catch { r._extra = {}; }
  r.company = r.company_name || "";
  r.country = r.company_country || "";
  r.firstName = r.first_name || "";
  r.lastName = r.last_name || "";
  return r;
}

module.exports = { listPipeline, setStage, updateExtra, getDetail, saveNote, checkReminders, PIPELINE_STAGES };
