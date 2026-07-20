// ── 发送历史 IPC 路由 ──
// v2.9.10: 统一到 SQLite，send-history.json 仅保留 usedSentences（句库去重）

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const { Log } = require('../core/logger');
const { loadBodies } = require('../services/send-engine');
const { resolveCompanyId } = require('../services/company-store');

// ── 句库去重（仅此一项保留 JSON，无 SQLite 对应列）──
const shp = path.join(APP_ROOT, 'data', 'send-history.json');
function _readSentences() { try { return fs.existsSync(shp) ? JSON.parse(fs.readFileSync(shp, 'utf-8')) : {}; } catch { return {}; } }
function _writeSentences(h) { const d = path.dirname(shp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(shp, JSON.stringify(h, null, 2)); }

/** 从 SQLite 联系人重建公司级历史（与 history:get 共用） */
function _buildHist() {
  const contactsDb = require('../services/contacts-db');
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
}

/** 推进公司阶段：更新该公司所有联系人的 stage */
function _advanceCompany(name, newStage, reason) {
  const contactsDb = require('../services/contacts-db');
  const all = contactsDb.listAll();
  let updated = 0;
  for (const c of all) {
    const cn = c.company_name || c.company || '';
    if (cn === name) {
      contactsDb.setStage(c.id, newStage, reason);
      updated++;
    }
  }
  return updated;
}

function register(ipcMain, deps) {
  function _notify() {
    try { deps?.mainWindow?.webContents.send('contacts:changed'); } catch { /* 窗口已关闭 */ }
  }

  // ── 发送历史（纯 SQLite）──
  ipcMain.handle('history:get', async () => {
    try { return _buildHist(); } catch { return {}; }
  });

  ipcMain.handle('history:advance', async (_e, companies) => {
    const h = _buildHist();
    const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    const now = new Date().toISOString();
    for (const name of companies) {
      const cur = (h[name]?.stage || 'cold');
      const idx = STAGES.indexOf(cur);
      const next = STAGES[idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx];
      const n = _advanceCompany(name, next, 'advance');
      Log.info('阶段', `${name}: ${cur}→${next} | ${n}人`);
      // 更新内存 hist 供返回值
      h[name] = { ...h[name], stage: next, lastSent: now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] };
      if (!h[name]?.startedAt) h[name].startedAt = now;
    }
    _notify();
    return h;
  });

  // ── 阶段追回 ──
  ipcMain.handle('history:catchup', async () => {
    const h = _buildHist();
    const logPaths = [path.join(APP_ROOT, 'send', 'send-log.json'), path.join(APP_ROOT, 'send', 'send-log-test.json')];
    const sentCompanies = new Set();
    for (const lp of logPaths) {
      try { if (fs.existsSync(lp)) { const log = JSON.parse(fs.readFileSync(lp, 'utf-8'));(log.sent || []).forEach(r => { if (r.company) sentCompanies.add(r.company); }); } } catch { /* 跳过 */ }
    }
    // ponytail: 校验公司是否在 contacts 表中存在，防止幽灵数据
    const contactsDb = require('../services/contacts-db');
    const allContacts = contactsDb.listAll();
    const existingCompanies = new Set(allContacts.map(c => c.company_name || c.company).filter(Boolean));
    let caught = 0;
    for (const name of sentCompanies) {
      if (!existingCompanies.has(name)) continue; // 公司已被删除，跳过
      if ((h[name]?.stage || 'cold') !== 'cold') continue;
      _advanceCompany(name, 'f1', 'catchup');
      caught++;
    }
    return { caught, total: sentCompanies.size };
  });

  // ── 句库去重（保留 JSON）──
  ipcMain.handle('history:recordSentences', async (_e, c, sids) => {
    const h = _readSentences();
    const e = h[c] || {};
    const u = e.usedSentences || [];
    h[c] = { ...e, usedSentences: (e.sentCount || 0) >= 5 ? [...(sids || [])] : [...new Set([...u, ...(sids || [])])] };
    _writeSentences(h);
    return { ok: true };
  });

  // ── 重新激活 ──
  ipcMain.handle('history:reactivate', async (_e, c) => {
    try {
      const contactsDb = require('../services/contacts-db');
      const all = contactsDb.listAll();
      for (const ct of all) {
        if ((ct.company_name || ct.company || '') !== c) continue;
        // ponytail: 只重置确实发过的联系人（有 last_sent_at），不动其他人
        if (!ct.last_sent_at) continue;
        contactsDb.setStage(ct.id, 'cold', 'manual:reactivate');
        contactsDb.update(ct.id, { last_sent_at: '', last_sent_acct: '' });
      }
    } catch { /* 降级 */ }
    _notify();
    return { ok: true };
  });

  // ── 日志查询（SQLite）──
  ipcMain.handle('history:getLog', async (_e, params) => {
    try { return require('../services/send-log-db').list(params || {}); }
    catch (e) { Log.error("历史", "查询发送日志失败", e.stack); return { total: 0, records: [] }; }
  });
  ipcMain.handle('history:getDates', async () => {
    try { return { ok: true, data: require('../services/send-log-db').getDates() }; }
    catch (e) { Log.error("历史", "查询发送日期失败", e.stack); return { ok: true, data: [] }; }
  });
  ipcMain.handle('history:getBody', async (_e, bodyId) => {
    if (!bodyId) return '';
    return require('../services/send-log-db').getBody(bodyId);
  });
  ipcMain.handle('history:delete', async (_e, indices) => {
    if (!indices?.length) return { ok: false };
    if (deps?._sendInProgress) return { ok: false, error: '发送进行中，无法清除记录' };
    try {
      const db = require('../services/db').getDb();
      if (indices[0] === '__ALL__') { db.exec("DELETE FROM send_log"); return { ok: true }; }
      const ph = indices.map(() => "?").join(",");
      db.prepare(`DELETE FROM send_log WHERE row_index IN (${ph})`).run(...indices);
      return { ok: true };
    } catch (e) { Log.error("历史", "删除发送记录失败", e.stack); return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
