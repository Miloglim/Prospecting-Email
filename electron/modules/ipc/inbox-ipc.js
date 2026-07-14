// ── 收件箱 IPC 路由 ──────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const { Log } = require('../core/logger');

let _pollTimer = null;
let _cooldownTimer = null;
let _fetching = false;
const FAST_INTERVAL_MS = 2 * 60 * 1000;      // 发信时 2 分钟
const NORMAL_INTERVAL_MS = 5 * 60 * 1000;     // 静默时 5 分钟
const FAST_COOLDOWN_MS = 5 * 60 * 1000;       // 冷却 5 分钟

function register(ipcMain, deps) {
  const inbox = require('../services/inbox-service');
  const configPath = path.join(APP_ROOT, 'send', 'config.json');

  async function _doFetch() {
    if (_fetching) return;
    _fetching = true;
    try {
      const before = inbox.listInbox().length;
      await inbox.fetchInbox(configPath);
      const after = inbox.listInbox().length;
      if (after > before) deps?.mainWindow?.webContents.send('inbox:changed');
      deps?.mainWindow?.webContents.send('contacts:changed');
    } catch (e) { Log.warn('[收件箱]', '自动拉取失败: ' + e.message); }
    _fetching = false;
  }

  function _startPolling(intervalMs) {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(_doFetch, intervalMs);
  }

  ipcMain.handle('inbox:fetch', async () => {
    try { return { ok: true, data: await inbox.fetchInbox(configPath) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('inbox:list', async () => ({ ok: true, data: inbox.listInbox() }));
  ipcMain.handle('inbox:getBody', async (_e, i) => ({ ok: true, data: inbox.getBody(i) }));
  ipcMain.handle('inbox:markProcessed', async (_e, i) => { inbox.markProcessed(i); return { ok: true }; });
  ipcMain.handle('inbox:linkContact', async (_e, i, cid, co) => { inbox.linkContact(i, cid, co); return { ok: true }; });
  ipcMain.handle('inbox:delete', async (_e, i) => { inbox.deleteMail(i); return { ok: true }; });
  ipcMain.handle('inbox:removeMatchedContact', async (_e, index, email) => { inbox.removeMatchedContact(index, email); return { ok: true }; });
  ipcMain.handle('inbox:removeMatchedContactsBatch', async (_e, items) => { inbox.removeMatchedContactsBatch(items); return { ok: true }; });
  ipcMain.handle('inbox:getBounceCount', async () => inbox.getBounceCount());
  ipcMain.handle('inbox:toggleImportant', async (_e, i, key) => { inbox.toggleImportantByKey(key); return { ok: true }; });
  ipcMain.handle('inbox:setType', async (_e, index, newType) => ({ ok: inbox.setMailType(index, newType) }));
  ipcMain.handle('inbox:clear', async () => {
    try {
      const db = require('../services/db').getDb();
      db.exec("DELETE FROM inbox");
    } catch { /* 降级 */ }
    try { if (fs.existsSync(path.join(APP_ROOT, 'data', 'inbox-cursor.json'))) fs.unlinkSync(path.join(APP_ROOT, 'data', 'inbox-cursor.json')); } catch { /* 静默 */ }
    return { ok: true };
  });

  // ── 长短时自动拉取 ────────────────────────────────────────────────────
  module.exports.triggerInboxFetch = () => {
    clearTimeout(_cooldownTimer);
    _startPolling(FAST_INTERVAL_MS);
    _doFetch(); // 立即拉一次
    Log.info('[收件箱]', '进入短时拉取模式（2分钟/次）');
    _cooldownTimer = setTimeout(() => {
      _startPolling(NORMAL_INTERVAL_MS);
      Log.info('[收件箱]', '发信冷却结束，恢复 10 分钟拉取');
    }, FAST_COOLDOWN_MS);
  };

  // 启动：常规模式，30 秒后首次拉
  _startPolling(NORMAL_INTERVAL_MS);
  setTimeout(() => _doFetch(), 30000);
}

module.exports = { register };
