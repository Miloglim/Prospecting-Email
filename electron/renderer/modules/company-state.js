// ── 公司聚合状态 ──────────────────────────────────────────────────────────
// 唯一写入入口：所有公司相关状态变更必须通过本模块，禁止直接操作 S.* 变量。
// 规则：读取随意，写入必须走 CS.xxx() 方法。
//
// 覆盖状态：
//   cards    — 已选公司的模板分配 (替代 S.selectedCards)
//   selected — 勾选集合 (替代 S.selectedCompanySet)
//   filter   — 阶段筛选 (替代 S.sendStageFilter)
//
// 用法：
//   import CS from './company-state.js';
//   CS.setCard('Acme', { type, stage, lang, template, _templateSource, _userTemplate });
//   CS.select('Acme');
//   CS.onChange((event, data) => { if (event === 'card') renderCards(); });

const S = window.S;

const CS = {
  // 事件监听器
  _listeners: [],

  // ── 读取 ──────────────────────────────────────────────────────────
  getCard(name) { return (S.selectedCards || {})[name]; },
  getCards() { return S.selectedCards || {}; },
  isSelected(name) { return S.selectedCompanySet?.has(name) || false; },
  getSelected() { return S.selectedCompanySet || new Set(); },
  getSelectedArray() { return [...(S.selectedCompanySet || [])]; },
  getFilter() { return S.sendStageFilter || 'active'; },

  // ── 写入：card ────────────────────────────────────────────────────
  setCard(name, card) {
    if (!S.selectedCards) S.selectedCards = {};
    S.selectedCards[name] = card;
    this._notify('card', { name, card });
  },

  removeCard(name) {
    if (!S.selectedCards) return;
    delete S.selectedCards[name];
    this._notify('card-remove', { name });
  },

  // 清理不在 names 列表中的 cards（入队后调用）
  pruneCards(keepNames) {
    if (!S.selectedCards) return;
    const keep = new Set(keepNames);
    for (const name of Object.keys(S.selectedCards)) {
      if (!keep.has(name)) delete S.selectedCards[name];
    }
  },

  // ── 写入：selection ──────────────────────────────────────────────
  select(name) {
    if (!S.selectedCompanySet) S.selectedCompanySet = new Set();
    S.selectedCompanySet.add(name);
    this._notify('select', { name });
  },

  deselect(name) {
    if (!S.selectedCompanySet) return;
    S.selectedCompanySet.delete(name);
    this._notify('deselect', { name });
  },

  selectAll(names) {
    if (!S.selectedCompanySet) S.selectedCompanySet = new Set();
    for (const n of names) S.selectedCompanySet.add(n);
    this._notify('select-all', { names });
  },

  clearSelection() {
    if (!S.selectedCompanySet) return;
    S.selectedCompanySet.clear();
    this._notify('clear-selection', {});
  },

  // ── 写入：filter ──────────────────────────────────────────────────
  setFilter(filter) {
    S.sendStageFilter = filter;
    this._notify('filter', { filter });
  },

  // ── 批量操作 ──────────────────────────────────────────────────────
  // 重置选中 + 设置 filter（常用组合）
  setFilterAndClear(filter) {
    S.sendStageFilter = filter;
    if (S.selectedCompanySet) S.selectedCompanySet.clear();
    this._notify('filter', { filter });
    this._notify('clear-selection', {});
  },

  // ── 事件 ──────────────────────────────────────────────────────────
  onChange(fn) {
    this._listeners.push(fn);
    // 返回取消订阅函数
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  },

  _notify(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); } catch (e) { console.error('[CS] listener error:', e); }
    }
  },
};

export default CS;
