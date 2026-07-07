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
    auto_reply: ['automatic reply','auto-reply','auto reply','out of office','out of the office','vacation','vacaciones','feriado','holiday notice','ooo -','[ooo]','ausente','ausência','fuera de la oficina','fora do escritório','respuesta automática','resposta automática','away from office','no estaré','estare ausente','estoy fuera','licença maternidade','maternity leave','acceso limitado'],
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
          id: c.id || '', company: c.company || '', companyId: c.companyId || '',
          contactName: c.contactName || '', firstName: c.firstName || '', lastName: c.lastName || '',
          clientType: c.clientType || '', tags: c.tags || [],
        };
      }
    }
  } catch { /* 联系人文件损坏 → 空索引 */ }
  _contactsIndexTime = Date.now();
  return _contactsIndex;
}

function _matchContact(fromEmail, fromName) {
  const idx = _buildContactsIndex();
  const emailMatch = idx[(fromEmail || '').toLowerCase().trim()];
  if (emailMatch) return emailMatch;
  // ponytail: 邮箱没匹配到时，尝试姓名匹配（O(n) 遍历，仅在邮箱失配时触发）
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

// ── 从正文提取邮箱 → 匹配联系人 ───────────────────────────────────────────
function _extractBodyContacts(plainText, htmlText, extraText) {
  const idx = _buildContactsIndex();
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

// ── 缓存读写 ──────────────────────────────────────────────────────────────────
function _readCache() {
  try { return fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) : []; }
  catch { return []; }
}
function _writeCache(mails) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // ponytail: 保留重要邮件，其余最多 500 封
  const important = mails.filter(m => m.important);
  const rest = mails.filter(m => !m.important).slice(-500);
  fs.writeFileSync(CACHE_PATH, JSON.stringify([...important, ...rest]));
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
  fs.writeFileSync(DELETED_PATH, JSON.stringify(arr));
}
function _readCursor() {
  try { return fs.existsSync(CURSOR_PATH) ? JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}
function _writeCursor(data) {
  const dir = path.dirname(CURSOR_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(data));
}

// ── 标签同步：收件箱分类 → 联系人 tags ──────────────────────────────────
function _syncTagsToContacts(newMails) {
  const TYPE_TAG = { bounce: 'bounced_by_contact', reply: 'replied', 'auto-reply': 'autoreply' };
  const updates = {}; // contactDbId → tag
  for (const m of newMails) {
    const tag = TYPE_TAG[m.type];
    if (!tag || !m.contactDbId) continue;
    if (!m.contactTags.includes(tag)) updates[m.contactDbId] = tag;
  }
  if (!Object.keys(updates).length) return;
  try {
    const cp = path.join(APP_ROOT, 'data', 'contacts.json');
    if (!fs.existsSync(cp)) return;
    // ponytail: 读取 → 修改 → 原子写入，始终基于盘上最新版本
    const onDisk = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    let synced = 0;
    for (const c of onDisk) {
      const tag = updates[c.id];
      if (tag) {
        c.tags = c.tags || [];
        if (!c.tags.includes(tag)) { c.tags.push(tag); synced++; }
      }
    }
    if (synced > 0) {
      const tmp = cp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(onDisk));
      fs.renameSync(tmp, cp);
      Log.info('[写盘]', `收件箱标签 → ${cp} (agent=${onDisk.filter(c=>c.clientType==='agent').length})`);
      Log.info('[收件箱]', `标签同步: ${synced} 个联系人`);
    }
  } catch (e) { Log.error('[收件箱]', '标签同步失败', e.stack); }
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
    const type = _classify(subject, fromAddr, bodySnippet);
    const contact = _matchContact(fromAddr, fromName);
    // 正文中提取邮箱 → 匹配联系人
    // 退信邮件额外扫原始来源（MIME 头中可能含被退回的邮箱）
    const extraText = type === 'bounce' ? (typeof rawSource === 'string' ? rawSource : Buffer.from(rawSource).toString('utf-8')) : '';
    const matchedContacts = _extractBodyContacts(parsed.text || '', parsed.html || '', extraText);
    if (type === 'bounce') {
      Log.info('[收件箱]', `退信提取: parsed.text=${(parsed.text||'').length}字 html=${(parsed.html||'').length}字 raw=${extraText.length}字 → 找到${matchedContacts.length}个邮箱`);
    }
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
          const toFetch = results.slice(-30);
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
      .slice(0, 30);
    // ponytail: 有游标说明不是第一次拉，没新邮件直接返回
    if (!ids.length) {
      if (lastUid) { sock.write('QUIT\r\n'); sock.end(); return rawSources; }
      ids = Object.keys(uidMap).map(Number).sort((a, b) => b - a).slice(0, 30);
    }
    let newUid = lastUid;
    for (const n of ids) {
      try {
        const raw = await _pop3Cmd(sock, `RETR ${n}`);
        raw._pop3Seq = String(n);
        rawSources.push(raw);
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
        rawSources = await _imapFetch(cfg, 2);
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

  // 同步分类标签到联系人表 + 退信计数
  if (newMails.length) {
    _syncTagsToContacts(newMails);
    const bounceN = newMails.filter(m => m.type === 'bounce').length;
    if (bounceN > 0) _incrementBounceCount(bounceN);
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
  return _readCache();
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

function removeMatchedContact(mailIndex, email) {
  const mails = _readCache();
  if (mails[mailIndex]?.matchedContacts) {
    mails[mailIndex].matchedContacts = mails[mailIndex].matchedContacts.filter(c => c.email !== email);
    _writeCache(mails);
  }
}

function syncAllTags() {
  const mails = _readCache();
  if (!mails.length) return { ok: true, synced: 0, message: '缓存为空' };
  _syncTagsToContacts(mails);
  return { ok: true, synced: 1, message: `已扫描 ${mails.length} 封缓存邮件` };
}

module.exports = { fetchInbox, listInbox, getBody, markProcessed, linkContact, deleteMail, removeMatchedContact, syncAllTags, getBounceCount, toggleImportant };
