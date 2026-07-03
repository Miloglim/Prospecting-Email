// ── 统一收件箱服务 ────────────────────────────────────────────────────────────
// POP3/IMAP raw source → mailparser 自动解析 → 分类 → 联系人匹配 → 缓存

const path = require('path');
const fs = require('fs');
const tls = require('tls');
const { simpleParser } = require('mailparser');
const { APP_ROOT } = require('../config');
const { Log } = require('../core/logger');

// ── 缓存路径 ────────────────────────────────────────────────────────────────
const CACHE_PATH = path.join(APP_ROOT, 'data', 'inbox-cache.json');
const CURSOR_PATH = path.join(APP_ROOT, 'data', 'inbox-cursor.json');
const DELETED_PATH = path.join(APP_ROOT, 'data', 'inbox-deleted.json');

// ── 关键词分类 ───────────────────────────────────────────────────────────────
const BOUNCE_KW = ['undelivered','returned mail','delivery failure','mail delivery','returned to sender',
  'message could not be delivered','delivery status notification','failure notice','mail system',
  'address rejected','user unknown','mailbox full','not found','does not exist','devuelto',
  'rebotado','devolución','no entregado','dirección de correo','no existe','bandeja llena'];
const AUTO_REPLY_KW = ['auto','automatic','automática','automático','ausente','out of office',
  'vacation','vacaciones','feriado','holiday','out of the office','fuera de la oficina',
  'ausencia','ooo','away from','no estaré','estare ausente','estoy fuera'];
const REPLY_INDICATORS = ['re:','resp:','rv:','enc:'];

function _classify(subject, from) {
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  if (BOUNCE_KW.some(kw => s.includes(kw))) return 'bounce';
  if (f.includes('mailer-daemon') || f.includes('postmaster') || f.includes('mail delivery')) return 'bounce';
  if (AUTO_REPLY_KW.some(kw => s.includes(kw) || f.includes(kw))) return 'auto-reply';
  if (REPLY_INDICATORS.some(kw => s.startsWith(kw))) return 'reply';
  return 'other';
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ── 联系人匹配 ───────────────────────────────────────────────────────────────
let _contactsIndex = null;
let _contactsIndexTime = 0;

function _buildContactsIndex() {
  if (_contactsIndex && Date.now() - _contactsIndexTime < 60000) return _contactsIndex;
  _contactsIndex = {};
  try {
    const cp = path.join(APP_ROOT, 'data', 'contacts.json');
    if (fs.existsSync(cp)) {
      const contacts = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      for (const c of contacts) {
        if (c.email) _contactsIndex[c.email.toLowerCase().trim()] = {
          company: c.company || '', companyId: c.companyId || '', contactName: c.contactName || '',
          firstName: c.firstName || '', lastName: c.lastName || '', clientType: c.clientType || '',
        };
      }
    }
  } catch { /* 联系人文件损坏 → 空索引 */ }
  _contactsIndexTime = Date.now();
  return _contactsIndex;
}

function _matchContact(fromEmail) {
  const idx = _buildContactsIndex();
  return idx[(fromEmail || '').toLowerCase().trim()] || null;
}

// ── 缓存读写 ──────────────────────────────────────────────────────────────────
function _readCache() {
  try { return fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) : []; }
  catch { return []; }
}
function _writeCache(mails) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const trimmed = mails.slice(-1000);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(trimmed, null, 2));
}
function _readDeleted() {
  try { return fs.existsSync(DELETED_PATH) ? new Set(JSON.parse(fs.readFileSync(DELETED_PATH, 'utf-8'))) : new Set(); }
  catch { return new Set(); }
}
function _writeDeleted(set) {
  const dir = path.dirname(DELETED_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 只保留最近 1000 条，限制文件大小
  const arr = [...set].slice(-1000);
  fs.writeFileSync(DELETED_PATH, JSON.stringify(arr, null, 2));
}
function _readCursor() {
  try { return fs.existsSync(CURSOR_PATH) ? JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}
function _writeCursor(data) {
  const dir = path.dirname(CURSOR_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(data, null, 2));
}

// ── 用 mailparser 解析 raw source → 统一格式 ────────────────────────────────
async function _parseRaw(rawSource, uid, accountId) {
  try {
    // ponytail: mailparser v3 兼容性 — Buffer 转 binary string 保留原始字节
    const input = typeof rawSource === 'string' ? rawSource : Buffer.from(rawSource).toString('binary');
    const parsed = await simpleParser(input);
    const fromAddr = parsed.from?.value?.[0]?.address || '';
    const fromName = parsed.from?.value?.[0]?.name || parsed.from?.text || fromAddr;
    const subject = parsed.subject || '(无主题)';
    const type = _classify(subject, fromAddr);
    const contact = _matchContact(fromAddr);
    const body = parsed.html || parsed.text || '';
    if (!fromAddr && !parsed.subject) {
      Log.warn('[收件箱]', `mailparser 无发件人+主题 — len=${input.length} 前200字: ${input.slice(0, 200)}`);
    }
    return {
      uid, accountId,
      subject, from: fromAddr, fromName,
      date: (parsed.date || new Date()).toISOString(),
      body,
      type,
      contactCompany: contact?.company || '',
      contactId: contact?.companyId || '',
      processed: false,
    };
  } catch (e) {
    Log.error('[收件箱]', `mailparser 异常: ${e.message}`, e.stack);
    return null;
  }
}

// ── IMAP 拉取（拿 raw source → mailparser）───────────────────────────────────
function _imapFetch(cfg, sinceDays) {
  const Imap = require('imap');
  return new Promise((resolve) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.pass,
      host: cfg.host, port: cfg.port || 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000, authTimeout: 10000,
    });
    const rawSources = [];
    imap.once('ready', () => {
      imap.openBox('INBOX', false, () => {
        const since = new Date(Date.now() - sinceDays * 86400000);
        imap.search([['SINCE', since]], (err, results) => {
          if (err || !results?.length) { imap.end(); return resolve(rawSources); }
          const toFetch = results.slice(-50);
          // ponytail: 取完整 raw source，mailparser 自动处理所有 MIME
          const fetch = imap.fetch(toFetch, { bodies: '', struct: true });
          fetch.on('message', (msg) => {
            const chunks = [];
            msg.on('body', (stream) => { stream.on('data', c => chunks.push(c)); });
            msg.once('end', () => { if (chunks.length) rawSources.push(Buffer.concat(chunks)); });
          });
          fetch.once('error', () => { imap.end(); resolve(rawSources); });
          fetch.once('end', () => { imap.end(); resolve(rawSources); });
        });
      });
    });
    imap.once('error', () => resolve(rawSources));
    imap.connect();
  });
}

// ── POP3 客户端 ──────────────────────────────────────────────────────────────
function _pop3Connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(sock));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('连接超时')); }, 15000);
  });
}
function _pop3ReadLine(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读行超时')); }, timeoutMs || 10000);
    const onData = (d) => { buf += d.toString(); const rn = buf.indexOf('\r\n'), n = buf.indexOf('\n'); const end = rn >= 0 ? rn : n; if (end >= 0) { clearTimeout(timer); sock.removeListener('data', onData); resolve(buf.slice(0, end).trim()); } };
    sock.on('data', onData);
  });
}
function _pop3ReadRaw(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { sock.removeAllListeners('data'); resolve(Buffer.concat(chunks)); }, timeoutMs || 30000);
    const onData = (d) => {
      chunks.push(d);
      // 检查所有已收数据尾部是否有 \r\n.\r\n（POP3 多行结束标记）
      const all = Buffer.concat(chunks).toString();
      if (/\r?\n\.\r?\n/.test(all)) { clearTimeout(timer); sock.removeListener('data', onData); resolve(Buffer.concat(chunks)); }
    };
    sock.on('data', onData);
  });
}
function _pop3Cmd(sock, cmd) {
  sock.write(cmd + '\r\n');
  if (cmd === 'QUIT') return Promise.resolve([]);
  if (/^RETR/i.test(cmd)) return _pop3ReadRaw(sock);
  if (/^(LIST|TOP|UIDL)/i.test(cmd)) return _pop3ReadMulti(sock);
  return _pop3ReadLine(sock).then(line => [line]);
}

function _pop3ReadMulti(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读多行超时')); }, timeoutMs || 15000);
    const onData = (d) => { buf += d.toString(); if (/\r?\n\.\r?\n/.test(buf)) { clearTimeout(timer); sock.removeListener('data', onData); const lines = buf.replace(/\r?\n\.\r?\n.*/, '').split(/\r?\n/); resolve(lines.length > 1 && /^[+-]/.test(lines[0]) ? lines.slice(1) : lines); } };
    sock.on('data', onData);
  });
}

// ── POP3 拉取（RETR 拿完整 raw → mailparser）─────────────────────────────────
async function _pop3Fetch(cfg, sinceDays) {
  const rawSources = [];
  let sock;
  try {
    sock = await _pop3Connect(cfg.host, cfg.port || 995);
    await _pop3ReadLine(sock, 15000);
    await _pop3Cmd(sock, `USER ${cfg.user}`);
    await _pop3Cmd(sock, `PASS ${cfg.pass}`);
    const statRes = await _pop3Cmd(sock, 'STAT');
    const total = parseInt((statRes[0] || '').split(' ')[1]) || 0;
    if (!total) { sock.write('QUIT\r\n'); sock.end(); return rawSources; }

    const cursor = _readCursor();
    const lastUid = cursor[cfg.user] || '';
    const uidlRes = await _pop3Cmd(sock, 'UIDL');
    // UIDL 返回格式: "msgNum uid"，每行一条
    // ponytail: pop3Cmd 对 UIDL 走 readMulti，返回行数组
    const uidMap = {};
    for (const line of uidlRes) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[0])) uidMap[parseInt(parts[0])] = parts[1];
    }
    let ids = Object.entries(uidMap)
      .filter(([, uid]) => uid !== lastUid)
      .map(([n]) => parseInt(n))
      .sort((a, b) => b - a)
      .slice(0, 50);
    if (!ids.length) ids = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 20);
    let newUid = lastUid;
    for (const n of ids) {
      try {
        rawSources.push(await _pop3Cmd(sock, `RETR ${n}`));
        if (!newUid || uidMap[n]) newUid = uidMap[n];
      } catch { continue; }
    }
    if (newUid) { cursor[cfg.user] = newUid; _writeCursor(cursor); }
    sock.write('QUIT\r\n'); sock.end();
  } catch (e) {
    try { sock?.end(); } catch { /* 清理 */ }
    Log.warn('[收件箱]', `POP3 ${cfg.user} 失败: ${e.message}`);
  }
  return rawSources;
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
async function fetchInbox(configPath) {
  if (!fs.existsSync(configPath)) return [];
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return []; }

  const accounts = config.smtpAccounts || [];
  if (!accounts.length) return [];

  const existing = _readCache();
  const deletedSet = _readDeleted();
  const existingKeys = new Set(existing.map(m => `${m.accountId}|${m.uid}|${m.from}|${m.subject}`));

  let newMails = [];
  for (const acc of accounts) {
    if (acc.active === false) continue;
    const cfg = acc.imap || { host: acc.smtp?.host?.replace('smtp.', 'pop3.') || '', port: 995, user: acc.smtp?.user || '', pass: acc.smtp?.pass || '' };
    if (!cfg.host || !cfg.user) continue;

    Log.info('[收件箱]', `拉取 ${acc.label || cfg.user} (${cfg.host}:${cfg.port})...`);
    try {
      let rawSources = [];
      if (cfg.host.includes('imap') || cfg.port === 993) {
        rawSources = await _imapFetch(cfg, 7);
      } else {
        rawSources = await _pop3Fetch(cfg, 7);
      }
      // mailparser 解析每个 raw source（顺序处理避免 CPU 峰值）
      Log.info('[收件箱]', `${acc.label || cfg.user} 收到 ${rawSources.length} 封原始邮件，解析中...`);
      let parsedOk = 0;
      for (const raw of rawSources) {
        const m = await _parseRaw(raw, '', cfg.user);
        if (!m) continue;
        parsedOk++;
        m.accountLabel = acc.label || cfg.user;
        const key = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
        if (!existingKeys.has(key) && !deletedSet.has(key)) {
          existingKeys.add(key);
          newMails.push(m);
        }
      }
      Log.info('[收件箱]', `${acc.label || cfg.user} 解析完成: ${parsedOk}/${rawSources.length} 封`);
    } catch (e) {
      Log.warn('[收件箱]', `${acc.label || cfg.user} 拉取失败: ${e.message}`);
    }
  }

  if (newMails.length) {
    const merged = [...newMails, ...existing].slice(-500);
    _writeCache(merged);
  }
  return _readCache();
}

function listInbox() {
  return _readCache();
}

function getBody(index) {
  const mails = _readCache();
  const m = mails[index];
  return m ? m.body || '' : '';
}

function markProcessed(index) {
  const mails = _readCache();
  if (mails[index]) { mails[index].processed = true; _writeCache(mails); }
}

function linkContact(index, contactId, company) {
  const mails = _readCache();
  if (mails[index]) { mails[index].contactId = contactId; mails[index].contactCompany = company; _writeCache(mails); }
}

function deleteMail(index) {
  const mails = _readCache();
  const m = mails[index];
  if (m) {
    const key = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
    const deletedSet = _readDeleted();
    deletedSet.add(key);
    _writeDeleted(deletedSet);
  }
  mails.splice(index, 1);
  _writeCache(mails);
}

module.exports = { fetchInbox, listInbox, getBody, markProcessed, linkContact, deleteMail };
