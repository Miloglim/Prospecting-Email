// ── 回复检测模块 ────────────────────────────────────────────────────────────
// 遍历所有活跃账号的 IMAP 收件箱，匹配已发邮件的回复
// 复用 bounce-checker.js 的 IMAP 连接模式，无需新依赖

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const { Log } = require("../core/logger");

// ── 排除关键词（自动回复 / 退信 / 系统邮件）────────────────────────────────
const EXCLUDE_SUBJECT_KW = [
  'undelivered','returned','failure','bounce','undeliverable','delivery status',
  'returned mail','message undeliverable','out of office','auto-reply','automatic reply',
  'automated response','vacation','ausente','fuera de oficina','fora do escritório',
  '退信','失败','退回','系统退信','无法送达','自动回复','休假',
  'mail delivery','mailer-daemon','postmaster','noreply','no-reply',
];

const REPLY_INDICATORS = ['re:','resp:','回复','enc:','fw:','fwd:'];

// ── MIME 解码（从 bounce-checker 精简）───────────────────────────────────────
function decodeMimeHeader(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B')
        return Buffer.from(data, 'base64').toString(charset.toLowerCase() === 'gb2312' ? 'gbk' : 'utf-8');
      return decodeURIComponent(data.replace(/_/g, ' ').replace(/%/g, '%25'));
    } catch { return data; }
  });
}

function isExcluded(subject) {
  const s = (subject || '').toLowerCase();
  if (REPLY_INDICATORS.some(kw => s.startsWith(kw))) return false; // 回复标题不排除
  return EXCLUDE_SUBJECT_KW.some(kw => s.includes(kw));
}

// ── 回复游标（增量扫描，避免重复）──────────────────────────────────────────
const CURSOR_PATH = path.join(APP_ROOT, 'data', 'reply-check-cursor.json');

function readCursor() {
  try { return fs.existsSync(CURSOR_PATH) ? JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}

function writeCursor(data) {
  const dir = path.dirname(CURSOR_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(data, null, 2));
}

// ── IMAP 回复扫描 ───────────────────────────────────────────────────────────
function imapCheckReplies(imapCfg, knownRecipients, senderEmail) {
  const Imap = require('imap');
  return new Promise((resolve) => {
    const imap = new Imap({
      user: imapCfg.user, password: imapCfg.pass,
      host: imapCfg.host, port: imapCfg.port || 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000, authTimeout: 10000,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, () => {
        // 扫描最近 7 天的邮件 — 直接传 Date 对象，node-imap 不接受 DD-MM-YYYY 字符串
        const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        imap.search([['SINCE', since]], (err, results) => {
          if (err || !results?.length) { imap.end(); return resolve({ ok: true, replies: [] }); }

          const last50 = results.slice(-50);
          const fetch = imap.fetch(last50, {
            bodies: ['HEADER.FIELDS (SUBJECT DATE FROM IN-REPLY-TO REFERENCES)', 'TEXT'],
            struct: true,
          });

          const replies = [];
          const recipientSet = new Set(knownRecipients.map(r => r.toLowerCase().trim()));

          fetch.on('message', (msg) => {
            let headers = '', body = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { body += chunk.toString(); });
            });
            msg.once('attributes', (attrs) => { /* UID for cursor */ });
            msg.once('end', () => {
              // 解析头部
              const subjectMatch = headers.match(/^Subject:\s*(.+)/im);
              const fromMatch = body.match(/^From:\s*(.+)/im) || headers.match(/^From:\s*(.+)/im);
              const dateMatch = headers.match(/^Date:\s*(.+)/im);
              const inReplyToMatch = headers.match(/^In-Reply-To:\s*(.+)/im);
              const refsMatch = headers.match(/^References:\s*(.+)/im);

              const subject = decodeMimeHeader(subjectMatch?.[1] || '');
              const from = (fromMatch?.[1] || '').trim();
              const date = (dateMatch?.[1] || '').trim();

              // 排除系统/退信/自动回复
              if (isExcluded(subject)) return;

              // 提取发件人邮箱
              const fromEmail = (from.match(/<(.+?)>/) || [])[1] || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[0] || '';
              if (!fromEmail) return;

              // 匹配：发件人在已知收件人列表中
              if (!recipientSet.has(fromEmail.toLowerCase().trim())) return;

              // 尝试匹配已发邮件的 Message-ID
              const msgId = (inReplyToMatch?.[1] || refsMatch?.[1] || '').trim();

              // 提取正文摘要（前 500 字符）
              const bodyText = body.replace(/\r?\n/g, ' ').slice(0, 500).trim();

              replies.push({
                from: fromEmail,
                subject,
                date,
                inReplyTo: msgId,
                snippet: bodyText,
              });
            });
          });

          fetch.once('error', () => { /* skip individual message errors */ });
          fetch.once('end', () => {
            imap.end();
            resolve({ ok: true, replies });
          });
        });
      });
    });

    imap.once('error', (e) => resolve({ ok: false, error: 'IMAP 失败: ' + e.message }));
    imap.connect();
  });
}

// ── POP3 检测 ─────────────────────────────────────────────────────────────
function isPop3(cfg) {
  const h = (cfg.host || '').toLowerCase();
  return cfg.port === 995 || h.includes('pop');
}

// ── POP3 客户端（精简，复用 bounce-checker 模式）─────────────────────────
const tls = require('tls');
function pop3Connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(sock));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('连接超时')); }, 20000);
  });
}
function pop3ReadLine(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读行超时')); }, timeoutMs || 15000);
    const onData = (d) => {
      buf += d.toString();
      const rn = buf.indexOf('\r\n'), n = buf.indexOf('\n');
      const end = rn >= 0 ? rn : n;
      if (end >= 0) { clearTimeout(timer); sock.removeListener('data', onData); resolve(buf.slice(0, end).trim()); }
    };
    sock.on('data', onData);
  });
}
function pop3ReadMulti(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读多行超时')); }, timeoutMs || 15000);
    const onData = (d) => {
      buf += d.toString();
      if (/\r?\n\.\r?\n/.test(buf)) {
        clearTimeout(timer); sock.removeListener('data', onData);
        const lines = buf.replace(/\r?\n\.\r?\n.*/, '').split(/\r?\n/);
        resolve(lines.length > 1 && /^[+-]/.test(lines[0]) ? lines.slice(1) : lines);
      }
    };
    sock.on('data', onData);
  });
}
function pop3Cmd(sock, cmd) {
  sock.write(cmd + '\r\n');
  if (cmd === 'QUIT') return Promise.resolve([]);
  if (/^(LIST|TOP|UIDL|RETR)/i.test(cmd)) return pop3ReadMulti(sock);
  return pop3ReadLine(sock).then(line => [line]);
}

// ── POP3 回复扫描 ─────────────────────────────────────────────────────────
async function pop3CheckReplies(cfg, knownRecipients, senderEmail) {
  const sock = await pop3Connect(cfg.host, cfg.port || 995);
  const replies = [];
  try {
    await pop3ReadLine(sock, 15000);
    await pop3Cmd(sock, `USER ${cfg.user}`);
    await pop3Cmd(sock, `PASS ${cfg.pass}`);
    const statRes = await pop3Cmd(sock, 'STAT');
    const total = parseInt((statRes[0] || '').split(' ')[1]) || 0;
    if (!total) { sock.write('QUIT\r\n'); sock.end(); return { ok: true, replies: [] }; }

    const uidlRes = await pop3Cmd(sock, 'UIDL');
    const uidMap = {};
    for (const line of uidlRes) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[0])) uidMap[parseInt(parts[0])] = parts[1];
    }
    const ids = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 30);
    const recipientSet = new Set(knownRecipients.map(r => r.toLowerCase().trim()));

    for (const n of ids) {
      try {
        const raw = await pop3Cmd(sock, `TOP ${n} 100`);
        let headerEnd = raw.findIndex(l => l.trim() === '');
        if (headerEnd < 0) headerEnd = raw.length;
        const headers = raw.slice(0, headerEnd);
        const bodyLines = raw.slice(headerEnd + 1);
        let subject = '', date = '', from = '';
        for (const h of headers) {
          const hl = h.toLowerCase();
          if (hl.startsWith('subject:')) subject = h.slice(8).trim();
          if (hl.startsWith('date:')) date = h.slice(5).trim();
          if (hl.startsWith('from:')) from = h.slice(5).trim();
        }
        const decoded = decodeMimeHeader(subject);
        if (isExcluded(decoded)) continue;

        const fromEmail = (from.match(/<(.+?)>/) || [])[1] || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[0] || '';
        if (!fromEmail || !recipientSet.has(fromEmail.toLowerCase().trim())) continue;

        const bodyText = bodyLines.join(' ').slice(0, 500).trim();
        replies.push({ from: fromEmail, subject: decoded, date, inReplyTo: '', snippet: bodyText });
      } catch { continue; }
    }
    sock.write('QUIT\r\n');
    sock.end();
    return { ok: true, replies };
  } catch (e) {
    try { sock.end(); } catch {}
    return { ok: false, error: 'POP3 失败: ' + (e.message || String(e)) };
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
async function checkReplies() {
  const configPath = path.join(APP_ROOT, 'send', 'config.json');
  if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在' };
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return { ok: false, error: '配置文件格式错误' }; }

  const accounts = config.smtpAccounts || [];
  const activeAccounts = accounts.filter(a => a.active !== false && a.imap?.host && a.imap?.user);

  // 加载已知收件人（所有联系人邮箱 + 发送历史收件人）
  const knownRecipients = new Set();

  // 从联系人数据库
  try {
    const cp = path.join(APP_ROOT, 'data', 'contacts.json');
    if (fs.existsSync(cp)) {
      const contacts = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      contacts.forEach(c => { if (c.email) knownRecipients.add(c.email.toLowerCase().trim()); });
    }
  } catch { /* 联系人文件不存在或损坏 */ }

  // 从发送日志
  try {
    const lp = path.join(APP_ROOT, 'send', 'send-log.json');
    if (fs.existsSync(lp)) {
      const log = JSON.parse(fs.readFileSync(lp, 'utf-8'));
      (log.sent || []).forEach(r => { if (r.to) knownRecipients.add(r.to.toLowerCase().trim()); });
    }
  } catch { /* 发送日志不存在或损坏 */ }

  // 兼容旧全局 IMAP
  const checkAccounts = activeAccounts.length > 0 ? activeAccounts
    : config.imap?.host ? [{ imap: config.imap, label: '默认', smtp: { user: config.imap.user } }]
    : [];

  if (!checkAccounts.length) return { ok: false, error: '无可用邮箱（请在账号中配置 IMAP/POP3 收件箱）' };

  const allReplies = [];
  for (const acc of checkAccounts) {
    const senderEmail = acc.imap?.user || acc.smtp?.user || '';
    try {
      const isPop = isPop3(acc.imap);
      const result = isPop
        ? await pop3CheckReplies(acc.imap, [...knownRecipients], senderEmail)
        : await imapCheckReplies(acc.imap, [...knownRecipients], senderEmail);
      if (result.ok && result.replies?.length) {
        result.replies.forEach(r => { r._accountLabel = acc.label || senderEmail; });
        allReplies.push(...result.replies);
      }
    } catch (e) {
      Log.warn(`[回复] 账号 ${acc.label || senderEmail} 检测异常:`, e.message);
    }
  }

  // 持久化到 reply-log.json
  if (allReplies.length > 0) {
    const rlp = path.join(APP_ROOT, 'data', 'reply-log.json');
    try {
      const dir = path.dirname(rlp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(rlp, JSON.stringify(allReplies, null, 2));
    } catch { /* 写入失败不影响检测结果 */ }
  }

  return { ok: true, replies: allReplies, message: allReplies.length ? `发现 ${allReplies.length} 条回复` : '未发现回复' };
}

// ── 应用回复标记（由 IPC 层调用）───────────────────────────────────────────
function applyReplies(replies) {
  if (!replies?.length) return { matched: 0 };

  const cp = path.join(APP_ROOT, 'data', 'contacts.json');
  if (!fs.existsSync(cp)) return { matched: 0 };
  let contacts;
  try { contacts = JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch { return { matched: 0 }; }

  let matched = 0;
  for (const r of replies) {
    if (!r.from) continue;
    const key = r.from.toLowerCase().trim();
    for (const c of contacts) {
      if ((c.email || '').toLowerCase().trim() === key && !c.replied) {
        c.replied = true;
        c.repliedAt = c.repliedAt || new Date().toISOString();
        c.replySnippet = (r.snippet || '').slice(0, 200);
        matched++;
      }
    }
  }

  if (matched > 0) {
    fs.writeFileSync(cp, JSON.stringify(contacts, null, 2));
  }
  return { matched };
}

// ── 自动回复检测调度（由 send-engine 调用）──────────────────────────────────
let _autoReplyTimer = null;
const REPLY_CHECK_INTERVAL = 30 * 60 * 1000; // 30 分钟

function scheduleAutoReplyCheck(mainWindow, tray) {
  clearTimeout(_autoReplyTimer);
  _autoReplyTimer = setTimeout(async () => {
    try {
      Log.info("回复", "自动检测启动");
      const result = await checkReplies();
      if (!result.ok || !result.replies?.length) return;

      const applied = applyReplies(result.replies);
      if (applied.matched > 0) {
        Log.info("回复", "标记 " + applied.matched + " 个联系人");
        if (tray) {
          const { Notification } = require('electron');
          new Notification({ title: '📬 回复检测', body: `发现 ${result.replies.length} 条回复，已标记 ${applied.matched} 个联系人` }).show();
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('reply:detected', { count: result.replies.length, matched: applied.matched });
        }
      }
      scheduleAutoReplyCheck(mainWindow, tray); // 下一轮
    } catch (e) { Log.warn("回复", "自动检测异常: " + e.message); }
  }, REPLY_CHECK_INTERVAL);
}

function cleanup() {
  clearTimeout(_autoReplyTimer);
  _autoReplyTimer = null;
}

module.exports = { checkReplies, applyReplies, scheduleAutoReplyCheck, cleanup };
