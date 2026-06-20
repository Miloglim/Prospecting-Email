// ── Prospecting Email — 渲染进程逻辑 v1.2 ──────────────────────────────

// ===== 全局状态 ======================================================
let templateLib = null;
let queue = JSON.parse(localStorage.getItem('emailQueue') || '[]');
let unsubscribeProgress = null;
let sendInProgress = false;
let clientsData = [];
let contactsData = [];
let clientsPage = 1;
const PAGE_SIZE = 100;

// ===== 页面导航 ======================================================
const navItems = document.querySelectorAll('.nav-item');
const navSubs = document.querySelectorAll('.nav-sub');
const pages = document.querySelectorAll('.page');

// 父级导航：切换子菜单展开
document.querySelector('.nav-parent')?.addEventListener('click', function(e) {
  e.stopPropagation();
  this.classList.toggle('open');
  navSubs.forEach(s => s.classList.toggle('show'));
});

// 子导航 + 普通导航：切换页面
[...navItems, ...navSubs].forEach(item => {
  if (item.classList.contains('nav-parent')) return;
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    navSubs.forEach(s => s.classList.remove('active'));
    item.classList.add('active');

    // 高亮父级
    if (item.classList.contains('nav-sub')) {
      document.querySelector('.nav-parent')?.classList.add('active');
    }

    pages.forEach(p => p.classList.remove('active'));
    const pageId = item.dataset.page;
    document.getElementById(`page-${pageId}`)?.classList.add('active');

    if (pageId === 'dashboard') loadDashboard();
    if (pageId === 'clients') renderClientsTable();
    if (pageId === 'contacts') loadContacts();
    if (pageId === 'backcheck') loadBackcheck();
    if (pageId === 'template-editor') initTemplateEditor();
    if (pageId === 'signature') initSignature();
    if (pageId === 'email-send') initEmailSend();
    if (pageId === 'queue') renderQueue();
    if (pageId === 'settings') initSettings();
  });
});

// ===== 仪表盘 ========================================================
async function loadDashboard() {
  try {
    const stats = await window.electronAPI.getDashboardStats();
    document.getElementById('stat-sent').textContent = stats.sentToday;
    document.getElementById('stat-remaining').textContent = stats.remaining;
    document.getElementById('stat-queue').textContent = queue.length;
  } catch (e) {
    document.getElementById('stat-sent').textContent = '--';
  }
  try {
    const smtp = await window.electronAPI.checkSmtpStatus();
    const el = document.getElementById('stat-smtp');
    el.textContent = smtp.ok ? '已连接' : '未配置';
    el.style.color = smtp.ok ? 'var(--success)' : 'var(--warning)';
  } catch (e) {}
}

// ===== 客户表导入 ====================================================
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

if (dropZone) {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await doImport(file);
  });
}

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await doImport(file);
});

async function doImport(file) {
  const filePath = window.electronAPI.getFilePath(file);
  const result = await window.electronAPI.importFile(filePath);
  if (result.error) { alert('导入失败: ' + result.error); return; }
  clientsData = result.clients;
  clientsPage = 1;
  alert(`成功导入 ${clientsData.length} 条记录`);
  renderClientsTable();
}

function renderClientsTable() {
  const table = document.getElementById('clients-table');
  const tbody = table?.querySelector('tbody');
  const empty = document.getElementById('clients-empty');
  const toolbar = document.getElementById('clients-toolbar');
  const count = document.getElementById('clients-count');
  const pagination = document.getElementById('clients-pagination');

  if (!clientsData.length) {
    if (table) table.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    if (pagination) pagination.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = '';
  if (toolbar) toolbar.style.display = 'flex';
  if (count) count.textContent = `共 ${clientsData.length} 条记录（第 ${clientsPage}/${Math.ceil(clientsData.length / PAGE_SIZE)} 页）`;

  // 分页切片
  const start = (clientsPage - 1) * PAGE_SIZE;
  const pageData = clientsData.slice(start, start + PAGE_SIZE);

  if (tbody) {
    tbody.innerHTML = pageData.map((c, i) => `
      <tr>
        <td>${start + i + 1}</td>
        <td>${escapeHtml(c.company)}</td>
        <td>${escapeHtml(c.country)}</td>
        <td>${escapeHtml(c.category)}</td>
        <td>${escapeHtml(c.email)}</td>
      </tr>
    `).join('');
  }

  // 分页控件
  renderPagination(pagination, clientsData.length, clientsPage, (p) => {
    clientsPage = p;
    renderClientsTable();
  });
}

// 「保存到联系人」
document.getElementById('clients-import-btn')?.addEventListener('click', async () => {
  if (!clientsData.length) return alert('没有可导入的数据');
  const result = await window.electronAPI.importContacts(clientsData);
  let msg = `新增 ${result.added} 位联系人（总计 ${result.total} 位）`;
  if (result.skipped > 0) msg += `\n跳过 ${result.skipped} 条重复记录`;
  alert(msg);
});

// 「清除」
document.getElementById('clients-clear-btn')?.addEventListener('click', () => {
  clientsData = [];
  clientsPage = 1;
  renderClientsTable();
});

// ===== 联系人 ========================================================
let contactsGroupMap = new Map();
let selectedContactCompany = null;
let contactsFilter = 'all';  // all | agent | direct | unlabeled

let contactsSendHistory = {};

async function loadContacts() {
  contactsData = await window.electronAPI.getContacts();
  contactsSendHistory = await window.electronAPI.getSendHistory() || {};
  // 诊断：打印分类统计
  const diag = { agent: 0, direct: 0, unlabeled: 0, noField: 0 };
  const seen = new Set();
  for (const c of contactsData) {
    if (!seen.has(c.company)) { seen.add(c.company); diag[c.clientType || 'noField']++; }
  }
  console.log('📊 联系人分类:', JSON.stringify(diag), '| 公司数:', seen.size, '| 总人数:', contactsData.length);
  // 绑定筛选标签事件（仅一次）
  if (!window._contactsFilterBound) {
    window._contactsFilterBound = true;
    document.querySelectorAll('#contacts-filter .cf-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        contactsFilter = tab.dataset.filter;
        selectedContactCompany = null;
        renderContactsList();
      });
    });
  }
  renderContactsList();
}

function clientTypeTag(clientType) {
  const map = {
    agent: '<span class="ctype-tag ctype-agent">🌐 代理</span>',
    direct: '<span class="ctype-tag ctype-direct">🏭 直客</span>',
    unlabeled: '',
  };
  return map[clientType] || '';
}

function groupByCompany(data) {
  const groups = {};
  for (const c of data) {
    const key = c.company || '未命名';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
}

function renderContactsList(filtered) {
  let data = filtered || contactsData;

  // 应用类型筛选
  if (contactsFilter === 'archived') {
    data = data.filter(c => contactsSendHistory[c.company]?.stage === 'archived');
  } else if (contactsFilter !== 'all') {
    data = data.filter(c => (c.clientType || 'unlabeled') === contactsFilter);
  }

  const sidebar = document.getElementById('contacts-sidebar');
  const detail = document.getElementById('contacts-detail');
  const layout = document.getElementById('contacts-layout');
  const filterBar = document.getElementById('contacts-filter');
  const empty = document.getElementById('contacts-empty');
  const statsBar = document.getElementById('contacts-stats');

  if (!data.length) {
    if (empty) { empty.style.display = 'block'; empty.textContent = contactsFilter === 'archived' ? '暂无已归档客户 — 客户发完 F4 后自动归档' : contactsFilter !== 'all' ? '该分类暂无联系人' : '暂无联系人 — 从「导入客户」导入'; }
    if (layout) layout.style.display = 'none';
    if (statsBar) statsBar.style.display = 'none';
    if (filterBar) filterBar.style.display = 'none';
    contactsGroupMap.clear();
    selectedContactCompany = null;
    return;
  }

  if (empty) empty.style.display = 'none';
  if (layout) layout.style.display = 'flex';
  if (filterBar) filterBar.style.display = 'flex';

  // 统计各类型公司数（始终基于全部数据）
  const counts = { agent: 0, direct: 0, unlabeled: 0 };
  const seenCompanies = new Set();
  for (const c of contactsData) {
    const key = c.company;
    if (!seenCompanies.has(key)) {
      seenCompanies.add(key);
      counts[c.clientType || 'unlabeled']++;
    }
  }

  // 更新筛选标签（只更新文本和 active，不重建 DOM）
  const tabs = filterBar?.querySelectorAll('.cf-tab');
  if (tabs) {
    const labelMap = {
      all: `全部 ${seenCompanies.size}`,
      agent: `🌐 代理 ${counts.agent}`,
      direct: `🏭 直客 ${counts.direct}`,
      unlabeled: `❓ 未标签 ${counts.unlabeled}`,
      archived: `📦 已归档 ${Object.values(contactsSendHistory).filter(h => h?.stage === 'archived').length}`,
    };
    tabs.forEach(tab => {
      const f = tab.dataset.filter;
      tab.textContent = labelMap[f] || f;
      tab.classList.toggle('active', contactsFilter === f);
    });
  }

  const groups = groupByCompany(data).sort((a, b) => b[1].length - a[1].length);

  // 快速查找表
  contactsGroupMap.clear();
  for (const [company, members] of groups) {
    contactsGroupMap.set(company, members);
  }

  // 统计
  const vipCount = groups.filter(g => g[1].length >= 5).length;
  if (statsBar) {
    statsBar.style.display = 'flex';
    statsBar.innerHTML = `<span>👥 <strong>${data.length}</strong> 位联系人</span><span>🏢 <strong>${groups.length}</strong> 家公司</span><span>⭐ <strong>${vipCount}</strong> 可定制客户</span>`;
  }

  // 左侧公司列表
  if (sidebar) {
    sidebar.innerHTML = groups.map(([company, members]) => {
      const ctype = members[0]?.clientType || 'unlabeled';
      const tagHtml = clientTypeTag(ctype);
      const ctry = escapeHtml(members[0]?.country || '');
      const hist = contactsSendHistory[company];
      const stageLabel = hist?.stage ? `<span class="ci-stage-badge">${STAGE_LABELS_SEND[hist.stage] || hist.stage.toUpperCase()}</span>` : '';
      const vipClass = members.length >= 5 ? ' ci-vip' : '';
      const subParts = [tagHtml, ctry, stageLabel].filter(Boolean);
      return `
      <div class="contact-item${selectedContactCompany === company ? ' active' : ''}" data-company="${escapeHtml(company)}">
        <div class="ci-main">
          <span class="ci-name${vipClass}">${escapeHtml(company)}</span>
          <span class="ci-count">${members.length}</span>
        </div>
        <div class="ci-sub">${subParts.join(' · ')}</div>
      </div>`;
    }).join('');

    // 点击公司 → 右侧显示成员
    sidebar.querySelectorAll('.contact-item').forEach(item => {
      item.addEventListener('click', () => {
        sidebar.querySelectorAll('.contact-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        selectedContactCompany = item.dataset.company;
        renderContactDetail(selectedContactCompany);
      });
    });

    // 如果之前有选中，恢复选中状态；否则自动选第一个
    if (selectedContactCompany && contactsGroupMap.has(selectedContactCompany)) {
      renderContactDetail(selectedContactCompany);
    } else {
      selectedContactCompany = groups[0]?.[0] || null;
      if (selectedContactCompany) {
        const firstItem = sidebar.querySelector(`[data-company="${escapeHtml(selectedContactCompany)}"]`);
        if (firstItem) firstItem.classList.add('active');
        renderContactDetail(selectedContactCompany);
      }
    }
  }
}

function renderContactDetail(company) {
  const detail = document.getElementById('contacts-detail');
  if (!detail) return;
  const members = contactsGroupMap.get(company) || [];
  const ctype = members[0]?.clientType || 'unlabeled';
  const hist = contactsSendHistory[company];
  const isArchived = hist?.stage === 'archived';
  detail.innerHTML = `
    <div class="contacts-detail-header">${escapeHtml(company)} · ${members.length} 位联系人 ${clientTypeTag(ctype)}</div>
    <div class="contacts-detail-body">
      <table>
        <thead><tr><th>国家</th><th>品类</th><th>邮箱</th><th>添加时间</th><th>操作</th></tr></thead>
        <tbody>
          ${members.map(m => `
            <tr>
              <td>${escapeHtml(m.country)}</td>
              <td>${escapeHtml(m.category)}</td>
              <td>${escapeHtml(m.email)}</td>
              <td>${formatDate(m.addedAt)}</td>
              <td><button class="btn-delete danger" data-id="${m.id}">删除</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${isArchived ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;display:flex;align-items:center;gap:8px"><span style="font-size:13px">📦 已归档 — 不参与常规序列</span><button id="btn-reactivate-contact" style="margin-left:auto;font-size:12px;padding:4px 12px">🔄 重新激活</button></div>` : ''}
    </div>
  `;

  // 删除按钮
  detail.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该联系人？')) return;
      await window.electronAPI.deleteContact(btn.dataset.id);
      contactsData = contactsData.filter(c => c.id !== btn.dataset.id);
      renderContactsList();
    });
  });

  // 重新激活按钮
  const reactBtn = document.getElementById('btn-reactivate-contact');
  if (reactBtn) {
    reactBtn.addEventListener('click', async () => {
      if (!confirm(`确定重新激活 ${company}？\n将重置为冷开发阶段，清空序列记录。`)) return;
      await window.electronAPI.reactivateCompany(company);
      contactsSendHistory = await window.electronAPI.getSendHistory() || {};
      renderContactsList();
    });
  }
}

// 删除全部
document.getElementById('contacts-delete-all')?.addEventListener('click', async () => {
  if (!confirm('确定删除全部联系人？此操作不可恢复！')) return;
  await window.electronAPI.deleteAllContacts();
  contactsData = [];
  selectedContactCompany = null;
  renderContactsList();
});

// 搜索
document.getElementById('contacts-search')?.addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (!q) { renderContactsList(); return; }
  const results = await window.electronAPI.searchContacts(q);
  selectedContactCompany = null; // 搜索后重置选中
  renderContactsList(results);
});

// 「添加客户」→ 跳转到导入页
document.getElementById('contacts-add-btn')?.addEventListener('click', () => {
  navItems.forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="clients"]').classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById('page-clients').classList.add('active');
});

// ===== 背调详情 ======================================================
async function loadBackcheck() {
  const container = document.getElementById('backcheck-companies');
  if (!container) return;

  // 从联系人列表加载
  contactsData = await window.electronAPI.getContacts();
  const status = await window.electronAPI.getBackcheckStatus();

  if (!contactsData.length) {
    container.innerHTML = '<p style="color:var(--text-secondary);padding:12px">暂无联系人 — 请先在「联系人」中导入客户</p>';
    return;
  }

  // 按公司分组 → 仅保留 >=5 人的可定制客户
  let groups = groupByCompany(contactsData)
    .filter(([, members]) => members.length >= 5);

  // 排序：星级降序 → 人数降序
  groups.sort((a, b) => {
    const ra = status[a[0]]?.rating || 0;
    const rb = status[b[0]]?.rating || 0;
    if (ra !== rb) return rb - ra;
    return b[1].length - a[1].length;
  });

  if (!groups.length) {
    container.innerHTML = '<p style="color:var(--text-secondary);padding:12px">暂无符合条件的可定制客户（需同一公司 ≥5 位联系人）</p>';
    return;
  }

  container.innerHTML = groups.map(([company, members]) => {
    const st = status[company];
    const ctype = members[0]?.clientType || 'unlabeled';
    const tagHtml = clientTypeTag(ctype);
    const ctry = escapeHtml(members[0]?.country || '');
    const vipClass = members.length >= 5 ? ' ci-vip' : '';
    let badge = '⬜';
    if (st?.status === 'researching' || st?.status === 'pending') badge = '🔄';
    else if (st?.status === 'timeout') badge = '⏰';
    else if (st?.status === 'done') badge = st.rating ? ratingStars(st.rating) : '✅';
    const subParts = [tagHtml, ctry].filter(Boolean);
    return `<div class="backcheck-company" data-company="${escapeHtml(company)}">
      <div class="bc-main"><span class="bc-name${vipClass}">${escapeHtml(company)}</span><span class="bc-badge">${badge}</span><span class="bc-count">${members.length}人</span></div>
      <div class="bc-sub">${subParts.join(' · ')}</div>
    </div>`;
  }).join('');

  let selectedCompany = null;

  container.querySelectorAll('.backcheck-company').forEach(el => {
    el.addEventListener('click', async () => {
      container.querySelectorAll('.backcheck-company').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectedCompany = el.dataset.company;

      // 每次点击重新读取最新状态 + 背调数据
      const [detail, freshStatus] = await Promise.all([
        window.electronAPI.getBackcheckDetail(selectedCompany),
        window.electronAPI.getBackcheckStatus(),
      ]);

      // 如果报告有星级但状态文件没有，自动同步
      const currentSt = freshStatus[selectedCompany];
      if (detail?.rating > 0 && (!currentSt?.rating || currentSt.rating !== detail.rating)) {
        await window.electronAPI.markBackcheckDone(selectedCompany, detail.rating);
        freshStatus[selectedCompany] = { ...currentSt, rating: detail.rating, status: 'done' };
      }

      renderBackcheckCard(detail, selectedCompany, freshStatus[selectedCompany]);

      // 更新列表中该公司的状态图标
      const updatedSt = freshStatus[selectedCompany];
      let badge = '⬜';
      if (updatedSt?.status === 'researching' || updatedSt?.status === 'pending') badge = '🔄';
      else if (updatedSt?.status === 'done') badge = updatedSt.rating ? ratingStars(updatedSt.rating) : '✅';
      const badgeEl = el.querySelector('.bc-badge');
      if (badgeEl) badgeEl.textContent = badge;
    });
  });
}

function renderBackcheckCard(info, companyName, st) {
  const card = document.getElementById('backcheck-card');
  if (!card) return;

  const hasData = info?.raw && info.raw.length > 50;
  const isDone = st?.status === 'done';
  const isResearching = st?.status === 'researching';
  const isPending = st?.status === 'pending';
  const isTimeout = st?.status === 'timeout';

  let bodyHtml = '';
  if (hasData || isDone) {
    const mdText = info.raw || '';
    bodyHtml = `<div class="backcheck-report">${renderMarkdown(mdText)}</div>`;
  } else if (isResearching || isPending) {
    bodyHtml = `<p style="color:var(--warning);padding:20px;text-align:center">🔄 ${st?.progress || '处理中...'}</p>`;
  } else if (isTimeout) {
    bodyHtml = '<p style="color:var(--danger);padding:20px;text-align:center">⏰ 请求超时，请检查请求文件</p>';
  } else {
    bodyHtml = '<p style="color:var(--text-secondary);padding:20px;text-align:center">点击下方按钮开始背调</p>';
  }

  const rating = info?.rating || 0;
  const ratingHtml = rating > 0 ? `<div style="font-size:16px;margin-bottom:12px">货代开发价值：${ratingStars(rating)} <span style="font-size:12px;color:var(--text-secondary)">(${rating}/5)</span></div>` : '';

  const showProgress = isResearching || isPending || isTimeout;
  const showStartBtn = !isDone && !isResearching && !isPending;
  const showCancelBtn = isResearching || isPending;

  card.innerHTML = `
    ${ratingHtml}
    ${bodyHtml}
    ${showProgress ? `
      <div style="background:#f8f9fb;border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:12px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">📡 状态</div>
        <div style="font-size:13px;color:var(--primary)">${st?.progress || '等待处理...'}</div>
        ${isPending ? '<div style="font-size:11px;color:var(--warning);margin-top:6px">📋 请求文件已生成，对 Claude 说「处理背调请求」即可自动完成</div>' : ''}
        ${isTimeout ? '<div style="font-size:11px;color:var(--danger);margin-top:6px">报告未在 10 分钟内生成，请手动检查</div>' : ''}
      </div>
    ` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;border-top:1px solid var(--border);padding-top:12px;flex-wrap:wrap">
      ${showStartBtn ? `<button id="btn-research">🔍 开始背调</button>` : ''}
      ${isDone ? `<button class="secondary" disabled>${rating > 0 ? ratingStars(rating) + ' 已评定' : '✅ 已完成背调'}</button>` : ''}
      ${isDone ? '<button id="btn-recheck" class="secondary">🔄 重新调查</button>' : ''}
      ${showCancelBtn ? '<button id="btn-cancel-research" class="secondary danger">✕ 取消</button>' : ''}
    </div>
    <div style="text-align:center;margin-top:8px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button id="btn-open-folder" class="secondary" style="font-size:12px;padding:6px 16px">📂 打开报告文件夹</button>
      ${isDone ? '<button id="btn-translate" class="secondary" style="font-size:12px;padding:6px 16px">🌐 翻译报告</button>' : ''}
      ${contactsSendHistory[companyName]?.stage === 'archived' ? '<button id="btn-reactivate-bc" class="secondary" style="font-size:12px;padding:6px 16px;color:var(--success)">🔄 重新激活</button>' : ''}
      <span id="translate-status" style="font-size:11px;color:var(--text-secondary);display:none"></span>
    </div>
  `;

  // 开始背调 / 重新调查
  document.getElementById('btn-research')?.addEventListener('click', () => doResearch(companyName));
  document.getElementById('btn-recheck')?.addEventListener('click', () => doResearch(companyName));

  // 翻译报告
  document.getElementById('btn-translate')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-translate');
    const status = document.getElementById('translate-status');
    const reportEl = card.querySelector('.backcheck-report');
    if (!reportEl || !btn) return;

    // 如果已翻译，切回原文
    if (btn.dataset.translated === '1') {
      reportEl.innerHTML = renderMarkdown(info.raw);
      btn.textContent = '🌐 翻译报告';
      btn.dataset.translated = '0';
      if (status) { status.style.display = 'none'; status.textContent = ''; }
      return;
    }

    // 开始翻译
    btn.disabled = true;
    btn.textContent = '⏳ 翻译中...';
    if (status) { status.style.display = 'inline'; status.textContent = '正在调用翻译接口...'; }

    try {
      const result = await window.electronAPI.translateReport(info.raw);
      if (result.ok) {
        reportEl.innerHTML = renderMarkdown(result.text);
        btn.textContent = '📄 查看原文';
        btn.dataset.translated = '1';
        if (status) { status.style.display = 'none'; }
      } else {
        const msg = result.error === 'no_keys'
          ? '未配置翻译 API Key，请在设置中填写有道/百度翻译'
          : (result.message || '翻译失败');
        if (status) { status.style.display = 'inline'; status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; }
        btn.textContent = '🌐 翻译报告';
      }
    } catch (e) {
      if (status) { status.style.display = 'inline'; status.textContent = '❌ 网络异常，请检查连接'; status.style.color = 'var(--danger)'; }
      btn.textContent = '🌐 翻译报告';
    }
    btn.disabled = false;
  });

  async function doResearch(companyName) {
    const contact = contactsData.find(c => (c.company || '').trim() === (companyName || '').trim());
    if (!contact) { alert('未找到联系人: ' + companyName); return; }

    // 即刻反馈
    const card = document.getElementById('backcheck-card');
    const btn = document.getElementById('btn-research') || document.getElementById('btn-recheck');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 搜索中...'; }
    if (card) {
      card.innerHTML = '<p style="color:var(--primary);padding:20px;text-align:center;font-size:14px">🔄 正在搜索 ' + escapeHtml(companyName) + ' ...</p>'
        + '<p style="color:var(--text-secondary);text-align:center;font-size:12px" id="research-progress">启动中...</p>';
    }

    // 监听后台进度
    let unsub = null;
    if (window.electronAPI.onBackcheckProgress) {
      unsub = window.electronAPI.onBackcheckProgress(async (data) => {
        if (data.company !== companyName) return;
        const progEl = document.getElementById('research-progress');
        if (progEl && data.type === 'research-progress') progEl.textContent = data.progress || '';
        if (data.type === 'research-done') {
          if (unsub) unsub();
          // 直接更新卡片，不等全量刷新
          const [detail, status] = await Promise.all([
            window.electronAPI.getBackcheckDetail(companyName),
            window.electronAPI.getBackcheckStatus(),
          ]);
          renderBackcheckCard(detail, companyName, status[companyName]);
          // 更新左侧列表的状态图标
          const item = document.querySelector(`.backcheck-company[data-company="${escapeHtml(companyName)}"]`);
          if (item) {
            const st = status[companyName];
            const badge = st?.status === 'done' ? (st.rating ? ratingStars(st.rating) : '✅') : '⬜';
            const span = item.querySelector('span:last-child');
            if (span) span.textContent = badge;
          }
        }
      });
    }

    const result = await window.electronAPI.startResearch(contact);
    if (!result.ok) {
      if (unsub) unsub();
      alert(result.message || '启动失败');
      loadBackcheck();
    }
  }

  // 取消调查
  document.getElementById('btn-cancel-research')?.addEventListener('click', async () => {
    if (!confirm('确定取消该公司的背调请求？')) return;
    await window.electronAPI.cancelBackcheck(companyName);
    loadBackcheck();
  });

  // 打开报告文件夹
  document.getElementById('btn-open-folder')?.addEventListener('click', () => {
    window.electronAPI.openReportsFolder?.();
  });

  // 重新激活（背调页）
  document.getElementById('btn-reactivate-bc')?.addEventListener('click', async () => {
    if (!confirm(`确定重新激活 ${companyName}？\n将重置为冷开发阶段，清空序列记录。`)) return;
    await window.electronAPI.reactivateCompany(companyName);
    contactsSendHistory = await window.electronAPI.getSendHistory() || {};
    loadBackcheck();
  });
}


// ===== 邮件发送 ======================================================
const STAGES_SEND = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
const STAGE_LABELS_SEND = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', archived: '📦 已归档' };
const STAGE_NEXT_SEND = { '': 'cold', cold: 'f1', f1: 'f2', f2: 'f3', f3: 'f4', f4: 'archived', archived: 'archived' };

let sendCompanies = {};
let sendHistory = {};
let selectedCards = {};
let selectedCompanySet = new Set(); // 持久化勾选状态，搜索不清除

async function initEmailSend() {
  if (!templateLib) templateLib = await window.electronAPI.getTemplateLibrary();
  document.getElementById('ws-add-queue').addEventListener('click', addToQueue);
  document.getElementById('monthly-generate-btn')?.addEventListener('click', generateMonthlyReports);
  await loadSendContacts();
}

function updateMonthlyReportSection() {
  const section = document.getElementById('monthly-report-section');
  const countEl = document.getElementById('monthly-archived-count');
  if (!section || !countEl) return;
  const archivedCount = Object.entries(sendCompanies)
    .filter(([name]) => sendHistory[name]?.stage === 'archived').length;
  if (archivedCount > 0) {
    section.style.display = 'block';
    countEl.textContent = `${archivedCount} 家归档客户`;
  } else {
    section.style.display = 'none';
  }
}

async function loadSendContacts() {
  contactsData = await window.electronAPI.getContacts();
  sendHistory = await window.electronAPI.getSendHistory() || {};
  sendCompanies = {};
  for (const c of contactsData) {
    const name = c.company || '未命名';
    if (!sendCompanies[name]) sendCompanies[name] = [];
    sendCompanies[name].push(c);
  }
  renderCompanyList();
  updateMonthlyReportSection();
}

function renderCompanyList(filter) {
  const container = document.getElementById('send-company-list');
  let companies = Object.entries(sendCompanies).sort((a,b) => b[1].length - a[1].length);
  if (filter) companies = companies.filter(([n]) => n.toLowerCase().includes(filter));
  // 已归档公司不出现在发送列表
  companies = companies.filter(([name]) => sendHistory[name]?.stage !== 'archived');
  if (!companies.length) {
    container.innerHTML = '<p style="font-size:12px;color:var(--text-secondary);padding:8px">无匹配公司</p>';
    return;
  }
  container.innerHTML = companies.map(([name, members]) => {
    const ctype = members[0]?.clientType || 'unlabeled';
    const tagHtml = clientTypeTag(ctype);
    const ctry = escapeHtml(members[0]?.country || '');
    const hist = sendHistory[name];
    const stageLabel = hist?.stage ? `<span class="sci-stage">${STAGE_LABELS_SEND[hist.stage]}</span>` : '';
    const vipClass = members.length >= 5 ? ' ci-vip' : '';
    const subParts = [tagHtml, ctry, stageLabel].filter(Boolean);
    return `<div class="send-company-item" data-company="${escapeHtml(name)}">
      <input type="checkbox" class="sc-check" data-company="${escapeHtml(name)}"${selectedCompanySet.has(name) ? ' checked' : ''}>
      <div class="sci-info">
        <span class="ci-name${vipClass}">${escapeHtml(name)}</span>
        ${subParts.length ? `<span class="sci-sub">${subParts.join(' · ')}</span>` : ''}
      </div>
      <span class="ci-count">${members.length}</span>
    </div>`;
  }).join('');
  updateSelectedCount();
  container.querySelectorAll('.send-company-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const cb = el.querySelector('.sc-check');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    el.querySelector('.sc-check').addEventListener('change', (e) => {
      const name = e.target.dataset.company;
      if (e.target.checked) selectedCompanySet.add(name);
      else selectedCompanySet.delete(name);
      updateSelectedCount();
    });
  });
}

function getSelectedCompanies() {
  return [...selectedCompanySet];
}

function updateSelectedCount() {
  const selected = getSelectedCompanies();
  document.getElementById('send-selected-count').textContent = selected.length ? `已选 ${selected.length} 家` : '';
  renderSelectedCards();
}

function renderSelectedCards() {
  const container = document.getElementById('send-company-cards');
  const empty = document.getElementById('send-cards-empty');
  const title = document.getElementById('send-list-title');
  const selected = getSelectedCompanies();
  if (!selected.length) {
    if (container) container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    if (title) title.textContent = '已选公司';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (title) title.textContent = `已选公司 (${selected.length})`;
  for (const name of selected) {
    if (!selectedCards[name]) {
      const members = sendCompanies[name] || [];
      const ctype = members[0]?.clientType || 'unlabeled';
      const hist = sendHistory[name];
      const stage = hist?.stage || 'cold';
      const lang = (members[0]?.country || '').includes('Brasil') ? 'pt' : 'es';
      const isArgentina = (members[0]?.country || '').toLowerCase().includes('argentina');
      const usedSentences = hist?.usedSentences || [];
      selectedCards[name] = { type: ctype, stage, lang, isArgentina, template: randomPick(ctype, stage, usedSentences, isArgentina) };
    }
  }
  for (const name of Object.keys(selectedCards)) {
    if (!selected.includes(name)) delete selectedCards[name];
  }
  if (container) {
    container.innerHTML = selected.map(name => {
      const card = selectedCards[name];
      const members = sendCompanies[name] || [];
      const emailCount = members.filter(m => m.email).length;
      const ctry = escapeHtml(members[0]?.country || '');
      const nextLabel = STAGE_LABELS_SEND[STAGE_NEXT_SEND[card.stage]] || 'F1';
      const typeLabel = card.type === 'agent' ? '代理' : card.type === 'direct' ? '直客' : '通用';
      return `<div class="sc-card">
        <div class="sc-card-header">
          <strong>${escapeHtml(name)}</strong>
          <span class="sc-stage">${STAGE_LABELS_SEND[card.stage]} → ${nextLabel}</span>
          <button class="sc-card-remove" data-company="${escapeHtml(name)}">✕</button>
        </div>
        <div class="sc-card-meta">
          <span>${emailCount} 收件人</span>
          ${ctry ? `<span>${ctry}</span>` : ''}
          <span>${typeLabel}模板</span>
          <span>${card.lang.toUpperCase()}</span>
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll('.sc-card-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedCompanySet.delete(btn.dataset.company);
        updateSelectedCount();
      });
    });
  }
}

function randomPick(type, stage, usedSentences, isArgentina) {
  if (!templateLib) return {};
  const usedSet = new Set(usedSentences || []);

  // 从数组随机选取，支持变体过滤和已用排除
  const pick = (arr, filterMode) => {
    if (!arr || !arr.length) return null;
    let pool = arr.filter(item => !usedSet.has(item.id));

    if (filterMode === 'ar') {
      // 阿根廷：优先 H-A*/C-A* 变体；没有则回退普通
      const arOnly = pool.filter(item => item.id.includes('-A'));
      if (arOnly.length > 0) pool = arOnly;
      else pool = pool.filter(item => !item.id.includes('-A'));
    } else if (filterMode === 'no-ar') {
      // 非阿根廷：排除变体
      pool = pool.filter(item => !item.id.includes('-A'));
    }
    // filterMode === 'any': 不做过滤

    // 全部已用过则重置（开始新序列）
    if (pool.length === 0) {
      pool = [...arr];
      if (filterMode === 'no-ar') pool = pool.filter(item => !item.id.includes('-A'));
    }
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // F3: 不用 Hook/Pain（降低压力，留门）
  // F4: 不用 Hook/Pain/Proof（收尾降级）
  const skipHook = (stage === 'f3' || stage === 'f4');
  const skipPain = (stage === 'f3' || stage === 'f4');
  const skipProof = (stage === 'f4');
  const hookMode = isArgentina ? 'ar' : 'no-ar';
  const ctaMode = isArgentina ? 'ar' : 'no-ar';

  return {
    hook: skipHook ? null : pick(templateLib.hooks, hookMode),
    pain: skipPain ? null : pick(templateLib.painPoints?.[type], 'any'),
    proof: skipProof ? null : pick(templateLib.proofs?.[type], 'any'),
    cta: pick(templateLib.ctas, ctaMode),
    followup: (stage !== 'cold' && stage !== 'archived') ? pick(templateLib.followUps?.[stage], 'any') : null,
  };
}

function addToQueue() {
  const selected = getSelectedCompanies();
  if (!selected.length) return alert('请先勾选左侧公司');
  let added = 0, totalContacts = 0;
  for (const name of selected) {
    const card = selectedCards[name];
    if (!card) continue;
    const members = sendCompanies[name] || [];
    const emails = members.map(m => m.email).filter(Boolean);
    if (!emails.length) continue;
    const tpl = card.template;
    const lang = card.lang;
    const body = assembleEmail(lang, tpl.hook, tpl.pain, tpl.proof, tpl.cta, tpl.followup, name, card.stage, card.type, card.isArgentina);
    const subjects = templateLib.subjects?.[card.type] || { es: '', pt: '', en: '' };
    const subject = subjects[lang] || subjects.es || '';
    const sentenceIds = [tpl.hook?.id, tpl.pain?.id, tpl.proof?.id, tpl.cta?.id, tpl.followup?.id].filter(Boolean);
    queue.push({ id: Date.now() + added, company: name, to: emails.join(', '), recipients: emails, subject, body, status: 'pending', addedAt: new Date().toISOString(), _stage: card.stage, _sentences: sentenceIds });
    // 记录已用句子（异步，不阻塞）
    window.electronAPI.recordSentences(name, sentenceIds).catch(() => {});
    added++;
    totalContacts += emails.length;
  }
  if (!added) return alert('所选公司无有效邮箱');
  saveQueue();
  document.getElementById('stat-queue').textContent = queue.length;
  // 跳转到发送队列
  navItems.forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="queue"]').classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById('page-queue').classList.add('active');
  renderQueue();
}

document.getElementById('send-select-all')?.addEventListener('click', () => {
  document.querySelectorAll('.sc-check').forEach(cb => {
    cb.checked = true;
    if (cb.dataset.company) selectedCompanySet.add(cb.dataset.company);
  });
  updateSelectedCount();
});
document.getElementById('send-deselect-all')?.addEventListener('click', () => {
  selectedCompanySet.clear();
  document.querySelectorAll('.sc-check').forEach(cb => { cb.checked = false; });
  updateSelectedCount();
});
document.getElementById('send-search')?.addEventListener('input', (e) => {
  renderCompanyList(e.target.value.toLowerCase());
});

// ===== 模板编辑器 =====================================================

const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4'];
const STAGE_LABELS = { cold: '冷开发', f1: '第1次跟进', f2: '第2次跟进', f3: '第3次跟进', f4: '第4次跟进' };
const TYPES = { agent: '代理', direct: '直客', unlabeled: '未标签' };
const PAIN_KEY = { agent: 'agent', direct: 'direct', unlabeled: 'unlabeled' };
const PROOF_KEY = { agent: 'agent', direct: 'direct', unlabeled: 'unlabeled' };

async function initTemplateEditor() {
  try {
    if (!templateLib) templateLib = await window.electronAPI.getTemplateLibrary();
    if (!templateLib || !templateLib.hooks) {
      document.getElementById('tmpl-tree').innerHTML = '<p style="color:var(--danger);padding:12px">模板加载失败，请重启应用</p>';
      return;
    }
  } catch(e) {
    document.getElementById('tmpl-tree').innerHTML = '<p style="color:var(--danger);padding:12px">模板加载失败: ' + e.message + '</p>';
    return;
  }
  // 初始化每阶段独立句库（深拷贝共享库）
  if (!templateLib._stages) {
    templateLib._stages = {};
    for (const type of Object.keys(TYPES)) {
      templateLib._stages[type] = {};
      for (const stage of STAGES) {
        templateLib._stages[type][stage] = {
          hooks: JSON.parse(JSON.stringify(templateLib.hooks || [])),
          pains: JSON.parse(JSON.stringify((templateLib.painPoints?.[PAIN_KEY[type]] || []))),
          proofs: JSON.parse(JSON.stringify((templateLib.proofs?.[PROOF_KEY[type]] || []))),
          ctas: JSON.parse(JSON.stringify(templateLib.ctas || [])),
          followups: JSON.parse(JSON.stringify((templateLib.followUps?.[stage] || []))),
        };
      }
    }
  }
  buildTree();
}

function buildTree() {
  const tree = document.getElementById('tmpl-tree');
  if (!tree) return;

  let html = '<ul class="tmpl-tree-list">';

  // 主题行（独立项）
  html += `<li class="tn-leaf"><div class="tn-label" data-node="subjects">🏷️ 主题行</div></li>`;

  // 三个客户类型下拉分组
  const typeIcons = { agent: '🌐', direct: '🏭', unlabeled: '❓' };
  for (const [type, label] of Object.entries(TYPES)) {
    html += `<li class="tn-folder open">`;
    html += `<div class="tn-label tn-folder-title"><span class="tn-arrow">▶</span>${typeIcons[type]} ${label}</div>`;
    html += `<ul class="tn-sublist">`;
    for (const stage of STAGES) {
      html += `<li class="tn-leaf"><div class="tn-label" data-node="${type}|${stage}">${STAGE_LABELS[stage]}</div></li>`;
    }
    html += `</ul></li>`;
  }

  // 垃圾词黑名单（独立项）
  html += `<li class="tn-leaf"><div class="tn-label" data-node="spam">🚫 垃圾词黑名单</div></li>`;

  html += '</ul>';
  tree.innerHTML = html;

  // 点击事件
  tree.querySelectorAll('.tn-label').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();

      // 点击的是文件夹标题 → 折叠/展开
      const folder = el.closest('.tn-folder');
      if (folder && el === folder.querySelector(':scope > .tn-label')) {
        folder.classList.toggle('open');
        return;
      }

      // 点击的是编辑项 → 高亮并显示编辑器
      tree.querySelectorAll('.tn-label.active').forEach(a => a.classList.remove('active'));
      el.classList.add('active');
      const node = el.dataset.node;
      if (node === 'subjects') showSubjectEditor();
      else if (node === 'spam') showSpamEditor();
      else showStageEditor(node);
    });
  });
}

function showSubjectEditor() {
  const panel = document.getElementById('tmpl-edit');
  const subs = templateLib.subjects;
  panel.innerHTML = '<h3>🏷️ 主题行</h3>' + Object.entries(TYPES).map(([type, label]) => `
    <div class="tmpl-section"><h4>${label}</h4>
      <div class="tmpl-sentence">
        <span class="ts-id">ES</span><div class="ts-body"><span class="ts-lang">西语</span>
        <textarea data-type="${type}" data-lang="es">${escapeHtml(subs[type]?.es||'')}</textarea></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">PT</span><div class="ts-body"><span class="ts-lang">葡语</span>
        <textarea data-type="${type}" data-lang="pt">${escapeHtml(subs[type]?.pt||'')}</textarea></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">EN</span><div class="ts-body"><span class="ts-lang">英语</span>
        <textarea data-type="${type}" data-lang="en">${escapeHtml(subs[type]?.en||'')}</textarea></div>
      </div>
    </div>
  `).join('') + '<button onclick="saveSubjects()" style="margin-top:8px">💾 保存主题行</button>';
}

function saveSubjects() {
  if (!confirm('确定保存主题行修改？')) return;
  document.querySelectorAll('#tmpl-edit textarea').forEach(ta => {
    const type = ta.dataset.type, lang = ta.dataset.lang;
    if (templateLib.subjects[type]) templateLib.subjects[type][lang] = ta.value;
  });
  alert('已保存');
}

function showStageEditor(node) {
  const [type, stage] = node.split('|');
  const stageData = templateLib._stages?.[type]?.[stage];
  if (!stageData) return;
  const panel = document.getElementById('tmpl-edit');

  const groups = [['hooks','Hook 破冰句'],['pains','Pain Point 痛点句'],['proofs','Proof 证明句'],['ctas','CTA 行动呼吁'],['followups','衔接句']];

  // 读垃圾词黑名单
  const spamWords = templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>👤 ${TYPES[type]} · ${STAGE_LABELS[stage]}</h3>` +
    groups.map(([key, title]) => {
      const items = stageData[key] || [];
      if (!items.length) return '';
      return `<div class="tmpl-section"><h4>${title}</h4>` + items.map((item, i) => `
        <div class="tmpl-sentence" data-key="${key}" data-index="${i}">
          <span class="ts-id">${item.id}</span>
          <div class="ts-body">
            <div class="ts-row">
              <span class="ts-lang">ES</span>
              <textarea class="ts-es">${escapeHtml(item.es||'')}</textarea>
              <span class="ts-check" data-lang="es"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">PT</span>
              <textarea class="ts-pt">${escapeHtml(item.pt||'')}</textarea>
              <span class="ts-check" data-lang="pt"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">EN</span>
              <textarea class="ts-en">${escapeHtml(item.en||'')}</textarea>
              <span class="ts-check" data-lang="en"></span>
            </div>
          </div>
        </div>
      `).join('') + '</div>';
    }).join('') +
    `<button id="btn-save-stage" style="margin-top:8px">💾 保存</button>
    <div id="quality-report" style="margin-top:12px;font-size:12px"></div>`;

  // 质量检查
  const limitES = 150, limitPT = 155, limitEN = 120;
  const allChecks = panel.querySelectorAll('.ts-check');
  const allAreas = panel.querySelectorAll('textarea');

  function wordCount(text) { return text.trim().split(/\s+/).filter(Boolean).length; }
  function hasSpam(text, lang) {
    const words = spamWords[lang] || [];
    const lower = text.toLowerCase();
    return words.filter(w => lower.includes(w.toLowerCase()));
  }

  function runQualityCheck() {
    const issues = [];
    allAreas.forEach(ta => {
      const lang = ta.classList.contains('ts-es') ? 'es' : ta.classList.contains('ts-pt') ? 'pt' : 'en';
      const limit = lang === 'es' ? limitES : lang === 'pt' ? limitPT : limitEN;
      const text = ta.value;
      const wc = wordCount(text);
      const spam = hasSpam(text, lang);
      const row = ta.closest('.ts-row');
      const check = row?.querySelector('.ts-check');

      let status = '✅';
      if (wc > limit) { status = '⚠️'; issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 超字数 (${wc}/${limit})`); }
      if (spam.length) { status = '🚫'; issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 含垃圾词: ${spam.slice(0,3).join(', ')}`); }
      if (check) check.textContent = status + ` ${wc}词`;
    });

    const byGroup = {};
    allAreas.forEach(ta => {
      const langCls = ta.classList.contains('ts-es') ? 'es' : ta.classList.contains('ts-pt') ? 'pt' : 'en';
      const key = ta.closest('.tmpl-sentence')?.dataset.key + '/' + langCls;
      if (!byGroup[key]) byGroup[key] = [];
      byGroup[key].push({ ta, text: ta.value.trim() });
    });
    for (const [, group] of Object.entries(byGroup)) {
      const seen = new Map();
      group.forEach(({ ta, text }) => {
        if (!text) return;
        if (seen.has(text)) issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} 与 ${seen.get(text)} 重复`);
        else seen.set(text, ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent);
      });
    }

    // 汇总报告
    const report = document.getElementById('quality-report');
    if (!report) return;
    if (issues.length === 0) {
      report.innerHTML = '<div style="color:var(--success);padding:8px;background:#e8f5e9;border-radius:4px">✅ 全部通过 — 无字数超标、无垃圾词、无重复</div>';
    } else {
      report.innerHTML = `<div style="color:var(--danger);padding:8px;background:#ffebee;border-radius:4px">🚫 ${issues.length} 个问题：<br>${issues.map(s => '· ' + s).join('<br>')}</div>`;
    }
  }

  allAreas.forEach(ta => ta.addEventListener('input', runQualityCheck));
  runQualityCheck();

  document.getElementById('btn-save-stage')?.addEventListener('click', () => {
    if (!confirm('确定保存该阶段句库修改？')) return;
    panel.querySelectorAll('.tmpl-sentence').forEach(el => {
      const key = el.dataset.key, idx = parseInt(el.dataset.index);
      const es = el.querySelector('.ts-es')?.value || '';
      const pt = el.querySelector('.ts-pt')?.value || '';
      const en = el.querySelector('.ts-en')?.value || '';
      if (stageData[key] && stageData[key][idx]) {
        stageData[key][idx].es = es;
        stageData[key][idx].pt = pt;
        stageData[key][idx].en = en;
      }
    });
    alert('已保存');
    updatePreview();
  });
}

function showSpamEditor() {
  const panel = document.getElementById('tmpl-edit');
  const sections = [
    { cat: 'hard', title: '🔴 硬禁止（命中即拦截）', rules: [
      { word: 'más grande, el mejor, #1, best, largest...', reason: '最高级/排名类 → 垃圾过滤器首要打击' },
      { word: 'urgente, actúa ahora, last chance...', reason: '制造紧迫感 → 垃圾信号' },
      { word: 'garantizado, 100%, risk-free...', reason: '夸大承诺 → 过度承诺触发过滤' },
      { word: 'oferta especial, descuento, deal...', reason: '价格诱饵 → 促销=广告' },
      { word: '全大写词 / 感叹号 !', reason: '垃圾邮件典型特征' },
    ]},
    { cat: 'soft', title: '🟡 软限制（每封最多1次）', rules: [
      { word: 'líder / leading', reason: '每封最多1次，需紧跟事实支撑' },
      { word: 'sin costo / at no cost', reason: '仅限CTA中使用1次' },
    ]},
    { cat: 'context', title: '⚪ 上下文规则', rules: [
      { word: '船东名 + 具体运价数字', reason: '同一封邮件不能同时出现' },
      { word: '本地仓库 / 本地团队', reason: '代理模板禁止提及' },
      { word: 'digital / AI / 平台 / technology', reason: '对海外客户禁用技术词汇' },
    ]},
  ];

  panel.innerHTML = `<h3>🚫 垃圾词黑名单</h3>` + sections.map(s => `
    <div class="tmpl-section"><h4>${s.title}</h4>
    ${s.rules.map(r => `
      <div class="spam-rule ${s.cat}">
        <span class="sr-word">${escapeHtml(r.word)}</span>
        <span class="sr-reason">${escapeHtml(r.reason)}</span>
      </div>
    `).join('')}
    </div>
  `).join('') + '<p style="font-size:11px;color:var(--text-secondary);margin-top:12px">修改规则请编辑 templates/general-templates.md</p>';
}

// ===== 签名管理 =======================================================

async function initSignature() {
  // 从 send/signature.html 加载
  const result = await window.electronAPI.loadSignature();
  const editor = document.getElementById('sig-content');
  const preview = document.getElementById('sig-preview');
  if (editor && result.ok) editor.innerHTML = result.html;
  if (preview && result.ok) preview.innerHTML = result.html;

  // 实时预览
  if (editor) {
    editor.addEventListener('input', () => {
      if (preview) preview.innerHTML = editor.innerHTML;
    });
  }
}

document.getElementById('sig-open-folder')?.addEventListener('click', () => {
  window.electronAPI.openSendFolder();
});

document.getElementById('sig-save')?.addEventListener('click', async () => {
  const html = document.getElementById('sig-content')?.innerHTML || '';
  const result = await window.electronAPI.saveSignature(html);
  alert(result.ok ? '✅ 签名已保存到 send/signature.html' : '❌ 保存失败');
});

function populateSelect(id, items) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = items.map(i => `<option value="${i.id}">${i.id}: ${truncate(i.es, 60)}</option>`).join('');
}

function populateCTA() {
  const sel = document.getElementById('ws-cta');
  if (!sel || !templateLib) return;
  sel.innerHTML = templateLib.ctas.map(c => `<option value="${c.id}">${c.id}: ${truncate(c.es, 50)}</option>`).join('');
}

function updatePainProofOptions() {
  // 旧版 Workshop 函数，已废弃 — 保留空壳防止引用报错
}

// ── 辅助文本函数（按客户类型 + 语言切换）────────────────────────────
function breathingRoomText(lang, type) {
  const map = {
    agent: {
      es: 'Si alguna vez tu capacidad actual se queda corta — o simplemente quieres comparar opciones — tener un respaldo cuesta cero y puede ahorrar muchos dolores de cabeza.',
      pt: 'Se alguma vez sua capacidade atual ficar limitada — ou simplesmente quiser comparar opções — ter um respaldo não custa nada e pode evitar muitas dores de cabeça.',
      en: "If your current capacity ever falls short — or you simply want to compare options — having backup costs nothing and can save you plenty of headaches.",
    },
    direct: {
      es: 'Si alguna vez tu operación actual enfrenta una demora o un imprevisto en aduana, contar con una alternativa probada puede ahorrarte semanas y costos inesperados.',
      pt: 'Se alguma vez sua operação atual enfrentar um atraso ou imprevisto na alfândega, contar com uma alternativa comprovada pode economizar semanas e custos inesperados.',
      en: 'If your current operation ever hits a customs delay or an unexpected snag, having a proven alternative can save you weeks and unplanned costs.',
    },
    unlabeled: {
      es: 'Si alguna vez necesitas apoyo logístico o simplemente quieres explorar alternativas, estoy a tu disposición.',
      pt: 'Se alguma vez você precisar de apoio logístico ou simplesmente quiser explorar alternativas, estou à sua disposição.',
      en: "If you ever need logistics support or simply want to explore alternatives, I'm at your disposal.",
    },
  };
  return (map[type] || map.unlabeled)[lang] || '';
}

function f4ClosingText(lang, type) {
  const map = {
    agent: {
      es: 'Si en el futuro necesitas respaldo de espacio o comparar opciones de naviera, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro você precisar de respaldo de espaço ou comparar opções de armador, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future you need space backup or want to compare carrier options, I'm here. No strings, no rush.",
    },
    direct: {
      es: 'Si en el futuro tu operación aduanal necesita un respaldo confiable, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro sua operação aduaneira precisar de um respaldo confiável, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future your customs operation needs reliable backup, I'm here. No strings, no rush.",
    },
    unlabeled: {
      es: 'Si en el futuro necesitas explorar opciones logísticas, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro você quiser explorar opções logísticas, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future you want to explore logistics options, I'm here. No strings, no rush.",
    },
  };
  return (map[type] || map.unlabeled)[lang] || '';
}

function f4FollowupText(lang, type) {
  const map = {
    agent: {
      es: 'Mientras tanto, de vez en cuando te compartiré alguna información de mercado que pueda ser útil para tu operación.',
      pt: 'Enquanto isso, de vez em quando compartilharei informações de mercado que possam ser úteis para sua operação.',
      en: "In the meantime, I'll occasionally share market insights that might be useful for your operation.",
    },
    direct: {
      es: 'Mientras tanto, te compartiré ocasionalmente información de mercado que pueda ser relevante para tus importaciones.',
      pt: 'Enquanto isso, compartilharei ocasionalmente informações de mercado que possam ser relevantes para suas importações.',
      en: "In the meantime, I'll occasionally share market insights that might be relevant to your imports.",
    },
    unlabeled: {
      es: 'Te compartiré de vez en cuando información del mercado que pueda resultarte útil.',
      pt: 'Compartilharei de vez em quando informações do mercado que possam ser úteis para você.',
      en: "I'll occasionally share market insights that might be useful to you.",
    },
  };
  return (map[type] || map.unlabeled)[lang] || '';
}

function assembleEmail(lang, hook, pain, proof, cta, followup, company, stage, type, isArgentina) {
  const t = (item) => item ? (item[lang] || '') : '';
  const lines = [];

  // 问候
  const greeting = lang === 'es' ? 'Buen día,' : lang === 'pt' ? 'Bom dia,' : 'Hello,';
  lines.push(greeting);
  lines.push('');

  // F1-F4: 跟进衔接句
  if (stage !== 'cold' && followup) {
    lines.push(t(followup));
    lines.push('');
  }

  // Hook（F3/F4 跳过）
  if (hook) lines.push(t(hook));

  // 冷开发：公司提及
  if (company && stage === 'cold') {
    lines.push('');
    lines.push(lang === 'es'
      ? `Sé que ${company} importa regularmente.`
      : lang === 'pt'
      ? `Sei que a ${company} importa regularmente.`
      : `I know ${company} imports regularly.`);
  }

  // Pain Point（F3/F4 跳过）
  if (pain) {
    lines.push('');
    lines.push(t(pain));
  }

  // Proof / F4收尾文
  lines.push('');
  const name = lang === 'es' ? 'Soy Zayne, de YQN.' : lang === 'pt' ? 'Sou Zayne, da YQN.' : "I'm Zayne from YQN.";

  if (stage === 'f4') {
    // F4: 收尾降级专用文本（来自模板正文）
    lines.push(f4ClosingText(lang, type));
    lines.push('');
    lines.push(f4FollowupText(lang, type));
  } else if (proof) {
    lines.push(name + ' ' + t(proof));
  } else {
    lines.push(name);
  }

  // 冷开发：呼吸句（按客户类型切换）
  if (stage === 'cold') {
    lines.push('');
    lines.push(breathingRoomText(lang, type));
  }

  // CTA
  if (cta) {
    lines.push('');
    lines.push(t(cta));
  }

  // 结语（阿根廷用 Un abrazo）
  lines.push('');
  const closing = isArgentina
    ? (lang === 'es' ? 'Un abrazo,' : 'Best,')
    : lang === 'es' ? 'Saludos,'
    : lang === 'pt' ? 'Atenciosamente,'
    : 'Best,';
  lines.push(closing);

  return lines.join('\n');
}

// ── 月度报告组装（归档客户维护）──────────────────────────────────────
function assembleMonthlyReport(lang, hook, isArgentina, marketContext) {
  const t = (item) => item ? (item[lang] || '') : '';
  const lines = [];

  const greeting = lang === 'es' ? 'Buen día,' : lang === 'pt' ? 'Bom dia,' : 'Hello,';
  lines.push(greeting);
  lines.push('');

  // Hook 问候句
  if (hook) {
    lines.push(t(hook));
    lines.push('');
  }

  // 用户填入的市场动态（默认兜底）
  const defaultMarket = {
    es: 'El panorama logístico en las rutas Asia-Latinoamérica sigue evolucionando. Los volúmenes de carga se mantienen activos y las tarifas continúan ajustándose. Como siempre, contar con opciones de respaldo marca la diferencia.',
    pt: 'O panorama logístico nas rotas Ásia-América Latina continua evoluindo. Os volumes de carga seguem ativos e as tarifas continuam se ajustando. Como sempre, contar com opções de respaldo faz a diferença.',
    en: 'The logistics landscape on Asia-Latin America routes keeps evolving. Cargo volumes remain active and rates continue to adjust. As always, having backup options makes the difference.',
  };
  lines.push(marketContext && marketContext.trim() ? marketContext.trim() : defaultMarket[lang] || defaultMarket.en);
  lines.push('');

  // 软关门
  const softClose = {
    es: 'Si en algún momento necesitas apoyo logístico, aquí estoy. Sin compromiso.',
    pt: 'Se em algum momento precisar de apoio logístico, estou aqui. Sem compromisso.',
    en: 'If you ever need logistics support, I\'m here. No strings.',
  };
  lines.push(softClose[lang] || softClose.en);

  // 结语
  lines.push('');
  const closing = isArgentina
    ? (lang === 'es' ? 'Un abrazo,' : 'Best,')
    : lang === 'es' ? 'Saludos,'
    : lang === 'pt' ? 'Atenciosamente,'
    : 'Best,';
  lines.push(closing);

  return lines.join('\n');
}

// ── 批量生成月度报告 ─────────────────────────────────────────────────
async function generateMonthlyReports() {
  const marketEl = document.getElementById('monthly-market-context');
  const marketContext = marketEl?.value || '';
  const archivedCompanies = Object.entries(sendCompanies)
    .filter(([name]) => sendHistory[name]?.stage === 'archived');

  if (!archivedCompanies.length) {
    alert('没有已归档的公司。');
    return;
  }

  let added = 0;
  for (const [name, members] of archivedCompanies) {
    const emails = members.map(m => m.email).filter(Boolean);
    if (!emails.length) continue;

    const ctype = members[0]?.clientType || 'unlabeled';
    const lang = (members[0]?.country || '').includes('Brasil') ? 'pt' : 'es';
    const isArgentina = (members[0]?.country || '').toLowerCase().includes('argentina');

    // 随机 Hook（排除阿根廷变体按常规处理）
    const hookMode = isArgentina ? 'ar' : 'no-ar';
    const hook = randomPick(ctype, 'monthly', [], isArgentina).hook; // 月度报告只要 Hook

    const body = assembleMonthlyReport(lang, hook, isArgentina, marketContext);
    const subjects = {
      agent: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
      direct: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
      unlabeled: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
    };
    const subject = subjects[ctype]?.[lang] || subjects.unlabeled[lang];

    queue.push({
      id: Date.now() + added,
      company: name,
      to: emails.join(', '),
      recipients: emails,
      subject,
      body,
      status: 'pending',
      addedAt: new Date().toISOString(),
      _stage: 'monthly',
    });
    added++;
  }

  if (!added) { alert('归档公司无有效邮箱。'); return; }

  saveQueue();
  document.getElementById('stat-queue').textContent = queue.length;
  alert(`已生成 ${added} 封月度报告，已加入发送队列。`);
  renderQueue();

  // 跳转到发送队列
  navItems.forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="queue"]').classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById('page-queue').classList.add('active');
}

// ===== 发送队列 =======================================================
function saveQueue() { localStorage.setItem('emailQueue', JSON.stringify(queue)); }

// 应用重启后，「发送中」的残留项恢复为「待发送」
queue.forEach(e => { if (e.status === 'sending') e.status = 'pending'; });
saveQueue();

async function syncTestMode() {
  try {
    const config = await window.electronAPI.loadConfig();
    const testEnabled = !!(config && config.test && config.test.enabled);
    const testEmail = config?.test?.email || '';
    const tsEl = document.getElementById('queue-test-status');
    if (tsEl) {
      tsEl.textContent = testEnabled ? `测试模式: ${testEmail}` : '';
    }
  } catch {}
}

function renderQueue() {
  syncTestMode();
  const tbody = document.querySelector('#queue-table tbody');
  const empty = document.getElementById('queue-empty');
  if (!tbody) return;
  if (!queue.length) { tbody.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  const sorted = [...queue].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  let seq = 0;
  tbody.innerHTML = sorted.map((e) => {
    seq++;
    const count = e.recipients?.length || (e.to?.split(',')?.length || 1);
    const stage = e._stage ? ' · ' + e._stage : '';
    return `
    <tr>
      <td>${seq}</td><td>${escapeHtml(e.company)}${stage}</td><td>${count} 位收件人</td>
      <td>${escapeHtml(e.subject)}</td><td class="status-${e.status}"${e._error ? ` title="${escapeHtml(e._error)}" style="cursor:help"` : ''}>${statusLabel(e.status)}</td>
    </tr>`;
  }).join('');
  document.getElementById('queue-start').disabled = sendInProgress;
  document.getElementById('queue-pause').disabled = !sendInProgress;
}

function statusLabel(s) {
  const map = { pending: '⏳ 待发送', sent: '✅ 已发送', failed: '❌ 失败', sending: '🔄 发送中' };
  return map[s] || s;
}

async function startSend() {
  if (sendInProgress) return;
  sendInProgress = true;
  const pending = queue.filter(e => e.status === 'pending');
  if (!pending.length) { sendInProgress = false; return; }
  pending.forEach(e => e.status = 'sending');
  document.getElementById('queue-progress').style.width = '0%';
  renderQueue();
  document.getElementById('queue-start').disabled = true;
  document.getElementById('queue-pause').disabled = false;
  document.getElementById('queue-cancel').disabled = false;
  if (unsubscribeProgress) unsubscribeProgress();

  unsubscribeProgress = await window.electronAPI.onSendProgress((data) => {
    if (data.type === 'sent') {
      const item = queue.find(e => e.id === data.id || (e.company === data.company && e.status === 'sending'));
      if (item) item.status = 'sent';
    } else if (data.type === 'failed') {
      const item = queue.find(e => e.id === data.id || (e.company === data.company && e.status === 'sending'));
      if (item) { item.status = 'failed'; item._error = data.error; }
    } else if (data.type === 'waiting') {
      // 更新时间窗口等待提示
      const prog = document.getElementById('queue-progress');
      if (prog) prog.title = data.message || '等待发送窗口...';
    } else if (data.type === 'delay') {
      // 显示延迟倒计时
    } else if (data.type === 'complete' || data.type === 'paused' || data.type === 'limit' || data.type === 'cancelled') {
      sendInProgress = false;
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
      // 只推进真正发送成功的公司（失败的不推进）
      const sentCompanies = queue.filter(e => e.status === 'sent' && e._stage).map(e => e.company);
      if (sentCompanies.length) {
        window.electronAPI.advanceStage([...new Set(sentCompanies)]);
      }
    }
    const sent = queue.filter(e => e.status === 'sent' || e.status === 'failed').length;
    document.getElementById('queue-progress').style.width = queue.length > 0 ? Math.round((sent / queue.length) * 100) + '%' : '0%';
    renderQueue();
    saveQueue();
  });
  window.electronAPI.startSend(pending);
}

document.getElementById('queue-start')?.addEventListener('click', () => { startSend().catch(e => console.error(e)); });
document.getElementById('queue-pause')?.addEventListener('click', async () => {
  await window.electronAPI.pauseSend();
  sendInProgress = false;
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = true;
  renderQueue();
});

document.getElementById('queue-cancel')?.addEventListener('click', async () => {
  if (!confirm('确定取消发送？正在发送的邮件将被中断，未发送的恢复为待发送。')) return;
  await window.electronAPI.cancelSend();
  sendInProgress = false;
  // 将 sending 状态的恢复为 pending
  queue.forEach(e => { if (e.status === 'sending') e.status = 'pending'; });
  saveQueue();
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = true;
  document.getElementById('queue-progress').style.width = '0%';
  renderQueue();
});

document.getElementById('queue-clear')?.addEventListener('click', () => {
  queue = queue.filter(e => e.status === 'pending' || e.status === 'sending');
  saveQueue();
  renderQueue();
  document.getElementById('queue-progress').style.width = '0%';
  document.getElementById('stat-queue').textContent = queue.length;
});

document.getElementById('queue-bounce-check')?.addEventListener('click', async () => {
  const btn = document.getElementById('queue-bounce-check');
  const resultDiv = document.getElementById('bounce-result');
  btn.disabled = true; btn.textContent = '⏳ 检查中...';
  resultDiv.style.display = 'none';
  try {
    const result = await window.electronAPI.checkBounces();
    resultDiv.style.display = 'block';
    if (result.ok) {
      if (result.bounced.length) {
        resultDiv.style.background = '#fff3e0';
        resultDiv.innerHTML = `<strong>📥 发现 ${result.bounced.length} 封退信：</strong><br>` +
          result.bounced.map(b => `· ${b.subject} <span style="color:var(--text-secondary)">${b.date}</span>`).join('<br>');
      } else {
        resultDiv.style.background = '#e8f5e9';
        resultDiv.textContent = '✅ 未发现退信';
      }
    } else {
      resultDiv.style.background = '#ffebee';
      resultDiv.textContent = '❌ ' + (result.error || '检查失败');
    }
  } catch (e) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#ffebee';
    resultDiv.textContent = '❌ 检查异常: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '📥 退信检查';
});


// ===== 工具函数 ======================================================
function findById(arr, id) { return arr?.find(i => i.id === id); }
function truncate(str, len) { return str?.length > len ? str.slice(0, len) + '...' : str; }
function escapeHtml(str) { return str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') || ''; }
function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// 轻量 Markdown → HTML（处理表格/标题/粗体/列表/分隔线）
function ratingStars(n) { return '⭐'.repeat(Math.min(5, Math.max(1, n))); }

async function pollBackcheckStatus(companyName, onDone) {
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await window.electronAPI.getBackcheckStatus();
    const s = st[companyName];
    // 完成/超时 → 刷新
    if (s?.status === 'done' || s?.status === 'timeout') { onDone(); return; }
  }
  onDone(); // 90秒超时刷新
}

function renderMarkdown(md) {
  // 1. 先转义
  let html = escapeHtml(md);
  // 2. 标题
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 3. 水平线
  html = html.replace(/^---$/gm, '<hr>');
  // 4. 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 5. 表格
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (match) => {
    const lines = match.trim().split('\n').filter(l => !/^\|[\s:\-|]+\|$/.test(l));
    if (lines.length < 1) return match;
    let t = '<table>';
    lines.forEach((line, i) => {
      const cells = line.split('|').filter(c => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      t += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    return t + '</table>';
  });
  // 6. 列表
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  // 7. 引用块
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // 8. 段落：按双换行切分，每段包 <p>
  const blocks = html.split('\n\n');
  html = blocks.map(b => {
    const trimmed = b.trim();
    if (!trimmed) return '';
    if (/^<(h[1-4]|hr|table|ul|ol|li|div|blockquote)/.test(trimmed)) return trimmed;
    // 单换行转 <br>
    return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  return html;
}

function renderPagination(container, total, current, onChange) {
  if (!container) return;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { container.style.display = 'none'; return; }
  container.style.display = 'flex';
  let html = `<button ${current === 1 ? 'disabled' : ''} data-p="1">««</button>`;
  html += `<button ${current === 1 ? 'disabled' : ''} data-p="${current - 1}">«</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= current - 2 && i <= current + 2)) {
      html += `<button class="${i === current ? 'active' : ''}" data-p="${i}">${i}</button>`;
    } else if (i === current - 3 || i === current + 3) {
      html += `<span>...</span>`;
    }
  }
  html += `<button ${current === totalPages ? 'disabled' : ''} data-p="${current + 1}">»</button>`;
  html += `<button ${current === totalPages ? 'disabled' : ''} data-p="${totalPages}">»»</button>`;
  container.innerHTML = html;
  container.querySelectorAll('button[data-p]').forEach(btn => {
    btn.addEventListener('click', () => onChange(parseInt(btn.dataset.p)));
  });
}

// ===== 设置 ==========================================================
const CFG_KEYS = [
  { id: 'cfg-smtp-host', path: 'smtp.host' },
  { id: 'cfg-smtp-port', path: 'smtp.port' },
  { id: 'cfg-smtp-secure', path: 'smtp.secure', isBool: true },
  { id: 'cfg-smtp-user', path: 'smtp.user' },
  { id: 'cfg-smtp-pass', path: 'smtp.pass' },
  { id: 'cfg-sender-name', path: 'sender.name' },
  { id: 'cfg-sender-email', path: 'sender.email' },
  { id: 'cfg-schedule-max', path: 'schedule.max_per_day' },
  { id: 'cfg-schedule-start', path: 'schedule.start_hour_beijing', isTime: true },
  { id: 'cfg-schedule-end', path: 'schedule.end_hour_beijing', isTime: true },
  { id: 'cfg-schedule-min-delay', path: 'schedule.min_delay_seconds' },
  { id: 'cfg-schedule-max-delay', path: 'schedule.max_delay_seconds' },
  { id: 'cfg-search-apikey', path: 'search.apiKey' },
  { id: 'cfg-tl-youdao-key', path: 'translate.youdao.appKey' },
  { id: 'cfg-tl-youdao-secret', path: 'translate.youdao.appSecret' },
  { id: 'cfg-tl-baidu-id', path: 'translate.baidu.appId' },
  { id: 'cfg-tl-baidu-key', path: 'translate.baidu.key' },
  { id: 'cfg-test-email', path: 'test.email' },
  { id: 'cfg-test-enabled', path: 'test.enabled', isBool: true },
  { id: 'cfg-imap-host', path: 'imap.host' },
  { id: 'cfg-imap-port', path: 'imap.port' },
  { id: 'cfg-imap-user', path: 'imap.user' },
  { id: 'cfg-imap-pass', path: 'imap.pass' },
];

function loadSettingsIntoForm(config) {
  if (!config) return;
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val = key.path.split('.').reduce((o, k) => o?.[k], config);
    // 时间字段：数字 → HH:MM
    if (key.isTime && val != null) {
      const h = String(Math.floor(val)).padStart(2, '0');
      val = h + ':00';
    }
    if (key.isBool) el.checked = !!val;
    else el.value = val ?? '';
  }
}

function collectSettingsFromForm() {
  const config = {};
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val;
    if (key.isBool) val = el.checked;
    else if (key.isTime) val = parseInt(el.value) || 0; // "19:00" → 19
    else if (el.type === 'number') val = Number(el.value) || 0;
    else val = el.value;
    getOrSet(config, key.path, val);
  }
  return config;

  function getOrSet(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!o[keys[i]]) o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = val;
  }
}

async function initSettings() {
  const config = await window.electronAPI.loadConfig();
  if (config) loadSettingsIntoForm(config);
  validateRequired();
}

function deepMerge(base, overlay) {
  const out = { ...base };
  for (const key of Object.keys(overlay)) {
    if (overlay[key] && typeof overlay[key] === 'object' && !Array.isArray(overlay[key])) {
      out[key] = deepMerge(base[key] || {}, overlay[key]);
    } else {
      out[key] = overlay[key];
    }
  }
  return out;
}

// 自动保存：监听所有设置输入变化
let settingSaveTimer = null;
document.querySelectorAll('#page-settings input, #page-settings select').forEach(el => {
  el.addEventListener('change', () => autoSaveSettings(el));
  if (el.type === 'text' || el.type === 'password' || el.type === 'number') {
    el.addEventListener('input', () => {
      clearTimeout(settingSaveTimer);
      settingSaveTimer = setTimeout(() => autoSaveSettings(el), 800);
    });
  }
});

// 必填字段检测
function validateRequired() {
  document.querySelectorAll('.setting-required input[data-required]').forEach(el => {
    el.style.borderColor = el.value.trim() ? '' : 'var(--danger)';
    el.style.background = el.value.trim() ? '' : '#fff5f5';
  });
}
document.querySelectorAll('.setting-required input[data-required]').forEach(el => {
  el.addEventListener('input', validateRequired);
});

async function autoSaveSettings(el) {
  validateRequired();
  const card = el.closest('.setting-card');
  const status = card?.querySelector('.setting-status');
  if (status) { status.textContent = '...'; status.style.color = 'var(--warning)'; }
  try {
    const existing = await window.electronAPI.loadConfig() || {};
    const formData = collectSettingsFromForm();
    const merged = deepMerge(existing, formData);
    const result = await window.electronAPI.saveConfig(merged);
    if (status) {
      status.textContent = result.ok ? '✓' : '✗';
      status.style.color = result.ok ? 'var(--success)' : 'var(--danger)';
      setTimeout(() => { status.textContent = ''; }, 2000);
    }
  } catch {
    if (status) { status.textContent = '✗'; status.style.color = 'var(--danger)'; }
  }
}

// ===== 初始化 ========================================================
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  console.log('🚀 Prospecting Email v1.2 已就绪');
});
