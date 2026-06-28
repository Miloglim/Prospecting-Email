// ── 发送引擎核心 ──
// 从 send-ipc.js 拆分：邮件发送、延迟管理、正文构建、日志记录、自动退信
// deps 通过参数传入，不直接引用全局变量

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const { beijingToday, beijingDateFromISO, sleep } = require('../utils');

// ── 内部状态：可中断延迟管理 ──
let _delayResolve = null;
let _delayTimer = null;
let _delayStarted = 0;
let _delayTotal = 0;

// ── 自动退信定时器 ──
let _autoBounceTimer = null;

// ── 正文存储（供 _logRecord 使用）─────────────────────────────────────────
const bodiesPath = path.join(APP_ROOT, 'data', 'send-bodies.json');

function loadBodies() {
  try { if (fs.existsSync(bodiesPath)) return JSON.parse(fs.readFileSync(bodiesPath, 'utf-8')); } catch {}
  return {};
}

function saveBody(text) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const bodies = loadBodies(); bodies[id] = (text || '').slice(0, 2000);
  const keys = Object.keys(bodies);
  if (keys.length > 5000) { keys.sort((a, b) => parseInt(a, 36) - parseInt(b, 36)); keys.slice(0, keys.length - 5000).forEach(k => delete bodies[k]); }
  const d = path.dirname(bodiesPath); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(bodiesPath, JSON.stringify(bodies, null, 2)); return id;
}

// ── 发送引擎：加载配置 ──────────────────────────────────────────────────
function _loadConfig(sendProgress) {
  const cp = path.join(APP_ROOT, 'send', 'config.json');
  if (!fs.existsSync(cp)) { sendProgress({ error: 'config.json 未找到' }); return null; }
  let config; try { config = JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch (e) { sendProgress({ error: 'config.json 解析失败: ' + e.message }); return null; }
  if (process.env.SMTP_PASS) config.smtp.pass = process.env.SMTP_PASS;
  if (!config.smtp?.host || !config.smtp?.user) { sendProgress({ error: 'SMTP 未配置' }); return null; }
  return config;
}

// ── 发送引擎：构建上下文 ──────────────────────────────────────────────────
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

// ── 正文构建：提取 send:testOne 和 _sendOne 中的重复 HTML 生成逻辑 ──────
function buildContent(bodyText, sigText, sigHtml) {
  const sigStart = (sigText || '').split('\n')[0]?.trim();
  const hasSig = sigStart && bodyText.trimEnd().includes(sigStart);
  const textBody = hasSig ? bodyText : (bodyText + '\n--\n' + sigText);
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
  const html = hasSig ? (htmlLines.join('\n') + '\n<br>\n' + bodyText.trimEnd().slice(bodyText.trimEnd().indexOf(sigStart))) : (htmlLines.join('\n') + '\n<br>\n' + sigHtml);
  return { textBody, html, hasSig };
}

// ── 日志记录 ──────────────────────────────────────────────────────────────
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

// ── 发送单封 ──────────────────────────────────────────────────────────────
// deps: { currentTransporter, currentSendAbort, isPaused }
async function _sendOne(ctx, email, log, deps) {
  const toList = email.recipients?.length ? email.recipients : (typeof email.to === 'string' ? email.to.split(',').map(s => s.trim()).filter(Boolean) : []);
  if (!toList.length) return { ok: false, n: 0 };

  const { textBody, html } = buildContent(email.body || '', ctx.sigText, ctx.sigHtml);

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
      deps.isPaused = true; return { ok: false, n: 0, fatal: true };
    }
    if (!ctx.testMode) for (const r of toList) { log.sent.push(_logRecord(ctx, r, email.company, subject, '', 'failed', finalErr)); }
    return { ok: false, n: 0 };
  }
}

// ── 预估 ──────────────────────────────────────────────────────────────────
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

// ── 可中断延迟：setTimeout + pause/abort 事件驱动 ──────────────────────────
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

// cancellableSleep: 可被 abort/pause 中断的延迟
async function cancellableSleep(ms, deps) {
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

// ── 发送引擎核心 ──────────────────────────────────────────────────────────
// deps: { sendQueue, isPaused, currentSendAbort, currentTransporter, _sendInProgress, mainWindow, tray }
async function runSendBatch(deps, sendProgress) {
  const config = _loadConfig(sendProgress); if (!config) return;
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
      const ok = await cancellableSleep(30000, deps); if (!ok || deps.isPaused || deps.currentSendAbort) break;
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
          if (!await cancellableSleep(dm, deps)) break;
        }
      }
      // 封间延迟
      if (i > 0 || log.daily_count > 0) {
        if (!await cancellableSleep(Math.floor(Math.random() * (ctx.perMax - ctx.perMin + 1)) + ctx.perMin, deps)) break;
      }
    }

    // 发送
    batchCount++;
    const result = await _sendOne(ctx, email, log, deps);
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
      if (!await cancellableSleep(bp, deps)) break;
      batchCount = 0;
    }
  }

  try { await deps.currentTransporter.close(); } catch {}
  console.log(`[发信] 完成 — 成功 ${sent} 封，失败 ${failed} 封`);
  if (!deps.isPaused && !deps.currentSendAbort) sendProgress({ type: 'complete', total: deps.sendQueue.length, sent, failed, _testMode: ctx.testMode || undefined });
  if (deps.tray && !deps.isPaused && !deps.currentSendAbort && !ctx.testMode) new (require('electron').Notification)({ title: "Milogin's Prospector", body: `发送完成: 成功 ${sent} 封` }).show();
  if (!ctx.testMode) scheduleAutoBounceCheck(deps.mainWindow, deps.tray);
}

// ── 自动退信调度 ──────────────────────────────────────────────────────────
function scheduleAutoBounceCheck(mainWindow, tray) {
  clearTimeout(_autoBounceTimer);
  _autoBounceTimer = setTimeout(async () => {
    try {
      console.log('[退信] 自动检测启动...');
      const { checkBounces } = require('../../bounce-checker');
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
        if (tray) new (require('electron').Notification)({ title: '📨 退信检测', body: `发现 ${result.bounced.length} 封退信，已标记 ${matched} 个联系人` }).show();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bounce:autoDetected', { count: result.bounced.length, matched });
      }
    } catch (e) { console.error('[退信] 自动退信检测异常:', e.message); }
  }, 10 * 60 * 1000);
}

// ── 清理 ──
function cleanup() {
  clearTimeout(_autoBounceTimer);
}

module.exports = {
  runSendBatch, _sendOne, _loadConfig, _buildContext, buildContent, _logRecord,
  loadBodies, saveBody,
  cancellableSleep, pauseDelay, resumeDelay, _clearDelay,
  scheduleAutoBounceCheck, cleanup,
};
