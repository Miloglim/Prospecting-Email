// ── Prospector — CRM 客户跟进服务 ─────────────────────────────────────────
"use strict";

const contactsDb = require("./contacts-db");
const interactionsDb = require("./interactions-db");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

// ── CRM 邮件本地缓存（独立于 inbox，永久保留）────────────────────────────
function _ensureEmailCache() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS crm_email_cache (
    account_id TEXT NOT NULL, uid TEXT NOT NULL,
    subject TEXT, from_addr TEXT, from_name TEXT, date TEXT, body TEXT,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (account_id, uid)
  )`);
  // ponytail: 增量加列，兼容旧表（SQLite 不支持 IF NOT EXISTS for ALTER TABLE，靠 try-catch 消化重复加列错误）
  try { db.exec("ALTER TABLE crm_email_cache ADD COLUMN ai_summary TEXT DEFAULT ''"); } catch { /* 列已存在 */ }
  try { db.exec("ALTER TABLE crm_email_cache ADD COLUMN ai_suggestion TEXT DEFAULT ''"); } catch { /* 列已存在 */ }
  try { db.exec("ALTER TABLE crm_email_cache ADD COLUMN ai_brief TEXT DEFAULT ''"); } catch { /* 列已存在 */ }
  try { db.exec("ALTER TABLE crm_email_cache ADD COLUMN ai_script TEXT DEFAULT ''"); } catch { /* 列已存在 */ }
}

// ── 统一标签映射：DB 存英文 key，界面显示中文 label ──────────────────────

const TAG = {
  // ponytail: replied/autoreply/bounced 已迁移到 _status 字段，tags 只保留CRM管线标签
  quoting:     { key: "quoting",     label: "报价中",   color: "#2196f3", alias: ["报价中"] },
  trial:       { key: "trial",       label: "试单",     color: "#8e24aa", alias: ["试单"] },
  cooperating: { key: "cooperating", label: "合作中",   color: "#4caf50", alias: ["合作中"] },
  lost:        { key: "lost",        label: "已流失",   color: "#b0b0b0", alias: ["已流失"] },
  other:       { key: "other",       label: "其他",     color: "#333333", alias: [] },
  reaching:    { key: "reaching",    label: "触达中",   color: "#ff9800", alias: ["触达中"] },
};

// 管线阶段（优先级从高到低）
const PIPELINE_STAGES = [
  { key: TAG.reaching.key,    label: TAG.reaching.label,    color: TAG.reaching.color },
  { key: TAG.quoting.key,     label: TAG.quoting.label,     color: TAG.quoting.color },
  { key: TAG.trial.key,       label: TAG.trial.label,       color: TAG.trial.color },
  { key: TAG.cooperating.key, label: TAG.cooperating.label, color: TAG.cooperating.color },
  { key: TAG.lost.key,        label: TAG.lost.label,        color: TAG.lost.color },
  { key: TAG.other.key,       label: TAG.other.label,       color: TAG.other.color },
];

const PIPELINE_KEYS = PIPELINE_STAGES.map(s => s.key);

/** _extra.crmPreferences 白名单 */
const PREFERENCE_KEYS = [
  "preferredRoutes", "cargoTypes", "decisionRole",
  "priceSensitivity", "preferredPorts", "preferredPol", "preferredPod",
  "annualVolume", "memo",
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
            c._extra, c.last_sent_at, c.assignee,
            co.name as company_name, co.country as company_country, co.website as company_website,
            ln.note_at as last_note_at,
            ln.note_content as last_note_content
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN (
       SELECT contact_id, MAX(created_at) as note_at,
         (SELECT content FROM contact_notes WHERE contact_id = u.contact_id ORDER BY created_at DESC LIMIT 1) as note_content
       FROM (
         SELECT contact_id, created_at FROM contact_notes
         UNION ALL
         SELECT contact_id, created_at FROM interactions
       ) u GROUP BY contact_id
     ) ln ON ln.contact_id = c.id
     WHERE ${where}
     ORDER BY c.last_sent_at DESC`
  ).all(...params).map(_normalizeRow);

  // 入口筛选：_status 为 replied/reached
  const isEntry = (row) => {
    // 自动回复硬排除
    if (row._status === 'autoreply') return false;
    // 门票：_status 为 replied 或 reached
    if (row._status === 'replied' || row._status === 'reached') return true;
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

  // 清除旧管线标签（兼容中英文），写入新标签
  const oldTags = contact.tags || [];
  const allAliases = PIPELINE_STAGES.flatMap(s => [s.key, s.label, ...(Object.values(TAG).find(t => t.key === s.key)?.alias || [])]);
  const newTags = [...new Set([...oldTags.filter(t => !allAliases.includes(t)), newKey])];

  contactsDb.update(contactId, { tags: newTags });

  try {
    const tagLabel = (k) => (Object.values(TAG).find(t => t.key === k) || {}).label || k;
    interactionsDb.add({
      contact_id: contactId, company_id: contact.company_id || "",
      type: "stage_changed", direction: "internal",
      subject: "阶段变更", snippet: `${oldTags.map(tagLabel).join('、') || '无'} → ${tagLabel(newKey)}`,
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
  let notes;
  try { notes = db.prepare("SELECT id, content, created_at, updated_at FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC").all(contactId); }
  catch (e) { return { ok: false, error: "notes查询: " + e.message }; }

  let interactions;
  try { interactions = interactionsDb.list({ contact_id: contactId, limit: 100 }); }
  catch (e) { return { ok: false, error: "interactions查询: " + e.message }; }

  // 间接匹配邮件：matched_contacts 中包含该联系人邮箱但未直接绑定
  let indirectMails = [];
  if (contact.email) {
    try {
      indirectMails = db.prepare(
        `SELECT uid, account_id, subject, from_addr, from_name, date, type FROM inbox
         WHERE contact_db_id != ? AND contact_id != ? AND lower(from_addr) != ?
           AND matched_contacts IS NOT NULL AND instr(matched_contacts, ?) > 0
         ORDER BY date DESC LIMIT 30`
      ).all(contactId, contactId, (contact.email || '').toLowerCase(), '"email":"' + (contact.email || '').toLowerCase() + '"');
    } catch (e) { return { ok: false, error: "indirectMails查询: " + e.message }; }
  }

  return { ok: true, data: { contact, notes, interactions, indirectMails } };
}

// ── 跟进备注 ──────────────────────────────────────────────────────────────────

function saveNote(contactId, content) {
  if (!content || !content.trim()) return { ok: false, error: "内容不能为空" };
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };
  // ponytail: 统一走 contactsDb.addNote
  const note = contactsDb.addNote(contactId, content.trim());
  Log.info("CRM", "跟进备注已保存", { contactId, noteId: note?.id });
  return { ok: true, data: note };
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
  let rows;
  try {
    const searchEmail = '"email":"' + (contact.email || '').toLowerCase() + '"';
    rows = db.prepare(
      `SELECT uid, account_id, subject, from_addr, from_name, date, body, type,
        CASE WHEN lower(from_addr) = ? OR contact_db_id = ? OR contact_id = ? THEN 0 ELSE 1 END as _indirect
       FROM inbox
       WHERE lower(from_addr) = ? OR contact_db_id = ? OR contact_id = ?
          OR (matched_contacts IS NOT NULL AND instr(matched_contacts, ?) > 0)
       ORDER BY date DESC LIMIT 50`
    ).all((contact.email || '').toLowerCase(), contactId, contactId, (contact.email || '').toLowerCase(), contactId, contactId, searchEmail);
  } catch (e) { return { ok: false, error: "getContactEmails: " + e.message }; }
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

// ── 邮件往来摘要（供 AI 上下文） ────────────────────────────────────────────
function getEmailHistorySummary(contactId, limit = 5, senderName = '') {
  if (!contactId) return '';
  const contact = contactsDb.getById(contactId);
  if (!contact) return '';
  const db = getDb();
  const rows = db.prepare(
    `SELECT subject, from_addr, from_name, date, type FROM inbox
     WHERE from_addr = ? OR contact_db_id = ? OR contact_id = ?
     ORDER BY date DESC LIMIT ?`
  ).all(contact.email, contactId, contactId, limit);
  if (!rows.length) return '';
  const me = senderName || '我方';
  return rows.map(r =>
    `[${r.type === 'reply' ? '客户来信' : r.type === 'bounce' ? '退信' : me + '发信'}]
    ${r.date?.slice(0,10)||''} ${r.subject||'(无)'}`
  ).join('\n');
}

// ── AI 邮件总结缓存 ──────────────────────────────────────────────────────────
function saveAiSummary(uid, accountId, summary, suggestion, brief, script) {
  _ensureEmailCache();
  const db = getDb();
  try {
    // 先确保行存在（不覆盖已有邮件正文），再更新 AI 字段
    db.prepare(`INSERT OR IGNORE INTO crm_email_cache (account_id, uid, subject, from_addr, from_name, date, body, cached_at)
      VALUES (?, ?, '', '', '', '', '', ?)`)
      .run(accountId || '', uid || '', new Date().toISOString());
    db.prepare("UPDATE crm_email_cache SET ai_summary = ?, ai_suggestion = ?, ai_brief = ?, ai_script = ? WHERE uid = ? AND account_id = ?")
      .run(summary || '', suggestion || '', brief || '', script || '', uid, accountId || '');
  } catch { /* 缓存写入失败不影响主流程 */ }
}

function getAiSummary(uid, accountId) {
  try {
    _ensureEmailCache();
    const db = getDb();
    const row = db.prepare("SELECT ai_summary, ai_suggestion, ai_brief, ai_script FROM crm_email_cache WHERE uid = ? AND account_id = ?")
      .get(uid, accountId || '');
    return row || { ai_summary: '', ai_suggestion: '', ai_brief: '', ai_script: '' };
  } catch { return { ai_summary: '', ai_suggestion: '', ai_brief: '', ai_script: '' }; }
}

function clearAllAiCache() {
  _ensureEmailCache();
  const db = getDb();
  // 只清 ai_brief 为空但有旧摘要的记录（旧格式迁移）
  const r = db.prepare("UPDATE crm_email_cache SET ai_summary = '', ai_suggestion = '', ai_brief = '' WHERE ai_summary != '' AND ai_brief IS NULL").run();
  return r.changes;
}

// ── 联系人关系网络 ──────────────────────────────────────────────────────────

function getRelations(contactId) {
  if (!contactId) return { ok: false, error: "参数缺失" };
  const contact = contactsDb.getById(contactId);
  if (!contact) return { ok: false, error: "联系人不存在" };

  const db = getDb();
  const companyId = contact.company_id;

  // 1. 查公司名
  let companyName = contact.company_name || "";
  if (!companyName && companyId) {
    try {
      const co = db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId);
      if (co) companyName = co.name;
    } catch { /* 降级 */ }
  }

  // 2. 查同公司已触达/已回复的联系人
  let rows;
  try {
    if (companyId) {
      rows = db.prepare(
        `SELECT id, first_name, last_name, title, email, opp_stage, _status, _extra
         FROM contacts WHERE company_id = ? AND _status IN ('reached','replied')
         ORDER BY _status DESC, last_sent_at DESC LIMIT 80`
      ).all(companyId);
    } else {
      rows = [];
    }
  } catch (e) {
    Log.error("CRM关系网络", "查询同公司联系人失败", e.stack);
    return { ok: false, error: "查询同公司联系人失败" };
  }

  // 3. 确保当前查看的联系人在列表中
  const hasCurrent = rows.some(r => r.id === contactId);
  if (!hasCurrent) {
    rows.unshift(contact);
  }

  const contactIds = new Set(rows.map(r => r.id));

  // 4. 节点：公司 + 联系人
  const companyNode = {
    id: companyId || '__company__',
    type: 'company',
    name: companyName || '未命名公司',
    isCompany: true,
  };

  const nodes = [companyNode];
  for (const r of rows) {
    nodes.push({
      id: r.id,
      type: 'contact',
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "",
      title: r.title || "",
      email: r.email || "",
      stage: r.opp_stage || "",
      status: r._status || "",
      isPrimary: r.id === contactId,
    });
  }

  // 5. 边：公司 → 联系人（主关系）
  const edges = [];
  for (const r of rows) {
    edges.push({
      source: companyNode.id,
      target: r.id,
      type: 'company',
    });
  }

  // 6. 自定义边：联系人之间的手动关联
  for (const r of rows) {
    let extra = {};
    try { extra = JSON.parse(r._extra || "{}"); } catch { /* 使用空对象 */ }
    const relations = extra.relations;
    if (Array.isArray(relations)) {
      for (const rel of relations) {
        const targetId = rel.targetId || rel.target;
        if (targetId && contactIds.has(targetId)) {
          edges.push({
            source: r.id,
            target: targetId,
            type: 'custom',
            label: rel.label || "",
          });
        }
      }
    }
  }

  // 7. 去重（公司→联系人边和自定义边可能重复）
  const seen = new Set();
  const validEdges = edges.filter(e => {
    const key = [e.source, e.target].sort().join('::') + '::' + e.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ok: true, data: { nodes, edges: validEdges } };
}

function saveRelation(fromId, toId, label) {
  try {
    if (!fromId || !toId) return { ok: false, error: "缺少联系人 ID" };
    if (fromId === toId) return { ok: false, error: "不能添加与自己的关系" };
    if (!label || !label.trim()) return { ok: false, error: "关系标签不能为空" };
    const contact = contactsDb.getById(fromId);
    if (!contact) return { ok: false, error: "联系人不存在" };
    let extra = {};
    try { extra = typeof contact._extra === 'string' ? JSON.parse(contact._extra) : (contact._extra || {}); } catch { extra = {}; }
    if (!extra.relations) extra.relations = [];
    if (extra.relations.length >= 200) return { ok: false, error: "关系数量已达上限（200条）" };
    const exists = extra.relations.find(r => r.target === toId && r.label === label);
    if (exists) return { ok: true, data: { id: contact.id } };
    extra.relations.push({ target: toId, label: label.trim(), category: "", color: "", createdAt: new Date().toISOString() });
    contactsDb.update(fromId, { _extra: extra });
    Log.info("CRM关系网络", "添加关系: " + fromId + " -> " + toId + " [" + label + "]");
    return { ok: true, data: { id: contact.id } };
  } catch (e) {
    Log.error("CRM关系网络", "保存关系失败", e.stack);
    return { ok: false, error: e.message };
  }
}

function deleteRelation(fromId, toId, label) {
  try {
    const contact = contactsDb.getById(fromId);
    if (!contact) return { ok: false, error: "联系人不存在" };
    let extra = {};
    try { extra = typeof contact._extra === 'string' ? JSON.parse(contact._extra) : (contact._extra || {}); } catch { extra = {}; }
    if (!extra.relations) return { ok: true, data: { id: contact.id } };
    extra.relations = extra.relations.filter(r => !(r.target === toId && r.label === label));
    contactsDb.update(fromId, { _extra: extra });
    Log.info("CRM关系网络", "删除关系: " + fromId + " -> " + toId + " [" + label + "]");
    return { ok: true, data: { id: contact.id } };
  } catch (e) {
    Log.error("CRM关系网络", "删除关系失败", e.stack);
    return { ok: false, error: e.message };
  }
}

module.exports = { listPipeline, setStage, updateExtra, getDetail, saveNote, checkReminders, getContactEmails, getEmailBody, getEmailHistorySummary, saveAiSummary, getAiSummary, clearAllAiCache, getRelations, saveRelation, deleteRelation, PIPELINE_STAGES, TAG };
