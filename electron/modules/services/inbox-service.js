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
const BOUNCE_COUNT_PATH = path.join(APP_ROOT, 'data', 'dash-bounce-count.json');

// ── 退信计数（独立于联系人库，删联系人不影响）─────────────────────────
function _readBounceCount() {
  try {
    if (fs.existsSync(BOUNCE_COUNT_PATH)) return JSON.parse(fs.readFileSync(BOUNCE_COUNT_PATH, 'utf-8'));
  } catch { /* 静默 */ }
  return { today: 0, total: 0, date: '' };
}
function _logInboxInteractions(newMails) {
  try {
    const contactsDb = require('./contacts-db');
    const interactionsDb = require('./interactions-db');
    for (const m of newMails) {
      let contactId = m.contactDbId || '';
      if (!contactId && m.from) {
        const c = contactsDb.getByEmail(m.from);
        if (c) contactId = c.id;
      }
      if (!contactId) continue;
      const itype = m.type === 'bounce' ? 'bounced' : m.type === 'reply' ? 'received' : m.type === 'auto-reply' ? 'received' : 'noted';
      interactionsDb.add({
        contact_id: contactId,
        company_id: m.contactId || '',
        type: itype,
        direction: 'inbound',
        subject: m.subject || '',
        snippet: (m.body || '').slice(0, 200),
        email_uid: m.uid || '',
      });
    }
  } catch { /* 互动记录不影响收件箱 */ }
}

function _incrementBounceCount(n) {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).toISOString().slice(0, 10);
  const c = _readBounceCount();
  if (c.date !== today) { c.today = 0; c.date = today; }
  c.today += n;
  c.total += n;
  try { fs.writeFileSync(BOUNCE_COUNT_PATH, JSON.stringify(c)); } catch { /* 静默 */ }
}
function getBounceCount() {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).toISOString().slice(0, 10);
  const c = _readBounceCount();
  if (c.date !== today) { c.today = 0; c.date = today; }
  return c;
}

// ── 关键词加载（data/inbox-keywords.json）────────────────────────────────
const KW_PATH = path.join(APP_ROOT, 'data', 'inbox-keywords.json');

let _kw = null;
function _loadKeywords() {
  if (_kw) return _kw;
  try {
    if (fs.existsSync(KW_PATH)) {
      const raw = JSON.parse(fs.readFileSync(KW_PATH, 'utf-8'));
      const flat = {};
      const keys = ['bounce_subject','bounce_senders','bounce_body','bounce_left','auto_reply','reply_prefix','inquiry'];
      for (const k of keys) {
        const v = raw[k];
        flat[k] = Array.isArray(v) ? v : (v?.words || []);
      }
      _kw = flat;
      return _kw;
    }
  } catch (e) { Log.error('[收件箱]', '关键词文件读取失败', e.stack); }
  // ponytail: 文件缺失时用内置兜底，并自动写出文件供后续编辑
  Log.warn('[收件箱]', '关键词文件缺失，使用内置默认并创建文件');
  _kw = {
    bounce_subject: ['undelivered','returned mail','delivery failure','mail delivery failed','returned to sender','message could not be delivered','delivery status notification','failure notice','mail system','address rejected','user unknown','mailbox full','not found','does not exist','non remis','nicht zugestellt','no se pudo entregar','退信','退回','退件','系统退信','投递失败','发送失败','undeliverable','permanent failure','message undelivered','warning: message','delayed delivery','delivery incomplete','rejected mail'],
    bounce_senders: ['mailer-daemon','postmaster','mail delivery subsystem','mailadmin@','mailer@'],
    bounce_body: ['address rejected','user unknown','mailbox not found','no such user','invalid recipient','mailbox unavailable','does not like recipient','not accepting mail','unrouteable address','recipient rejected','status: 5','over quota','mailbox exceeded','message blocked','smtp error','delivery failed permanently','unable to deliver','recipient unknown',"couldn't be delivered","couldn't deliver to","weren't found at","unknown to address","the following recipients","action required","recipients weren't found"],
    bounce_left: ['no longer','has left','left the company','no longer with','is no longer at','no longer works','不再该公司','已离职','no longer employed'],
    auto_reply: ['automatic reply','auto-reply','auto reply','out of office','out of the office','vacation','vacaciones','feriado','holiday notice','ooo -','[ooo]','ausente','ausência','fuera de la oficina','fora do escritório','respuesta automática','resposta automática','away from office','no estaré','estare ausente','estoy fuera','licença maternidade','maternity leave','acceso limitado','automaattinen vastaus'],
    reply_prefix: ['re:','resp:','rv:','ref:','回复:','答复:','转发:','fw:','fwd:'],
    inquiry: ['solicitud','consulta','cotización','cotizacion','información','info.','request for quote','rfq','presupuesto','orçamento','budget request','shipping quote','freight quote','logistics inquiry','cargo quote','transport quote'],
  };
  // 自动创建关键词文件
  try {
    const dir = path.dirname(KW_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toWrite = {};
    for (const k of ['bounce_subject','bounce_senders','bounce_body','bounce_left','auto_reply','reply_prefix','inquiry']) {
      toWrite[k] = { _note: '', words: _kw[k] };
    }
    fs.writeFileSync(KW_PATH, JSON.stringify(toWrite, null, 2));
  } catch { /* 写文件失败不影响运行 */ }
  return _kw;
}

function _classify(subject, from, bodySnippet) {
  const kw = _loadKeywords();
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  const b = (bodySnippet || '').toLowerCase();

  // 1. 退信
  // 1a. 标题含退信关键词
  if (kw.bounce_subject.some(k => s.includes(k))) return 'bounce';
  // 1b. 发件人是邮件系统地址
  if (kw.bounce_senders.some(k => f.includes(k))) return 'bounce';
  // 1c. 正文含 SMTP 错误码（5xx）或退信特征短语
  if (/\b5\d{2}\b/.test(b)) return 'bounce';
  if (kw.bounce_body.some(k => b.includes(k))) return 'bounce';
  // 1d. 离职/人已不在 → 也是退信
  if (kw.bounce_left.some(k => b.includes(k))) return 'bounce';

  // 2. 自动回复：标题 或 正文前 500 字符
  if (kw.auto_reply.some(k => s.includes(k) || b.slice(0, 500).includes(k))) return 'auto-reply';

  // 3. 回复/询盘
  if (kw.reply_prefix.some(k => s.startsWith(k))) return 'reply';
  if (kw.inquiry.some(k => s.includes(k) || b.slice(0, 500).includes(k))) return 'reply';

  // 4. 其余
  return 'other';
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ── 联系人匹配 ───────────────────────────────────────────────────────────────
// ponytail: 每次强制从 SQLite 重建索引，确保联系人删除后立即生效
function _buildContactsIndex() {
  const idx = {};
  try {
    const contactsDb = require('./contacts-db');
    const contacts = contactsDb.listAll();
    for (const c of contacts) {
      const email = (c.email || '').toLowerCase().trim();
      if (email) idx[email] = {
        id: c.id || '',
        company: c.company_name || c.company || '',
        companyId: c.company_id || '',
        contactName: c.contact_name || c.contactName || '',
        firstName: c.first_name || c.firstName || '',
        lastName: c.last_name || c.lastName || '',
        clientType: c.client_type || c.clientType || '',
        tags: c.tags || [],
      };
    }
  } catch { /* 联系人读取失败 → 空索引 */ }
  return idx;
}

function _matchContact(fromEmail, fromName, idx) {
  idx = idx || _buildContactsIndex();
  const emailMatch = idx[(fromEmail || '').toLowerCase().trim()];
  if (emailMatch) return emailMatch;
  if (fromName) {
    const nameLower = fromName.toLowerCase().trim();
    for (const contact of Object.values(idx)) {
      const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').toLowerCase();
      const contactName = (contact.contactName || '').toLowerCase();
      if ((fullName && nameLower.includes(fullName)) ||
          (contactName && nameLower.includes(contactName))) {
        return contact;
      }
    }
  }
  return null;
}
function _matchContactFromIdx(fromEmail, fromName, idx) { return _matchContact(fromEmail, fromName, idx); }

// ── 从正文提取邮箱 → 匹配联系人 ───────────────────────────────────────────
function _extractBodyContacts(plainText, htmlText, extraText) {
  return _extractBodyContactsFromIdx(plainText, htmlText, extraText, _buildContactsIndex());
}
function _extractBodyContactsFromIdx(plainText, htmlText, extraText, idx) {
  const text = (plainText || '') + ' ' + (htmlText || '').replace(/<[^>]+>/g, ' ') + ' ' + (extraText || '').replace(/<[^>]+>/g, ' ');
  const seen = new Set();
  const result = [];
  const emails = text.match(EMAIL_RE) || [];
  for (const em of emails) {
    if (result.length >= 20) break;
    const key = em.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const contact = idx[key];
    result.push({
      email: em,
      company: contact?.company || '',
      companyId: contact?.companyId || '',
      contactId: contact?.id || '',
      contactName: contact?.contactName || contact?.firstName || '',
      matched: !!contact,
    });
  }
  return result;
}

// ── 缓存读写（SQLite）──────────────────────────────────────────────────────────
const CACHE_PATH_JSON = CACHE_PATH;

function _readCache() {
  try {
    const { getDb } = require('./db');
    const rows = getDb().prepare('SELECT * FROM inbox ORDER BY important DESC, date DESC LIMIT 500').all();
    return rows.map(r => {
      try { r.contactTags = JSON.parse(r.contact_tags || '[]'); } catch { r.contactTags = []; }
      try { r.matchedContacts = JSON.parse(r.matched_contacts || '[]'); } catch { r.matchedContacts = []; }
      r.from = r.from_addr;
      r.fromName = r.from_name;
      r.contactCompany = r.contact_company;
      r.contactId = r.contact_id;
      r.contactDbId = r.contact_db_id;
      r.accountId = r.account_id;
      r.accountLabel = r.account_label;
      return r;
    });
  } catch { return []; }
}

function _writeCache(mails) {
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const insert = db.prepare('INSERT OR REPLACE INTO inbox (uid, account_id, subject, from_addr, from_name, date, body, type, contact_company, contact_id, contact_db_id, contact_tags, matched_contacts, processed, important, account_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    // ponytail: 事务内先清表再写入，与内存缓存完全同步，防止旧记录累积
    const batch = db.transaction(() => {
      db.exec('DELETE FROM inbox');
      for (const m of mails.slice(-500)) {
        insert.run(m.uid||'', m.accountId||'', m.subject||'', m.from||'', m.fromName||'', m.date||'', m.body||'', m.type||'other', m.contactCompany||'', m.contactId||'', m.contactDbId||'', JSON.stringify(m.contactTags||[]), JSON.stringify(m.matchedContacts||[]), m.processed?1:0, m.important?1:0, m.accountLabel||'');
      }
    });
    batch();
  } catch { /* 降级 */ }
}

function _migrateInboxFromJson() {
  try {
    if (!fs.existsSync(CACHE_PATH_JSON)) return 0;
    const mails = JSON.parse(fs.readFileSync(CACHE_PATH_JSON, 'utf-8'));
    if (!mails.length) return 0;
    const { getDb } = require('./db');
    const existing = getDb().prepare('SELECT COUNT(*) as n FROM inbox').get().n;
    if (existing > 0) return 0;
    _writeCache(mails);
    Log.info('[收件箱]', 'inbox 迁移: ' + mails.length + ' 封');
    return mails.length;
  } catch { return 0; }
}

// ── 删除记录 & 游标（JSON 文件，与 SQLite 缓存独立）──────────────────────
function _readDeleted() {
  try { return fs.existsSync(DELETED_PATH) ? new Set(JSON.parse(fs.readFileSync(DELETED_PATH, 'utf-8'))) : new Set(); }
  catch { return new Set(); }
}
function _writeDeleted(set) {
  try {
    const dir = path.dirname(DELETED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DELETED_PATH, JSON.stringify([...set].slice(-1000)));
  } catch { /* 静默 */ }
}
function _readCursor() {
  try { return fs.existsSync(CURSOR_PATH) ? JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}
function _writeCursor(data) {
  try {
    const dir = path.dirname(CURSOR_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CURSOR_PATH, JSON.stringify(data));
  } catch { /* 静默 */ }
}

// ── 标签同步：收件箱分类 → 联系人 tags ──────────────────────────────────
function _syncTagsToContacts(newMails) {
  const contactsDb = require('./contacts-db');
  const TYPE_TAG = { bounce: 'bounced_by_contact', reply: 'replied', 'auto-reply': 'autoreply' };
  let synced = 0;
  for (const m of newMails) {
    const tag = TYPE_TAG[m.type];
    if (!tag) continue;
    // ponytail: 实时从 SQLite 按邮箱匹配联系人，不依赖缓存的 contactDbId（可能过期/为空）
    const ids = new Set();
    const addByEmail = (email) => {
      if (!email) return;
      const contact = contactsDb.getByEmail(email);
      if (contact) ids.add(contact.id);
    };
    addByEmail(m.from);
    for (const c of (m.matchedContacts || [])) {
      addByEmail(c.email);
    }
    for (const id of ids) {
      if (contactsDb.addTag(id, tag)) synced++;
      if (m.type === 'bounce') {
        contactsDb.update(id, { is_bounced: true, bounce_type: 'permanent', bounce_reason: m.subject || '', bounced_at: new Date().toISOString() });
      }
    }
  }
  if (synced > 0) Log.info('[收件箱]', `标签同步: ${synced} 个联系人`);
  return synced;
}

// ── 用 mailparser 解析 raw source → 统一格式 ────────────────────────────────
async function _parseRaw(rawSource, uid, accountId) {
  try {
    // ponytail: 跳过空邮件（POP3 状态行等）
    if (!rawSource || rawSource.length < 20) return null;
    const input = typeof rawSource === 'string' ? rawSource : Buffer.from(rawSource).toString('binary');
    const parsed = await simpleParser(input);
    const fromAddr = parsed.from?.value?.[0]?.address || '';
    const fromName = parsed.from?.value?.[0]?.name || parsed.from?.text || fromAddr;
    const subject = parsed.subject || '(无主题)';
    const bodySnippet = parsed.text ? parsed.text.slice(0, 1000) : '';
    let type = _classify(subject, fromAddr, bodySnippet);
    const contactIdx = _buildContactsIndex(); // 一次读盘，下面共用
    const contact = _matchContactFromIdx(fromAddr, fromName, contactIdx);
    // 正文中提取邮箱 → 匹配联系人
    const extraText = type === 'bounce' ? (typeof rawSource === 'string' ? rawSource : Buffer.from(rawSource).toString('utf-8')) : '';
    const matchedContacts = _extractBodyContactsFromIdx(parsed.text || '', parsed.html || '', extraText, contactIdx);
    if (type === 'bounce') {
      Log.info('[收件箱]', `退信提取: parsed.text=${(parsed.text||'').length}字 html=${(parsed.html||'').length}字 raw=${extraText.length}字 → 找到${matchedContacts.length}个邮箱`);
    }
    // 匹配到联系人的 unknown 邮件升级为 reply；已分类为 bounce/auto-reply 的不覆盖
    const hasMatch = contact || (matchedContacts || []).some(c => c.matched);
    if (hasMatch && type === 'other') type = 'reply';

    let body = parsed.html || parsed.text || '';
    // mailparser 解析失败时用 raw 原文兜底，防止正文完全空白
    if (!body && input) {
      const rawStr = typeof input === 'string' ? input : Buffer.from(input).toString('utf-8');
      const escaped = rawStr.slice(0, 50000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      body = '<pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;color:#666">' + escaped + '</pre>';
    }
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
      contactDbId: contact?.id || '',
      contactTags: contact?.tags || [],
      matchedContacts: matchedContacts || [],
      processed: false,
      important: false,
    };
  } catch (e) {
    Log.error('[收件箱]', `mailparser 异常: ${e.message}`, e.stack);
    return null;
  }
}

// ── IMAP 拉取（UID 增量，游标自动推进）─────────────────────────────────────
function _imapFetch(cfg) {
  const Imap = require("imap");
  return new Promise((resolve) => {
    const imap = new Imap({
      user: cfg.user,
      password: cfg.pass,
      host: cfg.host,
      port: cfg.port || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });
    const rawSources = [];
    imap.once("ready", () => {
      imap.openBox("INBOX", true, () => {
        const cursorKey = `imap:${cfg.user}@${cfg.host}`;
        const cursor = _readCursor();
        const lastUid = parseInt(cursor[cursorKey]) || 0;

        const isIncremental = lastUid > 0;
        const searchCriteria = isIncremental
          ? [["UID", `${lastUid + 1}:*`]]
          : [["ALL"]];

        imap.search(searchCriteria, (err, results) => {
          if (err || !results?.length) {
            imap.end();
            return resolve(rawSources);
          }
          // ponytail: 增量拉取不限制数量，避免漏邮件；首次拉取取最近 40 封
          const toFetch = isIncremental ? results : results.slice(-40);
          let maxUid = lastUid;

          const fetch = imap.fetch(toFetch, {
            bodies: "",
            struct: true,
          });
          fetch.on("message", (msg) => {
            const chunks = [];
            msg.on("body", (stream) => {
              stream.on("data", (c) => chunks.push(c));
            });
            msg.once("attributes", (attrs) => {
              if (attrs?.uid > maxUid) maxUid = attrs.uid;
            });
            msg.once("end", () => {
              if (chunks.length) rawSources.push(Buffer.concat(chunks));
            });
          });
          fetch.once("error", () => {
            imap.end();
            resolve(rawSources);
          });
          fetch.once("end", () => {
            if (maxUid > lastUid) {
              cursor[cursorKey] = String(maxUid);
              _writeCursor(cursor);
            }
            imap.end();
            resolve(rawSources);
          });
        });
      });
    });
    imap.once("error", () => resolve(rawSources));
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
  return new Promise((resolve) => {
    const chunks = [];
    let totalLen = 0;
    const timer = setTimeout(() => { sock.removeAllListeners('data'); resolve(Buffer.concat(chunks, totalLen)); }, timeoutMs || 15000);
    const onData = (d) => {
      chunks.push(d);
      totalLen += d.length;
      if (totalLen < 5) return;
      // ponytail: 只拼末尾 200 字节查结束标记，避免 O(n²) 全量拼接
      let scanned = 0;
      const tailChunks = [];
      for (let i = chunks.length - 1; i >= 0 && scanned < 200; i--) {
        tailChunks.unshift(chunks[i]);
        scanned += chunks[i].length;
      }
      if (/\r?\n\.\r?\n/.test(Buffer.concat(tailChunks).toString())) {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        resolve(Buffer.concat(chunks, totalLen));
      }
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
    const chunks = [];
    const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读多行超时')); }, timeoutMs || 15000);
    const onData = (d) => {
      chunks.push(d);
      // ponytail: 只拼末尾 200 字节查结束标记，避免大 UIDL 列表的 O(n²) 字符串拼接
      let scanned = 0;
      const tailChunks = [];
      for (let i = chunks.length - 1; i >= 0 && scanned < 200; i--) {
        tailChunks.unshift(chunks[i]);
        scanned += chunks[i].length;
      }
      if (/\r?\n\.\r?\n/.test(Buffer.concat(tailChunks).toString())) {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        const buf = Buffer.concat(chunks).toString();
        const lines = buf.replace(/\r?\n\.\r?\n.*/, '').split(/\r?\n/);
        resolve(lines.length > 1 && /^[+-]/.test(lines[0]) ? lines.slice(1) : lines);
      }
    };
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
    const lastNum = parseInt(cursor[cfg.user]) || 0; // 游标存最大序号，新邮件序号一定更大
    const uidlRes = await _pop3Cmd(sock, 'UIDL');
    const uidMap = {};
    let maxServerNum = 0;
    for (const line of uidlRes) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
        const n = parseInt(parts[0]);
        uidMap[n] = parts[1];
        if (n > maxServerNum) maxServerNum = n;
      }
    }
    const isIncremental = lastNum > 0;
    let ids = Object.keys(uidMap)
      .map(Number)
      .filter((n) => n > lastNum) // 只要序号 > 游标的新邮件
      .sort((a, b) => b - a);
    if (!isIncremental) ids = ids.slice(0, 40); // 首次只取最近 40 封
    if (!ids.length) {
      if (lastNum) { sock.write('QUIT\r\n'); sock.end(); return rawSources; }
      ids = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 40);
    }
    let newCursorNum = lastNum;
    for (const n of ids) {
      try {
        const raw = await _pop3Cmd(sock, `RETR ${n}`);
        raw._pop3Seq = String(n);
        rawSources.push(raw);
        if (n > newCursorNum) newCursorNum = n;
      } catch { continue; }
    }
    if (newCursorNum > lastNum) {
      cursor[cfg.user] = String(newCursorNum);
      _writeCursor(cursor);
    }
    sock.write('QUIT\r\n'); sock.end();
  } catch (e) {
    try { sock?.end(); } catch { /* 清理 */ }
    Log.warn('[收件箱]', `POP3 ${cfg.user} 失败: ${e.message}`);
  }
  return rawSources;
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
let _fetchLock = false;
let _fetchLockTime = 0;
async function fetchInbox(configPath) {
  // 锁超时：超过 5 分钟认为上次卡死，强制释放
  if (_fetchLock && Date.now() - _fetchLockTime > 120000) {
    Log.warn('[收件箱]', '上次拉取超过2分钟未完成，强制释放锁');
    _fetchLock = false;
  }
  if (_fetchLock) { Log.info('[收件箱]', '上一次拉取未完成，跳过'); return _readCache(); }
  _fetchLock = true;
  _fetchLockTime = Date.now();
  try { return await _fetchInbox(configPath); } finally { _fetchLock = false; }
}
async function _fetchInbox(configPath) {
  if (!fs.existsSync(configPath)) return [];
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return []; }

  const accounts = config.smtpAccounts || [];
  if (!accounts.length) return [];

  const existing = _readCache();
  const deletedSet = _readDeleted();
  // uid+accountId 去重，保留 POP3/IPAM 序列号作为唯一标识
  const existingKeys = new Set(existing.map(m => `${m.accountId}|${m.uid}`));

  // ponytail: 多账号并行拉取，不再串行排队
  const activeAccounts = [];
  for (const acc of accounts) {
    if (acc.active === false) continue;
    const cfg = acc.imap || { host: acc.smtp?.host?.replace('smtp.', 'pop3.') || '', port: 995, user: acc.smtp?.user || '', pass: acc.smtp?.pass || '' };
    if (!cfg.host || !cfg.user) continue;
    activeAccounts.push({ acc, cfg });
  }

  const results = await Promise.all(activeAccounts.map(async ({ acc, cfg }) => {
    Log.info('[收件箱]', `拉取 ${acc.label || cfg.user} (${cfg.host}:${cfg.port})...`);
    try {
      let rawSources = [];
      if (cfg.host.includes('imap') || cfg.port === 993) {
        rawSources = await _imapFetch(cfg);
      } else {
        rawSources = await _pop3Fetch(cfg, 2);
      }
      Log.info('[收件箱]', `${acc.label || cfg.user} 收到 ${rawSources.length} 封原始邮件，解析中...`);
      const mails = [];
      for (const raw of rawSources) {
        const uid = raw._pop3Seq || '';
        const m = await _parseRaw(raw, uid, cfg.user);
        if (!m) continue;
        m.accountLabel = acc.label || cfg.user;
        mails.push(m);
      }
      Log.info('[收件箱]', `${acc.label || cfg.user} 解析完成: ${mails.length}/${rawSources.length} 封`);
      return mails;
    } catch (e) {
      Log.warn('[收件箱]', `${acc.label || cfg.user} 拉取失败: ${e.message}`);
      return [];
    }
  }));

  // 合并去重：uid+accountId 唯一，过滤已删除
  const newMails = [];
  for (const m of results.flat()) {
    const dedupKey = `${m.accountId}|${m.uid}`;
    const delKey = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
    if (existingKeys.has(dedupKey)) continue;
    if (deletedSet.has(delKey)) continue;
    existingKeys.add(dedupKey);
    newMails.push(m);
  }

  // 同步分类标签到联系人表 + 退信计数 + 互动记录
  if (newMails.length) {
    _syncTagsToContacts(newMails);
    const bounceN = newMails.filter(m => m.type === 'bounce').length;
    if (bounceN > 0) _incrementBounceCount(bounceN);
    _logInboxInteractions(newMails);
  }

  // ponytail: 直接返回内存数据，避免写完又读
  if (newMails.length) {
    const merged = [...newMails, ...existing].slice(-500);
    _writeCache(merged);
    return merged;
  }
  return existing;
}

function listInbox() {
  const mails = _readCache();
  const idx = _buildContactsIndex();
  const idxSize = Object.keys(idx).length;
  const beforeMatched = mails.filter(m => m.contactCompany || (m.matchedContacts || []).some(c => c.matched)).length;
  let changed = false;
  for (const m of mails) {
    const senderKey = (m.from || '').toLowerCase().trim();
    const senderMatch = !!(senderKey && idx[senderKey]);
    if (!senderMatch && m.contactCompany) {
      m.contactCompany = '';
      m.contactId = '';
      m.contactDbId = '';
      changed = true;
    }
    // ponytail: 不自动重设 contactCompany — 匹配仅在拉取新邮件时发生
    // 已由 removeMatchedContact 清理的匹配不应被 listInbox 复活
    if (m.matchedContacts) {
      for (const c of m.matchedContacts) {
        const was = c.matched;
        c.matched = !!idx[(c.email || '').toLowerCase().trim()];
        if (was !== c.matched) changed = true;
      }
    }
  }
  if (changed) _writeCache(mails);
  const afterMatched = mails.filter(m => m.contactCompany || (m.matchedContacts || []).some(c => c.matched)).length;
  if (beforeMatched !== afterMatched || changed) {
    Log.info('[收件箱]', `listInbox验证: 索引${idxSize}人, 匹配${beforeMatched}→${afterMatched}, 变更=${changed}`);
  }
  return mails;
}

function getBody(index) {
  const mails = _readCache();
  const m = mails[index];
  return m ? m.body || '' : '';
}

function markProcessed(index) {
  const mails = _readCache();
  if (mails[index]) { mails[index].processed = !mails[index].processed; _writeCache(mails); }
}

function toggleImportant(index) {
  const mails = _readCache();
  if (mails[index]) { mails[index].important = !mails[index].important; _writeCache(mails); }
}
function toggleImportantByKey(mailKey) {
  const mails = _readCache();
  const m = mails.find(x => `${x.accountId}|${x.uid}|${x.from}|${x.subject}` === mailKey);
  if (m) {
    m.important = !m.important;
    _writeCache(mails);
    Log.info('[收件箱]', `toggleImportant: key=${mailKey} → important=${m.important}`);
  } else {
    Log.warn('[收件箱]', `toggleImportant: 未找到 key=${mailKey} (缓存共${mails.length}封)`);
  }
}
function setMailType(index, newType) {
  const VALID_TYPES = ['bounce', 'reply', 'auto-reply', 'other'];
  if (!VALID_TYPES.includes(newType)) return false;
  const mails = _readCache();
  if (!mails[index]) return false;
  const oldType = mails[index].type;
  mails[index].type = newType;
  _writeCache(mails);
  Log.info('[收件箱]', `手动分类: [${index}] ${oldType} → ${newType}`);
  // 同步标签到联系人
  _syncTagsToContacts([mails[index]]);
  return true;
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
    // ponytail: SQLite 层同步删除，防止重启后重现
    try { const { getDb } = require('./db'); getDb().prepare('DELETE FROM inbox WHERE account_id=? AND uid=?').run(m.accountId, m.uid); } catch { /* 降级 */ }
  }
  mails.splice(index, 1);
  _writeCache(mails);
}

function removeMatchedContact(mailIndex, email) {
  const mails = _readCache();
  const m = mails[mailIndex];
  if (!m) return;
  const before = m.matchedContacts?.length || 0;
  if (m.matchedContacts) {
    m.matchedContacts = m.matchedContacts.filter(c => c.email.toLowerCase() !== email.toLowerCase());
  }
  // ponytail: 如果删的是发件人本身的匹配，同步清除 contactCompany
  if (m.from && m.from.toLowerCase() === (email || '').toLowerCase()) {
    m.contactCompany = '';
    m.contactId = '';
    m.contactDbId = '';
  }
  _writeCache(mails);
  Log.info('[收件箱]', `removeMatchedContact[${mailIndex}] ${email}: ${before}→${m.matchedContacts?.length || 0}条`);
}

function removeMatchedContactsBatch(items) {
  if (!items || !items.length) return;
  const mails = _readCache();
  for (const { mailIdx, email } of items) {
    const m = mails[mailIdx];
    if (!m) continue;
    const lower = (email || '').toLowerCase();
    if (m.matchedContacts) {
      const before = m.matchedContacts.length;
      m.matchedContacts = m.matchedContacts.filter(c => (c.email || '').toLowerCase() !== lower);
      Log.info('[收件箱]', `removeMatched[${mailIdx}] ${email}: ${before}→${m.matchedContacts.length}条`);
    }
    // ponytail: 如果删的是发件人本身的匹配，同步清除 contactCompany
    if (m.from && m.from.toLowerCase() === lower) {
      m.contactCompany = '';
      m.contactId = '';
      m.contactDbId = '';
    }
  }
  _writeCache(mails);
}

module.exports = { fetchInbox, listInbox, getBody, markProcessed, linkContact, deleteMail, removeMatchedContact, removeMatchedContactsBatch, getBounceCount, toggleImportant, toggleImportantByKey, setMailType, _migrateInboxFromJson };
