// ── 联系人持久化存储 + IPC 处理器 ──────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');
const { Log } = require("./core/logger");
const { classifyClient, markSuspicious, EMAIL_RE } = require('./classify-client');
const { getCompanyMeta, deleteCompanyMeta, resolveCompanyId, buildIndexFromContacts } = require('./services/company-store');
const { splitName: _splitName, normalizeCountry: _normalizeCountry } = require('./services/contacts-service');

function register(ipcMain, deps) {
  const contactsPath = path.join(APP_ROOT, 'data', 'contacts.json'); // 保留兼容旧引用
  const db = require('./services/contacts-db');

  // ponytail: SQLite 替代 JSON，不再需要缓存和手动写盘
  function readContacts() {
    return db.listAll();
  }

  function writeContacts(contacts, caller) {
    // SQLite 模式下 writeContacts 仅用于批量覆盖场景（如导入后全量替换）
    // 日常增删改走 db.upsert / db.update / db.remove
    Log.info('[DB]', `${caller}: 批量写入 ${contacts.length} 条`);
    for (const c of contacts) {
      try { db.upsert(c); } catch (e) { Log.warn('[DB]', `写入失败: ${c.email}`, e.stack); }
    }
  }



  ipcMain.handle('contacts:list', async () => {
    // ponytail: SQLite 迁移已完成，旧 JSON 清理逻辑不再需要
    return readContacts();
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
        existingContact.assignee = c.assignee || existingContact.assignee || '';
        existingContact.contactPerson = c.contactPerson || existingContact.contactPerson || '';
        if (c.stage && c.stage !== (existingContact.stage || 'cold')) db.setStage(existingContact.id, c.stage, 'manual:import');
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
          assignee: c.assignee || '', contactPerson: c.contactPerson || '',
          stage: c.stage || 'cold',
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
      _logDeletion(target.email, target.company);
    }
    contacts = contacts.filter(c => c.id !== id);
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true };
  });

  // 批量删除（一次读盘写盘）
  ipcMain.handle('contacts:deleteMany', async (_e, ids) => {
    contactsCache = null;
    const idSet = new Set(ids || []);
    let contacts = readContacts();
    const toDelete = contacts.filter(c => idSet.has(c.id));
    for (const target of toDelete) {
      if (target.company && target.email) {
        removeFromSendHistory(target.company, [target.email]);
        _logDeletion(target.email, target.company);
      }
    }
    contacts = contacts.filter(c => !idSet.has(c.id));
    writeContacts(contacts, 'contacts-ipc');
    return { ok: true, deleted: toDelete.length };
  });

  function _logDeletion(email, company) {
    const delLogPath = path.join(APP_ROOT, 'data', 'deleted-contacts.json');
    try {
      let delLog = [];
      if (fs.existsSync(delLogPath)) delLog = JSON.parse(fs.readFileSync(delLogPath, 'utf-8'));
      const cutoff = Date.now() - 5 * 86400000;
      delLog = delLog.filter(e => e.ts > cutoff);
      delLog.push({ email, company, ts: Date.now() });
      fs.writeFileSync(delLogPath, JSON.stringify(delLog));
    } catch { /* 静默 */ }
  }

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
    const existing = db.getByEmail(email);
    if (existing) db.update(existing.id, { is_bounced: true, bounce_type: bounceData.type || 'unknown', bounce_reason: bounceData.reason || '', bounced_at: new Date().toISOString() });
    return { ok: true };
  });

  ipcMain.handle('contacts:clearBounce', async (_e, email) => {
    const existing = db.getByEmail(email);
    if (existing) db.update(existing.id, { is_bounced: false, bounce_type: '', bounce_reason: '', bounced_at: '' });
    return { ok: true };
  });

  // 旧 API：单值标签（向后兼容）
  ipcMain.handle('contacts:setTag', async (_e, id, tag) => {
    if (tag) db.addTag(id, tag); else { const c = db.getById(id); if (c) db.update(id, { tags: [] }); }
    return { ok: true };
  });

  // 多标签设置（新 API）
  ipcMain.handle('contacts:setTags', async (_e, id, tags) => {
    const c = db.getById(id);
    if (!c) return { ok: false, error: '联系人不存在' };
    const arr = Array.isArray(tags) ? tags : [];
    const old = c.tags || [];
    for (const t of old) { if (!arr.includes(t)) db.removeTag(id, t); }
    for (const t of arr) { if (!old.includes(t)) db.addTag(id, t); }
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
    const result = await require('./services/contacts-service').classifyUnlabeled(apiKey);
    if (result.updated > 0) deps.mainWindow?.webContents.send('contacts:changed');
    return result;
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

  ipcMain.handle('companies:update', async (_e, id, data) => {
    try {
      const cdb = require('./services/contacts-db');
      const db = require('./services/db').getDb();
      db.prepare('UPDATE companies SET country=?, updated_at=? WHERE id=?').run(data.country||'', new Date().toISOString(), id);
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
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
