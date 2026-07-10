// ── 发送历史持久化 ──
// 从 send-ipc.js 拆分：发送历史、阶段管理、日志查询、正文读取

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');

// 引用 send-engine 的 loadBodies（两个模块共享同一数据文件）
const { loadBodies } = require('./send-engine');
const { resolveCompanyId } = require('./company-store');

// ── 发送历史读写 ──
const shp = path.join(APP_ROOT, 'data', 'send-history.json');
function rsh() { try { return fs.existsSync(shp) ? JSON.parse(fs.readFileSync(shp, 'utf-8')) : {}; } catch { return {}; } }
function wsh(h) { const d = path.dirname(shp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(shp, JSON.stringify(h, null, 2)); }

/** 双写：同时写公司名 key 和 companyId key（Phase 3 过渡） */
function _dualWrite(h, name, value) {
  h[name] = value;
  const { companyId } = resolveCompanyId(name);
  if (companyId && companyId !== name) h[companyId] = value;
}

function register(ipcMain, deps) {
  // ── 发送历史（从 SQLite 实时派生）──
  ipcMain.handle('history:get', async () => {
    try {
      const contactsDb = require('./contacts-db');
      const contacts = contactsDb.listAll();
      const hist = {};
      for (const c of contacts) {
        const name = c.company_name || c.company || "未命名";
        if (!hist[name]) hist[name] = { stage: "cold", lastSent: "", sentCount: 0, sentContacts: [], startedAt: c.created_at };
        const entry = hist[name];
        if (c.last_sent_at && c.last_sent_at > entry.lastSent) entry.lastSent = c.last_sent_at;
        if (c.last_sent_at) { entry.sentContacts.push(c.email.toLowerCase().trim()); entry.sentCount++; }
        const order = ["cold", "f1", "f2", "f3", "f4"];
        if (order.indexOf(c.stage || "cold") > order.indexOf(entry.stage)) entry.stage = c.stage;
      }
      return hist;
    } catch { return {}; }
  });
  ipcMain.handle('history:advance', async (_e, companies) => {
    const h = rsh(); const now = new Date().toISOString(); const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    for (const name of companies) { const cur = h[name]?.stage || 'cold'; const idx = STAGES.indexOf(cur); const ni = idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx; const next = STAGES[ni]; const u = { ...h[name], stage: next, lastSent: now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] }; if (!h[name]?.startedAt) u.startedAt = now; if (next === 'archived') u.archivedAt = now; _dualWrite(h, name, u); }
    wsh(h); return h;
  });

  // ── 批次统计：按日期分组计数（已迁移到 SQLite）

  // ── 阶段追回：扫描已发记录，将 cold 阶段已发公司推进到 f1 ──────────
  ipcMain.handle('history:catchup', async () => {
    const h = rsh();
    const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    // 从发送日志提取已发公司
    const logPaths = [
      path.join(APP_ROOT, 'send', 'send-log.json'),
      path.join(APP_ROOT, 'send', 'send-log-test.json'),
    ];
    const sentCompanies = new Set();
    for (const lp of logPaths) {
      try {
        if (fs.existsSync(lp)) {
          const log = JSON.parse(fs.readFileSync(lp, 'utf-8'));
          (log.sent || []).forEach(r => { if (r.company) sentCompanies.add(r.company); });
        }
      } catch { /* 文件损坏跳过 */ }
    }
    // 推进 cold 阶段的已发公司
    let caught = 0;
    const now = new Date().toISOString();
    for (const name of sentCompanies) {
      const cur = h[name]?.stage || 'cold';
      if (cur !== 'cold') continue;
      const u = { ...h[name], stage: 'f1', lastSent: h[name]?.lastSent || now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] };
      if (!h[name]?.startedAt) u.startedAt = now;
      _dualWrite(h, name, u);
      caught++;
    }
    if (caught > 0) wsh(h);
    return { caught, total: sentCompanies.size };
  });
  ipcMain.handle('history:recordSentences', async (_e, c, sids) => { const h = rsh(); const e = h[c] || {}; const u = e.usedSentences || []; _dualWrite(h, c, { ...e, usedSentences: (e.sentCount || 0) >= 5 ? [...(sids || [])] : [...new Set([...u, ...(sids || [])])] }); wsh(h); return { ok: true }; });
  ipcMain.handle('history:reactivate', async (_e, c) => { const h = rsh(); _dualWrite(h, c, { ...h[c], stage: 'cold', usedSentences: [], sentContacts: [], lastSent: new Date().toISOString(), archivedAt: undefined }); wsh(h); return { ok: true }; });
  ipcMain.handle('history:getLog', async (_e, params) => {
    try {
      const sendLog = require('./send-log-db');
      return sendLog.list(params || {});
    } catch (e) { return { total: 0, records: [] }; }
  });
  ipcMain.handle('history:getDates', async () => {
    try {
      const sendLog = require('./send-log-db');
      return { ok: true, data: sendLog.getDates() };
    } catch { return { ok: true, data: [] }; }
  });
  ipcMain.handle('history:getBody', async (_e, bodyId) => {
    if (!bodyId) return '';
    const sendLog = require('./send-log-db');
    return sendLog.getBody(bodyId);
  });
  ipcMain.handle('history:delete', async (_e, indices) => {
    if (!indices?.length) return { ok: false };
    if (deps?._sendInProgress) return { ok: false, error: '发送进行中，无法清除记录' };
    try {
      const db = require('./db').getDb();
      if (indices[0] === '__ALL__') { db.exec("DELETE FROM send_log"); return { ok: true }; }
      const ph = indices.map(() => "?").join(",");
      db.prepare(`DELETE FROM send_log WHERE row_index IN (${ph})`).run(...indices);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
