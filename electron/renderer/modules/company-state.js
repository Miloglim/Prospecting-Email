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
    // 联系人数据更新后，清除 ID 映射缓存，下次 _ensureIdMap() 自动重建
    delete S._companyNameToId;
    delete S._companyIdToName;
    if (_refreshCallbacks.contacts) _refreshCallbacks.contacts(S.contactsData);
    return S.contactsData;
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

export default CS;
