// ===== 收件箱 ==========================================================
const S = window.S;
import { lucide, escapeHtml, showToast, showConfirm, formatDate } from './shared.js';

let _mails = [];
let _selectedIdx = -1;
let _filter = 'all';
let _loading = false;
// ponytail: 已读状态存 localStorage，重启不丢，上限 2000 条
function _loadViewedKeys() {
  try { const s = localStorage.getItem('inbox-viewed'); return s ? new Set(JSON.parse(s)) : new Set(); }
  catch { return new Set(); }
}
function _saveViewedKeys() {
  const arr = [..._viewedKeys].slice(-2000);
  localStorage.setItem('inbox-viewed', JSON.stringify(arr));
}
const _viewedKeys = _loadViewedKeys();
let _initialLoadDone = false;
const _selectedSet = new Set(); // 多选集合
let _lastClickIdx = -1;       // Shift 范围选择起点

const TYPE_LABELS = { bounce: '退信', reply: '回复', 'auto-reply': '自动回复', other: '其他' };
const TYPE_DOT = { bounce: '#e5484d', reply: '#22a644', 'auto-reply': '#e6a817', other: '#8b8b8b' };

export async function initInbox() {
  // 进入收件箱 → 消红点
  const dot = document.getElementById('inbox-nav-dot');
  if (dot) dot.classList.remove('show');
  _mails = [];
  _selectedIdx = -1;
  const list = await window.electronAPI.listInbox();
  if (list.ok) _mails = list.data || [];
  // 首次加载：所有存量邮件标为已读
  if (!_initialLoadDone) {
    _mails.forEach(m => {
      const mkey = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
      _viewedKeys.add(mkey);
    });
    _saveViewedKeys();
    _initialLoadDone = true;
  }
  renderInbox();
}

export async function doFetchInbox() {
  if (_loading) return;
  _loading = true;
  // 刷新按钮转圈，列表保持不动
  const btn = document.getElementById('inbox-refresh');
  if (btn) btn.innerHTML = `${lucide('refresh-cw', 14, 'spin')} 刷新中...`;

  const result = await window.electronAPI.fetchInbox();
  _loading = false;
  if (result.ok) {
    _mails = result.data || [];
    renderInbox();
  } else {
    showToast(`拉取失败: ${result.error}`, 'err');
  }
  // 恢复按钮
  if (btn) btn.innerHTML = `${lucide('refresh-cw', 14)} 刷新`;
}

function renderInbox() {
  const listEl = document.getElementById('inbox-list');
  const detailEl = document.getElementById('inbox-detail');
  const countEl = document.getElementById('inbox-count');
  if (!listEl) return;

  // 筛选
  const filtered = _filter === 'all' ? _mails :
    _filter === 'important' ? _mails.filter(m => m.important) :
    _mails.filter(m => m.type === _filter);
  // ponytail: 按时间倒序
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 统计
  const counts = { bounce: 0, reply: 0, 'auto-reply': 0, other: 0 };
  const newCounts = { bounce: 0, reply: 0, 'auto-reply': 0, other: 0 };
  _mails.forEach(m => {
    if (counts[m.type] !== undefined) counts[m.type]++;
    const mkey = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
    if (!_viewedKeys.has(mkey)) newCounts[m.type]++;
  });
  if (countEl) {
    countEl.textContent = `共 ${_mails.length} 封 · 退信 ${counts.bounce} · 回复 ${counts.reply} · 自动回复 ${counts['auto-reply']} · 其他 ${counts.other}`;
  }
  // 分类标签红点
  _updateBadges(newCounts);

  // 左侧列表
  listEl.innerHTML = filtered.map((m, i) => {
    const realIdx = _mails.indexOf(m);
    const selCls = _selectedSet.has(realIdx) ? ' inbox-selected' : '';
    const cls = realIdx === _selectedIdx ? 'inbox-item active' + selCls : 'inbox-item' + selCls;
    const time = _shortTime(m.date);
    const mkey = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
    const isNew = !_viewedKeys.has(mkey);
    return `<div class="${cls}" data-idx="${realIdx}" data-mkey="${escapeHtml(mkey)}">
      <span class="inbox-type"><span class="inbox-dot ${isNew ? 'inbox-dot-new' : ''}" style="color:${TYPE_DOT[m.type] || '#8b8b8b'}">●</span></span>
      <div class="inbox-meta">
        <span class="inbox-subject">${escapeHtml(m.subject || '(无主题)')}</span>
        <span class="inbox-from">${escapeHtml(m.fromName || m.from)}${m.contactCompany ? ` · ${escapeHtml(m.contactCompany)}` : ''}</span>
      </div>
      ${m.important ? `<span style="color:#e6a817;flex-shrink:0;font-size:12px" title="重要邮件">★</span>` : ''}
      <span class="inbox-time">${time}</span>
      ${(m.contactCompany || (m.matchedContacts || []).some(c => c.matched !== false)) ? `<span class="inbox-matched-tag">已匹配</span>` : ''}
    </div>`;
  }).join('');

  // 点击事件
  listEl.querySelectorAll('.inbox-item').forEach(el => {
    // 左键点击
    el.addEventListener('click', (e) => {
      const idx = parseInt(el.dataset.idx);
      const mkey = el.dataset.mkey;
      // Ctrl+点击 → 切换多选
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (_selectedSet.has(idx)) _selectedSet.delete(idx);
        else _selectedSet.add(idx);
        renderInbox();
        return;
      }
      // Shift+点击 → 范围多选
      if (e.shiftKey && _lastClickIdx >= 0) {
        e.preventDefault();
        const from = Math.min(_lastClickIdx, idx);
        const to = Math.max(_lastClickIdx, idx);
        const visible = [...listEl.querySelectorAll('.inbox-item')].map(el2 => parseInt(el2.dataset.idx));
        for (const vi of visible) { if (vi >= from && vi <= to) _selectedSet.add(vi); else _selectedSet.delete(vi); }
        renderInbox();
        return;
      }
      // 普通点击 → 单选 + 查看详情
      _lastClickIdx = idx;
      _selectedSet.clear();
      _selectedSet.add(idx);
      _selectedIdx = idx;
      listEl.querySelectorAll('.inbox-item').forEach(e => e.classList.remove('active','inbox-selected'));
      el.classList.add('active','inbox-selected');
      const dot = el.querySelector('.inbox-dot-new');
      if (dot && mkey) {
        dot.classList.remove('inbox-dot-new');
        _viewedKeys.add(mkey);
        _saveViewedKeys();
        dot.addEventListener('transitionend', () => {
          _updateBadgesAfterView(mkey);
          renderDetail();
        }, { once: true });
        renderDetail();
        return;
      }
      if (mkey) { _viewedKeys.add(mkey); _saveViewedKeys(); }
      renderDetail();
    });
    // 右键菜单
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt(el.dataset.idx);
      // 右键项加入多选（原地标记，不重渲）
      if (!_selectedSet.has(idx)) { _selectedSet.add(idx); el.classList.add('inbox-selected'); }
      const selected = [..._selectedSet].sort((a, b) => b - a);
      document.getElementById('ctx-menu')?.remove();
      const menu = document.createElement('div');
      menu.id = 'ctx-menu';
      menu.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      const selCount = selected.length > 1 ? ` (${selected.length}封)` : '';
      const isImportant = _mails[selected[0]]?.important;
      const hasMatched = selected.some(i => {
        const mi = _mails[i];
        return mi?.contactCompany || (mi?.matchedContacts || []).some(c => c.matched);
      });
      menu.innerHTML = `
        <div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="important" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">${isImportant ? '取消重要' : '标记重要'}${selCount}</div>
        <div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="read" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">一键已读${selCount}</div>
        ${hasMatched ? `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="del-matched" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">删除匹配联系人</div>` : ''}
        <div style="border-top:1px solid var(--border);margin:4px 0"></div>
        <div style="padding:6px 14px;cursor:pointer;white-space:nowrap;color:#e5484d" data-action="delete" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">删除邮件${selCount}</div>
      `;
      menu.querySelector('[data-action="del-matched"]')?.addEventListener('click', async () => {
        menu.remove();
        // 收集所有选中邮件的匹配联系人（按邮箱去重）
        const allMatched = [];
        const seen = new Set();
        for (const i of selected) {
          const m = _mails[i];
          if (!m) continue;
          const addIfMatched = (email, dbId) => {
            if (!email || seen.has(email)) return;
            seen.add(email);
            allMatched.push({ mailIdx: i, email, id: dbId || '' });
          };
          if (m.contactCompany && m.from) addIfMatched(m.from, m.contactDbId);
          for (const c of (m.matchedContacts || [])) {
            if (c.matched && c.email) addIfMatched(c.email, c.contactId);
          }
        }
        if (!allMatched.length) { showToast('所选邮件无匹配联系人', 'warn'); return; }
        if (!await showConfirm(`确定删除 ${selected.length} 封选中邮件的全部 ${allMatched.length} 个匹配联系人？`)) return;
        // 批量删除联系人（一次读写）
        const contacts = await window.electronAPI.getContacts();
        const delIds = allMatched.map(c => c.id || (contacts.find(x => (x.email||'').toLowerCase() === c.email.toLowerCase()) || {}).id || '').filter(Boolean);
        if (delIds.length) await window.electronAPI.deleteContactsMany(delIds);
        // 清除缓存中匹配状态
        for (const c of allMatched) {
          await window.electronAPI.removeInboxMatchedContact(c.mailIdx, c.email);
          const mi = _mails[c.mailIdx];
          if (mi?.matchedContacts) mi.matchedContacts = mi.matchedContacts.filter(mc => mc.email !== c.email);
          if (c.email === mi?.from) { mi.contactCompany = ''; mi.contactId = ''; mi.contactDbId = ''; }
        }
        _selectedSet.clear();
        renderDetail();
        renderInbox();
        showToast(`已删除 ${allMatched.length} 个联系人`, 'ok');
      });

      menu.querySelector('[data-action="important"]').addEventListener('click', async () => {
        menu.remove();
        for (const i of selected) {
          const m = _mails[i];
          if (!m) continue;
          const key = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
          await window.electronAPI.toggleInboxImportant(i, key);
          m.important = !m.important;
        }
        _selectedSet.clear();
        renderInbox();
      });
      menu.querySelector('[data-action="read"]').addEventListener('click', () => {
        menu.remove();
        for (const i of selected) {
          const m = _mails[i];
          if (m) {
            const mk = `${m.accountId}|${m.uid}|${m.from}|${m.subject}`;
            _viewedKeys.add(mk);
          }
        }
        _saveViewedKeys();
        _selectedSet.clear();
        renderInbox();
      });
      menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        menu.remove();
        for (const i of selected) { await window.electronAPI.deleteInboxMail(i); }
        for (const i of selected) { _mails.splice(i, 1); }
        if (_selectedIdx >= 0 && !_mails[_selectedIdx]) _selectedIdx = -1;
        _selectedSet.clear();
        renderInbox();
      });
      document.body.appendChild(menu);
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  });

  // 右侧详情
  renderDetail();

  // 空列表提示
  if (!_loading && !filtered.length) {
    listEl.innerHTML = '<div class="inbox-loading">暂无邮件，点击刷新拉取</div>';
  }
  // 退信抽屉：有已匹配退信则渲染按钮，无则清空 DOM
  const drawer = document.getElementById('inbox-bounce-drawer');
  if (drawer) {
    const hasMatched = _filter === 'bounce' && _mails.some(m => m.type === 'bounce' && (m.contactCompany || (m.matchedContacts || []).some(c => c.matched)));
    if (hasMatched) {
      drawer.innerHTML = '<button id="inbox-delete-bounced">删除全部退信联系人</button>';
      // ponytail: 动态绑定事件（按钮每次重建，需重新绑定）
      document.getElementById('inbox-delete-bounced')?.addEventListener('click', _onDeleteBounced);
    } else {
      drawer.innerHTML = '';
    }
  }
}

async function renderDetail() {
  const el = document.getElementById('inbox-detail');
  if (!el) return;
  if (_selectedIdx < 0 || _selectedIdx >= _mails.length) {
    el.innerHTML = '<div class="inbox-detail-empty">选择左侧邮件查看正文</div>';
    return;
  }

  const m = _mails[_selectedIdx];
  // 懒加载正文
  let body = m.body || '';
  if (!body && m.uid) {
    try {
      const r = await window.electronAPI.getInboxBody(_selectedIdx);
      if (r.ok) { body = r.data || ''; m.body = body; }
    } catch { body = ''; }
  }

  const typeLabel = TYPE_LABELS[m.type] || '其他';
  const time = m.date ? new Date(m.date).toLocaleString('zh-CN') : '—';

  el.innerHTML = `
    <div class="inbox-detail-header">
      <div class="inbox-detail-field wide"><span>发件人</span><span>${escapeHtml(m.fromName || '')} &lt;${escapeHtml(m.from)}&gt;</span></div>
      <div class="inbox-detail-field wide"><span>主题</span><span>${escapeHtml(m.subject || '(无主题)')}</span></div>
      <div class="inbox-detail-field"><span>时间</span><span>${time}</span></div>
      <div class="inbox-detail-field"><span>账号</span><span>${escapeHtml(m.accountLabel || m.accountId)}</span></div>
      <div class="inbox-detail-field"><span>分类</span><span><span style="color:${TYPE_DOT[m.type] || '#8b8b8b'};font-weight:600">●</span> ${typeLabel}</span></div>
      <div class="inbox-detail-field"><span>关联</span><span class="${m.contactCompany ? '' : 'muted'}">${m.contactCompany ? `<a class="inbox-link-company" href="#">${escapeHtml(m.contactCompany)}</a>` : '未关联'}</span></div>
    </div>
    ${(() => {
      const allMatched = [];
      if (m.contactCompany) allMatched.push({ email: m.from, company: m.contactCompany, contactId: m.contactDbId, matched: true });
      for (const c of (m.matchedContacts || [])) {
        if (c.company && c.company === m.contactCompany) continue; // 去重
        allMatched.push(c);
      }
      const matched = allMatched.filter(c => c.matched !== false);
      const unmatched = allMatched.filter(c => c.matched === false);
      if (!allMatched.length) return '<div class="inbox-matched muted"><span>未提取到邮箱</span><span class="drawer-arrow">▾</span></div>';
      const detailHtml = [];
      if (matched.length) detailHtml.push(`<div>${matched.map(c => `<span class="inbox-match-item"><a class="inbox-match-link" href="#" data-email="${escapeHtml(c.email)}">${escapeHtml(c.email)}</a> → <b>${escapeHtml(c.company)}</b><span class="inbox-match-x" data-email="${escapeHtml(c.email)}" data-contactid="${escapeHtml(c.contactId || '')}" data-matched="1" title="删除该联系人"><svg width="8" height="8" viewBox="0 0 10 10" style="display:block"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.5"/></svg></span></span>`).join(' · ')}</div>`);
      if (unmatched.length) detailHtml.push(`<div style="color:var(--text-secondary);margin-top:4px">未匹配: ${unmatched.map(c => escapeHtml(c.email)).join(' · ')}</div>`);
      return `<div class="inbox-matched"><span>已匹配 ${matched.length} 人 · 未匹配 ${unmatched.length} 个邮箱</span><span class="drawer-arrow">▾</span><div class="inbox-matched-detail" style="max-height:200px">${detailHtml.join('')}</div></div>`;
    })()}
    <div class="inbox-detail-body-wrap"><iframe class="inbox-detail-body" sandbox="allow-scripts" scrolling="no"></iframe></div>
    <div class="inbox-detail-actions">
      <button id="inbox-btn-processed" class="${m.processed ? 'done' : ''}">${m.processed ? lucide('check-circle', 12) : '<span style="font-size:14px">○</span>'} ${m.processed ? '已处理' : '标记已处理'}</button>
      <button id="inbox-btn-delete">${lucide('trash', 12)} 删除邮件</button>
    </div>
  `;

  // 正文用 iframe 渲染（CSS 隔离 + wrap 层提供外部滚动条）
  const iframe = el.querySelector('.inbox-detail-body');
  if (iframe) {
    let doc = body;
    const MAX_BODY = 500000; // 500KB，超出截断防止 srcdoc 超限白屏
    let truncated = false;
    if (doc && doc.length > MAX_BODY) { doc = doc.slice(0, MAX_BODY); truncated = true; }
    if (!doc) doc = '<p style="color:#999">(无法加载正文)</p>';
    const truncNote = truncated ? '<p style="color:#e6a817;font-size:12px;padding:8px;background:#fff8e1;border-radius:4px;margin-bottom:8px">⚠ 正文过长（>500KB），仅显示前段。完整内容请用邮件客户端查看。</p>' : '';
    // ponytail: srcdoc 替代 blob URL — file:// 协议下 blob 被 Chromium 拦截
    iframe.srcdoc = `<html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.7;color:#333;padding:0;margin:0;word-break:break-word}img{max-width:100%}a{color:#2563eb}</style></head><body>${truncNote}${doc}<script>function rpt(){parent.postMessage({h:document.body.scrollHeight},'*')};rpt();setTimeout(rpt,800)<\/script></body></html>`;
    // 自适应高度：收到 body 高度后撑开 iframe
    iframe.style.minHeight = '300px';
    const onMsg = (e) => {
      if (e.data && typeof e.data.h === 'number') {
        iframe.style.height = Math.max(300, e.data.h + 32) + 'px';
        
      }
    };
    window.addEventListener('message', onMsg);
  }

  document.getElementById('inbox-btn-processed')?.addEventListener('click', async () => {
    m.processed = !m.processed;
    await window.electronAPI.markInboxProcessed(_selectedIdx);
    showToast(m.processed ? '已标记' : '已取消标记', 'ok');
    renderDetail();
    renderInbox();
  });
  document.getElementById('inbox-btn-delete')?.addEventListener('click', async () => {
    await window.electronAPI.deleteInboxMail(_selectedIdx);
    _mails.splice(_selectedIdx, 1);
    _selectedIdx = -1;
    renderInbox();
  });

  // 下滑正文时匹配栏平滑收回
  const wrap = el.querySelector('.inbox-detail-body-wrap');
  const matchedBar = el.querySelector('.inbox-matched');
  if (wrap && matchedBar) {
    wrap.addEventListener('scroll', () => {
      matchedBar.classList.toggle('collapsed', wrap.scrollTop > 10);
    });
  }

  // 点击邮箱 → 跳转联系人页搜索
  el.querySelectorAll('.inbox-match-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const email = link.dataset.email;
      // 先填入搜索词，再导航
      const si = document.getElementById('contacts-search');
      if (si) si.value = email;
      document.querySelector('.nav-item[data-page="contacts"]')?.click();
      // 延迟触发搜索，等页面就绪
      setTimeout(() => {
        const si2 = document.getElementById('contacts-search');
        if (si2 && si2.value === email) si2.dispatchEvent(new Event('input'));
      }, 300);
    });
  });

  // 点击 × 删除匹配联系人
  el.querySelectorAll('.inbox-match-x').forEach(x => {
    x.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const email = x.dataset.email;
      const contactId = x.dataset.contactid;
      const isMatched = x.dataset.matched === '1';
      if (isMatched && contactId) {
        await window.electronAPI.deleteContact(contactId);
      }
      await window.electronAPI.removeInboxMatchedContact(_selectedIdx, email);
      if (m.matchedContacts) {
        m.matchedContacts = m.matchedContacts.filter(c => c.email !== email);
      }
      if (email === m.from) {
        m.contactCompany = '';
        m.contactId = '';
        m.contactDbId = '';
      }
      // 更新列表项标签
      const hasMatch = m.contactCompany || (m.matchedContacts || []).some(c => c.matched);
      const item = document.querySelector(`#inbox-list .inbox-item[data-idx="${_selectedIdx}"]`);
      if (item) {
        const tag = item.querySelector('.inbox-matched-tag');
        if (tag && !hasMatch) tag.remove();
      }
      renderDetail();
    });
  });

  // 点击公司名 → 跳转联系人页并搜索
  el.querySelector('.inbox-link-company')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!m.contactCompany) return;
    document.querySelector('.nav-item[data-page="contacts"]')?.click();
    const searchInput = document.getElementById('contacts-search');
    if (searchInput) {
      searchInput.value = m.contactCompany;
      searchInput.dispatchEvent(new Event('input'));
    }
  });
}

function _updateBadges(newCounts) {
  ['important','reply','auto-reply','bounce','other'].forEach(type => {
    const badge = document.querySelector(`#inbox-filter .inbox-filter-btn[data-filter="${type}"] .filter-badge`);
    if (badge) {
      const n = type === 'important' ? _mails.filter(m => m.important && !_viewedKeys.has(`${m.accountId}|${m.uid}|${m.from}|${m.subject}`)).length : newCounts[type];
      badge.classList.toggle('show', n > 0);
    }
  });
}

// 动画结束后不重渲整列表，只更新被点击那封的分类红点
function _updateBadgesAfterView(mkey) {
  const m = _mails.find(m => `${m.accountId}|${m.uid}|${m.from}|${m.subject}` === mkey);
  if (!m) return;
  const newCounts = { bounce: 0, reply: 0, 'auto-reply': 0, other: 0 };
  _mails.forEach(m2 => {
    const k = `${m2.accountId}|${m2.uid}|${m2.from}|${m2.subject}`;
    if (!_viewedKeys.has(k) && newCounts[m2.type] !== undefined) newCounts[m2.type]++;
  });
  _updateBadges(newCounts);
}

function _shortTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (diff < 172800000) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 筛选 ────────────────────────────────────────────────────────────────
document.getElementById('inbox-filter')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.inbox-filter-btn');
  if (!btn) return;
  document.querySelectorAll('#inbox-filter .inbox-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _filter = btn.dataset.filter;
  _selectedIdx = -1;
  renderInbox();
});

// ── 退信批量删除按钮回调（动态绑定，由 renderInbox 挂载）──────────────────
async function _onDeleteBounced() {
  // 收集所有退信中已匹配的联系人（对齐右键菜单删除逻辑）
  const allMatched = [];
  for (let i = 0; i < _mails.length; i++) {
    const m = _mails[i];
    if (m.type !== 'bounce') continue;
    if (m.contactCompany && m.from) allMatched.push({ mailIdx: i, email: m.from, id: m.contactDbId || '' });
    for (const c of (m.matchedContacts || [])) {
      if (c.matched && c.email) allMatched.push({ mailIdx: i, email: c.email, id: c.contactId || '' });
    }
  }
  if (!allMatched.length) { showToast('退信中无已匹配联系人', 'warn'); return; }
  if (!await showConfirm(`确定删除退信中全部 ${allMatched.length} 个匹配联系人？`)) return;

  const contacts = await window.electronAPI.getContacts();
  const delIds = allMatched.map(c => c.id || (contacts.find(x => (x.email || '').toLowerCase() === c.email.toLowerCase()) || {}).id || '').filter(Boolean);
  if (delIds.length) await window.electronAPI.deleteContactsMany(delIds);

  // 批量清除缓存匹配状态（一次 IO）
  await window.electronAPI.removeInboxMatchedContactsBatch(allMatched);
  // 立即从 _mails 中清除已删除联系人的匹配信息（不等 listInbox，确保热更新）
  const delEmails = new Set(allMatched.map(c => (c.email || '').toLowerCase()));
  for (const m of _mails) {
    if (delEmails.has((m.from || '').toLowerCase())) { m.contactCompany = ''; m.contactId = ''; m.contactDbId = ''; }
    if (m.matchedContacts) m.matchedContacts = m.matchedContacts.filter(c => !delEmails.has((c.email || '').toLowerCase()));
  }
  showToast(`已删除 ${allMatched.length} 个联系人`, 'ok');
  // listInbox 回读磁盘做二次校验，保证前后端状态一致
  const list = await window.electronAPI.listInbox();
  if (list.ok) { _mails = list.data || []; }
  _selectedIdx = -1;
  renderInbox();
}

document.getElementById('inbox-refresh')?.addEventListener('click', doFetchInbox);
document.getElementById('inbox-clear')?.addEventListener('click', async () => {
  if (!await showConfirm('确定清除全部收件箱记录？\n重要标记会丢失。\n下次拉取会重新下载。')) return;
  await window.electronAPI.clearInbox();
  _mails = [];
  _selectedIdx = -1;
  renderInbox();
  showToast('已清除，下次拉取重新下载', 'ok');
});
document.getElementById('inbox-sync-tags')?.addEventListener('click', async () => {
  const btn = document.getElementById('inbox-sync-tags');
  btn.disabled = true; btn.textContent = '同步中...';
  const r = await window.electronAPI.syncInboxTags();
  showToast(r.ok ? (r.message || '同步完成') : ('同步失败: ' + (r.error || '')), r.ok ? 'ok' : 'err');
  btn.disabled = false; btn.textContent = '同步标签';
});

// 热刷新：后台拉到新邮件时自动更新列表 + 导航红点
window.electronAPI.onInboxChanged(async () => {
  if (document.getElementById('page-inbox')?.classList.contains('active')) {
    const list = await window.electronAPI.listInbox();
    if (list.ok) { _mails = list.data || []; renderInbox(); }
  } else {
    // 不在收件箱页面 → 显示红点
    const dot = document.getElementById('inbox-nav-dot');
    if (dot) dot.classList.add('show');
  }
});
// 联系人变化时重新验证收件箱匹配状态
window.electronAPI.onContactsChanged(async () => {
  if (document.getElementById('page-inbox')?.classList.contains('active')) {
    const list = await window.electronAPI.listInbox();
    if (list.ok) { _mails = list.data || []; renderInbox(); }
  }
});
// 快捷键：Ctrl+A 全选、Esc 取消、Ctrl+D 取消全选
window._inboxKeyHandler = (e) => {
  const page = document.getElementById('page-inbox');
  if (!page || !page.classList.contains('active')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    const listEl = document.getElementById('inbox-list');
    if (!listEl) return;
    listEl.querySelectorAll('.inbox-item').forEach(el => {
      const i = parseInt(el.dataset.idx);
      if (!isNaN(i)) _selectedSet.add(i);
    });
    renderInbox();
  }
  if (e.key === 'Escape' && _selectedSet.size) {
    e.preventDefault();
    _selectedSet.clear();
    renderInbox();
  }
};
document.addEventListener('keydown', window._inboxKeyHandler);

// ── 自动拉取倒计时 ───────────────────────────────────────────────────────────
let _inboxNextFetchAt = 0;
let _inboxTimer = null;

function _startInboxTimer() {
  if (_inboxTimer) clearInterval(_inboxTimer);
  _inboxTimer = setInterval(() => {
    const el = document.getElementById('inbox-timer');
    if (!el) return;
    const remain = Math.max(0, Math.floor((_inboxNextFetchAt - Date.now()) / 1000));
    if (_inboxNextFetchAt <= 0) { el.textContent = ''; return; }
    if (remain <= 0) { el.textContent = '⏳ 拉取中...'; return; }
    const m = Math.floor(remain / 60), s = remain % 60;
    el.textContent = `⏳ ${m}:${String(s).padStart(2, '0')}`;
  }, 1000);
}

window.electronAPI.onInboxNextFetch((data) => {
  _inboxNextFetchAt = data?.nextFetchAt || 0;
  _startInboxTimer();
});
// 启动时主动查询一次
(async () => {
  const r = await window.electronAPI.inboxNextFetch();
  if (r?.nextFetchAt) { _inboxNextFetchAt = r.nextFetchAt; _startInboxTimer(); }
})();

window.__pageHandlers['inbox'] = initInbox;
