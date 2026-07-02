// ── 发送 + 退信 IPC 入口 ──
// 发送引擎逻辑已拆分至 ./services/send-engine.js
// 历史持久化已拆分至 ./services/history-store.js
// 系统类 IPC 已拆分至 ./ipc/system-ipc.js

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');

// 从拆分模块引入发送引擎函数
const engine = require('./services/send-engine');

function register(ipcMain, deps) {
  const ssp = path.join(APP_ROOT, 'data', 'send-state.json');

  // 渲染进程通信：sendProgress 捕获 deps.mainWindow
  function sendProgress(data) {
    const w = deps.mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send('send:progress', data);
  }

  // ── 发送控制 IPC ──
  ipcMain.handle('send:start', async (_e, emails) => {
    if (deps._sendInProgress) return { finished: false, error: '发送已在进行中，请等待当前批次完成' };
    deps._sendInProgress = true;
    deps.sendQueue.length = 0; deps.sendQueue.push(...emails); deps.isPaused = false;
    try { await engine.runSendBatch(deps, sendProgress); } finally { deps._sendInProgress = false; }
    return { finished: true };
  });

  ipcMain.handle('send:resume', async () => {
    deps.isPaused = false;
    engine.resumeDelay();
    sendProgress({ type: 'resumed' });
    return { resumed: true };
  });

  ipcMain.handle('send:pause', async () => {
    deps.isPaused = true;
    engine.pauseDelay();
    sendProgress({ type: 'paused' });
    return { paused: true };
  });

  ipcMain.handle('send:cancel', async () => {
    deps.isPaused = true; deps.currentSendAbort = true;
    engine._clearDelay();
    deps.sendQueue.length = 0; deps._sendInProgress = false;
    try { deps.currentTransporter?.close(); } catch { /* 清理操作失败不影响主流程 */ }
    return { cancelled: true };
  });

  ipcMain.handle('send:status', async () => {
    const lp = path.join(APP_ROOT, 'send', 'send-log.json'); let dc = 0, ld = '';
    if (fs.existsSync(lp)) { const l = JSON.parse(fs.readFileSync(lp, 'utf-8')); dc = l.daily_count || 0; ld = l.last_date_beijing || l.last_date || ''; }
    return { queueLength: deps.sendQueue.length, isPaused: deps.isPaused, dailyCount: dc, lastDate: ld };
  });

  ipcMain.handle('send:saveState', async (_e, data) => {
    let cur = {}; try { if (fs.existsSync(ssp)) cur = JSON.parse(fs.readFileSync(ssp, 'utf-8')); } catch { /* 清理操作失败不影响主流程 */ }
    fs.writeFileSync(ssp, JSON.stringify({ ...cur, ...data }, null, 2)); return { ok: true };
  });

  ipcMain.handle('send:loadState', async () => {
    try { return { ok: true, data: fs.existsSync(ssp) ? JSON.parse(fs.readFileSync(ssp, 'utf-8')) : {} }; }
    catch { return { ok: true, data: {} }; }
  });

  // ── 测试发送单封 ──
  ipcMain.handle('send:testOne', async (_e, params) => {
    const configPath = path.join(APP_ROOT, 'send', 'config.json');
    if (!fs.existsSync(configPath)) return { ok: false, error: 'config.json 未找到' };
    let config; try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { return { ok: false, error: 'config.json 解析失败' }; }
    if (!config.test?.email) return { ok: false, error: '请先在设置中配置测试邮箱' };

    // 确定用哪个账号：优先 params.accountId 匹配，其次活跃账号第一个
    const acctMgr = require('./services/account-manager');
    let smtpConfig;
    const accounts = config.smtpAccounts || [];
    if (params.accountId && accounts.length > 0) {
      const acc = accounts.find(a => a.id === params.accountId);
      if (!acc) return { ok: false, error: '指定账号不存在' };
      smtpConfig = acc.smtp;
    } else if (accounts.length > 0) {
      const active = accounts.filter(a => a.active !== false);
      if (!active.length) return { ok: false, error: '无活跃发信账号' };
      smtpConfig = active[0].smtp;
    } else if (config.smtp?.host) {
      // 向后兼容旧格式
      smtpConfig = config.smtp;
      if (process.env.SMTP_PASS) smtpConfig = { ...smtpConfig, pass: process.env.SMTP_PASS };
    } else {
      return { ok: false, error: '请先配置 SMTP' };
    }
    if (process.env.SMTP_PASS) smtpConfig.pass = process.env.SMTP_PASS;

    const sigPath = path.join(APP_ROOT, 'send', 'signature.html');
    const signatureText = config.signature?.text || '金颖哲 Zayne Jin | YQN Logistics\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com';
    const signatureHtml = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '';
    const senderName = config.sender?.name || 'Zayne Jin';
    const senderEmail = smtpConfig.user || config.sender?.email || 'zayne_jin@yqn.com';
    const fromAddr = `"${senderName}" <${senderEmail}>`;
    const testCompany = config.test?.company || '测试公司';

    // 构建测试正文（替换公司名占位符）
    let body = params.body || `Buen día,\n\nSoy ${config.sender?.bodyName || 'Zayne'}, de YQN. Somos un agente de carga con operaciones en las principales rutas de Asia a Latinoamérica.\n\nSi en algún momento necesitan apoyo logístico, estoy a su disposición.\n\nSaludos,`;
    body = body.replace(/\{\{company\}\}/g, testCompany);

    // 使用 engine.buildContent 消除与 _sendOne 的重复逻辑
    const { textBody, html } = engine.buildContent(body, signatureText, signatureHtml);

    try {
      const transporter = acctMgr.createTransporter({ smtp: smtpConfig });
      const subject = params.subject || `[测试] 来自 YQN — ${testCompany}`;
      const info = await transporter.sendMail({
        from: fromAddr, to: config.test.email,
        subject: `[测试] ${subject.replace(/^\[测试\]\s*/, '')}`,
        text: textBody, html,
      });
      await transporter.close();
      return { ok: true, messageId: info.messageId, to: config.test.email };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 退信检测 ──
  ipcMain.handle('imap:test', async (_e, cfg) => require('../bounce-checker').testConnection(cfg));
  ipcMain.handle('bounce:check', async () => { try { return await Promise.race([require('../bounce-checker').checkBounces(), new Promise(r => setTimeout(() => r({ ok: false, error: '检测超时' }), 60000))]); } catch (e) { return { ok: false, error: '检测异常' }; } });
  ipcMain.handle('bounce:clear', async () => { require('../bounce-checker').clearCursor(); return { ok: true }; });

  // ── 退信日志 ──
  const blp = path.join(APP_ROOT, 'data', 'bounce-log.json');
  ipcMain.handle('bounce:loadLog', async () => { try { if (fs.existsSync(blp)) return { ok: true, data: JSON.parse(fs.readFileSync(blp, 'utf-8')) }; } catch { /* 清理操作失败不影响主流程 */ } return { ok: true, data: [] }; });
  ipcMain.handle('bounce:saveLog', async (_e, d) => { const dir = path.dirname(blp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(blp, JSON.stringify(d, null, 2)); return { ok: true }; });
}

module.exports = {
  register,
  cleanup: () => { engine.cleanup(); },
};
