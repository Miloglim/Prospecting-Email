// ── 系统类 IPC ──
// 从 send-ipc.js 拆分：仪表盘、SMTP 状态、配置、应用操作、网络、签名、队列、客户开发

const path = require('path');
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
  ipcMain.handle('queue:load', async () => { try { if (fs.existsSync(qfp)) return { ok: true, data: JSON.parse(fs.readFileSync(qfp, 'utf-8')) }; } catch {} return { ok: false, data: [] }; });

  // ── 仪表盘统计 ──
  ipcMain.handle('dashboard:getStats', async () => {
    const now = Date.now();
    if (_statsCache && now - _statsCacheTime < 5000) return _statsCache;
    const lp = path.join(APP_ROOT, 'send', 'send-log.json');
    const cp = path.join(APP_ROOT, 'send', 'config.json');
    let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500;
    const allSent = [];
    try {
      if (fs.existsSync(lp)) {
        const raw = await fs.promises.readFile(lp, 'utf-8');
        allSent.push(...(JSON.parse(raw).sent || []));
      }
    } catch {}
    const t = beijingToday();
    sentToday = allSent.filter(r => r.status === 'sent' && (r.time_beijing === t || (!r.time_beijing && r.time && beijingDateFromISO(r.time) === t))).length;
    totalSent = allSent.filter(r => r.status === 'sent').length;
    totalFailed = allSent.filter(r => r.status === 'failed').length;
    try {
      if (fs.existsSync(cp)) {
        const raw = await fs.promises.readFile(cp, 'utf-8');
        dailyLimit = JSON.parse(raw).schedule?.max_per_day || 500;
      }
    } catch {}
    _statsCache = { sentToday, dailyLimit, remaining: Math.max(0, dailyLimit - sentToday), totalSent, totalFailed, queueLength: deps.sendQueue.length };
    _statsCacheTime = now;
    return _statsCache;
  });

  // ── SMTP 状态 ──
  ipcMain.handle('smtp:checkStatus', async () => { const cp = path.join(APP_ROOT, 'send', 'config.json'); if (!fs.existsSync(cp)) return { ok: false, host: '未配置' }; try { const raw = await fs.promises.readFile(cp, 'utf-8'); const c = JSON.parse(raw); return { ok: !!(c.smtp?.host && c.smtp?.user), host: c.smtp?.host || '未配置', user: c.smtp?.user || '' }; } catch { return { ok: false, host: '未配置' }; } });

  // ── 网络检查 ──
  ipcMain.handle('network:check', async () => {
    const proxy = getProxyConfig(); const targets = [{ name: '百度', host: 'www.baidu.com' }, { name: 'Bing', host: 'cn.bing.com' }, { name: 'Google', host: 'www.google.com' }, { name: 'Wikipedia', host: 'en.wikipedia.org' }]; const results = [];
    for (const t of targets) {
      const start = Date.now();
      try { await new Promise((resolve, reject) => { const req = createRequest({ hostname: t.host, path: '/', method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'Prospector/1.0' } }); req.on('response', (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); }); req.end(); }); results.push({ name: t.name, ok: true, ms: Date.now() - start }); } catch (e) { results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e.message }); }
    }
    return { proxy: proxy ? `${proxy.hostname}:${proxy.port}` : null, results };
  });

  // ── 客户开发（需 Python 环境，当前暂不可用） ──
  ipcMain.handle('discover:search', async () => ({ ok: false, error: '此功能需要 Python 抓取服务，当前版本暂未包含' }));
  ipcMain.handle('discover:lookup', async () => ({ ok: false, error: '此功能需要 Python 抓取服务，当前版本暂未包含' }));

  // ── 签名 ──
  const sfp = path.join(APP_ROOT, 'send', 'signature.html');
  ipcMain.handle('signature:load', async () => { try { if (fs.existsSync(sfp)) return { ok: true, html: fs.readFileSync(sfp, 'utf-8') }; } catch {} return { ok: true, html: '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>' }; });
  ipcMain.handle('signature:save', async (_e, html) => { const d = path.dirname(sfp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(sfp, html); return { ok: true }; });

  // ── 设置 ──
  ipcMain.handle('config:load', async () => loadSearchConfig());
  ipcMain.handle('config:save', async (_e, config) => { const cp = path.join(APP_ROOT, 'send', 'config.json'); const d = path.dirname(cp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(cp, JSON.stringify(config, null, 2)); return { ok: true }; });
}

module.exports = { register };
