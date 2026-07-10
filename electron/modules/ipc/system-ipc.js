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

  // ── 客户开发 → 已迁移到 electron/modules/acquisition-ipc.js ──

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
    const contactsDb = require('../services/contacts-db');

    // Sheet1: 联系人（SQLite 完整字段）
    try {
      const contacts = contactsDb.listAll();
      const STAGE_LABEL = { cold:'冷开发', f1:'F1', f2:'F2', f3:'F3', f4:'F4' };
      const rows = contacts.map(c => ({
        '公司': c.company_name || c.company || '',
        '国家': c.company_country || c.country || '',
        '分类': c.category || '',
        '邮箱': c.email || '',
        '网站': c.company_website || c.website || '',
        '名': c.first_name || c.firstName || (c.contact_name || c.contactName || '').split(' ')[0] || ((c.email || '').split('@')[0] || ''),
        '姓': c.last_name || c.lastName || (c.contact_name || c.contactName || '').split(' ').slice(1).join(' ') || '',
        '职位': c.title || c.position || '',
        '电话': c.phone || '',
        '领英': c.linkedin || '',
        '客户类型': c.client_type || c.clientType || '',
        '标签': (c.tags || []).join(', '),
        '阶段': STAGE_LABEL[c.stage] || c.stage || 'cold',
        '退信': c.is_bounced ? '是' : '',
        '退信原因': c.bounce_reason || c.bounceReason || '',
        '最后发送': (c.last_sent_at || c._sentAt || '').slice(0, 10),
        '发信账号': c.last_sent_acct || c._sentAccount || '',
        '跟进人': c.assignee || '',
        '跟进备注': c.followup_note || '',
        '机会阶段': c.opp_stage || '',
        '添加时间': (c.created_at || '').slice(0, 10),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '联系人');
    } catch { /* 降级 */ }

    // Sheet2: 发送记录（SQLite）
    try {
      const sendLog = require('../services/send-log-db');
      const { records } = sendLog.list({ limit: 50000 });
      const rows = records.map(r => ({
        '时间': r.time ? new Date(r.time).toISOString().slice(0, 16).replace('T', ' ') : '',
        '公司': r.company || '', '收件人': r.to || '',
        '主题': r.subject || '', '发信账号': r._accountId || '',
        '状态': r.status === 'sent' ? '已发送' : r.status === 'failed' ? '失败' : r.status,
        '错误信息': r.error || '', '阶段': r._stage || '',
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '发送记录');
    } catch { /* 降级 */ }

    // Sheet3: 互动记录
    try {
      const interactionsDb = require('../services/interactions-db');
      const interactions = interactionsDb.list({ limit: 5000 });
      const rows = interactions.map(i => ({
        '时间': (i.created_at || '').slice(0, 16).replace('T', ' '),
        '类型': i.type === 'sent' ? '发信' : i.type === 'received' ? '收信' : i.type === 'bounced' ? '退信' : i.type,
        '方向': i.direction === 'outbound' ? '发出' : '收到',
        '主题': i.subject || '',
        '摘要': (i.snippet || '').slice(0, 200),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '互动记录');
    } catch { /* 降级 */ }

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
