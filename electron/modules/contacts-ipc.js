// ── 联系人持久化存储 + IPC 处理器 ──────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');
const { classifyClient, markSuspicious, EMAIL_RE } = require('./classify-client');
const { callScraplingAPI } = require('./scrapling');

function register(ipcMain, deps) {
  const contactsPath = path.join(APP_ROOT, 'data', 'contacts.json');
  let contactsCache = null;
  let contactsWriteLock = false;

  function readContacts() {
    if (contactsCache) return contactsCache;
    try {
      if (fs.existsSync(contactsPath)) {
        contactsCache = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        return contactsCache;
      }
    } catch {}
    return [];
  }

  function writeContacts(contacts) {
    contactsCache = contacts;
    contactsWriteLock = true;
    try {
      const dir = path.dirname(contactsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 自动备份：保留最近 3 份
      const bakBase = contactsPath.replace('.json', '.bak');
      for (let i = 2; i >= 0; i--) {
        const src = i === 0 ? contactsPath : `${bakBase}${i}`;
        const dst = `${bakBase}${i + 1}`;
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, dst); } catch {}
        }
      }
      fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
    } finally {
      contactsWriteLock = false;
    }
  }

  ipcMain.handle('contacts:list', async () => {
    const contacts = readContacts();
    let changed = false;
    for (const c of contacts) {
      const newType = classifyClient(c.company, c.category);
      if (c.clientType !== newType) {
        c.clientType = newType;
        changed = true;
      }
    }
    if (changed) writeContacts(contacts);
    return contacts;
  });

  ipcMain.handle('contacts:import', async (_e, clients) => {
    contactsCache = null;
    const existing = readContacts();
    const existingKeys = new Set(existing.map(c => `${c.company.toLowerCase()}||${(c.email || '').toLowerCase()}`));
    let added = 0, skipped = 0, invalidEmail = 0;
    for (const c of clients) {
      if (!c.company && !c.email) { skipped++; continue; }
      const key = `${(c.company || '').toLowerCase()}||${(c.email || '').toLowerCase()}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      const cleanEmail = (c.email || '').trim();
      if (cleanEmail && !EMAIL_RE.test(cleanEmail)) {
        invalidEmail++;
      }
      const { company, _suspicious } = markSuspicious(c.company);
      existing.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        company, country: c.country || '', category: c.category || '',
        email: cleanEmail, website: c.website || '', linkedin: c.linkedin || '',
        contactName: c.contactName || '', position: c.position || '', phone: c.phone || '',
        clientType: c.clientType || classifyClient(c.company, c.category),
        _suspicious, addedAt: new Date().toISOString(),
      });
      existingKeys.add(key);
      added++;
    }
    writeContacts(existing);
    return { total: existing.length, added, skipped, invalidEmail };
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
    } catch {}
  }

  ipcMain.handle('contacts:delete', async (_e, id) => {
    contactsCache = null;
    let contacts = readContacts();
    const target = contacts.find(c => c.id === id);
    if (target?.company && target?.email) {
      removeFromSendHistory(target.company, [target.email]);
    }
    contacts = contacts.filter(c => c.id !== id);
    writeContacts(contacts);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteAll', async () => {
    writeContacts([]);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteCompany', async (_e, company) => {
    contactsCache = null;
    let contacts = readContacts();
    const before = contacts.length;
    const emails = contacts.filter(c => c.company === company).map(c => c.email).filter(Boolean);
    contacts = contacts.filter(c => c.company !== company);
    writeContacts(contacts);

    // 级联清理公司状态
    removeFromSendHistory(company, emails);
    const bsp = path.join(APP_ROOT, 'data', 'backcheck-status.json');
    try {
      if (fs.existsSync(bsp)) {
        let bs = JSON.parse(fs.readFileSync(bsp, 'utf-8'));
        delete bs[company];
        fs.writeFileSync(bsp, JSON.stringify(bs, null, 2));
      }
    } catch {}

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
    if (updated) writeContacts(contacts);
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
    writeContacts(contacts);
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
    if (updated > 0) writeContacts(contacts);
    return { ok: true, updated, total: contacts.filter(c => (c.company || '').trim() === companyName.trim()).length };
  });

  // 决策人深挖
  ipcMain.handle('contacts:deepSearch', async (_e, website, companyName) => {
    if (!website || !website.startsWith('http')) {
      return { ok: false, error: 'no_website', message: '该公司未填写官网' };
    }
    const linkedinClient = require('../linkedin-client');
    const searchName = companyName || '';

    const [scrapeResult, linkedin1, linkedin2] = await Promise.all([
      callScraplingAPI(`/scrape/contacts?url=${encodeURIComponent(website)}&company=${encodeURIComponent(searchName)}`),
      linkedinClient.searchPeople(`${searchName} supply chain OR logistics OR procurement OR buyer`).catch(() => []),
      linkedinClient.searchPeople(`${searchName} compras OR importación OR importação OR comprador`).catch(() => []),
    ]);

    const websitePeople = (scrapeResult?.people || []).map(p => ({ ...p, source: 'website' }));
    const seenNames = new Set(websitePeople.map(p => p.name.toLowerCase()));
    const linkedinPeople = [...linkedin1, ...linkedin2].filter(p => {
      const key = p.name.toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    const allPeople = [...websitePeople, ...linkedinPeople];
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
      company_info: scrapeResult?.company_info || {},
      people: allPeople,
      stats: {
        total: allPeople.length,
        logistics: allPeople.filter(p => p.department === 'logistics').length,
        management: allPeople.filter(p => p.department === 'management').length,
        from_website: websitePeople.length,
        from_linkedin: linkedinPeople.length,
      },
    };
  });

  // 暴露内部方法给其他模块使用
  return { readContacts, writeContacts, contactsPath };
}

module.exports = { register };
