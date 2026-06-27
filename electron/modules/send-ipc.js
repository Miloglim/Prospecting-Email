// ── 发送引擎核心 + 所有发送/历史/退信/签名/设置/系统/仪表盘 IPC ─────────
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');
const { APP_ROOT, loadSearchConfig, createRequest, getProxyConfig } = require('./config');
const { beijingToday, beijingDateFromISO, sleep } = require('./utils');
const { callScraplingAPI } = require('./scrapling');

let _autoBounceTimer = null;

function register(ipcMain, deps) {
  const qfp = path.join(APP_ROOT, 'data', 'email-queue.json');
  const ssp = path.join(APP_ROOT, 'data', 'send-state.json');

  // ponytail: 不能解构 deps.mainWindow/tray — 注册时它们还是 null，窗口/tray 之后才创建
  function sendProgress(data) {
    const w = deps.mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send('send:progress', data);
  }

  // ── 正文存储 ──
  const bodiesPath = path.join(APP_ROOT, 'data', 'send-bodies.json');
  function loadBodies() { try { if (fs.existsSync(bodiesPath)) return JSON.parse(fs.readFileSync(bodiesPath, 'utf-8')); } catch {} return {}; }
  function saveBody(text) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const bodies = loadBodies(); bodies[id] = (text || '').slice(0, 2000);
    const keys = Object.keys(bodies);
    if (keys.length > 5000) { keys.sort((a, b) => parseInt(a, 36) - parseInt(b, 36)); keys.slice(0, keys.length - 5000).forEach(k => delete bodies[k]); }
    const d = path.dirname(bodiesPath); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(bodiesPath, JSON.stringify(bodies, null, 2)); return id;
  }

  // ── 自动退信 ──
    function scheduleAutoBounceCheck() {
    clearTimeout(_autoBounceTimer);
    _autoBounceTimer = setTimeout(async () => {
      try {
        console.log('[退信] 自动检测启动...');
        const { checkBounces } = require('../bounce-checker');
        const result = await checkBounces();
        if (!result.ok || !result.bounced?.length) return;
        const cp = path.join(APP_ROOT, 'data', 'contacts.json');
        if (!fs.existsSync(cp)) return;
        let contacts = JSON.parse(fs.readFileSync(cp, 'utf-8')); let matched = 0;
        for (const b of result.bounced) {
          if (!b.bouncedEmail) continue; const key = b.bouncedEmail.toLowerCase().trim();
          for (const c of contacts) { if ((c.email || '').toLowerCase().trim() === key) { c.bounced = true; c.bounceType = b.type || 'unknown'; c.bounceReason = b.reason || ''; c.bouncedAt = c.bouncedAt || new Date().toISOString(); matched++; } }
        }
        if (matched > 0) {
          fs.writeFileSync(cp, JSON.stringify(contacts, null, 2));
          if (deps.tray) new (require('electron').Notification)({ title: '📨 退信检测', body: `发现 ${result.bounced.length} 封退信，已标记 ${matched} 个联系人` }).show();
          if (deps.mainWindow && !deps.mainWindow.isDestroyed()) deps.mainWindow.webContents.send('bounce:autoDetected', { count: result.bounced.length, matched });
        }
      } catch (e) { console.error('[退信] 自动检测异常:', e.message); }
    }, 10 * 60 * 1000);
  }

  // ── 发送引擎：加载配置 + 构建上下文 ──────────────────────────────
  function _loadConfig() {
    const cp = path.join(APP_ROOT, 'send', 'config.json');
    if (!fs.existsSync(cp)) { sendProgress({ error: 'config.json 未找到' }); return null; }
    let config; try { config = JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch (e) { sendProgress({ error: 'config.json 解析失败: ' + e.message }); return null; }
    if (process.env.SMTP_PASS) config.smtp.pass = process.env.SMTP_PASS;
    if (!config.smtp?.host || !config.smtp?.user) { sendProgress({ error: 'SMTP 未配置' }); return null; }
    return config;
  }

  function _buildContext(config) {
    const nodemailer = require('nodemailer');
    const sigPath = path.join(APP_ROOT, 'send', 'signature.html');
    const testMode = !!(config.test?.enabled && config.test?.email);
    const isBatch = (config.schedule?.mode || 'multi') === 'batch';
    const sc = config.schedule || {};

    const ctx = {
      config, testMode, isBatch, nodemailer,
      logPath: path.join(APP_ROOT, 'send', testMode ? 'send-log-test.json' : 'send-log.json'),
      sigHtml: fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '',
      sigText: config.signature?.text || '金颖哲 Zayne Jin | YQN Logistics\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com',
      senderAddr: config.sender?.email || 'zayne_jin@yqn.com',
      fromAddr: `"${config.sender?.name || 'Zayne Jin'}" <${config.sender?.email || 'zayne_jin@yqn.com'}>`,
      maxPerDay: sc.max_per_day ?? 500,
      startH: sc.start_hour_beijing ?? 19,
      endH: sc.end_hour_beijing ?? 3,
      SINGLE: sc.single_recip_threshold ?? 2,
      // 封间延迟
      perMin: isBatch
        ? (sc.batch_item_delay_min ?? sc.min_delay_seconds ?? 30) * 1000
        : (sc.min_delay_seconds ?? 30) * 1000,
      perMax: isBatch
        ? (sc.batch_item_delay_max ?? sc.max_delay_seconds ?? 90) * 1000
        : (sc.max_delay_seconds ?? 90) * 1000,
      // 公司切换延迟
      cdMin: (sc.company_delay_min_seconds ?? 300) * 1000,
      cdMax: (sc.company_delay_max_seconds ?? 900) * 1000,
      SD_MIN: (sc.single_recip_delay_min_seconds ?? 60) * 1000,
      SD_MAX: (sc.single_recip_delay_max_seconds ?? 180) * 1000,
      // 批处理参数
      batchSize: sc.batch_size || 10,
      batchPauseMin: (sc.batch_pause_min_seconds ?? 150) * 1000,
      batchPauseMax: (sc.batch_pause_max_seconds ?? 210) * 1000,
    };
    return ctx;
  }

  function _logRecord(ctx, to, company, subject, msgId, status, err) {
    const rec = {
      index: 0, to, company: company || '', subject,
      messageId: msgId, count: 1,
      bodyId: saveBody(''),
      _stage: '', _lang: '', _type: 'unlabeled', _country: '',
      time: new Date().toISOString(), time_beijing: beijingToday(), status,
      _test: !!ctx.testMode,
    };
    if (err) rec.error = err;
    return rec;
  }

  async function _sendOne(ctx, email, log) {
    const toList = email.recipients?.length ? email.recipients : (typeof email.to === 'string' ? email.to.split(',').map(s => s.trim()).filter(Boolean) : []);
    if (!toList.length) return { ok: false, n: 0 };

    const bodyText = email.body || '';
    const sigStart = (ctx.sigText || '').split('\n')[0]?.trim();
    const hasSig = sigStart && bodyText.trimEnd().includes(sigStart);
    const textBody = hasSig ? bodyText : (bodyText + '\n--\n' + ctx.sigText);
    const lines = bodyText.split('\n'), htmlLines = [];
    let first = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const c = (first && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t)) ? `<strong style="font-size:15px">${t}</strong>` : t;
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${c}</p>`);
      first = false;
    }
    const html = hasSig ? (htmlLines.join('\n') + '\n<br>\n' + bodyText.trimEnd().slice(bodyText.trimEnd().indexOf(sigStart))) : (htmlLines.join('\n') + '\n<br>\n' + ctx.sigHtml);

    const subject = ctx.testMode ? `[测试] ${email.subject}` : email.subject;
    const aTo = ctx.testMode ? (ctx.config.test?.email || ctx.senderAddr) : toList[0];
    const aBcc = ctx.testMode ? [] : toList.slice(1);

    try {
      const info = await deps.currentTransporter.sendMail({ from: ctx.fromAddr, to: aTo, ...(aBcc.length ? { bcc: aBcc.join(', ') } : {}), subject, text: textBody, html });
      if (!ctx.testMode) for (const r of toList) { log.sent.push(_logRecord(ctx, r, email.company, subject, info.messageId, 'sent')); log.daily_count++; }
      return { ok: true, n: toList.length };
    } catch (err) {
      const em = err.message || '';
      if (!deps.currentSendAbort && (em.includes('socket') || em.includes('ECONN') || em.includes('closed'))) {
        try { await deps.currentTransporter.close(); } catch {}
        deps.currentTransporter = ctx.nodemailer.createTransport({
          host: ctx.config.smtp.host, port: ctx.config.smtp.port || 465, secure: ctx.config.smtp.secure !== false,
          auth: { user: ctx.config.smtp.user, pass: ctx.config.smtp.pass || '' },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
        });
        await sleep(2000);
        if (deps.currentSendAbort) return { ok: false, n: 0 };
        try {
          const info = await deps.currentTransporter.sendMail({ from: ctx.fromAddr, to: aTo, ...(aBcc.length ? { bcc: aBcc.join(', ') } : {}), subject, text: textBody, html });
          if (!ctx.testMode) for (const r of toList) { log.sent.push(_logRecord(ctx, r, email.company, subject, info.messageId, 'sent')); log.daily_count++; }
          return { ok: true, n: toList.length };
        } catch (retryErr) { err = retryErr; }
      }
      const finalErr = err.message || '';
      if (['rate limit','too many','try again','421','450','451','452'].some(k => finalErr.toLowerCase().includes(k)) && !ctx.testMode) {
        deps.isPaused = true; sendProgress({ type: 'ratelimit', error: finalErr }); return { ok: false, n: 0, fatal: true };
      }
      if (!ctx.testMode) for (const r of toList) { log.sent.push(_logRecord(ctx, r, email.company, subject, '', 'failed', finalErr)); }
      return { ok: false, n: 0 };
    }
  }

  function _computeEstimate(ctx, pendingItems) {
    const companies = new Set(pendingItems.map(e => e.company).filter(Boolean));
    let totalSec = 0;
    if (ctx.isBatch) {
      // 均匀模式：无封间延迟，仅批次间暂停
      const bAvg = Math.round((ctx.batchPauseMin + ctx.batchPauseMax) / 2000);
      totalSec = Math.max(0, Math.ceil(pendingItems.length / ctx.batchSize) - 1) * bAvg;
    } else {
      const avgDelay = Math.round((ctx.perMin + ctx.perMax) / 2000);
      const cdAvg = Math.round((ctx.cdMin + ctx.cdMax) / 2000);
      totalSec = pendingItems.length * avgDelay + Math.max(0, companies.size - 1) * cdAvg;
    }
    return {
      type: 'estimate', total: pendingItems.length,
      avgDelay: ctx.isBatch ? 0 : Math.round((ctx.perMin + ctx.perMax) / 2000),
      companyDelayMin: Math.round(ctx.cdMin / 1000), companyDelayMax: Math.round(ctx.cdMax / 1000),
      estMin: Math.floor(totalSec / 60), estSec: totalSec % 60,
      _mode: ctx.isBatch ? 'batch' : 'multi',
    };
  }

  // ── 发送引擎核心 ────────────────────────────────────────────────
  async function runSendBatch() {
    const config = _loadConfig(); if (!config) return;
    const ctx = _buildContext(config);

    let log = { sent: [], daily_count: 0, last_date: '' };
    if (fs.existsSync(ctx.logPath)) { try { log = JSON.parse(fs.readFileSync(ctx.logPath, 'utf-8')); } catch {} }
    if ((log.last_date_beijing || log.last_date) !== beijingToday()) { log.daily_count = 0; log.last_date_beijing = beijingToday(); }

    deps.currentSendAbort = false;
    deps.currentTransporter = ctx.nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port || 465, secure: config.smtp.secure !== false,
      auth: { user: config.smtp.user, pass: config.smtp.pass || '' },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
    });
    try { await deps.currentTransporter.verify().catch(() => {}); }
    catch (e) { sendProgress({ error: 'SMTP 连接失败: ' + e.message }); return; }

    function inWindow() {
      const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getHours();
      return ctx.startH < ctx.endH ? h >= ctx.startH && h < ctx.endH : h >= ctx.startH || h < ctx.endH;
    }

    const est = _computeEstimate(ctx, deps.sendQueue.filter(e => e.status === 'pending' || e.status === 'sending'));
    sendProgress(est);
    console.log(`[发信] 开始 — ${est.total} 封${ctx.isBatch ? '（批处理）' : ''}，预计 ${est.estMin}分${est.estSec}秒`);

    let sent = 0, failed = 0, batchCount = 0;

    for (let i = 0; i < deps.sendQueue.length; i++) {
      if (deps.currentSendAbort) { sendProgress({ type: 'cancelled' }); break; }
      if (deps.isPaused) { sendProgress({ type: 'paused' }); break; }
      if (!ctx.testMode && log.daily_count >= ctx.maxPerDay) { sendProgress({ type: 'limit', message: `已达每日上限 ${ctx.maxPerDay}` }); break; }
      while (!inWindow() && !deps.isPaused && !ctx.testMode && !deps.currentSendAbort) {
        const ok = await cancellableSleep(30000); if (!ok || deps.isPaused || deps.currentSendAbort) break;
      }
      if (deps.isPaused || deps.currentSendAbort) break;

      const email = deps.sendQueue[i];
      if (!email.recipients?.length && !email.to) continue;

      // 公司切换 + 封间延迟（仅多规则模式）
      if (!ctx.isBatch) {
        if (i > 0 && email.company !== deps.sendQueue[i - 1]?.company) {
          if (!deps.isPaused && log.daily_count < ctx.maxPerDay && (ctx.cdMin > 0 || ctx.cdMax > 0)) {
            const toList = email.recipients?.length || (email.to || '').split(',').length;
            const isSingle = toList <= ctx.SINGLE;
            const dm = Math.floor(Math.random() * ((isSingle ? ctx.SD_MAX : ctx.cdMax) - (isSingle ? ctx.SD_MIN : ctx.cdMin) + 1)) + (isSingle ? ctx.SD_MIN : ctx.cdMin);
            console.log(`[发信] 🏢 切换公司 → ${email.company}，暂停 ${Math.round(dm/1000)}s (${isSingle?'单人':'多人'})`);
            sendProgress({ type: 'delay', seconds: Math.round(dm/1000), company: email.company });
            if (!await cancellableSleep(dm)) break;
          }
        }
        // 封间延迟
        if (i > 0 || log.daily_count > 0) {
          if (!await cancellableSleep(Math.floor(Math.random() * (ctx.perMax - ctx.perMin + 1)) + ctx.perMin)) break;
        }
      }

      // 发送
      batchCount++;
      const result = await _sendOne(ctx, email, log);
      if (result.ok) sent += result.n; else if (result.fatal) { if (!ctx.testMode) fs.writeFileSync(ctx.logPath, JSON.stringify(log, null, 2)); break; } else failed += result.n;
      if (!ctx.testMode) fs.writeFileSync(ctx.logPath, JSON.stringify(log, null, 2));
      sendProgress(result.ok
        ? { type: 'sent', id: email.id, index: i + 1, total: deps.sendQueue.length, company: email.company, to: email.recipients?.[0] || email.to?.split(',')[0] || '', count: result.n }
        : { type: 'failed', id: email.id, error: '' }
      );

      // 批次暂停
      if (ctx.isBatch && batchCount >= ctx.batchSize) {
        const bp = Math.floor(Math.random() * (ctx.batchPauseMax - ctx.batchPauseMin + 1)) + ctx.batchPauseMin;
        const bpSec = Math.round(bp / 1000);
        console.log(`[发信] ⏸ 批次暂停 ${bpSec}s (${sent} 封已发，${deps.sendQueue.length - i - 1} 封待发)`);
        sendProgress({ type: 'delay', seconds: bpSec, company: `批次暂停(${batchCount}封后)` });
        if (!await cancellableSleep(bp)) break;
        batchCount = 0;
      }
    }

    try { await deps.currentTransporter.close(); } catch {}
    console.log(`[发信] 完成 — 成功 ${sent} 封，失败 ${failed} 封`);
    if (!deps.isPaused && !deps.currentSendAbort) sendProgress({ type: 'complete', total: deps.sendQueue.length, sent, failed, _testMode: ctx.testMode || undefined });
    if (deps.tray && !deps.isPaused && !deps.currentSendAbort && !ctx.testMode) new (require('electron').Notification)({ title: "Milogin's Prospector", body: `发送完成: 成功 ${sent} 封` }).show();
    if (!ctx.testMode) scheduleAutoBounceCheck();
  }

  // 可中断延迟：setTimeout + pause/abort 事件驱动，不需轮询
  let _delayResolve = null;
  let _delayTimer = null;
  let _delayStarted = 0;
  let _delayTotal = 0;

  function _clearDelay() {
    if (_delayTimer) { clearTimeout(_delayTimer); _delayTimer = null; }
    if (_delayResolve) { _delayResolve(true); _delayResolve = null; }
    _delayStarted = 0;
    _delayTotal = 0;
  }

  // 暂停：清除定时器，保留剩余时间，但不 resolve（循环原地冻结）
  function pauseDelay() {
    if (!_delayTimer) return;
    clearTimeout(_delayTimer);
    _delayTimer = null;
    _delayTotal -= (Date.now() - _delayStarted);
    if (_delayTotal < 0) _delayTotal = 0;
  }

  // 恢复：用剩余时间重建定时器
  function resumeDelay() {
    if (_delayTimer) return;                     // 已有活跃定时器，跳过
    if (!_delayResolve) return;                  // 无等待中的 Promise
    if (_delayTotal <= 0) {                      // 延迟已耗尽，立刻完成
      const r = _delayResolve;
      _delayResolve = null;
      r(true);
      return;
    }
    _delayStarted = Date.now();
    _delayTimer = setTimeout(() => {
      const r = _delayResolve;
      _delayResolve = null;
      _delayTimer = null;
      _delayStarted = 0;
      r(true);
    }, _delayTotal);
  }

  async function cancellableSleep(ms) {
    if (ms <= 0) return true;
    if (deps.currentSendAbort) return false;

    return new Promise((resolve) => {
      _delayResolve = resolve;
      _delayStarted = Date.now();
      _delayTotal = ms;
      _delayTimer = setTimeout(() => {
        _delayResolve = null;
        _delayTimer = null;
        _delayStarted = 0;
        resolve(true);
      }, ms);
    });
  }

  // ── IPC 注册 ──
  ipcMain.handle('send:start', async (_e, emails) => {
    if (deps._sendInProgress) return { finished: false, error: '发送已在进行中，请等待当前批次完成' };
    deps._sendInProgress = true;
    deps.sendQueue.length = 0; deps.sendQueue.push(...emails); deps.isPaused = false;
    try { await runSendBatch(); } finally { deps._sendInProgress = false; }
    return { finished: true };
  });
  ipcMain.handle('send:resume', async () => { deps.isPaused = false; resumeDelay(); sendProgress({ type: 'resumed' }); return { resumed: true }; });
  ipcMain.handle('send:pause', async () => { deps.isPaused = true; pauseDelay(); sendProgress({ type: 'paused' }); return { paused: true }; });
  ipcMain.handle('send:cancel', async () => { deps.isPaused = true; deps.currentSendAbort = true; _clearDelay(); deps.sendQueue.length = 0; deps._sendInProgress = false; try { deps.currentTransporter?.close(); } catch {} return { cancelled: true }; });
  ipcMain.handle('send:status', async () => {
    const lp = path.join(APP_ROOT, 'send', 'send-log.json'); let dc = 0, ld = '';
    if (fs.existsSync(lp)) { const l = JSON.parse(fs.readFileSync(lp, 'utf-8')); dc = l.daily_count || 0; ld = l.last_date_beijing || l.last_date || ''; }
    return { queueLength: deps.sendQueue.length, isPaused: deps.isPaused, dailyCount: dc, lastDate: ld };
  });

  // ── 测试发送单封 ──
  ipcMain.handle('send:testOne', async (_e, params) => {
    const nodemailer = require('nodemailer');
    const configPath = path.join(APP_ROOT, 'send', 'config.json');
    if (!fs.existsSync(configPath)) return { ok: false, error: 'config.json 未找到' };
    let config; try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { return { ok: false, error: 'config.json 解析失败' }; }
    if (process.env.SMTP_PASS) config.smtp.pass = process.env.SMTP_PASS;
    if (!config.test?.email) return { ok: false, error: '请先在设置中配置测试邮箱' };
    if (!config.smtp?.host || !config.smtp?.user) return { ok: false, error: '请先配置 SMTP' };

    const sigPath = path.join(APP_ROOT, 'send', 'signature.html');
    const signatureText = config.signature?.text || '金颖哲 Zayne Jin | YQN Logistics\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com';
    const signatureHtml = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '';
    const senderAddr = config.sender?.email || 'zayne_jin@yqn.com';
    const fromAddr = `"${config.sender?.name || 'Zayne Jin'}" <${senderAddr}>`;
    const testCompany = config.test?.company || '测试公司';

    // 构建测试正文（替换公司名占位符）
    let body = params.body || `Buen día,\n\nSoy ${config.sender?.bodyName || 'Zayne'}, de YQN. Somos un agente de carga con operaciones en las principales rutas de Asia a Latinoamérica.\n\nSi en algún momento necesitan apoyo logístico, estoy a su disposición.\n\nSaludos,`;
    // ponytail: 替换硬编码公司名为测试公司名
    body = body.replace(/\{\{company\}\}/g, testCompany);

    const sigStart = (signatureText || '').split('\n')[0]?.trim();
    const hasSig = sigStart && body.trimEnd().includes(sigStart);
    const textBody = hasSig ? body : (body + '\n--\n' + signatureText);
    const lines = body.split('\n'); const htmlLines = []; let first = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const c = (first && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t)) ? `<strong style="font-size:15px">${t}</strong>` : t;
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${c}</p>`);
      first = false;
    }
    const html = hasSig ? (htmlLines.join('\n') + '\n<br>\n' + body.trimEnd().slice(body.trimEnd().indexOf(sigStart))) : (htmlLines.join('\n') + '\n<br>\n' + signatureHtml);

    try {
      const transporter = nodemailer.createTransport({
        host: config.smtp.host, port: config.smtp.port || 465, secure: config.smtp.secure !== false,
        auth: { user: config.smtp.user, pass: config.smtp.pass || '' },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
      });
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

  // ── 发送历史 ──
  const shp = path.join(APP_ROOT, 'data', 'send-history.json');
  function rsh() { try { return fs.existsSync(shp) ? JSON.parse(fs.readFileSync(shp, 'utf-8')) : {}; } catch { return {}; } }
  function wsh(h) { const d = path.dirname(shp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(shp, JSON.stringify(h, null, 2)); }
  ipcMain.handle('history:get', async () => rsh());
  ipcMain.handle('history:advance', async (_e, companies) => {
    const h = rsh(); const now = new Date().toISOString(); const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    for (const name of companies) { const cur = h[name]?.stage || 'cold'; const idx = STAGES.indexOf(cur); const ni = idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx; const next = STAGES[ni]; const u = { ...h[name], stage: next, lastSent: now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] }; if (!h[name]?.startedAt) u.startedAt = now; if (next === 'archived') u.archivedAt = now; h[name] = u; }
    wsh(h); return h;
  });
  ipcMain.handle('history:recordSentences', async (_e, c, sids) => { const h = rsh(); const e = h[c] || {}; const u = e.usedSentences || []; h[c] = { ...e, usedSentences: (e.sentCount || 0) >= 5 ? [...(sids || [])] : [...new Set([...u, ...(sids || [])])] }; wsh(h); return { ok: true }; });
  ipcMain.handle('history:reactivate', async (_e, c) => { const h = rsh(); h[c] = { ...h[c], stage: 'cold', usedSentences: [], sentContacts: [], lastSent: new Date().toISOString(), archivedAt: undefined }; wsh(h); return { ok: true }; });
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
          try { records.push(...(JSON.parse(fs.readFileSync(lp, 'utf-8')).sent || [])); } catch {}
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
    for (const lp of [path.join(APP_ROOT, 'send', 'send-log.json'), path.join(APP_ROOT, 'send', 'send-log-test.json')]) {
      if (!fs.existsSync(lp)) continue;
      if (indices[0] === '__ALL__') { fs.writeFileSync(lp, JSON.stringify({ sent: [], daily_count: 0, last_date_beijing: '' }, null, 2)); continue; }
      const log = JSON.parse(fs.readFileSync(lp, 'utf-8')); const iset = new Set(indices.map(String)); log.sent = log.sent.filter(r => !iset.has(String(r.index))); fs.writeFileSync(lp, JSON.stringify(log, null, 2));
    }
    return { ok: true, deleted: indices[0] === '__ALL__' ? -1 : indices.length };
  });

  // ── 退信 ──
  ipcMain.handle('imap:test', async (_e, cfg) => require('../bounce-checker').testConnection(cfg));
  ipcMain.handle('bounce:check', async () => { try { return await Promise.race([require('../bounce-checker').checkBounces(), new Promise(r => setTimeout(() => r({ ok: false, error: '检测超时' }), 60000))]); } catch (e) { return { ok: false, error: '检测异常' }; } });
  const blp = path.join(APP_ROOT, 'data', 'bounce-log.json');
  ipcMain.handle('bounce:loadLog', async () => { try { if (fs.existsSync(blp)) return { ok: true, data: JSON.parse(fs.readFileSync(blp, 'utf-8')) }; } catch {} return { ok: true, data: [] }; });
  ipcMain.handle('bounce:saveLog', async (_e, d) => { const dir = path.dirname(blp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(blp, JSON.stringify(d, null, 2)); return { ok: true }; });

  // ── 签名 ──
  const sfp = path.join(APP_ROOT, 'send', 'signature.html');
  ipcMain.handle('signature:load', async () => { try { if (fs.existsSync(sfp)) return { ok: true, html: fs.readFileSync(sfp, 'utf-8') }; } catch {} return { ok: true, html: '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>' }; });
  ipcMain.handle('signature:save', async (_e, html) => { const d = path.dirname(sfp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(sfp, html); return { ok: true }; });

  // ── 队列持久化 ──
  ipcMain.handle('queue:save', async (_e, data) => { const d = path.dirname(qfp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(qfp, JSON.stringify(data, null, 2)); return { ok: true }; });
  ipcMain.handle('queue:load', async () => { try { if (fs.existsSync(qfp)) return { ok: true, data: JSON.parse(fs.readFileSync(qfp, 'utf-8')) }; } catch {} return { ok: false, data: [] }; });
  ipcMain.handle('send:saveState', async (_e, data) => { let cur = {}; try { if (fs.existsSync(ssp)) cur = JSON.parse(fs.readFileSync(ssp, 'utf-8')); } catch {} fs.writeFileSync(ssp, JSON.stringify({ ...cur, ...data }, null, 2)); return { ok: true }; });
  ipcMain.handle('send:loadState', async () => { try { return { ok: true, data: fs.existsSync(ssp) ? JSON.parse(fs.readFileSync(ssp, 'utf-8')) : {} }; } catch { return { ok: true, data: {} }; } });

  // ── 仪表盘 ──
  let _statsCache = null, _statsCacheTime = 0;
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

  // ── 客户开发 ──
  ipcMain.handle('discover:search', async (_e, params) => callScraplingAPI(`/search/discover?${new URLSearchParams(params).toString()}`));
  ipcMain.handle('discover:lookup', async (_e, params) => callScraplingAPI(`/scrape/email-pattern?${new URLSearchParams(params).toString()}`));

  // ── 系统 ──
  ipcMain.handle('app:minimizeToTray', async () => deps.mainWindow?.hide());
  ipcMain.handle('app:openReports', async () => { const d = path.join(APP_ROOT, 'reports'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });
  ipcMain.handle('app:openSendFolder', async () => { const d = path.join(APP_ROOT, 'send'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });
  ipcMain.handle('app:openExternal', async (_e, url) => { if (!url?.startsWith('https://')) return { ok: false }; await shell.openExternal(url); return { ok: true }; });
  ipcMain.handle('app:openLogFile', async () => {
    const { logDir } = require('../logger');
    const d = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
    const [dp] = d.split(', '); const [m, day, y] = dp.split('/');
    const p = path.join(logDir, `app-${y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}.log`);
    shell.openPath(p);
  });

  // ── 设置 ──
  ipcMain.handle('config:load', async () => loadSearchConfig());
  ipcMain.handle('config:save', async (_e, config) => { const cp = path.join(APP_ROOT, 'send', 'config.json'); const d = path.dirname(cp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(cp, JSON.stringify(config, null, 2)); return { ok: true }; });
}

module.exports = { register, cleanup: () => { clearTimeout(_autoBounceTimer); } };
