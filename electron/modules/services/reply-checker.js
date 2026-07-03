// ── 回复检测模块 ────────────────────────────────────────────────────────────
// 遍历所有活跃账号的 IMAP 收件箱，AI 四分类：回复 / 退信 / 自动回复 / 其他

const path = require('path');
const fs = require('fs');
const https = require('https');
const { APP_ROOT } = require('../config');
const { Log } = require("../core/logger");
const { API } = require('../core/contract');

// ponytail: 每次调用时动态读取代理（优先 config，其次系统环境变量）
function _getProxyUrl() {
  try {
    const cp = path.join(APP_ROOT, 'send', 'config.json');
    if (fs.existsSync(cp)) {
      const cfg = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      if (cfg?.proxy?.host) return 'http://' + cfg.proxy.host.replace(/^https?:\/\//, '');
    }
  } catch { /* */ }
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}
function _getProxyAgent() {
  const url = _getProxyUrl();
  if (!url) return undefined;
  try { const { HttpsProxyAgent } = require('https-proxy-agent'); return new HttpsProxyAgent(url); }
  catch { return undefined; }
}

// ── 自动回复关键词 ────────────────────────────────────────────────────────
const AUTO_REPLY_KW = [
  'out of office','auto-reply','automatic reply','automated response',
  'vacation','ausente','fuera de oficina','fora do escritório',
  '自动回复','休假',
  'automatische antwort','respuesta automática','resposta automática',
  'réponse automatique','automatisch antwoord','risposta automatica',
];

// ── 退信关键词（收件箱中误入的退信通知）───────────────────────────────────
const BOUNCE_SUBJECT_KW = [
  'undelivered','returned','failure','bounce','undeliverable','delivery status',
  'returned mail','message undeliverable',
  '退信','失败','退回','系统退信','无法送达',
  'mail delivery','mailer-daemon','postmaster','noreply','no-reply',
];

const REPLY_INDICATORS = ['re:','resp:','回复:','enc:','fw:','fwd:'];

// ponytail: 合并 config 中的自定义关键词
function _mergeCustomKw(config) {
  const customAutoReply = config?.reply?.autoReplyKeywords || [];
  const customBounce = config?.reply?.bounceKeywords || [];
  const customIndicators = config?.reply?.replyIndicators || [];
  const effAutoReplyKws = [...AUTO_REPLY_KW, ...customAutoReply.filter(k => !AUTO_REPLY_KW.includes(k))];
  const effBounceKws = [...BOUNCE_SUBJECT_KW, ...customBounce.filter(k => !BOUNCE_SUBJECT_KW.includes(k))];
  const effIndicators = [...REPLY_INDICATORS, ...customIndicators.filter(k => !REPLY_INDICATORS.includes(k))];
  return { effAutoReplyKws, effBounceKws, effIndicators };
}

// ── 正文清理：去掉 MIME 元数据、boundary、base64 块等 ─────────────────────
function cleanBodySnippet(bodyStr) {
  return bodyStr
    .split(/\r?\n/)
    .filter(l => !/^(--|=3D--|Content-|boundary|charset|This is a multi|<\!DOCTYPE|<html|<head|<meta|<body|<\/|[A-Za-z0-9+/=]{60,}|.{200,})/i.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 500)
    .trim();
}

// ── MIME 解码（从 bounce-checker 精简）───────────────────────────────────────
function decodeMimeHeader(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const buf = Buffer.from(data, 'base64');
        // 用 TextDecoder 支持全部编码（euc-kr, gb2312, shift_jis, iso-2022-jp 等）
        try { return new TextDecoder(charset).decode(buf); }
        catch { return buf.toString('utf-8'); }
      }
      return decodeURIComponent(data.replace(/_/g, ' ').replace(/%/g, '%25'));
    } catch { return data; }
  });
}

// ── 标题分类：AI 优先，关键词兜底 ──────────────────────────────────────────
// 优先级：Re: 前缀（快速）→ AI（精准）→ 关键词（兜底）→ other
let _effAutoReplyKws = AUTO_REPLY_KW;
let _effBounceKws = BOUNCE_SUBJECT_KW;
let _effIndicators = REPLY_INDICATORS;
let _apiKey = '';
let _aiEnabled = false;

// AI 通用调用
async function _aiAsk(prompt, maxTokens) {
  try {
    const body = JSON.stringify({
      model: 'agnes-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0, max_tokens: maxTokens,
    });
    const result = await new Promise((resolve) => {
      const req = https.request({
        ...API.AGNES, port: 443, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _apiKey },
        timeout: 5000, rejectUnauthorized: false,
        agent: _getProxyAgent(),
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      req.on('error', (e) => { Log.warn('[回复AI]', '网络: ' + (e.message || 'unknown')); resolve(null); });
      req.on('timeout', () => { req.destroy(); Log.warn('[回复AI]', '超时'); resolve(null); });
      req.end(body);
    });
    const content = (result?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (result && !content) Log.warn('[回复AI]', '返回空');
    return content;
  } catch (e) { Log.warn('[回复AI]', '异常: ' + (e.message || 'unknown')); return ''; }
}

// 关键词快速匹配
function _classifyByKeyword(subject) {
  const s = (subject || '').toLowerCase();
  if (_effIndicators.some(kw => s.startsWith(kw))) return 'reply';
  if (_effBounceKws.some(kw => s.includes(kw))) return 'bounce';
  if (_effAutoReplyKws.some(kw => s.includes(kw))) return 'auto-reply';
  return '';
}

// AI + 关键词综合分类（关键词优先，AI 兜底）
async function classifySubject(subject, bodySnippet) {
  if (!subject && !bodySnippet) return 'other';

  // 1. 关键词命中 → 直接返回（不浪费 AI，比 AI 精准）
  const kw = _classifyByKeyword(subject);
  if (kw) return kw;

  // 2. 关键词没命中 → AI 兜底
  if (_aiEnabled) {
    const prompt = '分析这封邮件，只返回一个词：reply（客户回复/询价/订单）、bounce（退信/投递失败/邮箱不存在）、auto-reply（自动回复/休假/OOO）、other（以上都不是）。\n\n' +
      '主题：' + (subject || '') + '\n正文：' + (bodySnippet || '').slice(0, 800);
    const answer = await _aiAsk(prompt, 20);
    if (['reply', 'bounce', 'auto-reply', 'other'].includes(answer)) return answer;
  }

  return 'other';
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
function imapCheckReplies(imapCfg, senderEmail) {
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
        const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
        imap.search([['SINCE', since]], (err, results) => {
          if (err || !results?.length) { imap.end(); return resolve({ ok: true, replies: [] }); }

          // 增量扫描：跳过游标已记录的 UID
          const cursor = readCursor();
          const lastUid = cursor[imapCfg.user] || 0;
          const newResults = results.filter(uid => uid > lastUid);
          const toFetch = newResults.length ? newResults.slice(-20) : [];
          if (!toFetch.length) { imap.end(); return resolve({ ok: true, replies: [] }); }
          // 记录本次扫描的最大 UID
          const maxUid = Math.max(...toFetch);
          cursor[imapCfg.user] = maxUid;
          writeCursor(cursor);
          const fetch = imap.fetch(toFetch, {
            bodies: ['HEADER.FIELDS (SUBJECT DATE FROM TO IN-REPLY-TO REFERENCES)', 'TEXT'],
            struct: true,
          });

          const candidates = []; // 先收集，再异步分类

          fetch.on('message', (msg) => {
            let body = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { body += chunk.toString(); });
            });
            msg.once('end', () => {
              const subjectMatch = body.match(/^Subject:\s*(.+)/im);
              const fromMatch = body.match(/^From:\s*(.+)/im);
              const dateMatch = body.match(/^Date:\s*(.+)/im);
              const toMatch = body.match(/^To:\s*(.+)/im);
              const inReplyToMatch = body.match(/^In-Reply-To:\s*(.+)/im);
              const refsMatch = body.match(/^References:\s*(.+)/im);

              const subject = decodeMimeHeader(subjectMatch?.[1] || '');
              const from = (fromMatch?.[1] || '').trim();
              const date = (dateMatch?.[1] || '').trim();
              const toRaw = (toMatch?.[1] || '').trim();
              const recipEmail = (toRaw.match(/<(.+?)>/) || [])[1] || toRaw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[0] || '';
              const fromEmail = (from.match(/<(.+?)>/) || [])[1] || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[0] || '';
              if (!fromEmail) return;

              const msgId = (inReplyToMatch?.[1] || refsMatch?.[1] || '').trim();
              const bodyText = cleanBodySnippet(body);

              candidates.push({ from: fromEmail, recipEmail, subject, date, inReplyTo: msgId, snippet: bodyText });
            });
          });

          fetch.once('error', () => { /* skip */ });
          fetch.once('end', async () => {
            imap.end();
            // 批量 AI 分类 + 账号匹配
            const replies = [];
            for (const c of candidates) {
              const type = await classifySubject(c.subject, c.snippet);
              if (type === 'other') continue;
              replies.push({ ...c, type });
            }
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
      buf += d.toString('latin1');
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
      buf += d.toString('latin1');
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
async function pop3CheckReplies(cfg, senderEmail) {
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
    const ids = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 15);

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

        const fromEmail = (from.match(/<(.+?)>/) || [])[1] || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[0] || '';
        if (!fromEmail) continue;

        const bodyText = cleanBodySnippet(bodyLines.join('\n'));
        const type = await classifySubject(decoded, bodyText);
        if (type === 'other') continue;
        replies.push({ from: fromEmail, subject: decoded, date, type, inReplyTo: '', snippet: bodyText });
      } catch { continue; }
    }
    sock.write('QUIT\r\n');
    sock.end();
    return { ok: true, replies };
  } catch (e) {
    try { sock.end(); } catch { /* 清理操作失败不影响主流程 */ }
    return { ok: false, error: 'POP3 失败: ' + (e.message || String(e)) };
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
async function checkReplies() {
  const configPath = path.join(APP_ROOT, 'send', 'config.json');
  if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在' };
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return { ok: false, error: '配置文件格式错误' }; }

  // 合并自定义关键词 + API Key
  const merged = _mergeCustomKw(config);
  _effAutoReplyKws = merged.effAutoReplyKws;
  _effBounceKws = merged.effBounceKws;
  _effIndicators = merged.effIndicators;
  const rawKey = (config.verify?.agnesKey || '').replace(/[\r\n\t]/g, '').trim();
  _apiKey = rawKey;
  _aiEnabled = rawKey.length >= 20 && !rawKey.includes(' ');

  const accounts = config.smtpAccounts || [];
  const activeAccounts = accounts.filter(a => a.active !== false && a.imap?.host && a.imap?.user);

  // 兼容旧全局 IMAP
  const checkAccounts = activeAccounts.length > 0 ? activeAccounts
    : config.imap?.host ? [{ imap: config.imap, label: '默认', smtp: { user: config.imap.user } }]
    : [];

  if (!checkAccounts.length) return { ok: false, error: '无可用邮箱（请在账号中配置 IMAP/POP3 收件箱）' };

  // 预加载联系人邮箱集合（用于匹配发件人）
  const contactEmails = new Set();
  try {
    const cp = path.join(APP_ROOT, 'data', 'contacts.json');
    if (fs.existsSync(cp)) {
      const contacts = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      for (const c of contacts) {
        if (c.email) contactEmails.add(c.email.toLowerCase().trim());
      }
    }
  } catch { /* 联系人加载失败不影响检测 */ }

  const allReplies = [];
  for (const acc of checkAccounts) {
    const senderEmail = acc.imap?.user || acc.smtp?.user || '';
    try {
      const isPop = isPop3(acc.imap);
      const result = isPop
        ? await pop3CheckReplies(acc.imap, senderEmail)
        : await imapCheckReplies(acc.imap, senderEmail);
      if (result.ok && result.replies?.length) {
        result.replies.forEach(r => {
          r._accountLabel = acc.label || senderEmail;
          r._contactMatched = contactEmails.has((r.from || '').toLowerCase().trim());
        });
        allReplies.push(...result.replies);
      }
    } catch (e) {
      Log.warn(`[回复] 账号 ${acc.label || senderEmail} 检测异常:`, e.message);
    }
  }

  // AI 从正文提取联系人邮箱（From 头没匹配到 + AI 可用时兜底）
  if (_aiEnabled) {
    for (const r of allReplies) {
      if (r._contactMatched) continue; // 已匹配，跳过
      const prompt = '从邮件正文中提取发件人的联系邮箱。排除 no-reply、postmaster、mailer-daemon 等系统地址。只返回邮箱，找不到返回 NONE。\n\n' +
        '主题：' + (r.subject || '') + '\n正文：' + (r.snippet || '').slice(0, 800);
      const answer = await _aiAsk(prompt, 20);
      if (answer && answer !== 'NONE') {
        const match = answer.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (match) {
          const aiEmail = match[0].toLowerCase().trim();
          r._contactMatched = contactEmails.has(aiEmail);
          if (r._contactMatched) r._aiExtractedEmail = aiEmail;
        }
      }
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

  return { ok: true, replies: allReplies, message: allReplies.length ? `发现 ${allReplies.length} 条邮件` : '未发现匹配邮件' };
}

// ── 应用回复标记（由 IPC 层调用）───────────────────────────────────────────
// 只标记 type === 'reply' 的邮件到联系人（auto-reply 不标记）
function applyReplies(replies) {
  if (!replies?.length) return { matched: 0 };

  const cp = path.join(APP_ROOT, 'data', 'contacts.json');
  if (!fs.existsSync(cp)) return { matched: 0 };
  let contacts;
  try { contacts = JSON.parse(fs.readFileSync(cp, 'utf-8')); } catch { return { matched: 0 }; }

  // 只处理真实回复，跳过自动回复
  const realReplies = replies.filter(r => r.type === 'reply');
  if (!realReplies.length) return { matched: 0 };

  let matched = 0;
  for (const r of realReplies) {
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
const REPLY_CHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟

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
