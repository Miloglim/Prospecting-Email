// ===== 收件箱 ==========================================================
const S = window.S;
import { lucide, escapeHtml, showToast, showConfirm, formatDate } from './shared.js';

const TAG_OPTIONS = [
  { val: '待开发',   label: '待开发',   color: '#9e9e9e' },
  { val: '自动回复', label: '自动回复', color: '#f5a623' },
  { val: '有回复',   label: '有回复',   color: '#22a644' },
  { val: '已触达',   label: '已触达',   color: '#3b82f6' },
  { val: '触达中',    label: '触达中',   color: '#ff9800' },
  { val: '报价中',    label: '报价中',   color: '#2196f3' },
  { val: '试单',      label: '试单',     color: '#8e24aa' },
  { val: '合作中',    label: '合作中',   color: '#4caf50' },
  { val: '已流失',    label: '已流失',   color: '#d93025' },
];

let _mails = [];
let _selectedIdx = -1;
let _selectedSet = new Set();
let _lastClickIdx = -1;
let _filter = 'all';
let _loading = false;
let _failedAccounts = [];
let _accountStats = [];
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

const TYPE_LABELS = { bounce: '退信', reply: '回复', 'auto-reply': '自动回复', other: '其他' };
const TYPE_DOT = { bounce: '#e5484d', reply: '#22a644', 'auto-reply': '#e6a817', other: '#8b8b8b' };

export async function initInbox() {
  // 进入收件箱 → 消红点
  const dot = document.getElementById('inbox-nav-dot');
  if (dot) dot.classList.remove('show');
  _mails = [];
  _selectedIdx = -1;
  _selectedSet = new Set();
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
  // 委托事件：在 #inbox-list 上绑一次，避免 renderInbox 重建时累加
  _bindInboxDelegates();
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
    _failedAccounts = result.failedAccounts || [];
    _accountStats = result.accountStats || [];
    const skipped = result.skippedAccounts || [];
    renderInbox();
    if (_failedAccounts.length) {
      showToast(`${_failedAccounts.map(a => a.label + ': ' + a.error).join('；')}`, 'err');
    }
    if (skipped.length) {
      showToast(`${skipped.map(a => a.label + ' 跳过: ' + a.reason).join('；')}`, 'warn');
    }
  } else {
    showToast(`拉取失败: ${result.error}`, 'err');
  }
  // 恢复按钮
  if (btn) btn.innerHTML = `${lucide('refresh-cw', 14)} 刷新`;
}

// 委托事件：绑在 #inbox-list 上只执行一次，避免 renderInbox 重建时监听器累加
let _delegatesBound = false;
function _bindInboxDelegates() {
  if (_delegatesBound) return;
  _delegatesBound = true;
  const listEl = document.getElementById('inbox-list');
  if (!listEl) return;

  // 左键点击 → 单选/Shift范围/Ctrl追加 + 查看详情
  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx);
    const mkey = item.dataset.mkey;
    // 筛选后的可见索引列表（用于 Shift 范围选择）
    const filtered = _filter === 'all' ? _mails :
      _filter === 'important' ? _mails.filter(m => m.important) :
      _mails.filter(m => m.type === _filter);
    const visibleIndices = filtered.map(m => _mails.indexOf(m));
    if (e.shiftKey && _lastClickIdx >= 0) {
      // Shift+单击：选中从锚点到当前的范围
      const anchorPos = visibleIndices.indexOf(_lastClickIdx);
      const curPos = visibleIndices.indexOf(idx);
      if (anchorPos >= 0 && curPos >= 0) {
        const [from, to] = anchorPos < curPos ? [anchorPos, curPos] : [curPos, anchorPos];
        _selectedSet = new Set(visibleIndices.slice(from, to + 1));
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+单击：切换该行的选中状态（追加模式）
      if (_selectedSet.has(idx)) _selectedSet.delete(idx);
      else _selectedSet.add(idx);
    } else {
      // 普通单击：单选，清空其他选中
      if (_selectedSet.has(idx) && _selectedSet.size === 1) {
        _selectedSet.delete(idx);
      } else {
        _selectedSet = new Set([idx]);
      }
    }
    _lastClickIdx = idx;
    // 详情
    _selectedIdx = idx;
    listEl.querySelectorAll('.inbox-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    // 已读
    const dot = item.querySelector('.inbox-dot-new');
    if (dot && mkey) { dot.classList.remove('inbox-dot-new'); _viewedKeys.add(mkey); _saveViewedKeys(); _updateBadgesAfterView(mkey); }
    else if (mkey) { _viewedKeys.add(mkey); _saveViewedKeys(); _updateBadgesAfterView(mkey); }
    // 更新选中样式
    listEl.querySelectorAll('.inbox-item').forEach(el => {
      const i = parseInt(el.dataset.idx);
      el.classList.toggle('selected', _selectedSet.has(i) && i !== _selectedIdx);
    });
    renderDetail();
  });

  // 右键菜单
  listEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    e.preventDefault();
    const idx = parseInt(item.dataset.idx);
    const m = _mails[idx];
    if (!m) return;
    // 右键的邮件不在选中集 → 清空并仅选中当前
    if (!_selectedSet.has(idx)) {
      _selectedSet = new Set([idx]);
      _selectedIdx = idx;
      renderInbox();
      return;
    }
    document.getElementById('ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    const isImportant = m.important;
    const hasMatched = m.contactCompany || (m.matchedContacts || []).some(c => c.matched);
    const curType = m.type || 'other';
    const TYPE_LABEL = { bounce: '退信', reply: '回复', 'auto-reply': '自动回复', other: '其他' };
    const selCount = _selectedSet.size;
    menu.innerHTML = `
      <div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="important" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">${isImportant ? '取消重要' : '标记重要'}</div>
      <div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="read" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">一键已读</div>
      ${hasMatched ? `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="del-matched" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">删除匹配联系人</div>` : ''}
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      ${['bounce','reply','auto-reply','other'].filter(t => t !== curType).map(t => `<div style="padding:6px 14px 6px 24px;cursor:pointer;white-space:nowrap;color:${TYPE_DOT[t]}" data-action="set-type" data-type="${t}" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">● 设为 ${TYPE_LABEL[t]}</div>`).join('')}
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      <div style="padding:4px 14px;color:var(--text-secondary);font-size:10px">联系人标签</div>
      ${TAG_OPTIONS.map(t => `<div style="padding:4px 14px 4px 24px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px" data-action="set-tag" data-tag="${t.val}" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'"><span style="width:7px;height:7px;border-radius:50%;background:${t.color};flex-shrink:0"></span>${t.label}</div>`).join('')}
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      <div style="padding:6px 14px;cursor:pointer;white-space:nowrap;color:#e5484d" data-action="delete" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">${selCount > 1 ? `删除选中的 ${selCount} 封` : '删除邮件'}</div>
    `;
    // 绑定菜单事件
    _bindMenuActions(menu, m, idx);
    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  });
}

// 右键菜单事件绑定（从 _bindInboxDelegates 抽离）
function _bindMenuActions(menu, m, idx) {
  menu.querySelectorAll('[data-action="set-type"]').forEach(el => el.addEventListener('click', async () => {
    menu.remove();
    const targetIdxes = _selectedSet.size > 1 ? [..._selectedSet] : [idx];
    for (const i of targetIdxes) {
      await window.electronAPI.setInboxType(i, el.dataset.type);
      if (_mails[i]) _mails[i].type = el.dataset.type;
    }
    renderInbox();
  }));
  menu.querySelector('[data-action="del-matched"]')?.addEventListener('click', async () => {
    menu.remove();
    // 收集所有选中邮件中的匹配联系人（多选时遍历全部选中项）
    const targetIdxes = _selectedSet.size > 1 ? [..._selectedSet] : [idx];
    const allMatched = [];
    for (const i of targetIdxes) {
      const mail = _mails[i];
      if (!mail) continue;
      if (mail.contactCompany && mail.from) allMatched.push({ mailIdx: i, email: mail.from, id: mail.contactDbId || '' });
      for (const c of (mail.matchedContacts || [])) {
        if (c.matched && c.email) allMatched.push({ mailIdx: i, email: c.email, id: c.contactId || '' });
      }
    }
    if (!allMatched.length) { showToast('无匹配联系人', 'warn'); return; }
    if (!await showConfirm(`确定删除选中的 ${allMatched.length} 个匹配联系人？`)) return;
    const contacts = await window.electronAPI.getContacts();
    const delIds = allMatched.map(c => c.id || (contacts.find(x => (x.email||'').toLowerCase() === c.email.toLowerCase()) || {}).id || '').filter(Boolean);
    if (delIds.length) await window.electronAPI.deleteContactsMany(delIds);
    await window.electronAPI.removeInboxMatchedContactsBatch(allMatched);
    // 更新内存中的匹配状态
    const delEmails = new Set(allMatched.map(c => (c.email || '').toLowerCase()));
    for (const mail of _mails) {
      if (delEmails.has((mail.from || '').toLowerCase())) { mail.contactCompany = ''; mail.contactId = ''; mail.contactDbId = ''; }
      if (mail.matchedContacts) mail.matchedContacts = mail.matchedContacts.filter(mc => !delEmails.has((mc.email || '').toLowerCase()));
    }
    renderDetail(); renderInbox();
    showToast(`已删除 ${allMatched.length} 个联系人`, 'ok');
  });
  menu.querySelector('[data-action="important"]').addEventListener('click', async () => {
    menu.remove();
    const targetIdxes = _selectedSet.size > 1 ? [..._selectedSet] : [idx];
    for (const i of targetIdxes) {
      const mail = _mails[i];
      if (!mail) continue;
      const key = `${mail.accountId}|${mail.uid}|${mail.from}|${mail.subject}`;
      await window.electronAPI.toggleInboxImportant(i, key);
      mail.important = !mail.important;
    }
    renderInbox();
  });
  menu.querySelector('[data-action="read"]').addEventListener('click', () => {
    menu.remove();
    const targetIdxes = _selectedSet.size > 1 ? [..._selectedSet] : [idx];
    for (const i of targetIdxes) {
      const mail = _mails[i];
      if (!mail) continue;
      const mk = `${mail.accountId}|${mail.uid}|${mail.from}|${mail.subject}`;
      _viewedKeys.add(mk);
    }
    _saveViewedKeys();
    renderInbox();
  });
  // 标签选择：发件人邮箱 → 查联系人 → 写库 → 强制刷新联系人数据
  menu.querySelectorAll('[data-action="set-tag"]').forEach(el => el.addEventListener('click', async () => {
    menu.remove();
    const tagVal = el.dataset.tag;
    const targetIdxes = _selectedSet.size > 1 ? [..._selectedSet] : [idx];
    const diag = []; // 探针
    let total = 0;
    for (const i of targetIdxes) {
      const mail = _mails[i];
      if (!mail?.from) { diag.push(`邮件${i}: 无发件人`); continue; }
      diag.push(`查询: ${mail.from}`);
      const c = (S.contactsData || []).find(x => (x.email || '').toLowerCase() === mail.from.toLowerCase());
      if (!c?.id) { diag.push(`→ 未找到联系人(共${(S.contactsData||[]).length}条)`); continue; }
      diag.push(`→ 找到: ${c.id} tags=${JSON.stringify(c.tags||[])}`);
      // 合并：保留状态类标签，替换机会类标签
      const STS = ['已触达','有回复','自动回复','reached','replied','autoreply','auto_reply','bounced_by_contact','left_company'];
      const OPP = ['待开发','触达中','报价中','试单','合作中','已流失'];
      const old = c.tags || [];
      const merged = [...old.filter(t => !OPP.includes(t) && !STS.includes(t) || STS.includes(t)), ...(OPP.includes(tagVal) ? [tagVal] : []), ...(STS.includes(tagVal) ? [tagVal] : [])];
      const r = await window.electronAPI.setContactTags(c.id, [...new Set(merged)]);
      diag.push(`→ setContactTags: ok=${r.ok} added=${JSON.stringify(r.added||[])} removed=${JSON.stringify(r.removed||[])}`);
      total++;
    }
    if (total > 0) {
      S.contactsData = await window.electronAPI.getContacts();
      const verify = (S.contactsData || []).find(x => targetIdxes.some(i => {
        const m = _mails[i]; return m && (x.email || '').toLowerCase() === (m.from || '').toLowerCase();
      }));
      diag.push(`重读验证: tags=${JSON.stringify(verify?.tags||[])}`);
      renderDetail();
      document.dispatchEvent(new CustomEvent('contacts:sync'));
      showToast(`已为 ${total} 个联系人设置标签`, 'ok');
    } else {
      diag.push('结果: 0个联系人被打标');
    }
    console.log('[标签探针]', diag.join('\n  '));
    if (!total) showToast('未找到匹配的联系人 → 看F12', 'warn');
  }));
  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    menu.remove();
    if (_selectedSet.size > 1) {
      // 批量删除
      if (!await showConfirm(`确定删除 ${_selectedSet.size} 封邮件？`)) return;
      const sorted = [..._selectedSet].sort((a, b) => b - a);
      for (const i of sorted) { await window.electronAPI.deleteInboxMail(i); _mails.splice(i, 1); }
      _selectedSet = new Set();
      if (_selectedIdx >= _mails.length) _selectedIdx = -1;
      showToast('已删除', 'ok');
    } else {
      await window.electronAPI.deleteInboxMail(idx);
      _mails.splice(idx, 1);
      _selectedSet.delete(idx);
      if (_selectedIdx >= _mails.length) _selectedIdx = -1;
    }
    renderInbox();
  });
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
    let html = `共 ${_mails.length} 封 · 退信 ${counts.bounce} · 回复 ${counts.reply} · 自动回复 ${counts['auto-reply']} · 其他 ${counts.other}`;
    // 分账号计数：直接从 _mails 聚合，任何时候都准确
    const acctCounts = {};
    for (const m of _mails) {
      const key = m.accountLabel || m.accountId || '?';
      acctCounts[key] = (acctCounts[key] || 0) + 1;
    }
    // 补上 _accountStats 里 0 封的账号（可能是拉取失败或协议不对）
    for (const s of _accountStats) {
      const key = s.label || s.host;
      if (!acctCounts[key]) acctCounts[key] = 0;
    }
    const acctKeys = Object.keys(acctCounts);
    if (acctKeys.length >= 1) {
      const parts = acctKeys.map(key => {
        const n = acctCounts[key];
        const st = _accountStats.find(s => (s.label || s.host) === key);
        const protocol = st ? st.protocol : '';
        // 诊断：0 封时显示内部步骤信息
        let detail = '';
        if (n === 0 && st && st.diag) {
          const d = st.diag;
          if (d.error) {
            // 探针：根据已有的计时数据确定卡在哪一步
            const lastStep = d.uidl ? 'UIDL→RETR' : d.stat ? 'UIDL' : d.auth ? 'STAT' : d.greet ? 'AUTH' : d.connect ? 'GREET' : 'CONNECT';
            const ms = d.total || 0;
            detail = ` (卡在${lastStep}, ${ms}ms: ${d.error})`;
          } else if (d.step === 'STAT' && d.statTotal === 0) detail = ' (收件箱为空)';
          else if (d.step === 'UIDL' && d.uidlCount === 0) detail = ' (UIDL解析失败)';
          else if (d.step === 'UIDL' && d.cursorValid) detail = ' (游标阻塞)';
          else if (d.step === 'FETCH') detail = ` (${d.fetchCount}封未解析)`;
          else if (d.total !== undefined) {
            // 成功时也显示耗时链
            const chain = [`连接${d.connect||0}ms`, `认证${d.auth - (d.connect||0)}ms`, `STAT${d.stat - (d.auth||0)}ms`, `UIDL${d.uidl - (d.stat||0)}ms`, `拉取${d.retr - (d.uidl||0)}ms`];
            detail = n === 0 ? ` (0封, ${chain.join('→')})` : '';
          }
        }
        const color = n === 0 && st && !st.ok ? 'color:#e5484d' : n === 0 ? 'color:#e6a817' : '';
        return `<span${color ? ` style="${color}"` : ''} title="${escapeHtml(JSON.stringify(st?.diag || {}))}">${key}${protocol ? ' ' + protocol : ''}: ${n}封${detail}</span>`;
      });
      html += ' &nbsp;|&nbsp; ' + parts.join(' &nbsp;·&nbsp; ');
    }
    countEl.innerHTML = html;
  }
  // 分类标签红点
  _updateBadges(newCounts);

  // 左侧列表
  listEl.innerHTML = filtered.map((m, i) => {
    const realIdx = _mails.indexOf(m);
    const isSelected = _selectedSet.has(realIdx);
    const isActive = realIdx === _selectedIdx;
    const cls = [
      'inbox-item',
      isActive ? 'active' : '',
      isSelected && !isActive ? 'selected' : '',
    ].filter(Boolean).join(' ');
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

  // 右侧详情
  renderDetail();

  // 空列表提示
  if (!_loading && !filtered.length) {
    listEl.innerHTML = '<div class="inbox-loading">暂无邮件，点击刷新拉取</div>';
  }
  // 退信抽屉：有已匹配退信则平滑下拉显示删除按钮
  const drawer = document.getElementById('inbox-bounce-drawer');
  if (drawer) {
    const hasMatched = _filter === 'bounce' && _mails.some(m => m.type === 'bounce' && (m.contactCompany || (m.matchedContacts || []).some(c => c.matched)));
    drawer.classList.toggle('open', hasMatched);
    if (hasMatched) {
      drawer.innerHTML = '<button id="inbox-delete-bounced">删除全部退信联系人</button>';
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
      <div class="inbox-detail-field"><span>标签</span><span>${(() => {
        const c = (S.contactsData || []).find(x => (x.email || '').toLowerCase() === (m.from || '').toLowerCase());
        const tags = c?.tags || [];
        const diag = c ? `[找到:${c.id} tags:${JSON.stringify(tags)}]` : `[查无:${m.from} 共${(S.contactsData||[]).length}条]`;
        if (!tags.length) return `<span class="muted" title="${escapeHtml(diag)}">—</span>`;
        const TL = { reached:'已触达', replied:'有回复', autoreply:'自动回复', bounced_by_contact:'退信', left_company:'已离职', auto_reply:'自动回复' };
        return tags.map(t => `<span style="display:inline-block;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:8px;font-size:10px;margin-right:2px" title="${escapeHtml(diag)}">${escapeHtml(TL[t] || t)}</span>`).join('');
      })()}</span></div>
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

  document.getElementById('inbox-btn-delete')?.addEventListener('click', async () => {
    await window.electronAPI.deleteInboxMail(_selectedIdx);
    _mails.splice(_selectedIdx, 1);
    _selectedSet.delete(_selectedIdx);
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
  _selectedSet = new Set();
  _lastClickIdx = -1;
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
  // ponytail: 删除后自动标记这些退信为已读
  for (let i = 0; i < _mails.length; i++) {
    const m = _mails[i];
    if (m.type === 'bounce' && (m.contactCompany || (m.matchedContacts || []).some(c => c.matched))) {
      _viewedKeys.add(`${m.accountId}|${m.uid}|${m.from}|${m.subject}`);
    }
  }
  _saveViewedKeys();
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
  _selectedSet = new Set();
  renderInbox();
  showToast('已清除，下次拉取重新下载', 'ok');
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
// 快捷键：Ctrl+A 全选
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('page-inbox')?.classList.contains('active')) return;
  if (e.ctrlKey && e.key === 'a') {
    e.preventDefault();
    const filtered = _filter === 'all' ? _mails :
      _filter === 'important' ? _mails.filter(m => m.important) :
      _mails.filter(m => m.type === _filter);
    if (!filtered.length) return;
    _selectedSet = new Set(filtered.map(m => _mails.indexOf(m)));
    renderInbox();
  }
});

window.__pageHandlers['inbox'] = initInbox;
