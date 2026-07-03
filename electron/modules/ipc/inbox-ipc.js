// ── 收件箱 IPC 路由 ──────────────────────────────────────────────────────────
const path = require('path');
const { APP_ROOT } = require('../config');
const { Log } = require('../core/logger');

let _autoTimer = null;
let _fetching = false;
const AUTO_INTERVAL_MS = 10 * 60 * 1000;

function register(ipcMain) {
  const inbox = require('../services/inbox-service');
  const configPath = path.join(APP_ROOT, 'send', 'config.json');

  async function _doFetch() {
    if (_fetching) return;
    _fetching = true;
    try { await inbox.fetchInbox(configPath); } catch (e) { Log.warn('[收件箱]', '自动拉取失败: ' + e.message); }
    _fetching = false;
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

  // ── 自动检测 ──────────────────────────────────────────────────────────
  exports.triggerInboxFetch = () => {
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(() => { _doFetch(); _autoTimer = setInterval(_doFetch, AUTO_INTERVAL_MS); }, 60000);
  };

  // 启动 30 秒后首次拉，之后每 10 分钟
  clearInterval(_autoTimer);
  _autoTimer = setTimeout(() => { _doFetch(); _autoTimer = setInterval(_doFetch, AUTO_INTERVAL_MS); }, 30000);
}

module.exports = { register };
