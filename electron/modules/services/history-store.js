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
  // ── 发送历史 ──
  ipcMain.handle('history:get', async () => rsh());
  ipcMain.handle('history:advance', async (_e, companies) => {
    const h = rsh(); const now = new Date().toISOString(); const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    for (const name of companies) { const cur = h[name]?.stage || 'cold'; const idx = STAGES.indexOf(cur); const ni = idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx; const next = STAGES[ni]; const u = { ...h[name], stage: next, lastSent: now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] }; if (!h[name]?.startedAt) u.startedAt = now; if (next === 'archived') u.archivedAt = now; _dualWrite(h, name, u); }
    wsh(h); return h;
  });
  ipcMain.handle('history:recordSentences', async (_e, c, sids) => { const h = rsh(); const e = h[c] || {}; const u = e.usedSentences || []; _dualWrite(h, c, { ...e, usedSentences: (e.sentCount || 0) >= 5 ? [...(sids || [])] : [...new Set([...u, ...(sids || [])])] }); wsh(h); return { ok: true }; });
  ipcMain.handle('history:reactivate', async (_e, c) => { const h = rsh(); _dualWrite(h, c, { ...h[c], stage: 'cold', usedSentences: [], sentContacts: [], lastSent: new Date().toISOString(), archivedAt: undefined }); wsh(h); return { ok: true }; });
  ipcMain.handle('history:getLog', async (_e, params) => {
    const { limit, offset, search, type, lang, country, stage } = params || {};
    // 合并正式 + 测试两个日志文件
    const logPaths = [
      path.join(APP_ROOT, 'send', 'send-log.json'),
      path.join(APP_ROOT, 'send', 'send-log-test.json'),
    ];
    try {
      let records = [];
      for (const lp of logPaths) {
        if (fs.existsSync(lp)) {
          try { records.push(...(JSON.parse(fs.readFileSync(lp, 'utf-8')).sent || [])); } catch { /* 发送日志文件读取失败 → 跳过该文件 */ }
        }
      }
      records.sort((a, b) => (b.time || '').localeCompare(a.time || '')); // 最新在前
      if (search) { const q = search.toLowerCase(); records = records.filter(r => (r.company || '').toLowerCase().includes(q) || (r.subject || '').toLowerCase().includes(q)); }
      if (type) records = records.filter(r => (r._type || 'unlabeled') === type);
      if (lang) records = records.filter(r => (r._lang || '') === lang);
      if (country) records = records.filter(r => (r._country || '') === country);
      if (stage) records = records.filter(r => r._stage === stage);
      const total = records.length; records = records.slice(offset || 0, (offset || 0) + (limit || 50));
      return { total, records: records.map(r => { const { body, ...rest } = r; return rest; }) };
    } catch (e) { return { total: 0, records: [] }; }
  });
  ipcMain.handle('history:getBody', async (_e, bodyId) => { if (!bodyId) return ''; return loadBodies()[bodyId] || ''; });
  ipcMain.handle('history:delete', async (_e, indices) => {
    if (!indices?.length) return { ok: false };
    if (deps?._sendInProgress) return { ok: false, error: '发送进行中，无法清除记录' };
    for (const lp of [path.join(APP_ROOT, 'send', 'send-log.json'), path.join(APP_ROOT, 'send', 'send-log-test.json')]) {
      if (!fs.existsSync(lp)) continue;
      if (indices[0] === '__ALL__') { fs.writeFileSync(lp, JSON.stringify({ sent: [], daily_count: 0, last_date_beijing: '' }, null, 2)); continue; }
      const log = JSON.parse(fs.readFileSync(lp, 'utf-8')); const iset = new Set(indices.map(String)); log.sent = log.sent.filter(r => !iset.has(String(r.index))); fs.writeFileSync(lp, JSON.stringify(log, null, 2));
    }
    return { ok: true, deleted: indices[0] === '__ALL__' ? -1 : indices.length };
  });
}

module.exports = { register };
