// ── 退信检测模块 v2（POP3/IMAP + UID增量 + AI兜底 + 去重）────────────
const tls = require('tls');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ponytail: APP_ROOT 统一从 config.js 引，避免自算路径在打包模式下偏移
const { APP_ROOT } = require('./modules/config');
const { Log } = require('./modules/core/logger');
const { API } = require('./modules/core/contract');

const BOUNCE_KW = [
  // 英文
  'undelivered','returned','failure','bounce','undeliverable',
  'delivery status','mail delivery','returned mail','message undeliverable',
  'no-reply', 'Mail Delivery Subsystem', 'Delivery Status Notification', 'No Longer',
  // 中文
  '退信','失败','退回','系统退信','无法送达','退信通知','投递失败',
  '邮件被退回','未送达','发送失败','拒收','不存在','not found',
  'user unknown','mailbox full','recipient rejected','address rejected',
  // 韩文
  '배달','실패','받는 사람','찾을 수 없','전달','거부','반송','수신자','없습', '배달되지 않음'
];
// ── 退信原因分类 ──────────────────────────────────────────────────────
function classifyBounce(subject, bodySnippet) {
  const text = ((subject || '') + ' ' + (bodySnippet || '')).toLowerCase();
  // 永久退信 (5xx)
  if (text.includes('550') || text.includes('551') || text.includes('553') || text.includes('554'))
    return { type: 'permanent', reason: '拒收' };
  if (text.includes('552'))
    return { type: 'permanent', reason: '邮箱已满' };
  if (text.includes('not found') || text.includes('user unknown') || text.includes('不存在')
    || text.includes('address rejected') || text.includes('invalid address')
    || text.includes('invalid recipient') || text.includes('no such user')
    || text.includes('recipient rejected') || text.includes('邮箱不存在')
    || text.includes('收件人不存在') || text.includes('无法送达')
    || text.includes('disabled') || text.includes('deactivated')
    || text.includes('does not exist') || text.includes('could not be delivered'))
    return { type: 'permanent', reason: '邮箱不存在' };
  if (text.includes('拒收') || text.includes('blocked') || text.includes('spam')
    || text.includes('blacklist') || text.includes('rejected for policy'))
    return { type: 'permanent', reason: '拒收' };
  if (text.includes('mailbox full') || text.includes('quota exceeded') || text.includes('邮箱已满') || text.includes('容量已满'))
    return { type: 'temporary', reason: '邮箱已满' };
  // 临时退信 (4xx)
  if (text.includes('421') || text.includes('450') || text.includes('451') || text.includes('452'))
    return { type: 'temporary', reason: '服务暂时不可用' };
  if (text.includes('try again') || text.includes('temporarily') || text.includes('try later'))
    return { type: 'temporary', reason: '临时拒收' };
  if (text.includes('greylisted') || text.includes('rate limit') || text.includes('too many'))
    return { type: 'temporary', reason: '频率限制' };
  return { type: 'unknown', reason: '未知原因' };
}

// ── 协议检测 ──────────────────────────────────────────────────────────
function isPop3(cfg) {
  const h = (cfg.host || '').toLowerCase();
  return cfg.port === 995 || h.includes('pop');
}

// ── 退信源邮箱提取 ────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractBouncedAddress(headers, bodyLines, senderEmail) {
  const text = [...headers, ...(bodyLines || [])].join('\n');
  const bodyText = (bodyLines || []).join(' ').replace(/\s+/g, ' ');
  const excludeDomains = ['no-reply','noreply','mailer-daemon','postmaster','mailadmin','mailsupport','aliyun.com'];
  if (senderEmail) { const d = senderEmail.split('@')[1]; if (d) excludeDomains.push(d); }
  function isExcluded(e) { return excludeDomains.some(d => e.toLowerCase().includes(d)); }

  const xfr = text.match(/X-Failed-Recipients:\s*(.+)/i);
  if (xfr) { const m = xfr[1].match(EMAIL_RE); if (m) return m[0].toLowerCase().trim(); }

  const dsn = text.match(/Final-Recipient:\s*rfc822;\s*(\S+)/i);
  if (dsn) return dsn[1].toLowerCase().trim().replace(/[;,]/, '');
  const orcpt = text.match(/Original-Recipient:\s*rfc822;\s*(\S+)/i);
  if (orcpt) return orcpt[1].toLowerCase().trim().replace(/[;,]/, '');

  const enPatterns = [
    /The following (?:address|recipient)(?:.*?)(?:failed|was not|could not|couldn'?t)[^:]*:\s*(\S+@\S+)/i,
    /could not be delivered to\s+(\S+@\S+)/i,
    /couldn'?t (?:be )?deliver(?:ed)? to\s+(\S+@\S+)/i,
    /Deliver(?:y|ed) to\s+(\S+@\S+)\s+(?:failed|unsuccessful)/i,
    /not be delivered to\s+(\S+@\S+)/i,
    /delivery to the following[^:]*:\s*(\S+@\S+)/i,
    /message was not delivered to\s+(\S+@\S+)/i,
    /undelivered[^:]*:\s*(\S+@\S+)/i,
    /<(\S+@\S+)>.*?(?:failed|rejected|bounced|undeliverable)/i,
    /did not reach the following[^:]*:\s*(\S+@\S+)/i,
    /following recipients?[^:]*:\s*(\S+@\S+)/i,
  ];
  const cnPatterns = [
    /收(?:件|信)人?\s*(?:邮件)?地址[：:\s]*(\S+@\S+)/,
    /^To:\s*<?(\S+@\S+)>?/im,
    /[\[<](\S+@\S+)[\]>]/,
    /收信地址\s*\n\s*(\S+@\S+)/,
    /收件人\s*\n\s*(\S+@\S+)/,
    /退信[^@]{0,30}(\S+@\S+)/,
    /无法(?:送达|投递)[^@]{0,30}(\S+@\S+)/,
    /投递失败[^@]{0,30}(\S+@\S+)/,
    /邮件(?:被退回|未送达)[^@]{0,30}(\S+@\S+)/,
    /(?:该|此|以下)(?:邮件|地址|收件人).*?(\S+@\S+)/,
    /(\S+@\S+).*?(?:不存在|未知|无效|错误|拒收|被拒|失败)/,
  ];
  for (const p of [...enPatterns, ...cnPatterns]) {
    const m = bodyText.match(p);
    if (m) {
      const addr = m[1].toLowerCase().trim().replace(/[;,<>'")\]]/g, '');
      if (EMAIL_RE.test(addr) && !isExcluded(addr)) return addr;
    }
  }
  const allEmails = text.match(EMAIL_RE) || [];
  const candidates = allEmails.map(e => e.toLowerCase().trim().replace(/[;,<>'")\]]/g, ''))
    .filter(e => EMAIL_RE.test(e) && !isExcluded(e));
  if (candidates.length) return candidates[0];
  return '';
}

// ── AI 提取被退回邮箱（Agnes）— 读完完整邮件，支持多收件人/连排/分栏 ─────
async function aiExtractAddresses(markdownBody, apiKey) {
  if (!apiKey) return [];
  const answer = await aiAsk(
    '从退信邮件中提取所有被退回的邮箱地址。注意：多个邮箱可能连在一起（如 a@x.comb@y.com）或分行列出。请逐个拆分并返回，用逗号分隔。排除系统地址（no-reply、postmaster、mailer-daemon）。找不到返回 NONE。',
    markdownBody.slice(0, 4000), 500, apiKey
  );
  if (!answer || answer === 'NONE') return [];
  // 拆分合并的邮箱（a@x.comb@y.com → a@x.com, b@y.com）
  const parts = answer.split(/[,;\s\n]+/).filter(Boolean);
  const emails = [];
  for (const p of parts) {
    const found = p.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (found) emails.push(...found);
  }
  return [...new Set(emails.map(e => e.toLowerCase().trim()))].filter(e => EMAIL_RE.test(e));
}

// ── AI 退信分类（Agnes）─────────────────────────────────────────────────
async function aiClassify(subject, bodySnippet, apiKey) {
  if (!apiKey) return { type: 'unknown', reason: '未知原因' };
  const answer = await aiAsk(
    '分析这封退信邮件。返回格式：类型|原因。类型只能是 permanent（永久失败）或 temporary（临时失败）。原因用简短中文说明。示例：permanent|邮箱不存在',
    '主题：' + (subject || '') + '\n正文：' + (bodySnippet || '').slice(0, 1000),
    50, apiKey
  );
  if (!answer) return { type: 'unknown', reason: '未知原因' };
  // 优先按 | 分隔解析
  const pipeIdx = answer.indexOf('|');
  if (pipeIdx > 0) {
    const type = answer.slice(0, pipeIdx).trim();
    const reason = answer.slice(pipeIdx + 1).trim();
    if (type === 'permanent' || type === 'temporary') return { type, reason: reason || '未知原因' };
  }
  // 兼容旧格式（空格分隔）
  const parts = answer.split(/\s+/);
  const typeFallback = parts[0];
  const reasonFallback = parts.slice(1).join(' ') || '未知原因';
  if (typeFallback === 'permanent' || typeFallback === 'temporary') return { type: typeFallback, reason: reasonFallback };
  return { type: 'unknown', reason: '未知原因' };
}

// ── AI 通用调用（Agnes API，OpenAI 兼容）────────────────────────────────
async function aiAsk(systemPrompt, userContent, maxTokens, apiKey) {
  try {
    const body = JSON.stringify({
      model: 'agnes-2.0-flash', messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0, max_tokens: maxTokens,
    });
    const result = await new Promise((resolve) => {
      const req = https.request({
        ...API.AGNES, port: 443, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        timeout: 15000, rejectUnauthorized: false,
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(body);
    });
    return (result?.choices?.[0]?.message?.content || '').trim();
  } catch { return ''; }
}

// ── MIME body 解码 ─────────────────────────────────────────────────────
function decodeMimeBody(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : lines;
  const parts = text.split(/^--[^\n]*$/m);
  let bestDecoded = text;
  let allTextParts = [];

  for (const part of parts) {
    const isPlain = /Content-Type:\s*text\/plain/i.test(part);
    const isDSN = /Content-Type:\s*message\/delivery-status/i.test(part);
    if (!isPlain && !isDSN) continue;
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
    const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part);
    let decoded = '';
    if (isBase64) {
      const m = part.match(/\n\n([A-Za-z0-9+/=\s]+?)(?:\n--|$)/s);
      if (m) { try { decoded = Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf-8'); } catch { /* base64 解码失败 → 保留空串，后续按原文处理 */ } }
    } else if (isQP) {
      const m = part.match(/\n\n([\s\S]+?)(?:\n--|$)/);
      if (m) { try { decoded = m[1].replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); } catch { /* QP 解码失败 → 保留空串 */ } }
    } else {
      const m = part.match(/\n\n([\s\S]+?)(?:\n--|$)/);
      if (m) decoded = m[1];
    }
    if (decoded) {
      allTextParts.push(decoded);
      // 优先选包含错误码的部分作为 bestDecoded
      if (/5\d\d|4\d\d|not found|user unknown|不存在|拒收|rejected|undeliverable/i.test(decoded)) {
        bestDecoded = decoded;
      }
    }
  }
  if (allTextParts.length > 0 && bestDecoded === text) {
    bestDecoded = allTextParts[0]; // 没找到错误码时用第一个 text part
  }
  if (allTextParts.length === 0 && bestDecoded === text) {
    const cleaned = text.replace(/[\s\n]+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 50) {
      try { bestDecoded = Buffer.from(cleaned, 'base64').toString('utf-8'); } catch { /* 降级解码失败 → 继续用原文 */ }
    }
  }
  return bestDecoded.split(/\r?\n/);
}

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

// ── 退信日志去重 ──────────────────────────────────────────────────────
const BOUNCE_LOG_PATH = path.join(APP_ROOT, 'data', 'bounce-log.json');

function dedupBounceLog(entries) {
  const seen = new Set();
  return entries.filter(e => {
    const key = `${e.bouncedEmail || 'unknown'}|${(e.date || '').slice(0, 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendBounceLog(newEntries) {
  let log = [];
  try { if (fs.existsSync(BOUNCE_LOG_PATH)) log = JSON.parse(fs.readFileSync(BOUNCE_LOG_PATH, 'utf-8')); } catch { /* 退信日志损坏 → 从头开始 */ }
  if (!Array.isArray(log)) log = [];
  const merged = dedupBounceLog([...log, ...newEntries]);
  fs.writeFileSync(BOUNCE_LOG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// ── POP3 客户端 ───────────────────────────────────────────────────────
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

// ── UID 游标 ──────────────────────────────────────────────────────────
const CURSOR_PATH = path.join(APP_ROOT, 'data', 'bounce-check-cursor.json');

function readCursor() {
  try { return fs.existsSync(CURSOR_PATH) ? JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}

function writeCursor(data) {
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(data, null, 2));
}

// ── POP3 增量扫描 ─────────────────────────────────────────────────────
async function pop3Check(cfg, senderEmail, effectiveKw, apiKey) {
  const sock = await pop3Connect(cfg.host, cfg.port || 995);
  let bounced = [];
  try {
    await pop3ReadLine(sock, 15000);
    await pop3Cmd(sock, `USER ${cfg.user}`);
    await pop3Cmd(sock, `PASS ${cfg.pass}`);
    const statRes = await pop3Cmd(sock, 'STAT');
    const total = parseInt((statRes[0] || '').split(' ')[1]) || 0;
    if (!total) { sock.write('QUIT\r\n'); sock.end(); return { ok: true, bounced: [], message: '收件箱为空' }; }

    // UID 增量：只扫描上次 UIDL 之后的新邮件
    const cursor = readCursor();
    const lastUid = cursor[cfg.user] || '';
    const uidlRes = await pop3Cmd(sock, 'UIDL');
    const uidMap = {};
    for (const line of uidlRes) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[0])) uidMap[parseInt(parts[0])] = parts[1];
    }

    // 找出新邮件（UID 不在游标中的）
    let newIds = Object.entries(uidMap)
      .filter(([, uid]) => uid !== lastUid)
      .map(([n]) => parseInt(n))
      .sort((a, b) => b - a);
    if (!newIds.length) {
      // 全部是新的（首次运行或游标丢失），扫最近 50 封
      newIds = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 20);
    }
    // 取最近 50 封新邮件
    newIds = newIds.slice(0, 20);

    // 反向扫描（从新到旧）
    let newUid = lastUid;
    for (const n of newIds) {
      try {
        const raw = await pop3Cmd(sock, `TOP ${n} 200`);
        let headerEnd = raw.findIndex(l => l.trim() === '');
        if (headerEnd < 0) headerEnd = raw.length;
        const headers = raw.slice(0, headerEnd);
        const bodyLines = raw.slice(headerEnd + 1);
        let subject = '', date = '', from = '';
        for (const h of headers) {
          if (h.toLowerCase().startsWith('subject:')) subject = h.slice(8).trim();
          if (h.toLowerCase().startsWith('date:')) date = h.slice(5).trim();
          if (h.toLowerCase().startsWith('from:')) from = h.slice(5).trim();
        }
        const decoded = decodeMimeHeader(subject);
        const decodedBody = decodeMimeBody(bodyLines);
        const bodySnippet = decodedBody.slice(0, 100).join('\n').slice(0, 1000);
        // 标题 + 正文前 500 字双搜关键词
        if (effectiveKw.some(kw => decoded.toLowerCase().includes(kw.toLowerCase()) || bodySnippet.toLowerCase().includes(kw.toLowerCase()))) {
          let bouncedEmails = [extractBouncedAddress(headers, decodedBody, senderEmail)].filter(Boolean);
          // AI 兜底：正则没提到，或正文有多人特征（逗号分隔多个邮箱）时用 AI 补全
          const bodyText = decodedBody.slice(0, 20).join('\n').slice(0, 1000);
          const needAI = !bouncedEmails.length || (bodyText.match(EMAIL_RE) || []).length > 2;
          if (needAI && apiKey) {
            const aiEmails = await aiExtractAddresses(bodyText, apiKey);
            if (aiEmails.length) {
              const all = new Set([...bouncedEmails, ...aiEmails]);
              bouncedEmails = [...all];
            }
          }
          let classification = classifyBounce(decoded + ' ' + bodySnippet, bodySnippet);
          if (classification.type === 'unknown' && apiKey) {
            classification = await aiClassify(decoded, bodySnippet, apiKey);
          }
          if (bouncedEmails.length) {
            for (const em of bouncedEmails) {
              bounced.push({ from, subject: decoded, date, bouncedEmail: em, rawSnippet: '', ...classification });
            }
          } else {
            bounced.push({ from, subject: decoded, date, bouncedEmail: '', rawSnippet: bodySnippet, ...classification });
          }
          if (bounced.length >= 100) break;
        }
        // 记录最新 UID
        if (!newUid || uidMap[n]) newUid = uidMap[n];
      } catch { continue; }
    }
    // 保存游标
    if (newUid) {
      cursor[cfg.user] = newUid;
      writeCursor(cursor);
    }
    sock.write('QUIT\r\n');
    sock.end();
    // 去重写入日志
    if (bounced.length) appendBounceLog(bounced);
    return { ok: true, bounced, message: bounced.length ? `发现 ${bounced.length} 封退信` : '未发现退信' };
  } catch (e) {
    try { sock.end(); } catch { /* socket 已关闭，无需处理 */ }
    return { ok: false, error: 'POP3 失败: ' + (e.message || String(e)) };
  }
}

// ── IMAP 客户端过滤 ───────────────────────────────────────────────────
function imapCheck(cfg, senderEmail, effectiveKw, apiKey) {
  const Imap = require('imap');
  return new Promise((resolve) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.pass,
      host: cfg.host, port: cfg.port || 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000, authTimeout: 10000,
    });
    const bounced = [];
    imap.once('ready', () => {
      imap.openBox('INBOX', false, () => {
        const d = new Date(Date.now() - 90 * 86400000);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const since = `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
        // 客户端过滤：只拉最近邮件，本地匹配关键词，避免 IMAP 超长 OR 树
        imap.search([['SINCE', since]], async (err, results) => {
          // 部分 IMAP 服务器（如国内企业邮）不支持 SINCE，降级为全量搜索
          if (err || !results?.length) {
            imap.search([['ALL']], async (err2, allResults) => {
              if (err2 || !allResults?.length) { imap.end(); return resolve({ ok: true, bounced: [], message: '未发现退信' }); }
              processResults(allResults.slice(-200));
            });
            return;
          }
          processResults(results.slice(-200));
        });
        function processResults(recentIds) {
          const fetch = imap.fetch(recentIds, {
            bodies: ['HEADER.FIELDS (SUBJECT DATE X-FAILED-RECIPIENTS)', 'TEXT'],
            struct: true
          });
          const messages = [];
          fetch.on('message', (msg) => {
            let headers = '', body = '';
            msg.on('body', (stream, info) => {
              let data = '';
              stream.on('data', c => data += c);
              stream.on('end', () => {
                if (info.which === 'TEXT') body = data;
                else headers = data;
              });
            });
            msg.once('end', () => messages.push({ headers, body }));
          });
          fetch.once('error', () => { imap.end(); resolve({ ok: true, bounced, message: `部分读取，发现 ${bounced.length} 封退信` }); });
          fetch.once('end', async () => {
            imap.end();
            for (const { headers, body } of messages) {
              const subj = (headers.match(/Subject: (.+)/i) || [])[1] || '';
              const decodedSubj = decodeMimeHeader(subj).trim();
              // 本地关键词匹配（标题 + 正文前 500 字）
              const bodySnippet2 = body.slice(0, 1000);
              if (!effectiveKw.some(kw => decodedSubj.toLowerCase().includes(kw.toLowerCase()) || bodySnippet2.toLowerCase().includes(kw.toLowerCase()))) continue;
              const date = (headers.match(/Date: (.+)/i) || [])[1] || '';
              const fromIMAP = (headers.match(/From: (.+)/i) || [])[1] || '';
              const bodyLines = body.split(/\r?\n/);
              const headerLines = headers.split(/\r?\n/);
              const decodedBody = decodeMimeBody(bodyLines);
              let addr = extractBouncedAddress(headerLines, decodedBody, senderEmail);
              let bouncedEmails2 = addr ? [addr] : [];
              const bodyText2 = decodedBody.slice(0, 20).join('\n').slice(0, 1000);
              const needAI2 = !bouncedEmails2.length || (bodyText2.match(EMAIL_RE) || []).length > 2;
              if (needAI2 && apiKey) {
                const aiEmails = await aiExtractAddresses(bodyText2, apiKey);
                if (aiEmails.length) {
                  const all2 = new Set([...bouncedEmails2, ...aiEmails]);
                  bouncedEmails2 = [...all2];
                }
              }
              const bodySnippet = bodyLines
                .filter(l => !/^(--|=3D--|Content-|boundary|charset|This is a multi|<\!DOCTYPE|<html|<head|<meta|<body|<\/)/i.test(l.trim()))
                .slice(0, 100).join('\n').slice(0, 1000);
              let classification2 = classifyBounce(decodedSubj + ' ' + bodySnippet, bodySnippet);
              if (classification2.type === 'unknown' && apiKey) {
                classification2 = await aiClassify(decodedSubj, bodySnippet, apiKey);
              }
              if (bouncedEmails2.length) {
                for (const em of bouncedEmails2) {
                  bounced.push({ from: fromIMAP, subject: decodedSubj, date: date.trim(), bouncedEmail: em, rawSnippet: '', ...classification2 });
                }
              } else {
                bounced.push({ from: fromIMAP, subject: decodedSubj, date: date.trim(), bouncedEmail: '', rawSnippet: bodySnippet, ...classification2 });
              }
            }
            if (bounced.length) appendBounceLog(bounced);
            resolve({ ok: true, bounced, message: bounced.length ? `发现 ${bounced.length} 封退信` : '未发现退信' });
          });
        }
      });
    });
    imap.once('error', (e) => resolve({ ok: false, error: 'IMAP 失败: ' + (e.message || e) }));
    imap.connect();
  });
}

// ── 主入口 ────────────────────────────────────────────────────────────
// 遍历所有发信账号的 IMAP 收件箱，汇总退信结果
async function checkBounces() {
  const configPath = path.join(APP_ROOT, 'send', 'config.json');
  if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在' };
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return { ok: false, error: '配置文件格式错误' }; }
  const userKw = (config.bounce?.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  const effectiveKw = [...new Set([...BOUNCE_KW, ...userKw])];
  const apiKey = (config.verify?.agnesKey || '').replace(/[\r\n\t]/g, '').trim();

  // 收集所有活跃账号，无 IMAP 则从 SMTP 自动推导
  const accounts = config.smtpAccounts || [];
  const imapAccounts = accounts
    .filter(a => a.active !== false)
    .map(a => {
      if (a.imap?.host && a.imap?.user) return a;
      // 自动推导：smtp.xxx.com → imap.xxx.com，同用户同密码
      const host = (a.smtp?.host || '').replace(/^smtp\./i, 'imap.')
        .replace(/^mail\./i, 'imap.');
      return { ...a, imap: { host, port: 993, user: a.smtp?.user || '', pass: a.smtp?.pass || '', tls: true } };
    })
    .filter(a => a.imap?.host && a.imap?.user);

  // 向后兼容：旧格式全局 imap
  if (!imapAccounts.length && config.imap?.host && config.imap?.user) {
    const senderEmail = config.imap.user || '';
    return isPop3(config.imap) ? pop3Check(config.imap, senderEmail, effectiveKw, apiKey) : imapCheck(config.imap, senderEmail, effectiveKw, apiKey);
  }

  if (!imapAccounts.length) {
    return { ok: false, error: '无可用邮箱（请在账号中配置 IMAP）' };
  }

  // 遍历各账号收件箱
  const allBounced = [];
  let lastError = '';
  for (const acc of imapAccounts) {
    try {
      const senderEmail = acc.imap.user || acc.smtp?.user || '';
      const checkFn = isPop3(acc.imap) ? pop3Check : imapCheck;
      Log.info('退信', `检查 ${acc.label || senderEmail} (${acc.imap.host}:${acc.imap.port})...`);
      const result = await checkFn(acc.imap, senderEmail, effectiveKw, apiKey);
      if (result.ok) {
        Log.info('退信', `${acc.label || senderEmail}: ${result.bounced?.length || 0} 封退信`);
        if (result.bounced?.length) allBounced.push(...result.bounced);
      } else {
        Log.error('退信', `${acc.label || senderEmail} 失败: ${result.error || '未知错误'}`);
        lastError = result.error || '';
      }
    } catch (e) {
      Log.error('退信', `账号 ${acc.label || acc.imap.user} 检测异常`, e.stack);
    }
  }

  return { ok: true, bounced: allBounced, message: allBounced.length ? `发现 ${allBounced.length} 封退信` : '未发现退信' };
}

async function testConnection(cfg) {
  if (!cfg?.host || !cfg?.user || !cfg?.pass) {
    return { ok: false, error: '请填写服务器、邮箱和密码' };
  }
  if (isPop3(cfg)) {
    try {
      const sock = await pop3Connect(cfg.host, cfg.port || 995);
      await pop3ReadLine(sock, 15000);
      await pop3Cmd(sock, `USER ${cfg.user}`);
      await pop3Cmd(sock, `PASS ${cfg.pass}`);
      sock.write('QUIT\r\n');
      sock.end();
      return { ok: true, message: 'POP3 连接成功' };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  const Imap = require('imap');
  return new Promise((resolve) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.pass,
      host: cfg.host, port: cfg.port || 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000, authTimeout: 8000,
    });
    imap.once('ready', () => { imap.end(); resolve({ ok: true, message: 'IMAP 连接成功' }); });
    imap.once('error', (e) => resolve({ ok: false, error: e.message || String(e) }));
    imap.connect();
  });
}

function clearCursor() {
  try { if (fs.existsSync(CURSOR_PATH)) fs.unlinkSync(CURSOR_PATH); } catch { /* 文件不存在 */ }
}
module.exports = { checkBounces, testConnection, classifyBounce, clearCursor };
