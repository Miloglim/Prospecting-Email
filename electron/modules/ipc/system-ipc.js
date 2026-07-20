// ── 系统类 IPC ──
// 从 send-ipc.js 拆分：仪表盘、SMTP 状态、配置、应用操作、网络、签名、队列、客户开发

const path = require('path');
const { Log } = require("../core/logger");
const fs = require('fs');
const { shell } = require('electron');
const { APP_ROOT, loadSearchConfig, createRequest, getProxyConfig } = require('../config');
const { beijingToday, beijingDateFromISO } = require('../utils');

// ── 仪表盘缓存 ──
let _statsCache = null;
let _statsCacheTime = 0;

function register(ipcMain, deps) {
  // ── 队列持久化 ──
  const qfp = path.join(APP_ROOT, 'data', 'email-queue.json');
  ipcMain.handle('queue:save', async (_e, data) => { const d = path.dirname(qfp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(qfp, JSON.stringify(data, null, 2)); return { ok: true }; });
  ipcMain.handle('queue:load', async () => { try { if (fs.existsSync(qfp)) return { ok: true, data: JSON.parse(fs.readFileSync(qfp, 'utf-8')) }; } catch { /* 非关键 I/O 失败不影响主流程 */ } return { ok: false, data: [] }; });

  // ── 仪表盘统计 ──
  ipcMain.handle('dashboard:getStats', async () => {
    const dashboard = require('../services/dashboard-service');
    return dashboard.getStats(deps);
  });

  // 应用版本号
  ipcMain.handle('app:getVersion', async () => require('electron').app.getVersion());

  // ── SMTP 状态（业务逻辑下沉 account-manager）──
  ipcMain.handle('smtp:checkStatus', async () => {
    const cp = path.join(APP_ROOT, 'send', 'config.json');
    if (!fs.existsSync(cp)) return { ok: false, host: '未配置' };
    try {
      const c = JSON.parse(await fs.promises.readFile(cp, 'utf-8'));
      // 新格式：smtpAccounts
      if (Array.isArray(c.smtpAccounts) && c.smtpAccounts.length > 0) {
        let states = {};
        try {
          const lp = path.join(APP_ROOT, 'send', 'send-log.json');
          if (fs.existsSync(lp)) {
            const log = JSON.parse(await fs.promises.readFile(lp, 'utf-8'));
            states = log._accountStates || {};
          }
        } catch { /* 文件损坏不影响状态检查 */ }

        const acctMgr = require('../services/account-manager');
        const status = acctMgr.getAccountsStatus(c.smtpAccounts, states);
        if (!status) return { ok: false, host: '无账号配置', user: '' };
        if (!status.activeCount) {
          const reason = status.hasFused ? '账号异常（熔断/离线）' : '无连通账号';
          return { ok: false, host: reason, user: '' };
        }
        const first = status.firstActive;
        return {
          ok: status.anyPassed,
          host: first?.smtp?.host || '未配置',
          user: first?.smtp?.user || '',
          accountCount: status.accountCount,
          activeCount: status.activeCount,
          testedCount: status.testedCount,
          passedCount: status.passedCount,
          failedCount: status.failedCount,
          untestedCount: status.untestedCount,
        };
      }
      // 旧格式：smtp（兼容）
      return { ok: !!(c.smtp?.host && c.smtp?.user), host: c.smtp?.host || '未配置', user: c.smtp?.user || '' };
    } catch { return { ok: false, host: '未配置' }; }
  });

  // ── 网络检查 ──
  ipcMain.handle('network:check', async () => {
    const proxy = getProxyConfig(); const targets = [{ name: '百度', host: 'www.baidu.com' }, { name: 'Bing', host: 'cn.bing.com' }, { name: 'Google', host: 'www.google.com' }, { name: 'Wikipedia', host: 'en.wikipedia.org' }]; const results = [];
    for (const t of targets) {
      const start = Date.now();
      try { await new Promise((resolve, reject) => { const req = createRequest({ hostname: t.host, path: '/', method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'Outreacher/1.0' } }); req.on('response', (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); }); req.end(); }); results.push({ name: t.name, ok: true, ms: Date.now() - start }); } catch (e) { results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e.message }); }
    }
    return { proxy: proxy ? `${proxy.hostname}:${proxy.port}` : null, results };
  });

  // ── 自动检测系统代理 ──
  ipcMain.handle('system:detectProxy', async () => {
    // 1. 环境变量优先
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy;
    if (envProxy) {
      // 去掉 http:// 前缀，提取 host:port
      const host = envProxy.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      return { ok: true, host, source: 'env' };
    }

    // 2. Windows 系统代理（注册表）
    if (process.platform === 'win32') {
      try {
        const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
        const { execSync } = require('child_process');
        const enabled = execSync(`reg query "${regKey}" /v ProxyEnable`, { encoding: 'utf-8', timeout: 3000 });
        if (enabled.includes('0x1')) {
          const server = execSync(`reg query "${regKey}" /v ProxyServer`, { encoding: 'utf-8', timeout: 3000 });
          const m = server.match(/ProxyServer\s+REG_SZ\s+(.+)/);
          if (m?.[1]) {
            const host = m[1].trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
            return { ok: true, host, source: 'system' };
          }
        }
      } catch { /* 注册表读取失败 → 无系统代理 */ }
    }

    return { ok: false, host: null, reason: '未检测到系统代理' };
  });

  // ── 客户开发 → 已迁移到 electron/modules/acquisition-ipc.js ──

  // ── 系统功能 ──
  const { app, shell } = require('electron');
  ipcMain.handle('app:minimizeToTray', async () => { deps.mainWindow?.hide(); return true; });
  ipcMain.handle('app:openReports', async () => shell.openPath(path.join(APP_ROOT, 'reports')));
  ipcMain.handle('app:openSendFolder', async () => shell.openPath(path.join(APP_ROOT, 'send')));
  ipcMain.handle('app:openExternal', async (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:openLogFile', async () => shell.openPath(path.join(APP_ROOT, 'logs')));

  // ── 签名 ──
  const sigStore = require('../services/signature-store');
  sigStore.init(APP_ROOT);
  ipcMain.handle('signature:load', async (_e, accountId) => {
    try {
      const html = sigStore.readSignature(accountId || null);
      return { ok: true, html };
    } catch { return { ok: true, html: '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>' }; }
  });
  ipcMain.handle('signature:save', async (_e, html, accountId) => {
    return sigStore.writeSignature(html, accountId || null);
  });

  // ── 设置 ──
  ipcMain.handle('config:load', async () => loadSearchConfig());
  ipcMain.handle('config:save', async (_e, config) => { const cp = path.join(APP_ROOT, 'send', 'config.json'); const d = path.dirname(cp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(cp, JSON.stringify(config, null, 2)); return { ok: true }; });

  // ── 数据导出 ──
  ipcMain.handle('data:export', async () => {
    try {
      const { exportAll } = require('../services/export-service');
      return exportAll();
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 回复检测 ──
  ipcMain.handle('reply:check', async () => {
    const reply = require('../services/reply-checker');
    return await reply.checkReplies();
  });
  ipcMain.handle('reply:log', async () => {
    const rlp = path.join(APP_ROOT, 'data', 'reply-log.json');
    try { if (fs.existsSync(rlp)) return { ok: true, data: JSON.parse(fs.readFileSync(rlp, 'utf-8')) }; } catch { /* 文件损坏 */ }
    return { ok: true, data: [] };
  });
  ipcMain.handle('reply:getCount', async () => {
    const reply = require('../services/reply-checker');
    return reply.getReplyCount();
  });

  ipcMain.handle("shell:openPath", async (_e, filePath) => {
    try {
      const { shell } = require("electron");
      await shell.openPath(filePath);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
