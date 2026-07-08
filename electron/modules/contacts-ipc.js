// ── 联系人持久化存储 + IPC 处理器 ──────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');
const { Log } = require("./core/logger");
const { classifyClient, markSuspicious, EMAIL_RE } = require('./classify-client');
const { getCompanyMeta, deleteCompanyMeta, resolveCompanyId, buildIndexFromContacts } = require('./services/company-store');

// ── 标签迁移状态（一次写入后标记，避免每次 contacts:list 都扫描）─────────
let _tagsMigrated = false;

// 预定义标签（contacts:setTags 可传的合法值）
const PREDEFINED_TAGS = ['autoreply', 'reached', 'replied', 'bounced_by_contact'];

/** 智能拆分全名为 firstName + lastName */
function _splitName(fullName) {
  if (!fullName || !fullName.trim()) return { firstName: '', lastName: '' };
  // 移除括号内备注（如 "Michel Braverman (director de marketing)"）
  const cleaned = fullName.replace(/\(.*?\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) {
    // 单字/无空格（中文名等）→ 全放 firstName
    return { firstName: parts[0], lastName: '' };
  }
  // 首段 = firstName，末段 = lastName
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/**
 * 删除旧 tag 单值字段（一次迁移，标记后不再扫描）
 * 调用时机：contacts:list 首次发现 tag 字段时
 */
function _cleanupTagField(contacts) {
  if (_tagsMigrated) return false;
  let changed = false;
  for (const c of contacts) {
    if (typeof c.tag === 'string') {
      if (c.tag && !Array.isArray(c.tags)) c.tags = [c.tag];
      if (c.tag && Array.isArray(c.tags) && !c.tags.includes(c.tag)) c.tags.push(c.tag);
      delete c.tag;
      changed = true;
    }
  }
  _tagsMigrated = true; // 无论是否有残留 tag，扫过一次就标记完成
  return changed;
}

function register(ipcMain, deps) {
  const contactsPath = path.join(APP_ROOT, 'data', 'contacts.json');
  let contactsCache = null;
  let _writeQueue = Promise.resolve(); // 写入队列，串行化所有写操作

  function readContacts() {
    if (contactsCache) return contactsCache;
    try {
      if (fs.existsSync(contactsPath)) {
        contactsCache = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        return contactsCache;
      }
    } catch (e) { Log.error('联系人', '读取 contacts.json 失败', e.stack); }
    return [];
  }

  function writeContacts(contacts, caller) {
    // ponytail: 写入前重读磁盘，合并保留并发写入 + 正确删除 + 正确新增
    try {
      if (fs.existsSync(contactsPath)) {
        const onDisk = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        const idMap = new Map(contacts.map(c => [c.id, c]));
        const keepIds = new Set(contacts.map(c => c.id));
        // 更新已存在的，保留被删除的
        const merged = onDisk.filter(c => keepIds.has(c.id));
        for (const c of merged) {
          const incoming = idMap.get(c.id);
          if (incoming) Object.assign(c, incoming);
        }
        // 添加盘上没有的新联系人
        const onDiskIds = new Set(onDisk.map(c => c.id));
        for (const c of contacts) {
          if (!onDiskIds.has(c.id)) merged.push(c);
        }
        contacts = merged;
      }
    } catch { /* 读盘失败用传入数据 */ }
    Log.info('[写盘]', `${caller} → ${contactsPath} (${contacts.length}条, agent=${contacts.filter(c=>c.clientType==='agent').length})`);
    contactsCache = contacts;
    try {
      const dir = path.dirname(contactsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 原子写入：先写临时文件，再 rename
      const tmp = contactsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(contacts, null, 2));
      // 备份轮转
      const bakBase = contactsPath.replace('.json', '.bak');
      for (let i = 2; i >= 0; i--) {
        const src = i === 0 ? contactsPath : `${bakBase}${i}`;
        const dst = `${bakBase}${i + 1}`;
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, dst); } catch { /* 备份轮转失败不阻塞写入 */ }
        }
      }
      fs.renameSync(tmp, contactsPath);
    } finally { /* noop */ }
  }

  // ── 国家名标准化映射（中文/西语 → 英文）──────────────────────────────
  function _normalizeCountry(raw) {
    if (!raw || !raw.trim()) return '';
    const m = {
      '巴西':'Brazil','brasil':'Brazil',
      '葡萄牙':'Portugal',
      '安哥拉':'Angola',
      '莫桑比克':'Mozambique','moçambique':'Mozambique',
      '佛得角':'Cape Verde','cabo verde':'Cape Verde',
      '几内亚比绍':'Guinea-Bissau','guiné-bissau':'Guinea-Bissau','guine-bissau':'Guinea-Bissau',
      '圣多美':'São Tomé','são tomé':'São Tomé','sao tome':'São Tomé',
      '东帝汶':'East Timor','timor-leste':'East Timor',
      '墨西哥':'Mexico','méxico':'Mexico',
      '哥伦比亚':'Colombia',
      '智利':'Chile',
      '秘鲁':'Peru','perú':'Peru',
      '阿根廷':'Argentina',
      '厄瓜多尔':'Ecuador',
      '玻利维亚':'Bolivia',
      '巴拉圭':'Paraguay',
      '乌拉圭':'Uruguay',
      '巴拿马':'Panama','panamá':'Panama',
      '哥斯达黎加':'Costa Rica',
      '委内瑞拉':'Venezuela',
      '危地马拉':'Guatemala',
      '洪都拉斯':'Honduras',
      '萨尔瓦多':'El Salvador',
      '尼加拉瓜':'Nicaragua',
      '多米尼加':'Dominican Republic',
      '古巴':'Cuba',
      '波多黎各':'Puerto Rico',
      '美国':'United States','usa':'United States','us':'United States',
      '英国':'United Kingdom','uk':'United Kingdom','england':'United Kingdom',
      '加拿大':'Canada',
      '澳大利亚':'Australia',
      '新西兰':'New Zealand',
      '德国':'Germany','deutschland':'Germany',
      '法国':'France',
      '意大利':'Italy','italia':'Italy',
      '西班牙':'Spain','españa':'Spain',
      '荷兰':'Netherlands','holland':'Netherlands',
      '比利时':'Belgium',
      '日本':'Japan',
      '韩国':'South Korea','korea':'South Korea',
      '中国':'China',
      '印度':'India',
      '新加坡':'Singapore',
      '阿联酋':'UAE','迪拜':'UAE','dubai':'UAE',
    };
    const key = raw.trim();
    // 精确匹配优先
    if (m[key] !== undefined) return m[key];
    // 大小写不敏感
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(m)) {
      if (k.toLowerCase() === lower) return v;
    }
    return raw.trim();
  }

  ipcMain.handle('contacts:list', async () => {
    const contacts = readContacts();
    let changed = false;

    // 一次性迁移：删除旧 tag 字段 → tags 数组
    if (_cleanupTagField(contacts)) changed = true;

    for (const c of contacts) {
      // 旧数据迁移：contactName 自动拆分 firstName/lastName
      if (!c.firstName && !c.lastName && c.contactName) {
        const split = _splitName(c.contactName);
        c.firstName = split.firstName;
        c.lastName = split.lastName;
        changed = true;
      }

      // 旧数据迁移：无 companyId 的联系人自动分配
      if (!c.companyId && c.company) {
        const { companyId } = resolveCompanyId(c.company);
        if (companyId) { c.companyId = companyId; changed = true; }
      }

      // 国家名标准化：中文/西语 → 英文
      if (c.country) {
        const normalized = _normalizeCountry(c.country);
        if (normalized !== c.country) { c.country = normalized; changed = true; }
      }

      // 公司级元数据：手动设置了类型的公司，跳过自动分类
      const meta = getCompanyMeta(c.company);
      if (meta._manualType) {
        if (c.clientType !== meta.clientType) {
          c.clientType = meta.clientType;
          changed = true;
        }
      } else {
        const newType = classifyClient(c.company, c.category);
        if (c.clientType !== newType) {
          c.clientType = newType;
          changed = true;
        }
      }
    }
    if (changed) writeContacts(contacts, 'contacts-ipc');
    return contacts;
  });

  ipcMain.handle('contacts:import', async (_e, clients) => {
    contactsCache = null;
    const existing = readContacts();
    // 读取删除记录，5天内删除的邮箱跳过
    const delLogPath = path.join(APP_ROOT, 'data', 'deleted-contacts.json');
    let deletedEmails = new Set();
    try {
      if (fs.existsSync(delLogPath)) {
        const delLog = JSON.parse(fs.readFileSync(delLogPath, 'utf-8'));
        const cutoff = Date.now() - 5 * 86400000;
        for (const e of delLog) {
          if (e.ts > cutoff) deletedEmails.add(e.email.toLowerCase().trim());
        }
      }
    } catch { /* 静默 */ }
    // email 为唯一去重键（对齐 HubSpot 标准）
    const emailIndex = new Map();
    for (const c of existing) {
      if (c.email) emailIndex.set(c.email.toLowerCase().trim(), c);
    }
    let added = 0, updated = 0, skipped = 0, invalidEmail = 0;
    const invalidEmails = [];
    for (const c of clients) {
      if (!c.company && !c.email) { skipped++; continue; }
      const cleanEmail = (c.email || '').trim();
      if (!cleanEmail) { skipped++; continue; }
      if (!EMAIL_RE.test(cleanEmail)) { invalidEmail++; invalidEmails.push({ company: c.company || '未知', email: cleanEmail }); continue; }
      if (deletedEmails.has(cleanEmail.toLowerCase().trim())) { skipped++; continue; }
      // 国家名标准化
      if (c.country) c.country = _normalizeCountry(c.country);

      const existingContact = emailIndex.get(cleanEmail.toLowerCase());
      if (existingContact) {
        // 同 email → 更新已有记录
        if (c.company) {
          existingContact.company = c.company;
          // 公司名变了 → 重新解析 companyId（保留旧的如果规范化后相同）
          const { companyId } = resolveCompanyId(c.company);
          if (companyId) existingContact.companyId = companyId;
        }
        existingContact.country = c.country || existingContact.country;
        existingContact.category = c.category || existingContact.category;
        existingContact.website = c.website || existingContact.website;
        existingContact.linkedin = c.linkedin || existingContact.linkedin;
        existingContact.contactName = c.contactName || existingContact.contactName;
        existingContact.position = c.position || existingContact.position;
        existingContact.phone = c.phone || existingContact.phone;
        // firstName/lastName：优先用导入值，否则从 contactName 拆分填充
        if (c.firstName || c.lastName) {
          existingContact.firstName = c.firstName || existingContact.firstName || '';
          existingContact.lastName = c.lastName || existingContact.lastName || '';
        } else if (c.contactName && !existingContact.firstName && !existingContact.lastName) {
          const split = _splitName(c.contactName);
          existingContact.firstName = split.firstName;
          existingContact.lastName = split.lastName;
        }
        // 仅当手动指定 clientType 时覆盖
        if (c.clientType && c.clientType !== 'unlabeled') {
          existingContact.clientType = c.clientType;
        }
        if (!existingContact.firstName && !existingContact.lastName && existingContact.contactName) {
          const split = _splitName(existingContact.contactName);
          existingContact.firstName = split.firstName;
          existingContact.lastName = split.lastName;
        }
        updated++;
      } else {
        // 新联系人
        const { company, _suspicious } = markSuspicious(c.company);
        const { companyId } = resolveCompanyId(company);
        const split = (c.firstName || c.lastName) ? {} : _splitName(c.contactName || '');
        existing.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          company, companyId, country: c.country || '', category: c.category || '',
          email: cleanEmail, website: c.website || '', linkedin: c.linkedin || '',
          firstName: c.firstName || split.firstName || '',
          lastName: c.lastName || split.lastName || '',
          contactName: c.contactName || '', position: c.position || '', phone: c.phone || '',
          clientType: c.clientType || classifyClient(c.company, c.category),
          tags: [],  // 新联系人默认空标签
          _suspicious, addedAt: new Date().toISOString(),
        });
        emailIndex.set(cleanEmail.toLowerCase(), existing[existing.length - 1]);
        added++;
      }
    }
    writeContacts(existing);
    Log.info("联系人", "导入: +" + added + " 新增, " + updated + " 更新, " + skipped + " 跳过(无邮箱), " + invalidEmail + " 无效邮箱, 总计" + existing.length);
    return { total: existing.length, added, updated, skipped, invalidEmail, invalidEmails };
  });

  // 清理 send-history 中指定公司的联系人
  function removeFromSendHistory(company, emails) {
    const shp = path.join(APP_ROOT, 'data', 'send-history.json');
    try {
      if (!fs.existsSync(shp)) return;
      let sh = JSON.parse(fs.readFileSync(shp, 'utf-8'));
      if (sh[company]?.sentContacts && emails) {
        const set = new Set(emails.map(e => e.toLowerCase().trim()));
        sh[company].sentContacts = sh[company].sentContacts.filter(e => !set.has((e || '').toLowerCase().trim()));
        if (!sh[company].sentContacts.length) delete sh[company].sentContacts;
      }
      fs.writeFileSync(shp, JSON.stringify(sh, null, 2));
    } catch (e) { Log.error('联系人', '删除公司后更新发送历史失败', e.stack); }
  }

  ipcMain.handle('contacts:delete', async (_e, id) => {
    contactsCache = null;
    let contacts = readContacts();
    const target = contacts.find(c => c.id === id);
    if (target?.company && target?.email) {
      removeFromSendHistory(target.company, [target.email]);
      // 记录删除日志（5天保留）
      const delLogPath = path.join(APP_ROOT, 'data', 'deleted-contacts.json');
      try {
        let delLog = [];
        if (fs.existsSync(delLogPath)) delLog = JSON.parse(fs.readFileSync(delLogPath, 'utf-8'));
        const cutoff = Date.now() - 5 * 86400000;
        delLog = delLog.filter(e => e.ts > cutoff);
        delLog.push({ email: target.email, company: target.company, ts: Date.now() });
        fs.writeFileSync(delLogPath, JSON.stringify(delLog));
      } catch { /* 删除日志写入失败不影响主流程 */ }
    }
    contacts = contacts.filter(c => c.id !== id);
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteAll', async () => {
    Log.warn("联系人", "全部清除");
    writeContacts([]);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteCompany', async (_e, company) => {
    contactsCache = null;
    let contacts = readContacts();
    const before = contacts.length;
    const targets = contacts.filter(c => c.company === company);
    const emails = targets.map(c => c.email).filter(Boolean);
    contacts = contacts.filter(c => c.company !== company);
    writeContacts(contacts, 'contacts-ipc');
    // 记录删除日志
    const delLogPath = path.join(APP_ROOT, 'data', 'deleted-contacts.json');
    try {
      let delLog = [];
      if (fs.existsSync(delLogPath)) delLog = JSON.parse(fs.readFileSync(delLogPath, 'utf-8'));
      const cutoff = Date.now() - 5 * 86400000;
      delLog = delLog.filter(e => e.ts > cutoff);
      for (const t of targets) {
        if (t.email) delLog.push({ email: t.email, company: t.company, ts: Date.now() });
      }
      fs.writeFileSync(delLogPath, JSON.stringify(delLog));
    } catch { /* 静默 */ }

    // 级联清理公司状态
    removeFromSendHistory(company, emails);
    deleteCompanyMeta(company);  // 清理公司元数据
    const bsp = path.join(APP_ROOT, 'data', 'backcheck-status.json');
    try {
      if (fs.existsSync(bsp)) {
        let bs = JSON.parse(fs.readFileSync(bsp, 'utf-8'));
        delete bs[company];
        // 同时清理 companyId 双写 key
        const { companyId } = require('./services/company-store').resolveCompanyId(company);
        if (companyId && companyId !== company) delete bs[companyId];
        fs.writeFileSync(bsp, JSON.stringify(bs, null, 2));
      }
    } catch (e) { Log.error('联系人', '删除公司后更新背调状态失败', e.stack); }

    Log.info("联系人", "删除公司: " + company + ", " + (before - contacts.length) + "人");
    return { ok: true, deleted: before - contacts.length };
  });

  ipcMain.handle('contacts:updateBounce', async (_e, email, bounceData) => {
    const contacts = readContacts();
    const key = (email || '').toLowerCase().trim();
    let updated = 0;
    for (const c of contacts) {
      if ((c.email || '').toLowerCase().trim() === key) {
        c.bounced = true;
        c.bounceType = bounceData.type || 'unknown';
        c.bounceReason = bounceData.reason || '';
        c.bouncedAt = c.bouncedAt || new Date().toISOString();
        updated++;
      }
    }
    if (updated) writeContacts(contacts, 'contacts-ipc');
    return { ok: true, updated };
  });

  ipcMain.handle('contacts:clearBounce', async (_e, email) => {
    const contacts = readContacts();
    const key = (email || '').toLowerCase().trim();
    for (const c of contacts) {
      if ((c.email || '').toLowerCase().trim() === key) {
        c.bounced = false; c.bounceType = ''; c.bounceReason = ''; c.bouncedAt = '';
      }
    }
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true };
  });

  // 旧 API：单值标签（向后兼容，内部转为数组）
  ipcMain.handle('contacts:setTag', async (_e, id, tag) => {
    contactsCache = null;
    const contacts = readContacts();
    const c = contacts.find(x => x.id === id);
    if (!c) return { ok: false, error: '联系人不存在' };
    const tagStr = tag || '';
    c.tags = tagStr ? [tagStr] : [];
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true };
  });

  // 多标签设置（新 API）
  ipcMain.handle('contacts:setTags', async (_e, id, tags) => {
    contactsCache = null;
    const contacts = readContacts();
    const c = contacts.find(x => x.id === id);
    if (!c) return { ok: false, error: '联系人不存在' };
    c.tags = Array.isArray(tags) ? [...tags] : [];
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true };
  });

  ipcMain.handle('contacts:search', async (_e, query) => {
    const contacts = readContacts();
    const q = query.toLowerCase();
    return contacts.filter(c =>
      c.company.toLowerCase().includes(q) ||
      (c.country || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
  });

  ipcMain.handle('contacts:updateCountry', async (_e, companyName, newCountry) => {
    const contacts = readContacts();
    let updated = 0;
    for (const c of contacts) {
      if ((c.company || '').trim() === companyName.trim()) {
        c.country = newCountry;
        updated++;
      }
    }
    if (updated > 0) writeContacts(contacts, 'contacts-ipc');
    return { ok: true, updated, total: contacts.filter(c => (c.company || '').trim() === companyName.trim()).length };
  });

  // 决策人深挖
  ipcMain.handle('contacts:deepSearch', async (_e, website, companyName) => {
    if (!website || !website.startsWith('http')) {
      return { ok: false, error: 'no_website', message: '该公司未填写官网' };
    }
    const linkedinClient = require('../linkedin-client');
    const searchName = companyName || '';

    const [linkedin1, linkedin2] = await Promise.all([
      linkedinClient.searchPeople(`${searchName} supply chain OR logistics OR procurement OR buyer`).catch(() => []),
      linkedinClient.searchPeople(`${searchName} compras OR importación OR importação OR comprador`).catch(() => []),
    ]);

    const seenNames = new Set();
    const linkedinPeople = [...linkedin1, ...linkedin2].filter(p => {
      const key = p.name.toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    const allPeople = [...linkedinPeople];
    const LOGISTICS_KW = ['supply chain', 'logistics', 'procurement', 'compras', 'buyer',
      'import', 'export', 'customs', 'shipping', 'freight', 'logística', 'adquisiciones',
      'importación', 'exportación', 'comprador', 'suprimentos', 'supply', 'purchasing', 'sourcing'];
    const EXECUTIVE_KW = ['ceo', 'president', 'director', 'general manager', 'vp ',
      'managing director', 'country manager', 'plant manager', 'director general',
      'gerente geral', 'presidente'];

    for (const p of allPeople) {
      const low = (p.title || '').toLowerCase();
      p.department = LOGISTICS_KW.some(kw => low.includes(kw)) ? 'logistics'
        : EXECUTIVE_KW.some(kw => low.includes(kw)) ? 'management' : 'other';
    }

    return {
      ok: true,
      company_info: {},
      people: allPeople,
      stats: {
        total: allPeople.length,
        logistics: allPeople.filter(p => p.department === 'logistics').length,
        management: allPeople.filter(p => p.department === 'management').length,

        from_linkedin: linkedinPeople.length,
      },
    };
  });

  // ── AI 客户分类 ──────────────────────────────────────────────────────────
  ipcMain.handle('contacts:classifyAI', async () => {
    const cfgPath = path.join(APP_ROOT, 'send', 'config.json');
    let apiKey = '';
    try { if (fs.existsSync(cfgPath)) { const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); apiKey = cfg.translate?.deepseek?.apiKey || ''; } } catch (e) { Log.error('[AI分类]', '读取配置失败', e.stack); }
    if (!apiKey) { Log.warn('[AI分类]', '缺少 DeepSeek API Key，跳过'); return { ok: false, error: '请先配置 DeepSeek API Key' }; }

    const { classifyClientAI } = require('./classify-client');
    const contacts = readContacts();
    const unlabeled = contacts.filter(c => c.clientType === 'unlabeled');
    if (!unlabeled.length) { Log.info('[AI分类]', '所有联系人已分类，无需 AI'); return { ok: true, updated: 0, message: '所有联系人已分类' }; }

    // ponytail: 按公司去重，同一家公司只调一次 AI，避免 1729 个联系人重复请求
    const companyMap = new Map(); // company → contacts
    for (const c of unlabeled) {
      const key = c.company || '';
      if (!companyMap.has(key)) companyMap.set(key, []);
      companyMap.get(key).push(c);
    }
    const companies = [...companyMap.keys()].slice(0, 20);
    Log.info('[AI分类]', `开始 AI 分类，未标签 ${unlabeled.length} 个联系人 × ${companies.length} 家公司（单次上限20）`);

    let updated = 0;
    try {
      for (const company of companies) {
        const members = companyMap.get(company);
        // ponytail: 限速保护，避免连续调用触发 DeepSeek 429
        await new Promise(r => setTimeout(r, 1000));
        const newType = await classifyClientAI(company, members[0]?.category || '', apiKey);
        if (newType !== 'unlabeled') {
          for (const c of members) {
            if (c.clientType !== newType) {
              c.clientType = newType;
              updated++;
            }
          }
          Log.info('[AI分类]', `${company} → ${newType}（${members.length}人）`);
        }
      }
    } catch (e) {
      if (e.message === 'DeepSeek_API_Key_Invalid') {
        return { ok: false, error: 'DeepSeek API Key 无效，请到设置页更新' };
      }
      throw e;
    }
    if (updated > 0) {
      Log.info('[AI分类]', `准备写入 ${updated} 条变更到 ${contactsPath}...`);
      writeContacts(contacts, 'AI分类');
      contactsCache = null; // 强制后续读取从磁盘加载
      const diskVerify = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
      const dvAgent = diskVerify.filter(c => c.clientType === 'agent').length;
      const dvDirect = diskVerify.filter(c => c.clientType === 'direct').length;
      Log.info('[AI分类]', `磁盘验证: ${dvAgent} agent, ${dvDirect} direct`);
    }
    Log.info('[AI分类]', `完成: ${updated} 人 / ${companies.length} 家公司重新分类`);
    if (updated > 0) deps.mainWindow?.webContents.send('contacts:changed');
    return { ok: true, updated, total: companies.length };
  });

  // ── 跟进备注 ──────────────────────────────────────────────────────────────
  ipcMain.handle('contacts:saveFollowup', async (_e, contactId, text) => {
    if (!text || !text.trim()) return { ok: false, error: '内容为空' };
    const contacts = readContacts();
    const c = contacts.find(x => x.id === contactId);
    if (!c) return { ok: false, error: '联系人不存在' };
    c.followups = c.followups || [];
    c.followups.push({ text: text.trim(), ts: Date.now() });
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true, followups: c.followups };
  });
  ipcMain.handle('contacts:getFollowups', async (_e, contactId) => {
    const contacts = readContacts();
    const c = contacts.find(x => x.id === contactId);
    return c?.followups || [];
  });

  // ── 读取删除记录 ──────────────────────────────────────────────────────────
  ipcMain.handle('contacts:deletedLog', async () => {
    const delLogPath = path.join(APP_ROOT, 'data', 'deleted-contacts.json');
    try {
      if (fs.existsSync(delLogPath)) {
        const log = JSON.parse(fs.readFileSync(delLogPath, 'utf-8'));
        const cutoff = Date.now() - 5 * 86400000;
        return log.filter(e => e.ts > cutoff).sort((a, b) => b.ts - a.ts);
      }
    } catch { /* 静默 */ }
    return [];
  });

  // ── 单个联系人 upsert（email 唯一）─────────────────────────────────────
  ipcMain.handle('contacts:upsert', async (_e, contact) => {
    contactsCache = null;
    const contacts = readContacts();
    const email = (contact.email || '').toLowerCase().trim();
    if (!email || !EMAIL_RE.test(contact.email)) {
      return { ok: false, error: '无效邮箱' };
    }

    const existing = contacts.find(c => (c.email || '').toLowerCase().trim() === email);
    if (existing) {
      // 更新已有记录
      if (contact.company) {
        existing.company = contact.company;
        const { companyId } = resolveCompanyId(contact.company);
        if (companyId) existing.companyId = companyId;
      }
      if (contact.country) existing.country = contact.country;
      if (contact.category) existing.category = contact.category;
      if (contact.website) existing.website = contact.website;
      if (contact.linkedin) existing.linkedin = contact.linkedin;
      if (contact.contactName) existing.contactName = contact.contactName;
      if (contact.position) existing.position = contact.position;
      if (contact.phone) existing.phone = contact.phone;
      if (contact.firstName) existing.firstName = contact.firstName;
      if (contact.lastName) existing.lastName = contact.lastName;
      if (contact.clientType && contact.clientType !== 'unlabeled') existing.clientType = contact.clientType;
      // 首次有 contactName 时自动拆分
      if ((contact.contactName || contact.firstName) && !existing.firstName && !existing.lastName) {
        const split = _splitName(contact.firstName
          ? `${contact.firstName} ${contact.lastName || ''}`.trim()
          : (contact.contactName || ''));
        existing.firstName = split.firstName;
        existing.lastName = split.lastName;
      }
      writeContacts(contacts, 'contacts-ipc');
      return { ok: true, action: 'updated', contact: existing };
    }

    // 新建
    const split = (contact.firstName || contact.lastName)
      ? {} : _splitName(contact.contactName || '');
    const { company, _suspicious } = markSuspicious(contact.company || '');
    const { companyId } = resolveCompanyId(company);
    const newContact = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      company, companyId, country: contact.country || '', category: contact.category || '',
      email: contact.email.trim(), website: contact.website || '', linkedin: contact.linkedin || '',
      firstName: contact.firstName || split.firstName || '',
      lastName: contact.lastName || split.lastName || '',
      contactName: contact.contactName || '', position: contact.position || '', phone: contact.phone || '',
      clientType: contact.clientType || classifyClient(company, contact.category),
      tags: [], tag: '',
      _suspicious, addedAt: new Date().toISOString(),
    };
    contacts.push(newContact);
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true, action: 'created', contact: newContact };
  });

  // 暴露内部方法给其他模块使用
  return { readContacts, writeContacts: (c) => writeContacts(c, 'external'), contactsPath };
}

module.exports = { register };
