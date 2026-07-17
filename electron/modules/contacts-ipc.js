// ── 联系人持久化存储 + IPC 处理器 ──────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');
const { Log } = require("./core/logger");
const { classifyClient, markSuspicious, normalizeClientType, EMAIL_RE } = require('./classify-client');
const { getCompanyMeta, deleteCompanyMeta, resolveCompanyId, buildIndexFromContacts } = require('./services/company-store');
const { splitName: _splitName, normalizeCountry: _normalizeCountry } = require('./services/contacts-service');

function register(ipcMain, deps) {
  const contactsPath = path.join(APP_ROOT, 'data', 'contacts.json'); // 保留兼容旧引用
  const db = require('./services/contacts-db');

  // 通知渲染进程联系人数据已变更
  function _notify() {
    try { deps.mainWindow?.webContents.send('contacts:changed'); } catch { /* 窗口已关闭 */ }
  }

  // ponytail: SQLite 替代 JSON，不再需要缓存和手动写盘
  function readContacts() {
    return db.listAll();
  }

  function writeContacts(contacts, caller) {
    // SQLite 模式下 writeContacts 用于批量导入场景
    // 日常增删改用 db.upsert / db.update / db.remove
    let ok = 0, fail = 0;
    for (const c of contacts) {
      try { db.upsert(c); ok++; } catch (e) {
        fail++;
        if (fail === 1) Log.error('[DB]', `首条失败样例: ${c.email} | 错误: ${e.message}`, e.stack);
      }
    }
    Log.info('[DB]', `${caller}: 批量写入 ${contacts.length} 条, 成功${ok}, 失败${fail}`);
    return { ok, fail };
  }



  ipcMain.handle('contacts:list', async () => {
    // ponytail: SQLite 迁移已完成，旧 JSON 清理逻辑不再需要
    return readContacts();
  });

  ipcMain.handle('contacts:import', async (_e, clients) => {
    contactsCache = null;
    const existing = readContacts();
    // email 为唯一去重键（对齐 HubSpot 标准）
    const emailIndex = new Map();
    for (const c of existing) {
      if (c.email) emailIndex.set(c.email.toLowerCase().trim(), c);
    }
    let added = 0, updated = 0, skipped = 0, invalidEmail = 0, noEmailImported = 0;
    const invalidEmails = [];
    for (const c of clients) {
      if (!c.company && !c.email) { skipped++; continue; }
      const cleanEmail = (c.email || '').trim();

      // 空邮箱 → 生成占位符入库，标记 no_email
      if (!cleanEmail) {
        const placeholder = `--${noEmailImported + 1}@no.email`;
        const { company, _suspicious } = markSuspicious(c.company);
        const { companyId } = resolveCompanyId(company);
        existing.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          company, companyId, country: c.country || '', category: c.category || '',
          email: placeholder, website: c.website || '', linkedin: c.linkedin || '',
          firstName: c.firstName || '', lastName: c.lastName || '',
          contactName: c.contactName || '', position: c.position || '', phone: c.phone || '',
          clientType: normalizeClientType(c.clientType || c.client_type) || classifyClient(c.company || '', c.category || ''), assignee: c.assignee || '', contactPerson: c.contactPerson || '',
          stage: c.stage || 'cold', tags: [], _suspicious: 1, _extra: c._extra || {}, addedAt: new Date().toISOString(),
        });
        emailIndex.set(placeholder.toLowerCase(), existing[existing.length - 1]);
        noEmailImported++;
        continue;
      }

      // 格式异常邮箱 → 保留原文入库，标记 invalid_email
      if (!EMAIL_RE.test(cleanEmail)) {
        invalidEmail++;
        invalidEmails.push({ company: c.company || '未知', email: cleanEmail });
        const { company, _suspicious } = markSuspicious(c.company);
        const { companyId } = resolveCompanyId(company);
        existing.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          company, companyId, country: c.country || '', category: c.category || '',
          email: cleanEmail, website: c.website || '', linkedin: c.linkedin || '',
          firstName: c.firstName || '', lastName: c.lastName || '',
          contactName: c.contactName || '', position: c.position || '', phone: c.phone || '',
          clientType: normalizeClientType(c.clientType || c.client_type) || classifyClient(c.company || '', c.category || ''), assignee: c.assignee || '', contactPerson: c.contactPerson || '',
          stage: c.stage || 'cold', tags: [], _suspicious: 1, _extra: c._extra || {}, addedAt: new Date().toISOString(),
        });
        emailIndex.set(cleanEmail.toLowerCase(), existing[existing.length - 1]);
        continue;
      }
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
        // 仅当手动指定 clientType 时覆盖（先规范化中文/多语标签）
        const normCT = normalizeClientType(c.clientType || c.client_type);
        if (normCT && normCT !== 'unlabeled') {
          existingContact.clientType = normCT;
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
          clientType: normalizeClientType(c.clientType || c.client_type) || classifyClient(c.company, c.category),
          assignee: c.assignee || '', contactPerson: c.contactPerson || '',
          stage: c.stage || 'cold',
          tags: [],  // 新联系人默认空标签
          _suspicious, _extra: c._extra || {}, addedAt: new Date().toISOString(),
        });
        emailIndex.set(cleanEmail.toLowerCase(), existing[existing.length - 1]);
        added++;
      }
    }
    const wr = writeContacts(existing, 'contacts-ipc');
    const writeFailed = wr.fail || 0;
    Log.info("联系人", `导入: +${added} 新增, ${updated} 表内重复合并, ${skipped} 跳过, ${invalidEmail} 异常邮箱, ${noEmailImported} 无邮箱, ${writeFailed} 写入失败, 总计${existing.length - writeFailed}`);
    return { total: existing.length - writeFailed, added: added - writeFailed, updated, skipped, invalidEmail, invalidEmails, noEmailImported, writeFailed };
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
    const target = readContacts().find(c => c.id === id);
    if (target?.company && target?.email) {
      removeFromSendHistory(target.company, [target.email]);
    }
    db.remove(id);
    _notify();
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteMany', async (_e, ids) => {
    const idSet = new Set(ids || []);
    const toDelete = readContacts().filter(c => idSet.has(c.id));
    for (const target of toDelete) {
      if (target.company && target.email) {
        removeFromSendHistory(target.company, [target.email]);
      }
    }
    db.removeMany([...idSet]);
    _notify();
    return { ok: true, deleted: toDelete.length };
  });

  ipcMain.handle('contacts:deleteAll', async () => {
    Log.warn("联系人", "全部清除 — 开始");
    const { getDb } = require('./services/db');
    const db = getDb();

    // ── 1. SQLite 全表清空 ──
    db.pragma("foreign_keys = OFF");
    const tables = ['contacts', 'opportunities', 'companies', 'interactions', 'send_log', 'inbox'];
    for (const t of tables) {
      try { db.exec(`DELETE FROM ${t}`); } catch { /* 表可能不存在 */ }
    }
    db.pragma("foreign_keys = ON");

    // ── 2. JSON 文件删除（联系人相关） ──
    const dataDir = path.join(APP_ROOT, 'data');
    const sendDir = path.join(APP_ROOT, 'send');
    const deleteFiles = [
      // 联系人核心
      'contacts.json',
      'send-history.json',
      'backcheck-status.json',
      'company-meta.json',
      'companies.json',
      // 发送相关
      'send-queue.json',
      'send-bodies.json',
      'send-state.json',
      'email-queue.json',
      'template-overrides.json',
      // 退信/背调
      'bounce-check-cursor.json',
      'bounce-log.json',
      'dash-bounce-count.json',
      // 收件箱（重置游标+缓存+删除记录）
      'inbox-cursor.json',
      'inbox-deleted.json',
      'inbox-cache.json',
      // 测试数据库
      '_test_prospector.db',
    ];
    let deletedCount = 0;
    for (const f of deleteFiles) {
      const fp = path.join(dataDir, f);
      try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); deletedCount++; } } catch { /* 跳过 */ }
    }
    // send/ 目录下的日志文件
    const sendFiles = ['send-log.json', 'send-log-test.json', 'send-batch.json', 'session-log.json'];
    for (const f of sendFiles) {
      const fp = path.join(sendDir, f);
      try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); deletedCount++; } } catch { /* 跳过 */ }
    }
    // 清理旧备份文件
    try {
      const dataFiles = fs.readdirSync(dataDir);
      for (const f of dataFiles) {
        if (f.startsWith('contacts.bak')) {
          try { fs.unlinkSync(path.join(dataDir, f)); deletedCount++; } catch { /* 跳过 */ }
        }
      }
    } catch { /* 跳过 */ }

    // ── 3. 通知渲染进程清空 localStorage ──
    try {
      deps.mainWindow?.webContents.send('contacts:cleared');
    } catch { /* 降级 */ }

    Log.warn("联系人", `全部清除 — 完成: ${tables.length}表 + ${deletedCount}文件`);
    return { ok: true, deletedFiles: deletedCount };
  });

  ipcMain.handle('contacts:deleteCompany', async (_e, company) => {
    const contacts = readContacts();
    const targets = contacts.filter(c => c.company === company);
    const deleted = targets.length;
    const emails = targets.map(c => c.email).filter(Boolean);
    // ponytail: SQLite 模式用 db.remove 真删，writeContacts（upsert）不会删
    db.removeMany(targets.map(c => c.id).filter(Boolean));
    // 无论有无联系人，都删掉 companies 表中的公司记录
    try {
      const { getDb } = require('./services/db');
      getDb().prepare("DELETE FROM companies WHERE name = ?").run(company);
    } catch { /* 降级 */ }

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

    Log.info("联系人", `删除公司: ${company}, ${deleted}人`);
    return { ok: true, deleted };
  });

  ipcMain.handle('contacts:updateBounce', async (_e, email, bounceData) => {
    const existing = db.getByEmail(email);
    if (existing) db.update(existing.id, { is_bounced: true, bounce_type: bounceData.type || 'unknown', bounce_reason: bounceData.reason || '', bounced_at: new Date().toISOString() });
    if (existing) _notify();
    return { ok: true };
  });

  ipcMain.handle('contacts:clearBounce', async (_e, email) => {
    const existing = db.getByEmail(email);
    if (existing) db.update(existing.id, { is_bounced: false, bounce_type: '', bounce_reason: '', bounced_at: '' });
    if (existing) _notify();
    return { ok: true };
  });

  // 旧 API：单值标签（向后兼容）
  ipcMain.handle('contacts:setTag', async (_e, id, tag) => {
    if (tag) db.addTag(id, tag); else { const c = db.getById(id); if (c) db.update(id, { tags: [] }); }
    _notify();
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
    _notify();
    return { ok: true };
  });

  ipcMain.handle('contacts:search', async (_e, query) => {
    return db.search(query);
  });

  ipcMain.handle('contacts:updateCountry', async (_e, companyName, newCountry) => {
    // ponytail: country 存在 companies 表，非 contacts 表
    const { getDb } = require('./services/db');
    const result = getDb().prepare("UPDATE companies SET country = ?, updated_at = ? WHERE name = ?")
      .run(newCountry, new Date().toISOString(), companyName.trim());
    _notify();
    return { ok: true, updated: result.changes };
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
    const contact = db.getById(contactId);
    if (!contact) return { ok: false, error: '联系人不存在' };
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = `[${ts}] ${text.trim()}`;
    const prev = (contact.followup_note || '').trim();
    const updated = prev ? prev + '\n' + entry : entry;
    db.update(contactId, { followup_note: updated });
    return { ok: true, text: updated };
  });
  ipcMain.handle('contacts:getFollowups', async (_e, contactId) => {
    const contact = db.getById(contactId);
    return (contact?.followup_note || '').split('\n').filter(Boolean);
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
    const email = (contact.email || '').toLowerCase().trim();
    if (!email || !EMAIL_RE.test(contact.email)) return { ok: false, error: '无效邮箱' };

    const existing = db.getByEmail(email);
    // 预处理：名称拆分 + 公司解析
    if (!contact.firstName && !contact.lastName && contact.contactName) {
      const split = _splitName(contact.contactName);
      contact.firstName = split.firstName;
      contact.lastName = split.lastName;
    }
    if (contact.company) {
      const { company, _suspicious } = markSuspicious(contact.company);
      contact.company = company;
      contact._suspicious = _suspicious;
    }
    // ponytail: 渲染层可能传 client_type（snake_case）或 clientType（camelCase），两者都检查
    const ct = contact.clientType || contact.client_type;
    if (!ct || ct === 'unlabeled') {
      contact.clientType = classifyClient(contact.company || '', contact.category || '');
    } else {
      contact.clientType = ct; // 统一到 camelCase，避免 update() 中双重 key 覆盖
    }

    // ponytail: 直接调 db.upsert，由 SQLite 处理去重和字段映射
    const result = db.upsert(contact);
    _notify();
    return { ok: true, action: existing ? 'updated' : 'created', contact: result };
  });

  // ── 备注 ──
  ipcMain.handle('contacts:listNotes', async (_e, contactId) => {
    return db.listNotes(contactId);
  });
  ipcMain.handle('contacts:addNote', async (_e, contactId, content) => {
    const note = db.addNote(contactId, content);
    if (!note) return { ok: false, error: '内容为空' };
    return { ok: true, data: note };
  });
  ipcMain.handle('contacts:deleteNote', async (_e, noteId) => {
    db.deleteNote(noteId);
    return { ok: true };
  });

  // 暴露内部方法给其他模块使用
  return { readContacts, writeContacts: (c) => writeContacts(c, 'external'), contactsPath };
}

module.exports = { register };
