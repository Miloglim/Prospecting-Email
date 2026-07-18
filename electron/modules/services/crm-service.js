// ── Prospector — CRM 客户跟进服务 ─────────────────────────────────────────
"use strict";

const contactsDb = require("./contacts-db");
const interactionsDb = require("./interactions-db");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 管道阶段定义 */
const PIPELINE_STAGES = [
  { stage: "触达中", label: "触达中", color: "#ff9800" },
  { stage: "报价中", label: "报价中", color: "#2196f3" },
  { stage: "试单", label: "试单", color: "#8e24aa" },
  { stage: "合作中", label: "合作中", color: "#4caf50" },
  { stage: "已流失", label: "已流失", color: "#d93025" },
];

const MANUAL_STAGES = ["报价中", "试单", "合作中", "已流失"];

/** _extra.crmPreferences 白名单 */
const PREFERENCE_KEYS = [
  "preferredRoutes", "cargoTypes", "decisionRole",
  "priceSensitivity", "preferredPorts", "annualVolume", "memo",
];

/** _extra.crmReminder 白名单 */
const REMINDER_KEYS = ["nextFollowupAt", "followupNote"];

// ── 管道查询 ──────────────────────────────────────────────────────────────────

/**
 * 获取管道数据，按阶段分列
 * @param {{ search?: string, country?: string }} filters
 * @returns {{ columns: Array<{ stage: string, label: string, color: string, contacts: object[] }> }}
 */
function listPipeline(filters = {}) {
  const db = getDb();

  // "触达中" 列：自动识别 _status 已触达的客户
  const autoParams = [];
  let autoWhere = `c._status IN ('已触达', '有回复', '自动回复', 'reached', 'replied', 'autoreply') AND (c.opp_stage = '待开发' OR c.opp_stage = '' OR c.opp_stage IS NULL)`;
  if (filters.search) {
    const q = `%${filters.search.toLowerCase()}%`;
    autoWhere += ` AND (lower(co.name) LIKE ? OR lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ? OR lower(c.email) LIKE ?)`;
    autoParams.push(q, q, q, q);
  }
  if (filters.country) {
    autoWhere += ` AND co.country = ?`;
    autoParams.push(filters.country);
  }

  const autoContacts = db.prepare(
    `SELECT c.id, c.company_id, c.email, c.first_name, c.last_name, c.title,
            c.phone, c.linkedin, c.position, c.contact_name,
            c.client_type, c.stage, c._status, c.opp_stage, c.tags,
            c._extra, c.last_sent_at,
            co.name as company_name, co.country as company_country, co.website as company_website
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE ${autoWhere}
     ORDER BY c.last_sent_at DESC`
  ).all(...autoParams).map(_normalizeRow);

  // 手动阶段列（报价中/试单/合作中/已流失）
  const columns = PIPELINE_STAGES.map(stageDef => {
    if (stageDef.stage === "触达中") {
      return { ...stageDef, contacts: autoContacts };
    }
    const params = [stageDef.stage];
    let where = `c.opp_stage = ?`;
    if (filters.search) {
      const q = `%${filters.search.toLowerCase()}%`;
      where += ` AND (lower(co.name) LIKE ? OR lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ? OR lower(c.email) LIKE ?)`;
      params.push(q, q, q, q);
    }
    if (filters.country) {
      where += ` AND co.country = ?`;
      params.push(filters.country);
    }

    const contacts = db.prepare(
      `SELECT c.id, c.company_id, c.email, c.first_name, c.last_name, c.title,
              c.phone, c.linkedin, c.position, c.contact_name,
              c.client_type, c.stage, c._status, c.opp_stage, c.tags,
              c._extra, c.last_sent_at,
              co.name as company_name, co.country as company_country, co.website as company_website
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE ${where}
       ORDER BY c.updated_at DESC`
    ).all(...params).map(_normalizeRow);

    return { ...stageDef, contacts };
  });

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

  const oldStage = contact.opp_stage || "待开发";
  contactsDb.update(contactId, { opp_stage: newStage });

  // 审计记录
  try {
    interactionsDb.add({
      contact_id: contactId,
      company_id: contact.company_id || "",
      type: "stage_changed",
      direction: "internal",
      subject: "阶段变更",
      snippet: `${oldStage} → ${newStage}`,
    });
  } catch (e) {
    Log.error("CRM", "写审计记录失败", e.stack);
  }

  Log.info("CRM", "阶段变更", { contactId, from: oldStage, to: newStage });
  return { ok: true, data: { id: contactId, opp_stage: newStage } };
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
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  // 查所有在 CRM 管道中且有 nextFollowupAt 的联系人
  const rows = db.prepare(
    `SELECT c.id, c.first_name, c.last_name, c.email, c._extra, c.opp_stage,
            co.name as company_name, co.country as company_country
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
     WHERE c._extra LIKE '%nextFollowupAt%'
       AND (c.opp_stage IN (${MANUAL_STAGES.map(() => "?").join(",")})
            OR c._status IN ('已触达', '有回复', '自动回复', 'reached', 'replied', 'autoreply'))`
  ).all(...MANUAL_STAGES).map(r => {
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
  try { r.tags = JSON.parse(r.tags || "[]"); } catch { r.tags = []; }
  try { r._extra = JSON.parse(r._extra || "{}"); } catch { r._extra = {}; }
  r.company = r.company_name || "";
  r.country = r.company_country || "";
  r.firstName = r.first_name || "";
  r.lastName = r.last_name || "";
  return r;
}

module.exports = { listPipeline, setStage, updateExtra, getDetail, saveNote, checkReminders, PIPELINE_STAGES };
