// ── 公司聚合状态 ──────────────────────────────────────────────────────────
// 唯一写入入口：所有公司相关状态变更必须通过本模块，禁止直接操作 S.* 变量。
// 规则：读取随意，写入必须走 CS.xxx() 方法。
//
// Phase 3: 内部使用 companyId，同时维护 companyName 向后兼容。
//
// 覆盖状态：
//   cards    — 已选公司的模板分配 (S.selectedCardsById[id] + S.selectedCards[name])
//   selected — 勾选集合 (S.selectedCompanySet → Set<companyId>)
//   filter   — 阶段筛选 (S.sendStageFilter)
//   + 跨模块共享字段：contactsData / templateLib / sendHistory /
//     contactsSendHistory / discoverPreselectCompany / networkStatusDismissed
//
// 用法：
//   import CS from './company-state.js';
//   CS.setCard('Acme', { type, stage, lang, template, _templateSource, _userTemplate });
//   CS.select('Acme');
//   CS.onChange((event, data) => { if (event === 'card') renderCards(); });
//   const contacts = await CS.getContacts(); // 代替 S.contactsData

const S = window.S;
let _refreshCallbacks = {}; // ponytail: 简单回调，避免引入事件总线

/** 构建 name → companyId 索引（从联系人数据） */
function _ensureIdMap() {
  if (S._companyNameToId) return;
  S._companyNameToId = {};
  S._companyIdToName = {};
  for (const [name, members] of Object.entries(S.sendCompanies || {})) {
    for (const c of members) {
      if (c.companyId) {
        S._companyNameToId[name] = c.companyId;
        S._companyIdToName[c.companyId] = name;
        break; // 取第一个联系人的 companyId
      }
    }
  }
}

/** 输入可能是 name 或 companyId，统一返回 companyId */
function _resolveId(nameOrId) {
  if (!nameOrId) return '';
  // 已经是已知 companyId
  if (S.sendCompaniesById?.[nameOrId]) return nameOrId;
  if (S.selectedCardsById?.[nameOrId]) return nameOrId;
  // 通过 name 查 companyId
  _ensureIdMap();
  const id = S._companyNameToId?.[nameOrId];
  if (id) return id;
  // fallback: 没有 companyId（旧数据），把 name 当 id 用
  return nameOrId;
}

/** companyId → companyName */
function _idToName(id) {
  _ensureIdMap();
  return S._companyIdToName?.[id] || id;
}

const CS = {
  _listeners: [],

  // ── 公开工具 ──────────────────────────────────────────────────────────
  /** companyId → companyName */
  getName(id) { return _idToName(id); },
  /** companyName → companyId */
  getId(name) { return _resolveId(name); },

  // ── 读取：card ────────────────────────────────────────────────────────
  /** 按 name 或 companyId 读取卡片 */
  getCard(nameOrId) {
    const id = _resolveId(nameOrId);
    return (S.selectedCardsById || {})[id] || (S.selectedCards || {})[nameOrId];
  },
  /** 获取全部卡片（companyId → card） */
  getCards() { return S.selectedCardsById || {}; },
  /** 获取全部卡片（companyName → card，向后兼容） */
  getCardsByName() { return S.selectedCards || {}; },

  // ── 读取：selection ──────────────────────────────────────────────────
  isSelected(nameOrId) {
    const id = _resolveId(nameOrId);
    return S.selectedCompanySet?.has(id) || false;
  },
  /** @returns {Set<string>} companyId 集合 */
  getSelected() { return S.selectedCompanySet || new Set(); },
  getSelectedArray() { return [...(S.selectedCompanySet || [])]; },

  // ── 读取：filter ──────────────────────────────────────────────────────
  getFilter() { return S.sendStageFilter || 'active'; },

  // ── 写入：card ────────────────────────────────────────────────────────
  setCard(nameOrId, card) {
    const id = _resolveId(nameOrId);
    const name = _idToName(id) || nameOrId;
    // 新：companyId key
    if (!S.selectedCardsById) S.selectedCardsById = {};
    S.selectedCardsById[id] = card;
    // 旧：company name key（向后兼容）
    if (!S.selectedCards) S.selectedCards = {};
    S.selectedCards[name] = card;
    this._notify('card', { id, name, card });
  },

  removeCard(nameOrId) {
    const id = _resolveId(nameOrId);
    const name = _idToName(id) || nameOrId;
    if (S.selectedCardsById) delete S.selectedCardsById[id];
    if (S.selectedCards) delete S.selectedCards[name];
    this._notify('card-remove', { id, name });
  },

  pruneCards(keepIds) {
    if (!S.selectedCardsById && !S.selectedCards) return;
    const keep = new Set(keepIds.map(k => _resolveId(k)));
    if (S.selectedCardsById) {
      for (const id of Object.keys(S.selectedCardsById)) {
        if (!keep.has(id)) delete S.selectedCardsById[id];
      }
    }
    if (S.selectedCards) {
      for (const name of Object.keys(S.selectedCards)) {
        const id = _resolveId(name);
        if (!keep.has(id)) delete S.selectedCards[name];
      }
    }
  },

  // ── 写入：selection（内部存 companyId）────────────────────────────────
  select(nameOrId) {
    const id = _resolveId(nameOrId);
    if (!S.selectedCompanySet) S.selectedCompanySet = new Set();
    S.selectedCompanySet.add(id);
    this._notify('select', { id, name: _idToName(id) });
  },

  deselect(nameOrId) {
    const id = _resolveId(nameOrId);
    if (!S.selectedCompanySet) return;
    S.selectedCompanySet.delete(id);
    this._notify('deselect', { id });
  },

  selectAll(items) {
    if (!S.selectedCompanySet) S.selectedCompanySet = new Set();
    for (const n of items) {
      const id = _resolveId(n);
      S.selectedCompanySet.add(id);
    }
    this._notify('select-all', { items });
  },

  clearSelection() {
    if (!S.selectedCompanySet) return;
    S.selectedCompanySet.clear();
    this._notify('clear-selection', {});
  },

  // ── 写入：filter ──────────────────────────────────────────────────────
  setFilter(filter) {
    S.sendStageFilter = filter;
    this._notify('filter', { filter });
  },

  setFilterAndClear(filter) {
    S.sendStageFilter = filter;
    if (S.selectedCompanySet) S.selectedCompanySet.clear();
    this._notify('filter', { filter });
    this._notify('clear-selection', {});
  },

  // ── 跨模块共享：联系人数据（5 个文件）─────────────────────────────────
  /** 获取联系人缓存（不触发网络请求） */
  getContacts() { return S.contactsData || []; },
  /** 异步加载联系人（首次缓存 / 强制刷新） */
  async refreshContacts() {
    S.contactsData = await window.electronAPI.getContacts();
    delete S._companyNameToId;
    delete S._companyIdToName;
    if (_refreshCallbacks.contacts) _refreshCallbacks.contacts(S.contactsData);
    return S.contactsData;
  },

  // ── 统一刷新：联系人数据 + 发送历史 + UI ──────────────────────────────
  /** ponytail: 任何地方改了联系人数据，调这一个函数即可。刷新 DB 数据 + 通知 UI。 */
  async syncContactsUI() {
    await this.refreshContacts();
    await this.refreshContactsSendHistory();
    _classifyContacts();
    document.dispatchEvent(new CustomEvent('contacts:sync'));
  },

  // ── 跨模块共享：模板库（4 个文件）─────────────────────────────────────
  getTemplateLib() { return S.templateLib; },
  async refreshTemplateLib() {
    S.templateLib = await window.electronAPI.getTemplateLibrary();
    return S.templateLib;
  },

  // ── 跨模块共享：发送历史（3 个文件）───────────────────────────────────
  getSendHistory() { return S.sendHistory || {}; },
  async refreshSendHistory() {
    S.sendHistory = await window.electronAPI.getSendHistory() || {};
    return S.sendHistory;
  },

  // ── 跨模块共享：联系人视角的发送历史（3 个文件）─────────────────────
  getContactsSendHistory() { return S.contactsSendHistory || {}; },
  async refreshContactsSendHistory() {
    S.contactsSendHistory = await window.electronAPI.getSendHistory() || {};
    return S.contactsSendHistory;
  },

  // ── 跨模块共享：发现页预选公司（3 个文件）───────────────────────────
  getDiscoverPreselect() { return S.discoverPreselectCompany || null; },
  setDiscoverPreselect(company) { S.discoverPreselectCompany = company || null; },

  // ── 跨模块共享：网络状态已关闭提示（2 个文件）───────────────────────
  getNetworkDismissed() { return S.networkStatusDismissed || false; },
  setNetworkDismissed(v) { S.networkStatusDismissed = !!v; },

  // ── 跨模块共享：onChange 回调注册（contactsData 刷新通知）────────────
  onRefreshContacts(fn) { _refreshCallbacks.contacts = fn; },

  // ── 事件 ──────────────────────────────────────────────────────────────
  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  },

  _notify(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); } catch (e) { console.error('[CS] listener error:', e); }
    }
  },
};

// ── 联系人预分类 ──────────────────────────────────────────────────────────
// 在 syncContactsUI() 中调用，产出 S.contactsClassified 供发送界面直接读取
// 分类逻辑与 shared.js 的 isContactSendable 保持一致

const SKIP_STATUSES = new Set(['reached', 'replied', 'autoreply', 'bounced']);
const SKIP_TAGS = new Set(['reached']);

function _isSendable(c) {
  if (!c.email || !c.email.includes('@') || c.email.endsWith('@no.email')) return false;
  if (c._emailStatus === 'invalid_email' || c._emailStatus === 'no_email') return false;
  if (c._status === 'bounced') return false;
  if (SKIP_STATUSES.has(c._status)) return false;
  if ((c.tags || []).some(t => SKIP_TAGS.has(t))) return false;
  return true;
}

// 阶段颜色（深色调，区别于桶色）
const STAGE_COLORS = { cold: '#6b7280', f1: '#2563eb', f2: '#ea580c', f3: '#7c3aed', f4: '#16a34a' };
const STAGE_LABELS = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4' };

const TIME_BUCKETS = [
  { key: 'never',  label: '从未发送', minDays: null, color: '#9e9e9e' },
  { key: 'd1',     label: '1天前',    minDays: 1, maxDays: 1, color: '#42a5f5' },
  { key: 'd2',     label: '2天前',    minDays: 2, maxDays: 2, color: '#1e88e5' },
  { key: 'd3',     label: '3天前',    minDays: 3, maxDays: 3, color: '#1976d2' },
  { key: 'd4_7',   label: '4-7天前',  minDays: 4, maxDays: 7, color: '#ff9800' },
  { key: 'd8plus', label: '7天以上',  minDays: 8, maxDays: Infinity, color: '#8e24aa' },
  { key: 'today',  label: '今天',     minDays: 0, maxDays: 0, disabled: true, color: '#4caf50' },
];

function _daysAgo(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const then = new Date(dateStr);
  const nu = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const tu = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const d = Math.floor((nu - tu) / 86400000);
  return d < 0 ? null : d;
}

function _classifyContacts() {
  const contacts = S.contactsData || [];
  const sendHist = S.sendHistory || S.contactsSendHistory || {};
  const classified = {
    sending: { never: [], d1: [], d2: [], d3: [], d4_7: [], d8plus: [], today: [] },
    autoreply: [],
    reached: [],
    invalid: [],
  };

  const byCompany = {};
  for (const c of contacts) {
    const name = c.company || c.company_name || '';
    if (!name) continue;
    if (!byCompany[name]) byCompany[name] = [];
    byCompany[name].push(c);
  }

  let debugTotal = 0, debugWithDate = 0;
  for (const [company, members] of Object.entries(byCompany)) {
    const normalContacts = [];
    const autoreplyContacts = [];
    const reachedContacts = [];
    const invalidContacts = [];
    const histLastSent = sendHist[company]?.lastSent || '';

    for (const c of members) {
      const lastSent = c.last_sent_at || histLastSent || '';
      const days = _daysAgo(lastSent);
      const st = c.stage || c._stage || 'cold';
      const entry = {
        email: c.email || '',
        firstName: c.firstName || c.first_name || '',
        lastName: c.lastName || c.last_name || '',
        stage: st,
        clientType: c.clientType || c.client_type || 'unlabeled',
        country: c.country || c.company_country || '',
        ok: c._status === 'autoreply'
          ? !!(c.email && c.email.includes('@') && !c.email.endsWith('@no.email'))
          : _isSendable(c),
        lastSentDays: days,
        _status: c._status || '',
        _emailStatus: c._emailStatus || '',
        tags: c.tags || [],
      };

      if (c._emailStatus === 'invalid_email' || c._emailStatus === 'no_email') {
        invalidContacts.push(entry);
      } else if (c._status === 'autoreply') {
        autoreplyContacts.push(entry);
      } else {
        normalContacts.push(entry);
        if (c._status === 'reached' || c._status === 'replied' || (c.tags || []).includes('reached')) {
          reachedContacts.push(entry);
        }
      }
    }

    // ── 异常邮箱区 ──
    if (invalidContacts.length) {
      classified.invalid.push({
        company,
        stageLabel: 'invalid',
        contactCount: invalidContacts.length,
        sendableCount: 0,
        contacts: invalidContacts,
      });
    }

    // ── 自动回复区 ──
    if (autoreplyContacts.length) {
      classified.autoreply.push({
        company,
        stageLabel: 'autoreply',
        contactCount: autoreplyContacts.length,
        sendableCount: autoreplyContacts.filter(c => c.ok).length,
        contacts: autoreplyContacts,
      });
    }

    // ── 已触达区 ──
    if (reachedContacts.length) {
      classified.reached.push({
        company,
        stageLabel: 'reached',
        contactCount: reachedContacts.length,
        sendableCount: 0,
        contacts: reachedContacts,
      });
    }

    // ── 按距上次发送天数分桶 ──
    for (const c of normalContacts) {
      const days = c.lastSentDays;
      let bucket;
      if (days === null) { bucket = 'never'; }
      else if (days === 0) { bucket = 'today'; }
      else if (days === 1) { bucket = 'd1'; }
      else if (days === 2) { bucket = 'd2'; }
      else if (days === 3) { bucket = 'd3'; }
      else if (days <= 7) { bucket = 'd4_7'; }
      else { bucket = 'd8plus'; }

      if (!classified.sending[bucket]) classified.sending[bucket] = [];

      // 找或建该公司在此桶中的条目
      let compEntry = classified.sending[bucket].find(e => e.company === company);
      if (!compEntry) {
        compEntry = { company, stageLabel: bucket, contactCount: 0, sendableCount: 0, contacts: [] };
        classified.sending[bucket].push(compEntry);
      }
      compEntry.contacts.push(c);
      compEntry.contactCount++;
      if (c.ok) compEntry.sendableCount++;
    }
  }

  S.contactsClassified = classified;
  // 临时诊断
  const buckets = {};
  for (const k of Object.keys(classified.sending)) buckets[k] = classified.sending[k].reduce((s, e) => s + e.contactCount, 0);
  console.log('[分类桶]', JSON.stringify(buckets), 'sendHist有数据的公司数:', Object.keys(sendHist).filter(k => sendHist[k]?.lastSent).length);
}

export { TIME_BUCKETS, STAGE_COLORS, STAGE_LABELS };
export default CS;
