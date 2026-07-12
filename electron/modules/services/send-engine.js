// ── 发送引擎核心 ──
// 从 send-ipc.js 拆分：邮件发送、延迟管理、正文构建、日志记录、自动退信
// deps 通过参数传入，不直接引用全局变量

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const { beijingToday, beijingDateFromISO, sleep } = require('../utils');
const { Log } = require('../core/logger');

// ── 内部状态：可中断延迟管理 ──
let _delayResolve = null;
let _delayTimer = null;
let _delayStarted = 0;
let _delayTotal = 0;

// ── 自动退信定时器 ──
let _autoBounceTimer = null;

// ── 联系人标签回写：发送成功后标记 _sentBy / _sentAccount / _sentAt ─────
const contactsPath = path.join(APP_ROOT, 'data', 'contacts.json');

function _tagContacts(emails, accountId, accountLabel, stage) {
  try {
    const contactsDb = require('./contacts-db');
    const now = new Date().toISOString();
    for (const addr of emails) {
      const existing = contactsDb.getByEmail(addr);
      if (!existing) continue;
      contactsDb.update(existing.id, { last_sent_at: now, last_sent_acct: accountLabel || '' });
      if (stage && stage !== (existing.stage || 'cold')) {
        contactsDb.setStage(existing.id, stage, 'send');
      }
    }
  } catch { /* 静默跳过 */ }
}

// ── 正文存储（供 _logRecord 使用）─────────────────────────────────────────
const bodiesPath = path.join(APP_ROOT, 'data', 'send-bodies.json');

function loadBodies() {
  try { if (fs.existsSync(bodiesPath)) return JSON.parse(fs.readFileSync(bodiesPath, 'utf-8')); } catch { /* 正文缓存损坏 → 返回空对象，正文仍可实时构建 */ }
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

  // 多账号格式
  const accounts = config.smtpAccounts || [];
  if (accounts.length > 0) {
    const active = accounts.filter(a => a.active !== false);
    if (!active.length) { sendProgress({ error: '无可用发信账号（全部已停用）' }); return null; }
    // 环境变量覆盖密码
    if (process.env.SMTP_PASS) {
      for (const a of accounts) { if (a.smtp) a.smtp.pass = process.env.SMTP_PASS; }
    }
    config._accounts = accounts;
    return config;
  }

  // 向后兼容：旧格式 smtp
  if (process.env.SMTP_PASS && config.smtp) config.smtp.pass = process.env.SMTP_PASS;
  if (!config.smtp?.host || !config.smtp?.user) { sendProgress({ error: 'SMTP 未配置' }); return null; }
  config._accounts = [{
    id: 'legacy', label: '默认账号', active: true,
    dailyLimit: config.schedule?.max_per_day || 500,
    smtp: { ...config.smtp },
    imap: config.imap ? { ...config.imap } : undefined,
  }];
  return config;
}

// ── 发送引擎：构建上下文 ──────────────────────────────────────────────────
function _buildContext(config) {
  const nodemailer = require('nodemailer');
  const sigPath = path.join(APP_ROOT, 'send', 'signature.html');
  const testMode = !!(config.test?.enabled && config.test?.email);
  const isBatch = (config.schedule?.mode || 'multi') === 'batch';
  const sc = config.schedule || {};
  const accounts = config._accounts || [];

  const dryRun = !!(config.test?.dryRun); // ponytail: 发信阻隔 — 流程完整但不真实发送

  const ctx = {
    config, testMode, dryRun, isBatch, nodemailer, accounts,
    logPath: path.join(APP_ROOT, 'send', testMode ? 'send-log-test.json' : 'send-log.json'),
    sigHtml: fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '',
    sigText: config.signature?.text || '金颖哲 Zayne Jin | YQN Logistics\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com',
    senderAddr: config.sender?.email || 'zayne_jin@yqn.com',
    maxPerDay: accounts.filter(a => a.active !== false).reduce((sum, a) => sum + (a.dailyLimit || 500), 0),
    startH: sc.start_hour_beijing ?? 19,
    endH: sc.end_hour_beijing ?? 3,
    SINGLE: sc.single_recip_threshold ?? 2,
    // 封间延迟：批处理模式无封间延迟（BCC 批量），仅模拟人工模式使用
    perMin: isBatch ? 0 : (sc.min_delay_seconds || 30) * 1000,
    perMax: isBatch ? 0 : (sc.max_delay_seconds || 90) * 1000,
    // 公司切换延迟（仅模拟人工模式；批处理模式由组间间隔控制节奏）
    cdMin: isBatch ? 0 : (sc.company_delay_min_seconds ?? 300) * 1000,
    cdMax: isBatch ? 0 : (sc.company_delay_max_seconds ?? 900) * 1000,
    SD_MIN: (sc.single_recip_delay_min_seconds ?? 60) * 1000,
    SD_MAX: (sc.single_recip_delay_max_seconds ?? 180) * 1000,
    // 批处理参数：组间间隔（每发一组后暂停），非"每N封停一次"
    groupIntervalMin: (sc.batch_pause_min_seconds ?? 150) * 1000,
    groupIntervalMax: (sc.batch_pause_max_seconds ?? 210) * 1000,
    // ponytail: 小公司累计阈值 — 不足一组时连发，满 batchSize 人才暂停
    batchSize: sc.batch_size || 10,
  };
  return ctx;
}

// ── 账号 from 地址 ─────────────────────────────────────────────────────────
function _fromAddr(account, senderName) {
  const name = senderName || account.label || account.smtp?.user || '';
  const senderEmail = account.smtp?.user || '';
  return `"${name}" <${senderEmail}>`;
}

// ── 正文构建 ────────────────────────────────────────────────────────────
function buildContent(bodyText, sigText, sigHtml) {
  // ponytail: 模板已自带结尾语（Saludos/Atentamente/Regards等），不再追加签名
  const SIG_PATTERNS = /(Saludos|Atentamente|Cordialmente|Un saludo|Best regards|Sincerely|Atenciosamente|Cordialement|Respectfully)[\s,]*$/im;
  const sigStart = (sigText || '').split('\n')[0]?.trim();

  // 检测是否为 HTML 正文（用户模板 contenteditable 保留格式）
  const isHtml = /<[a-z][\s\S]*>/i.test(bodyText);
  if (isHtml) {
    const plainText = bodyText.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
    const hasValediction = SIG_PATTERNS.test(plainText);
    const hasSig = sigStart && bodyText.includes(sigStart);
    const textBody = (hasSig || hasValediction) ? plainText : (plainText + '\n--\n' + sigText);
    const html = (hasSig || hasValediction) ? bodyText : (bodyText + '<br>\n' + sigHtml);
    return { textBody, html, hasSig: hasSig || hasValediction };
  }

  // 纯文本正文：原有逻辑
  const hasSig = sigStart && bodyText.trimEnd().includes(sigStart);
  const hasValediction = SIG_PATTERNS.test(bodyText.trimEnd());
  const textBody = (hasSig || hasValediction) ? bodyText : (bodyText + '\n--\n' + sigText);
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
function _logRecord(ctx, to, company, subject, bodyText, bodyId, msgId, status, err, accountId, emailMeta) {
  const rec = {
    index: 0, to, company: company || '', subject,
    messageId: msgId, count: 1,
    bodyId: bodyId || saveBody(bodyText || ''),
    _stage: emailMeta?._stage || '',
    _lang: emailMeta?._lang || '',
    _type: emailMeta?._type || 'unlabeled',
    _country: emailMeta?._country || '',
    _tplInfo: emailMeta?._tplInfo || '',
    _templateSource: emailMeta?._templateSource || '',
    _templateLabel: emailMeta?._templateLabel || '',
    _batchLabel: emailMeta?._batchLabel || '',
    time: new Date().toISOString(), time_beijing: beijingToday(), status,
    _test: !!ctx.testMode,
    _accountId: accountId || '',
  };
  if (err) rec.error = err;
  return rec;
}

// ── 发送单封 ──────────────────────────────────────────────────────────────
async function _sendOne(ctx, email, log, deps) {
  let toList = email.recipients?.length ? email.recipients : (typeof email.to === 'string' ? email.to.split(',').map(s => s.trim()).filter(Boolean) : []);
  if (!toList.length) return { ok: false, n: 0 };

  // ponytail: 过滤已发送收件人，防止中断恢复后重复发信
  const alreadySent = new Set(
    (email._recipientStatus || [])
      .filter(r => r.status === 'sent')
      .map(r => r.email.toLowerCase().trim())
  );
  toList = toList.filter(addr => !alreadySent.has(addr.toLowerCase().trim()));
  if (!toList.length) return { ok: true, n: 0, skipped: true };

  const { textBody, html } = buildContent(email.body || '', ctx.sigText, ctx.sigHtml);
  const accountId = deps.currentAccount?.id || '';

  const subject = ctx.testMode ? `[测试] ${email.subject}` : email.subject;
  const aTo = ctx.testMode ? (ctx.config.test?.email || ctx.senderAddr) : toList[0];
  const aBcc = ctx.testMode ? [] : toList.slice(1);
  const fromAddr = _fromAddr(deps.currentAccount || {}, ctx.config?.sender?.name);
  // ponytail: 同一次发送共用 bodyId，避免每人一条重复正文
  const sharedBodyId = saveBody(email.body || textBody);

  try {
    // ponytail: 发信阻隔 — Dry Run 模式：流程完整但不真实发送
    const info = ctx.dryRun
      ? { messageId: '<dry-run-' + Date.now().toString(36) + '@milogin>', dryRun: true }
      : await deps.currentTransporter.sendMail({ from: fromAddr, to: aTo, ...(aBcc.length ? { bcc: aBcc.join(', ') } : {}), subject, text: textBody, html });
    for (const r of toList) {
      // ponytail: 只存模板正文（不含签名），签名由显示层从 signature.html 加载
      const lr = _logRecord(ctx, r, email.company, subject, email.body || textBody, sharedBodyId, info.messageId, 'sent', null, accountId, email);
      log.sent.push(lr);
      try { require('./send-log-db').add(lr); } catch { /* 降级 */ }
    }
    if (!log.daily_counts) log.daily_counts = {};
    log.daily_counts[accountId] = (log.daily_counts[accountId] || 0) + toList.length;
    log.daily_count = (log.daily_count || 0) + toList.length; // ponytail: 同步总量，兼容 send:status 读取
    _tagContacts(toList, accountId, deps.currentAccount?.label || deps.currentAccount?.smtp?.user || '', email._stage);
    // 记录互动
    try {
      const contactsDb = require('./contacts-db');
      for (const r of toList) {
        const contact = contactsDb.getByEmail(r);
        if (contact) require('./interactions-db').add({ contact_id: contact.id, company_id: contact.company_id || '', type: 'sent', direction: 'outbound', subject, snippet: (email.body || '').slice(0, 200) });
      }
    } catch { /* 互动记录不影响发送 */ }
    return { ok: true, n: toList.length };
  } catch (err) {
    const em = err.message || '';
    // 连接错误：重建 transporter 重试一次
    if (!deps.currentSendAbort && (em.includes('socket') || em.includes('ECONN') || em.includes('closed'))) {
      try { await deps.currentTransporter.close(); } catch { /* 关闭旧连接失败 → 直接重建 transporter */ }
      const acctMgr = require('./account-manager');
      if (deps.currentAccount?.smtp) {
        deps.currentTransporter = acctMgr.createTransporter(deps.currentAccount);
      }
      await sleep(2000);
      if (deps.currentSendAbort) return { ok: false, n: 0 };
      try {
        const info = ctx.dryRun
          ? { messageId: '<dry-run-retry-' + Date.now().toString(36) + '@milogin>', dryRun: true }
          : await deps.currentTransporter.sendMail({ from: fromAddr, to: aTo, ...(aBcc.length ? { bcc: aBcc.join(', ') } : {}), subject, text: textBody, html });
        for (const r of toList) {
          log.sent.push(_logRecord(ctx, r, email.company, subject, email.body || textBody, sharedBodyId, info.messageId, 'sent', null, accountId, email));
        }
        if (!log.daily_counts) log.daily_counts = {};
        log.daily_counts[accountId] = (log.daily_counts[accountId] || 0) + toList.length;
        log.daily_count = (log.daily_count || 0) + toList.length;
        _tagContacts(toList, accountId, deps.currentAccount?.label || deps.currentAccount?.smtp?.user || '');
        return { ok: true, n: toList.length };
      } catch (retryErr) { err = retryErr; }
    }
    const finalErr = err.message || '';
    const isRateLimit = ['rate limit','too many','try again','421','450','451','452'].some(k => finalErr.toLowerCase().includes(k));
    if (isRateLimit && !ctx.testMode) {
      return { ok: false, n: 0, fused: true };
    }
    for (const r of toList) { log.sent.push(_logRecord(ctx, r, email.company, subject, email.body || textBody, sharedBodyId, '', 'failed', finalErr, accountId, email)); }
    return { ok: false, n: 0 };
  }
}

// ── 预估 ──────────────────────────────────────────────────────────────────
function _computeEstimate(ctx, pendingItems) {
  const companies = new Set(pendingItems.map(e => e.company).filter(Boolean));
  let totalSec = 0;
  if (ctx.isBatch) {
    // 匀速速发：每组之间组间间隔 + 公司切换延迟
    const giAvg = Math.round((ctx.groupIntervalMin + ctx.groupIntervalMax) / 2000);
    totalSec = Math.max(0, pendingItems.length - 1) * giAvg;
    const cdAvg = Math.round((ctx.cdMin + ctx.cdMax) / 2000);
    totalSec += Math.max(0, companies.size - 1) * cdAvg;
  } else {
    // 模拟人工：封间延迟 + 公司切换延迟
    const perDelayAvg = Math.round((ctx.perMin + ctx.perMax) / 2000);
    const cdAvg = Math.round((ctx.cdMin + ctx.cdMax) / 2000);
    totalSec = pendingItems.length * perDelayAvg + Math.max(0, companies.size - 1) * cdAvg;
  }
  return {
    type: 'estimate', total: pendingItems.length,
    avgDelay: ctx.isBatch ? Math.round((ctx.groupIntervalMin + ctx.groupIntervalMax) / 2000) : Math.round((ctx.perMin + ctx.perMax) / 2000),
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

function pauseDelay() {
  if (!_delayTimer) return;
  clearTimeout(_delayTimer);
  _delayTimer = null;
  _delayTotal -= (Date.now() - _delayStarted);
  if (_delayTotal < 0) _delayTotal = 0;
  // ponytail: 持久化暂停时的剩余延迟，防重启跳过倒计时
  if (_delayTotal > 0) {
    try {
      const statePath = path.join(APP_ROOT, 'data', 'send-state.json');
      fs.writeFileSync(statePath, JSON.stringify({ pendingDelaySec: Math.ceil(_delayTotal / 1000), delayStartedAt: Date.now(), status: 'paused' }));
    } catch { /* 状态文件写入失败不阻塞 */ }
  }
}

function resumeDelay() {
  if (_delayTimer) return;
  if (!_delayResolve) return;
  if (_delayTotal <= 0) {
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
async function runSendBatch(deps, sendProgress) {
  const config = _loadConfig(sendProgress); if (!config) return;
  const ctx = _buildContext(config);
  const acctMgr = require('./account-manager');

  let log = { sent: [], daily_count: 0, daily_counts: {}, _accountStates: {}, last_date: '' };
  if (fs.existsSync(ctx.logPath)) { try { log = JSON.parse(fs.readFileSync(ctx.logPath, 'utf-8')); } catch { /* 文件损坏时降级为空日志 */ } }
  if ((log.last_date_beijing || log.last_date) !== beijingToday()) {
    log.daily_count = 0;
    log.daily_counts = {};
    log._accountStates = {};
    log.last_date_beijing = beijingToday();
  }
  if (!log.daily_counts) log.daily_counts = {};
  if (!log._accountStates) log._accountStates = {};

  deps.currentSendAbort = false;

  // 预连所有活跃账号的 transporter（懒加载缓存）
  const transporterCache = new Map();
  function getTransporter(account) {
    if (!transporterCache.has(account.id)) {
      transporterCache.set(account.id, acctMgr.createTransporter(account));
      Log.info('发信', `创建 transporter: ${account.label || account.smtp?.user}`);
    }
    return transporterCache.get(account.id);
  }

  const totalLimit = ctx.maxPerDay;
  const totalDailyCount = Object.values(log.daily_counts || {}).reduce((sum, v) => sum + v, 0) || log.daily_count || 0;

  // ponytail: 加载联系人账号标签，供 pickNextAccount 复用原账号
  let contactAccountMap = {};
  try {
    if (fs.existsSync(contactsPath)) {
      const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
      for (const c of contacts) {
        if (c._sentBy && c.email) contactAccountMap[c.email.toLowerCase().trim()] = c._sentBy;
      }
    }
  } catch { /* 联系人数据无法读取 → 不影响发送，仅丢失账号映射信息 */ }

  function inWindow() {
    const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getHours();
    return ctx.startH < ctx.endH ? h >= ctx.startH && h < ctx.endH : h >= ctx.startH || h < ctx.endH;
  }

  const est = _computeEstimate(ctx, deps.sendQueue.filter(e => e.status === 'pending' || e.status === 'sending'));
  sendProgress(est);
  const accountCount = ctx.accounts.length;
  const activeCount = ctx.accounts.filter(a => a.active !== false).length;
  Log.info("发信", "开始: " + est.total + "封, " + activeCount + "/" + accountCount + "个账号, 预计" + est.estMin + "分" + est.estSec + "秒" + (ctx.dryRun ? " [DRY RUN]" : "") + (ctx.testMode ? " [测试]" : ""));

  let sent = 0, failed = 0;
  let lastAccountIdx = -1;
  // 速率熔断：5 秒内累计发送 >= batchSize×2 人 → 强制暂停（给正常连发留余量）
  let rapidRecipCount = 0;
  let lastRapidTime = 0;
  const RAPID_WINDOW_MS = 5000;
  const MELTDOWN_COOLDOWN_SEC = 30;
  const RAPID_LIMIT = ctx.batchSize * 2;
  // ponytail: 快照队列长度，防止并发推入导致循环无限增长
  const queueLen = deps.sendQueue.length;
  // ponytail: 小公司累计发送人数 — 满 batchSize 才触发组间间隔
  let batchAccum = 0;

  // ponytail: 恢复上次未完成的组间间隔（防重启跳过倒计时）
  try {
    const statePath = path.join(APP_ROOT, 'data', 'send-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      // 熔断冷却期检查
      if (state.meltdownUntil && Date.now() < state.meltdownUntil) {
        const remain = Math.ceil((state.meltdownUntil - Date.now()) / 1000);
        sendProgress({ type: 'ratelimit', error: `发送过快！冷却中，${remain} 秒后可恢复` });
        return;
      }
      if (state.pendingDelaySec > 0 && state.delayStartedAt) {
        const elapsed = Math.floor((Date.now() - state.delayStartedAt) / 1000);
        const remain = Math.max(0, state.pendingDelaySec - elapsed);
        if (remain > 3) { // 剩余不足 3 秒就算了
          Log.info("发信", "恢复组间间隔 " + remain + "s (剩余)");
          sendProgress({ type: 'delay', seconds: remain, company: '恢复组间间隔' });
          await cancellableSleep(remain * 1000, deps);
          if (deps.isPaused || deps.currentSendAbort) return;
        }
      }
    }
  } catch (e) { Log.warn('发信', '恢复间隔状态失败', e.stack); }
  // 清除间隔状态
  try { fs.writeFileSync(path.join(APP_ROOT, 'data', 'send-state.json'), JSON.stringify({ status: 'sending' })); } catch { /* 状态文件写入失败不影响发送 */ }

  try {
  for (let i = 0; i < queueLen; i++) {
    if (deps.currentSendAbort) { sendProgress({ type: 'cancelled' }); break; }
    if (deps.isPaused) { sendProgress({ type: 'paused' }); break; }

    // 全局上限检查
    if (!ctx.testMode) {
      const currentTotal = Object.values(log.daily_counts || {}).reduce((sum, v) => sum + v, 0) || 0;
      if (currentTotal >= totalLimit) { sendProgress({ type: 'limit', message: `已达每日上限 ${totalLimit}` }); break; }
    }

    while (!inWindow() && !deps.isPaused && !ctx.testMode && !deps.currentSendAbort) {
      const ok = await cancellableSleep(30000, deps); if (!ok || deps.isPaused || deps.currentSendAbort) break;
    }
    if (deps.isPaused || deps.currentSendAbort) break;

    const email = deps.sendQueue[i];
    if (!email.recipients?.length && !email.to) continue;

    // 轮询选择下一个可用账号（含熔断检测）
    // 取第一个收件人的历史账号作为优先项
    const firstRcpt = (email.recipients?.[0] || (email.to || '').split(',')[0] || '').toLowerCase().trim();
    const prefId = contactAccountMap[firstRcpt] || '';
    const picked = acctMgr.pickNextAccount(ctx.accounts, lastAccountIdx, log.daily_counts, log._accountStates, prefId);
    if (!picked.account) {
      const reason = picked.reason || '无可用账号';
      Log.warn("发信", "停止: " + reason);
      sendProgress({ error: `发送停止：${reason}` }); break;
    }
    const { account, idx } = picked;
    lastAccountIdx = idx;
    deps.currentAccount = account;
    deps.currentTransporter = getTransporter(account);

    // 公司切换延迟（两模式通用）
    if (i > 0 && email.company !== deps.sendQueue[i - 1]?.company) {
      const dm = Math.floor(Math.random() * (ctx.cdMax - ctx.cdMin + 1)) + ctx.cdMin;
      Log.info("发信", "切换公司: " + email.company + ", 暂停" + Math.round(dm/1000) + "s");
      sendProgress({ type: 'delay', seconds: Math.round(dm/1000), company: email.company });
      if (!await cancellableSleep(dm, deps)) break;
    }

    // 封间延迟（仅模拟人工模式）
    if (!ctx.isBatch && (i > 0 || totalDailyCount > 0 || sent > 0)) {
      if (!await cancellableSleep(Math.floor(Math.random() * (ctx.perMax - ctx.perMin + 1)) + ctx.perMin, deps)) break;
    }

    // 发送
    const result = await _sendOne(ctx, email, log, deps);

    if (result.skipped) {
      // 全部已发：不发进度、不扣配额
    } else if (result.ok) {
      sent += result.n;
      if (!ctx.testMode) acctMgr.recordSuccess(account.id, log._accountStates);

      // 速率熔断检测（Dry Run 模式下不触发）
      if (!ctx.dryRun && !ctx.testMode) {
        const now = Date.now();
        if (now - lastRapidTime < RAPID_WINDOW_MS) {
          rapidRecipCount += result.n || 0;
        } else {
          rapidRecipCount = result.n || 0;
        }
        lastRapidTime = now;
        if (rapidRecipCount >= RAPID_LIMIT) {
          Log.warn("发信", `速率熔断: ${RAPID_WINDOW_MS/1000}秒内发送${rapidRecipCount}人, 强制暂停${MELTDOWN_COOLDOWN_SEC}秒`);
          try { fs.writeFileSync(path.join(APP_ROOT, 'data', 'send-state.json'), JSON.stringify({ meltdownUntil: Date.now() + MELTDOWN_COOLDOWN_SEC * 1000, status: 'meltdown' })); } catch { /* 熔断状态文件写入失败不阻塞暂停 */ }
          sendProgress({ type: 'ratelimit', error: `发送过快！${RAPID_WINDOW_MS/1000}秒内连发${rapidRecipCount}人，已强制暂停${MELTDOWN_COOLDOWN_SEC}秒` });
          deps.isPaused = true;
          rapidRecipCount = 0;
          break;
        }
      }
    } else if (result.fused) {
      if (!ctx.testMode) acctMgr.recordFailure(account.id, log._accountStates, true);
      Log.info('发信', `⚡ 账号 ${account.label || account.smtp?.user} 已熔断`);
      failed += result.n;
    } else if (result.fatal) {
      if (!ctx.testMode) acctMgr.recordFailure(account.id, log._accountStates, false);
      try { fs.writeFileSync(ctx.logPath, JSON.stringify(log, null, 2)); } catch { /* 日志写入失败 → 已在本循环另有写入点 */ }
      break;
    } else {
      failed += result.n;
      if (!ctx.testMode) acctMgr.recordFailure(account.id, log._accountStates, false);
    }
    // ponytail: SQLite 已持久化，不再写 JSON
    sendProgress(result.skipped
      ? { type: 'skipped', id: email.id }
      : result.ok
        ? { type: 'sent', id: email.id, index: i + 1, total: queueLen, company: email.company, to: (email.recipients || [email.to]).join(','), count: result.n, accountLabel: account.label || account.smtp?.user }
        : result.fused
          ? { type: 'fused', id: email.id, accountLabel: account.label || account.smtp?.user }
          : { type: 'failed', id: email.id, to: (email.recipients || [email.to]).join(','), error: '' }
    );

    // 组间间隔（仅批处理（匀速速发）模式，小公司累计满 batchSize 人才暂停）
    if (ctx.isBatch && i < queueLen - 1) {
      batchAccum += result.n || 0;
      if (batchAccum < ctx.batchSize) {
        Log.info("发信", `小公司连发: 累计${batchAccum}/${ctx.batchSize}人, 跳过组间间隔`);
        continue;
      }
      batchAccum = 0;
      const gi = Math.floor(Math.random() * (ctx.groupIntervalMax - ctx.groupIntervalMin + 1)) + ctx.groupIntervalMin;
      const giSec = Math.round(gi / 1000);
      Log.info("发信", "组间间隔 " + giSec + "s (" + (i+1) + "/" + queueLen + "组, 累计满" + ctx.batchSize + "人)");
      // ponytail: 持久化间隔状态，防重启跳过倒计时
      try { fs.writeFileSync(path.join(APP_ROOT, 'data', 'send-state.json'), JSON.stringify({ pendingDelaySec: giSec, delayStartedAt: Date.now(), status: 'delaying' })); } catch { /* 间隔状态记录失败不阻塞发送 */ }
      sendProgress({ type: 'delay', seconds: giSec, company: `组间间隔(${i + 1}/${queueLen}组)` });
      if (!await cancellableSleep(gi, deps)) break;
    }
  }

  } catch (e) { Log.error("发信", "循环异常", e.stack); }
  finally {
    for (const t of transporterCache.values()) { try { await t.close(); } catch { /* 关闭失败不影响后续 */ } }
  }
  Log.info("发信", "完成: 成功" + sent + "封, 失败" + failed + "封");
  if (!deps.isPaused && !deps.currentSendAbort) sendProgress({ type: 'complete', total: queueLen, sent, failed, _testMode: ctx.testMode || undefined });
  if (!deps.isPaused && !deps.currentSendAbort) deps.mainWindow?.webContents.send('history:changed');
  if (deps.tray && !deps.isPaused && !deps.currentSendAbort && !ctx.testMode) new (require('electron').Notification)({ title: "Milogin's Prospector", body: `发送完成: 成功 ${sent} 封` }).show();
  // ponytail: 老退信/回复检测已由收件箱接管
  // scheduleAutoBounceCheck(deps.mainWindow, deps.tray);
  // require('./reply-checker').scheduleAutoReplyCheck(deps.mainWindow, deps.tray);
}

// ── 自动退信调度 ──────────────────────────────────────────────────────────
function scheduleAutoBounceCheck(mainWindow, tray) {
  clearTimeout(_autoBounceTimer);
  _autoBounceTimer = setTimeout(async () => {
    try {
      Log.info("退信", "自动检测启动");
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
        { const tmp = cp + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(contacts, null, 2)); fs.renameSync(tmp, cp); }
        if (tray) new (require('electron').Notification)({ title: '📨 退信检测', body: `发现 ${result.bounced.length} 封退信，已标记 ${matched} 个联系人` }).show();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bounce:autoDetected', { count: result.bounced.length, matched });
      }
    } catch (e) { Log.error("退信", "自动检测异常", e.stack); }
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
