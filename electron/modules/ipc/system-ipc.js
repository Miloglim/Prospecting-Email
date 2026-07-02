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
    } catch { /* 非关键 I/O 失败不影响主流程 */ }
    const t = beijingToday();
    sentToday = allSent.filter(r => r.status === 'sent' && (r.time_beijing === t || (!r.time_beijing && r.time && beijingDateFromISO(r.time) === t))).length;
    totalSent = allSent.filter(r => r.status === 'sent').length;
    totalFailed = allSent.filter(r => r.status === 'failed').length;
    try {
      if (fs.existsSync(cp)) {
        const raw = await fs.promises.readFile(cp, 'utf-8');
        const config = JSON.parse(raw);
        // 多账号：合计所有活跃账号的每日限额
        const accounts = config.smtpAccounts || [];
        if (accounts.length > 0) {
          dailyLimit = accounts.filter(a => a.active !== false).reduce((sum, a) => sum + (a.dailyLimit || 500), 0);
        } else {
          dailyLimit = config.schedule?.max_per_day || 500;
        }
      }
    } catch { /* 非关键 I/O 失败不影响主流程 */ }
    _statsCache = { sentToday, dailyLimit, remaining: Math.max(0, dailyLimit - sentToday), totalSent, totalFailed, queueLength: deps.sendQueue.length };
    _statsCacheTime = now;
    return _statsCache;
  });

  // 应用版本号
  ipcMain.handle('app:getVersion', async () => require('electron').app.getVersion());

  // ── SMTP 状态（兼容旧 smtp + 新 smtpAccounts，含连通性测试结果）──
  ipcMain.handle('smtp:checkStatus', async () => {
    const cp = path.join(APP_ROOT, 'send', 'config.json');
    if (!fs.existsSync(cp)) return { ok: false, host: '未配置' };
    try {
      const raw = await fs.promises.readFile(cp, 'utf-8');
      const c = JSON.parse(raw);
      // 新格式：smtpAccounts
      if (Array.isArray(c.smtpAccounts) && c.smtpAccounts.length > 0) {
        // 读取熔断状态
        let fusedIds = new Set();
        try {
          const lp = path.join(APP_ROOT, 'send', 'send-log.json');
          if (fs.existsSync(lp)) {
            const log = JSON.parse(await fs.promises.readFile(lp, 'utf-8'));
            const acctMgr = require('../services/account-manager');
            for (const a of c.smtpAccounts) {
              if (acctMgr.isFused(a.id, log._accountStates || {})) fusedIds.add(a.id);
            }
          }
        } catch { /* 非关键 I/O 失败不影响主流程 */ }

        const enabled = c.smtpAccounts.filter(a => a.active !== false);
        if (!enabled.length) return { ok: false, host: '无活跃账号', user: '' };

        const tested = enabled.filter(a => a._lastTest);
        const passed = tested.filter(a => a._lastTest?.ok);
        const failed = tested.filter(a => a._lastTest && !a._lastTest.ok);
        const untested = enabled.filter(a => !a._lastTest);

        // 活跃数 = 启用 且 非熔断 且 (未测试 或 测试通过)。失败/熔断视为停用
        const active = enabled.filter(a =>
          !fusedIds.has(a.id) && (!a._lastTest || a._lastTest.ok !== false)
        );

        if (!active.length) {
          const reason = fusedIds.size > 0 ? '账号异常（熔断/离线）' : '无连通账号';
          return { ok: false, host: reason, user: '' };
        }
        const first = active[0];
        return {
          ok: passed.length > 0,
          host: first.smtp?.host || '未配置',
          user: first.smtp?.user || '',
          accountCount: c.smtpAccounts.length,
          activeCount: active.length,
          testedCount: tested.length,
          passedCount: passed.length,
          failedCount: failed.length,
          untestedCount: untested.length,
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
      try { await new Promise((resolve, reject) => { const req = createRequest({ hostname: t.host, path: '/', method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'Prospector/1.0' } }); req.on('response', (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); }); req.end(); }); results.push({ name: t.name, ok: true, ms: Date.now() - start }); } catch (e) { results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e.message }); }
    }
    return { proxy: proxy ? `${proxy.hostname}:${proxy.port}` : null, results };
  });

  // ── 客户开发（需 Python 环境，当前暂不可用） ──
  ipcMain.handle('discover:search', async () => ({ ok: false, error: '此功能需要 Python 抓取服务，当前版本暂未包含' }));
  ipcMain.handle('discover:lookup', async () => ({ ok: false, error: '此功能需要 Python 抓取服务，当前版本暂未包含' }));

  // ── 系统功能 ──
  const { app, shell } = require('electron');
  ipcMain.handle('app:minimizeToTray', async () => { deps.mainWindow?.hide(); return true; });
  ipcMain.handle('app:openReports', async () => shell.openPath(path.join(APP_ROOT, 'reports')));
  ipcMain.handle('app:openSendFolder', async () => shell.openPath(path.join(APP_ROOT, 'send')));
  ipcMain.handle('app:openExternal', async (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:openLogFile', async () => shell.openPath(path.join(APP_ROOT, 'logs')));

  // ── 签名 ──
  const sfp = path.join(APP_ROOT, 'send', 'signature.html');
  ipcMain.handle('signature:load', async () => { try { if (fs.existsSync(sfp)) return { ok: true, html: fs.readFileSync(sfp, 'utf-8') }; } catch { /* 非关键 I/O 失败不影响主流程 */ } return { ok: true, html: '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>' }; });
  ipcMain.handle('signature:save', async (_e, html) => { const d = path.dirname(sfp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(sfp, html); return { ok: true }; });

  // ── 设置 ──
  ipcMain.handle('config:load', async () => loadSearchConfig());
  ipcMain.handle('config:save', async (_e, config) => { const cp = path.join(APP_ROOT, 'send', 'config.json'); const d = path.dirname(cp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(cp, JSON.stringify(config, null, 2)); return { ok: true }; });

  // ── 数据导出 ──
  ipcMain.handle('data:export', async () => {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    // Sheet1: 联系人
    const cp = path.join(APP_ROOT, 'data', 'contacts.json');
    if (fs.existsSync(cp)) {
      try {
        const contacts = JSON.parse(fs.readFileSync(cp, 'utf-8'));
        const rows = contacts.map(c => ({
          '公司': c.company || '', '国家': c.country || '', '分类': c.category || '',
          '邮箱': c.email || '', '网站': c.website || '',
          '名': c.firstName || '', '姓': c.lastName || '', '联系人': c.contactName || '',
          '职位': c.position || '', '电话': c.phone || '', '客户类型': c.clientType || '',
          '标签': (c.tags||[]).join(', '), '添加时间': (c.addedAt||'').slice(0,10),
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '联系人');
      } catch { /* 非关键 I/O 失败不影响主流程 */ }
    }

    // Sheet2: 发送记录
    const lp = path.join(APP_ROOT, 'send', 'send-log.json');
    if (fs.existsSync(lp)) {
      try {
        const log = JSON.parse(fs.readFileSync(lp, 'utf-8'));
        const rows = (log.sent || []).map(r => ({
          '时间': r.time ? new Date(r.time).toISOString().slice(0,16).replace('T',' ') : '',
          '公司': r.company || '', '收件人': r.to || '',
          '主题': r.subject || '', '发信账号': r._accountId || '',
          '状态': r.status === 'sent' ? '已发送' : r.status === 'failed' ? '失败' : r.status,
          '错误信息': r.error || '', '阶段': r._stage || '',
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '发送记录');
      } catch { /* 非关键 I/O 失败不影响主流程 */ }
    }

    // Sheet3: 跟进状态（联系人 + 发送历史合并）
    try {
      let contacts = [];
      if (fs.existsSync(cp)) contacts = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      const sp = path.join(APP_ROOT, 'data', 'send-history.json');
      let history = {};
      if (fs.existsSync(sp)) history = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      const rows = contacts.map(c => {
        const h = history[c.company] || {};
        return {
          '公司': c.company || '', '邮箱': c.email || '', '国家': c.country || '',
          '阶段': h.stage || '', '最后发送': (h.lastSent||'').slice(0,10),
          '发送次数': h.sentCount || 0, '已退信': c.bounced ? '是' : '',
          '已回复': c.replied ? '是' : '',
        };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '跟进状态');
    } catch { /* 非关键 I/O 失败不影响主流程 */ }

    // 保存到桌面
    const desktop = path.join(require('os').homedir(), 'Desktop');
    const filename = `Milogin数据导出_${new Date().toISOString().slice(0,10)}.xlsx`;
    const dest = path.join(desktop, filename);
    XLSX.writeFile(wb, dest);
    return { ok: true, data: { path: dest, filename } };
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
}

module.exports = { register };
