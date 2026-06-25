// ── Milogin's Prospector — 渲染进程逻辑 v1.3 ──────────────────────────────

// 全局错误捕获（调试用，定位后再移除）
window.addEventListener('error', (e) => {
  const msg = `🔥 JS错误: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`;
  console.error(msg, e.error);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f44336;color:#fff;padding:8px 16px;font-size:12px;z-index:99999;white-space:pre-wrap';
  banner.textContent = msg;
  document.body.prepend(banner);
});

// ===== 全局状态 ======================================================
let templateLib = null;
let queue = [];
let _queueLoaded = false;

async function loadQueue() {
  if (_queueLoaded) return;
  // 优先从文件恢复（比 localStorage 可靠）
  try {
    const result = await window.electronAPI.loadQueue();
    if (result.ok && result.data.length) {
      queue = result.data;
      console.log('📋 队列从文件恢复:', queue.length, '条');
      _queueLoaded = true;
      // 同步到 localStorage 作为缓存
      localStorage.setItem('emailQueue', JSON.stringify(queue));
      return;
    }
  } catch (e) { console.warn('文件队列加载失败，尝试 localStorage:', e.message); }
  // 回退到 localStorage
  try {
    const stored = localStorage.getItem('emailQueue');
    if (stored) {
      queue = JSON.parse(stored);
      console.log('📋 队列从 localStorage 恢复:', queue.length, '条');
    }
  } catch (e) {
    console.error('邮件队列数据损坏，已重置', e.message);
    localStorage.removeItem('emailQueue');
  }
  _queueLoaded = true;
}
let unsubscribeProgress = null;
let sendInProgress = false;
let autoBounceTimer = null;
let nextBounceScanAt = 0;
let clientsData = [];
let contactsData = [];
let clientsPage = 1;
const PAGE_SIZE = 100;

// ===== 页面导航 ======================================================
const navItems = document.querySelectorAll('.nav-item');
const navSubs = document.querySelectorAll('.nav-sub');
const pages = document.querySelectorAll('.page');
let lastBackcheckProvider = 'deep-research'; // 记忆引擎选择
let currentBackcheckCompany = null; // 当前背调公司
let currentBackcheckDetail = null;   // 当前背调报告缓存

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
    if (pageId === 'backcheck') { currentBackcheckCompany = null; loadBackcheck(); }
    if (pageId === 'template-editor') initTemplateEditor();
    if (pageId === 'signature') initSignature();
    if (pageId === 'template-preview') initTemplatePreview();
    if (pageId === 'email-send') initEmailSend();
    if (pageId === 'queue') renderQueue();
    if (pageId === 'bounces') initBouncePage();
    if (pageId === 'history') initHistoryPage();
    if (pageId === 'settings') initSettings();
    if (pageId === 'discover') initDiscover();
  });
});

// ===== 仪表盘 ========================================================
async function loadDashboard() {
  try {
    const stats = await window.electronAPI.getDashboardStats();
    document.getElementById('stat-sent').textContent = stats.sentToday;
    document.getElementById('stat-remaining').textContent = stats.remaining;
    document.getElementById('stat-queue').textContent = queue.filter(e => e.status === 'pending').length;
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
  if (result.invalidEmail > 0) msg += `\n⚠️ ${result.invalidEmail} 个邮箱格式异常，已导入但建议手动修正`;
  alert(msg);
});

// 「从飞书导入」
document.getElementById('feishu-import-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('feishu-import-btn');
  btn.disabled = true; btn.innerHTML = `${lucide('refresh-cw',12,'spin')} 读取中...`;
  try {
    const config = await window.electronAPI.loadConfig();
    const url = config?.feishu?.url;
    // 从URL自动提取 baseToken 和 tableId
    const baseMatch = url?.match(/\/base\/([a-zA-Z0-9_-]+)/);
    const tableMatch = url?.match(/table[=\/]([a-zA-Z0-9_-]+)/);
    const baseToken = baseMatch?.[1];
    const tableId = tableMatch?.[1];
    if (!baseToken || !tableId) {
      alert('请在设置页填写飞书多维表格完整地址（含 /base/xxx?table=xxx）');
    btn.disabled = false; btn.innerHTML = `${lucide('file-spreadsheet',14)} 从飞书导入`;
      return;
    }
    const result = await window.electronAPI.importFeishu(baseToken, tableId);
    if (result.error) { alert('导入失败:\n' + result.error + '\n\n请将显示内容反馈给开发者'); }
    else {
      clientsData = result.clients;
      clientsPage = 1;
      let msg = `✅ ${clientsData.length} 条`;
      if (result.suspiciousCount > 0) {
        msg += `\n\n📊 飞书共 ${result.rawCount} 行，${result.suspiciousCount} 行公司名异常已标记「待确认」`;
      }
      alert(msg);
      renderClientsTable();
    }
  } catch (e) { alert('飞书导入异常: ' + e.message); }
  btn.disabled = false; btn.innerHTML = `${lucide('file-spreadsheet',14)} 从飞书导入`;
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
    agent: `<span class="ctype-tag ctype-agent">${lucide('globe',12)} 代理</span>`,
    direct: `<span class="ctype-tag ctype-direct">${lucide('building',12)} 直客</span>`,
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
  } else if (contactsFilter === 'suspicious') {
    data = data.filter(c => c._suspicious === true);
  } else if (contactsFilter !== 'all') {
    data = data.filter(c => (c.clientType || 'unlabeled') === contactsFilter);
  }

  const sidebar = document.getElementById('contacts-sidebar');
  const detail = document.getElementById('contacts-detail');
  const layout = document.getElementById('contacts-layout');
  const filterBar = document.getElementById('contacts-filter');
  const empty = document.getElementById('contacts-empty');
  const statsBar = document.getElementById('contacts-stats');

  // 统计各类型公司数（始终基于全部数据，不受筛选影响）
  const counts = { agent: 0, direct: 0, unlabeled: 0 };
  const seenCompanies = new Set();
  for (const c of contactsData) {
    const key = c.company;
    if (!seenCompanies.has(key)) {
      seenCompanies.add(key);
      counts[c.clientType || 'unlabeled']++;
    }
  }

  // 更新筛选标签（即使列表为空也保持可见，确保用户能切回）
  const tabs = filterBar?.querySelectorAll('.cf-tab');
  if (tabs) {
    const labelMap = {
      all: `全部 ${seenCompanies.size}`,
      agent: `${lucide('globe',13)} 代理 ${counts.agent}`,
      direct: `${lucide('building',13)} 直客 ${counts.direct}`,
      unlabeled: `${lucide('help-circle',13)} 未标签 ${counts.unlabeled}`,
      suspicious: `${lucide("alert-circle",13)} 待确认 ${contactsData.filter(c => c._suspicious).length}`,
      archived: `${lucide("archive",13)} 已归档 ${Object.values(contactsSendHistory).filter(h => h?.stage === "archived").length}`,
    };
    tabs.forEach(tab => {
      const f = tab.dataset.filter;
      tab.innerHTML = labelMap[f] || f;
      tab.classList.toggle('active', contactsFilter === f);
    });
  }

  if (!data.length) {
    if (empty) { empty.style.display = 'block'; empty.textContent = contactsFilter === 'archived' ? '暂无已归档客户 — 客户发完 F4 后自动归档' : contactsFilter === 'suspicious' ? '暂无待确认公司 — 导入数据中未检测到异常公司名' : contactsFilter !== 'all' ? '该分类暂无联系人' : '暂无联系人 — 从「导入客户」导入'; }
    if (layout) layout.style.display = 'none';
    if (statsBar) statsBar.style.display = 'none';
    if (filterBar) filterBar.style.display = 'flex';
    if (sidebar) sidebar.innerHTML = '';
    if (detail) detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
    contactsGroupMap.clear();
    selectedContactCompany = null;
    return;
  }

  if (empty) empty.style.display = 'none';
  if (layout) layout.style.display = 'flex';
  if (filterBar) filterBar.style.display = 'flex';

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
    statsBar.innerHTML = `<span>${lucide('users',14)} <strong>${data.length}</strong> 位联系人</span><span>${lucide('building',14)} <strong>${groups.length}</strong> 家公司</span><span>${lucide('star',14)} <strong>${vipCount}</strong> 可定制客户</span>`;
  }

  // 左侧公司列表
  if (sidebar) {
    sidebar.innerHTML = groups.map(([company, members]) => {
      const ctype = members[0]?.clientType || 'unlabeled';
      const tagHtml = clientTypeTag(ctype);
      const ctry = escapeHtml(members[0]?.country || '');
      const hist = contactsSendHistory[company];
      const stageLabel = hist?.stage ? `<span class="ci-stage-badge ci-stage-${hist.stage}">${STAGE_LABELS_SEND[hist.stage] || hist.stage.toUpperCase()}</span>` : '';
      const vipClass = members.length >= 5 ? ' ci-vip' : '';
      const subParts = [tagHtml, ctry, stageLabel].filter(Boolean);
      return `
      <div class="contact-item${selectedContactCompany === company ? ' active' : ''}" data-company="${escapeHtml(company)}">
        <div class="ci-main">
          <span class="ci-name${vipClass}">${escapeHtml(company)}</span>
          <span class="ci-count">${members.length}</span>
          <button class="ci-delete-company" data-company="${escapeHtml(company)}" title="删除该公司所有联系人" style="font-size:14px;padding:0 4px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;opacity:.5;line-height:1">×</button>
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

      // 删除公司按钮 — 阻止冒泡，不触发选中
      const delBtn = item.querySelector('.ci-delete-company');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const co = delBtn.dataset.company;
          if (!confirm(`确定删除「${co}」及其全部联系人？此操作不可恢复。`)) return;
          const result = await window.electronAPI.deleteCompany(co);
          // 从内存移除
          contactsData = contactsData.filter(c => c.company !== co);
          contactsGroupMap.delete(co);
          // 从侧边栏移除
          item.remove();
          // 如果是当前选中公司，清空右侧
          if (selectedContactCompany === co) {
            selectedContactCompany = null;
            if (detail) detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
          }
          // 更新筛选标签计数（不刷新列表）
          const totalCompanies = new Set(contactsData.map(c => c.company)).size;
          const allTab = document.querySelector('#contacts-filter .cf-tab[data-filter="all"]');
          if (allTab) allTab.innerHTML = `全部 ${totalCompanies}`;
        });
      }
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
    <div class="contacts-detail-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>${escapeHtml(company)} · ${members.length} 位联系人 ${clientTypeTag(ctype)}</span>
      <button id="btn-backcheck-contact" class="secondary" style="font-size:11px;padding:3px 10px;margin-left:auto">🔬 背调</button>
    </div>
    <div class="contacts-detail-body">
      <table>
        <thead><tr><th>国家</th><th>品类</th><th>邮箱</th><th>状态</th><th>添加时间</th><th>操作</th></tr></thead>
        <tbody>
          ${members.map(m => {
            const bouncedBadge = m.bounced
              ? `<span title="${escapeHtml(m.bounceReason || '退信')} (${m.bounceType === 'permanent' ? '永久' : m.bounceType === 'temporary' ? '临时' : '未知'})" style="cursor:help;font-size:10px;color:${m.bounceType === 'temporary' ? 'var(--warning)' : 'var(--danger)'}">${m.bounceType === 'temporary' ? '⚠️ 退信' : '🚫 退信'}</span>`
              : '';
            return `
            <tr style="${m.bounced ? 'opacity:.5' : ''}">
              <td>${escapeHtml(m.country)}</td>
              <td>${escapeHtml(m.category)}</td>
              <td>${escapeHtml(m.email)}</td>
              <td>${bouncedBadge}</td>
              <td>${formatDate(m.addedAt)}</td>
              <td>${m.bounced ? `<button class="btn-clear-bounce" data-email="${escapeHtml(m.email)}" style="font-size:10px;padding:2px 6px">清除</button>` : `<button class="btn-delete danger" data-id="${m.id}">删除</button>`}</td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
      ${isArchived ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;display:flex;align-items:center;gap:8px"><span style="font-size:13px">📦 已归档 — 不参与常规序列</span><button id="btn-reactivate-contact" style="margin-left:auto;font-size:12px;padding:4px 12px">🔄 重新激活</button></div>` : ''}
    </div>
  `;

  // 删除按钮 — 局部移除行，不刷新整个页面
  detail.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该联系人？')) return;
      await window.electronAPI.deleteContact(btn.dataset.id);
      // 从内存数据中移除
      contactsData = contactsData.filter(c => c.id !== btn.dataset.id);
      // 从当前公司成员中移除
      const members = contactsGroupMap.get(company);
      if (members) {
        const idx = members.findIndex(m => m.id === btn.dataset.id);
        if (idx >= 0) members.splice(idx, 1);
      }
      // 仅移除该行 DOM
      const row = btn.closest('tr');
      if (row) {
        row.style.transition = 'opacity .2s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 200);
      }
      // 更新头部计数和侧边栏计数
      const headerEl = detail.querySelector('.contacts-detail-header');
      if (headerEl && members) headerEl.textContent = `${company} · ${members.length} 位联系人 ${clientTypeTag(ctype)}`;
      const sidebarEl = document.querySelector(`.contact-item[data-company="${escapeHtml(company)}"] .ci-count`);
      if (sidebarEl && members) sidebarEl.textContent = members.length;
      // 如果公司无联系人，移除侧边栏项
      if (members && !members.length) {
        contactsGroupMap.delete(company);
        const item = document.querySelector(`.contact-item[data-company="${escapeHtml(company)}"]`);
        if (item) item.remove();
        selectedContactCompany = null;
        detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
      }
    });
  });

  // 清除退信标记
  detail.querySelectorAll('.btn-clear-bounce').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.electronAPI.clearBounce(btn.dataset.email);
      contactsData = await window.electronAPI.getContacts();
      renderContactsList();
    });
  });

  // 发起背调按钮
  const bcBtn = document.getElementById('btn-backcheck-contact');
  if (bcBtn) {
    bcBtn.addEventListener('click', async () => {
      const contact = members[0];
      if (!contact) return;
      showToast(`正在启动 ${company} 背调...`, 'ok');
      const result = await window.electronAPI.startResearch(contact, 'deep-research');
      if (!result.ok) { showToast(result.message || '启动失败', 'err'); return; }
      discoverPreselectCompany = company;
      const nav = document.querySelector('[data-page="backcheck"]');
      if (nav) nav.click();
    });
  }

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
let networkStatusDismissed = false;
let foreignNetworkOk = true; // 境外网络可达性

async function checkNetworkStatus() {
  if (networkStatusDismissed) return;
  const el = document.getElementById('network-status');
  const text = document.getElementById('network-status-text');
  if (!el || !text) return;
  el.style.display = 'block';
  text.innerHTML = `${lucide('refresh-cw',12,'spin')} 检测中...`;
  try {
    const r = await window.electronAPI.checkNetwork();
    const proxyInfo = r.proxy ? ` 代理: ${r.proxy}` : ' 无代理';
    const bad = r.results.filter(x => !x.ok);
    foreignNetworkOk = bad.length === 0;
    if (bad.length === 0) {
      el.style.background = '#e8f5e9'; text.innerHTML = `${lucide('check-circle',12)} 网络正常${proxyInfo}`;
    } else if (bad.length <= 2) {
      el.style.background = '#fff8e1'; text.innerHTML = `${lucide('alert-circle',12)} 部分站点不可达: ${bad.map(x=>x.name).join(', ')}${proxyInfo}`;
    } else {
      el.style.background = '#ffebee'; text.innerHTML = `${lucide('x-circle',12)} 境外站点全部不可达，建议配置代理${proxyInfo}`;
    }
  } catch {
    el.style.background = '#ffebee'; text.innerHTML = `${lucide('x-circle',12)} 网络检测失败`;
    foreignNetworkOk = false;
  }
}

async function loadBackcheck() {
  const container = document.getElementById('backcheck-companies');
  if (!container) return;

  // 只在首次进入（无选中公司）时重置，内部刷新不动工具栏
  if (!currentBackcheckCompany) {
    const toolbar = document.getElementById('backcheck-toolbar');
    if (toolbar) { toolbar.innerHTML = ''; toolbar.style.display = 'none'; }
    currentBackcheckDetail = null;
  }

  // 网络状态检查
  checkNetworkStatus();

  // 从联系人列表加载
  contactsData = await window.electronAPI.getContacts();
  const status = await window.electronAPI.getBackcheckStatus();

  if (!contactsData.length) {
    container.innerHTML = '<p style="color:var(--text-secondary);padding:12px">暂无联系人 — 请先在「联系人」中导入客户</p>';
    return;
  }

  // 读取背调筛选设置
  let filterEnabled = true;
  try {
    const cfg = await window.electronAPI.loadConfig();
    filterEnabled = cfg?.backcheck?.filterEnabled !== false; // 默认开启
  } catch {}

  // 按公司分组 → 根据设置决定是否仅保留 ≥5 人
  let groups = groupByCompany(contactsData);
  if (filterEnabled) {
    groups = groups.filter(([, members]) => members.length >= 5);
  }

  // 排序：星级降序 → 人数降序
  groups.sort((a, b) => {
    const ra = status[a[0]]?.rating || 0;
    const rb = status[b[0]]?.rating || 0;
    if (ra !== rb) return rb - ra;
    return b[1].length - a[1].length;
  });

  if (!groups.length) {
    const msg = filterEnabled
      ? '暂无符合条件的可定制客户（需同一公司 ≥5 位联系人）<br><span style="font-size:11px;color:var(--text-secondary)">可在设置中关闭背调筛选查看所有公司</span>'
      : '暂无联系人 — 请先在「联系人」中导入客户';
    container.innerHTML = `<p style="color:var(--text-secondary);padding:12px">${msg}</p>`;
    return;
  }

  container.innerHTML = '<div id="bc-batch-bar" style="display:flex;align-items:center;gap:6px;padding:3px 6px 3px 0;margin-bottom:4px;border-bottom:1px solid var(--border);font-size:11px">'
    + '<button id="bc-research-all" style="font-size:10px;padding:1px 8px;cursor:pointer;white-space:nowrap">全部调查</button>'
    + '<span id="bc-selected-count" style="color:var(--text-secondary);font-size:10px;flex:1"></span>'
    + '<button id="bc-toggle-all" style="font-size:10px;padding:1px 6px;cursor:pointer;white-space:nowrap">选择</button>'
    + '</div>'
    + groups.map(([company, members]) => {
    const st = status[company];
    const ctype = members[0]?.clientType || 'unlabeled';
    const tagHtml = clientTypeTag(ctype);
    const ctry = escapeHtml(members[0]?.country || '');
    const vipClass = members.length >= 5 ? ' ci-vip' : '';
    let badge = lucide('square',14);
    if (st?.status === 'researching' || st?.status === 'pending') badge = lucide('refresh-cw',14,'spin');
    else if (st?.status === 'timeout') badge = lucide('clock',14);
    else if (st?.status === 'done') badge = st.rating ? '' : lucide('check-circle',14);
    const ratingText = (st?.status === 'done' && st.rating) ? ratingStars(st.rating) : '';
    const subParts = [tagHtml, ctry].filter(Boolean);
    return `<div class="backcheck-company" data-company="${escapeHtml(company)}">
      <div class="bc-main"><input type="checkbox" class="bc-checkbox" data-company="${escapeHtml(company)}" style="width:11px;height:11px;flex-shrink:0;margin:0" onclick="event.stopPropagation()"><span class="bc-name${vipClass}">${escapeHtml(company)}</span><span class="bc-badge">${badge}</span><span class="bc-count">${members.length}人</span></div>
      ${ratingText ? `<div class="bc-sub">${ratingText}</div>` : ''}
      <div class="bc-sub">${subParts.join(' · ')}</div>
    </div>`;
  }).join('');

  // 批量操作按钮
  let bcSelectMode = false;
  document.getElementById('bc-toggle-all')?.addEventListener('click', function() {
    bcSelectMode = !bcSelectMode;
    this.textContent = bcSelectMode ? '取消选择' : '选择';
    this.style.background = bcSelectMode ? 'var(--primary)' : '';
    this.style.color = bcSelectMode ? '#fff' : '';
    container.querySelectorAll('.bc-checkbox').forEach(cb => { cb.checked = bcSelectMode; });
    updateBcSelectedCount();
  });
  document.getElementById('bc-research-all')?.addEventListener('click', async () => {
    const cbs = container.querySelectorAll('.bc-checkbox:checked');
    const list = cbs.length ? [...cbs] : container.querySelectorAll('.bc-checkbox');
    if (!list.length) return;
    if (!confirm(`即将对 ${list.length} 家公司启动背调，确认？`)) return;
    for (const cb of list) {
      const cname = cb.dataset.company;
      const contact = contactsData.find(c => (c.company || '').trim() === cname);
      if (!contact) continue;
      await window.electronAPI.startResearch(contact, lastBackcheckProvider);
      const badgeEl = cb.closest('.backcheck-company')?.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = lucide('refresh-cw',14,'spin');
    }
    showToast(`已启动 ${list.length} 家公司背调`, 'ok');
  });
  function updateBcSelectedCount() {
    const cnt = container.querySelectorAll('.bc-checkbox:checked').length;
    const total = container.querySelectorAll('.bc-checkbox').length;
    const el = document.getElementById('bc-selected-count');
    if (el) el.textContent = cnt ? `已选 ${cnt}/${total} 家` : `共 ${total} 家`;
  }
  container.addEventListener('change', (e) => {
    if (e.target.classList.contains('bc-checkbox')) updateBcSelectedCount();
  });
  updateBcSelectedCount();

  let selectedCompany = null;

  container.querySelectorAll('.backcheck-company').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('bc-checkbox')) return;
      container.querySelectorAll('.backcheck-company').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectedCompany = el.dataset.company;

      const [detail, freshStatus] = await Promise.all([
        window.electronAPI.getBackcheckDetail(selectedCompany),
        window.electronAPI.getBackcheckStatus(),
      ]);

      const currentSt = freshStatus[selectedCompany];
      if (detail?.rating > 0 && (!currentSt?.rating || currentSt.rating !== detail.rating)) {
        await window.electronAPI.markBackcheckDone(selectedCompany, detail.rating);
        freshStatus[selectedCompany] = { ...currentSt, rating: detail.rating, status: 'done' };
      }

      renderBackcheckCard(detail, selectedCompany, freshStatus[selectedCompany]);

      const updatedSt = freshStatus[selectedCompany];
      let badge = lucide('square',14);
      if (updatedSt?.status === 'researching' || updatedSt?.status === 'pending') badge = lucide('refresh-cw',14,'spin');
      else if (updatedSt?.status === 'done') badge = updatedSt.rating ? '' : lucide('check-circle',14);
      const badgeEl = el.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = badge;
    });
  });

  // 从客户开发页面预选跳转 → 自动点击对应公司
  if (discoverPreselectCompany) {
    const target = container.querySelector(`.backcheck-company[data-company="${escapeHtml(discoverPreselectCompany)}"]`);
    if (target) target.click();
    discoverPreselectCompany = null;
  }

  // 工具栏事件委托（一次性绑定）
  if (!window._backcheckToolbarBound) {
    window._backcheckToolbarBound = true;
    // 网络状态关闭 + 重新检查
    document.getElementById('network-close-btn')?.addEventListener('click', () => {
      const el = document.getElementById('network-status');
      if (el) el.style.display = 'none';
      networkStatusDismissed = true;
    });
    document.getElementById('network-check-btn')?.addEventListener('click', checkNetworkStatus);
    const tb = document.getElementById('backcheck-toolbar');
    if (tb) {
      tb.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn || !currentBackcheckCompany) return;
        const cname = currentBackcheckCompany;
        if (btn.id === 'btn-research' || btn.id === 'btn-recheck') doResearch(cname);
        if (btn.id === 'btn-cancel-research') { if (confirm('确定取消？')) { await window.electronAPI.cancelBackcheck(cname); loadBackcheck(); } }
        if (btn.id === 'btn-open-folder') window.electronAPI.openReportsFolder?.();
        if (btn.id === 'btn-reactivate-bc') { if (confirm(`确定重新激活 ${cname}？`)) { await window.electronAPI.reactivateCompany(cname); contactsSendHistory = await window.electronAPI.getSendHistory() || {}; loadBackcheck(); } }
        if (btn.id === 'btn-fix-country') fixCountryFromToolbar();
        if (btn.id === 'btn-add-to-queue') addReportToQueue();
      });
      tb.addEventListener('change', (e) => {
        if (e.target.id === 'bc-provider') lastBackcheckProvider = e.target.value;
      });
    }
  }
}

// ── 工具栏独立事件处理 ─────────────────────────────────────────────

// 背调核心（独立函数，工具按钮可复用）
async function doResearch(companyName) {
  const contact = contactsData.find(c => (c.company || '').trim() === (companyName || '').trim());
  if (!contact) { alert('未找到联系人: ' + companyName); return; }

  const provider = document.getElementById('bc-provider')?.value || 'deep-research';

  const reportWrap = document.getElementById('backcheck-report-wrap');
  const btn = document.getElementById('btn-research') || document.getElementById('btn-recheck');
  if (btn) btn.innerHTML = lucide('refresh-cw',14,'spin') + ' 搜索中...';
  if (reportWrap) {
    reportWrap.innerHTML = '<p style="color:var(--primary);padding:20px;text-align:center;font-size:14px">' + lucide('refresh-cw',16,'spin') + ' 正在搜索 ' + escapeHtml(companyName) + ' ...</p>'
      + '<p style="color:var(--text-secondary);text-align:center;font-size:12px" id="research-progress">启动中...</p>';
  }

  let unsub = null;
  if (window.electronAPI.onBackcheckProgress) {
    unsub = window.electronAPI.onBackcheckProgress(async (data) => {
      if (data.company !== companyName) return;
      const progEl = document.getElementById('research-progress');
      if (progEl && data.type === 'research-progress') progEl.textContent = data.progress || '';
      if (data.type === 'research-done') {
        if (unsub) unsub();
        const [detail, status] = await Promise.all([
          window.electronAPI.getBackcheckDetail(companyName),
          window.electronAPI.getBackcheckStatus(),
        ]);
        renderBackcheckCard(detail, companyName, status[companyName]);
        const item = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
        if (item) {
          const st = status[companyName];
          const badge = st?.status === 'done' ? (st.rating ? ratingStars(st.rating) : lucide('check-circle',14)) : lucide('square',14);
          const badgeEl = item.querySelector('.bc-badge');
          if (badgeEl) badgeEl.innerHTML = badge;
        }
      }
    });
  }

  const result = await window.electronAPI.startResearch(contact, provider);
  if (!result.ok) {
    if (unsub) unsub();
    alert(result.message || '启动失败');
    return;
  }
  lastBackcheckProvider = provider;
  // 立即更新左侧图标为动态
  const bcItem = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
  if (bcItem) {
    const badgeEl = bcItem.querySelector('.bc-badge');
    if (badgeEl) badgeEl.innerHTML = lucide('refresh-cw',14,'spin');
  }
  // 兜底检查
  const [detail, status] = await Promise.all([
    window.electronAPI.getBackcheckDetail(companyName),
    window.electronAPI.getBackcheckStatus(),
  ]);
  const st = status[companyName];
  if (st?.status === 'done') {
    if (unsub) unsub();
    renderBackcheckCard(detail, companyName, st);
    const item = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
    if (item) {
      const badge = st.rating ? ratingStars(st.rating) : lucide('check-circle',14);
      const badgeEl = item.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = badge;
    }
  }
}

// 获取开发信正文（优先独立文件，兜底报告内提取）
function extractEmailFromDetail(detail) {
  if (detail?.emailBody) return detail.emailBody;
  if (detail?.raw) {
    const m = detail.raw.match(/## 开发信[\s\S]+/);
    return m ? m[0] : '';
  }
  return '';
}

async function addReportToQueue() {
  if (!currentBackcheckDetail?.raw || !currentBackcheckCompany) return;
  const emailBody = extractEmailFromDetail(currentBackcheckDetail);
  if (!emailBody) { showToast('未找到开发信内容', 'err'); return; }

  // 获取公司联系人
  const members = (contactsData || []).filter(c => (c.company || '').trim() === currentBackcheckCompany.trim());
  const ctype = members[0]?.clientType || 'unlabeled';
  const country = members[0]?.country || '';
  const validMembers = members.filter(m => m.email && m.email.includes('@'));
  if (!validMembers.length) { showToast('该公司无有效邮箱', 'err'); return; }

  // 生成主题
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  const GROUP_SIZE = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);
  const groups = [];
  for (let i = 0; i < validMembers.length; i += GROUP_SIZE) {
    groups.push(validMembers.slice(i, i + GROUP_SIZE));
  }

  let added = 0;
  for (const group of groups) {
    const toEmails = group.map(m => m.email);
    // 从开发信中提取 Subject 行
    const subjMatch = emailBody.match(/\*\*Subject:\*\*\s*(.+)/i);
    const baseSubject = subjMatch ? subjMatch[1].trim() : ('Logistics Partner / ' + (country || 'LatAm'));
    queue.push({
      id: ++queueIdCounter, company: currentBackcheckCompany, to: toEmails.join(', '), recipients: toEmails,
      subject: baseSubject, body: emailBody, status: 'pending', addedAt: new Date().toISOString(),
      _stage: 'cold', _type: ctype, _lang: country === 'Brazil' ? 'pt' : 'es', _country: country,
      _fromReport: true,
    });
    added++;
  }

  showToast(`✅ 已加入 ${added} 组共 ${validMembers.length} 位联系人到队列`, 'ok');
  saveQueue();
  document.getElementById('stat-queue').textContent = queue.filter(e => e.status === 'pending').length;
  // 跳转到发送队列
  document.querySelector('[data-page="queue"]')?.click();
}

async function fixCountryFromToolbar() {
  if (!currentBackcheckDetail) { showToast('无报告数据', 'err'); return; }
  // 优先用缓存的检测结果，否则实时计算
  let detectedCountry = currentBackcheckDetail._detectedCountry;
  let contact = currentBackcheckDetail._contact;
  if (!detectedCountry && currentBackcheckDetail.country) {
    const countryMap = { '巴西':'Brazil','brasil':'Brazil','brazil':'Brazil','墨西哥':'Mexico','méxico':'Mexico','mexico':'Mexico','智利':'Chile','chile':'Chile','秘鲁':'Peru','perú':'Peru','peru':'Peru','哥伦比亚':'Colombia','colombia':'Colombia','阿根廷':'Argentina','argentina':'Argentina' };
    const raw = currentBackcheckDetail.country.split(/[\n(（⚠]/)[0].trim();
    for (const [k, v] of Object.entries(countryMap)) {
      if (raw.toLowerCase().includes(k.toLowerCase())) { detectedCountry = v; break; }
    }
    contact = contactsData?.find(c => (c.company || '').trim() === (currentBackcheckCompany || '').trim());
  }
  if (!detectedCountry) { showToast('未检测到国家信息', 'err'); return; }
  const old = contact?.country || '(空)';
  if (!confirm(`确认将「${currentBackcheckCompany}」所有联系人的国家标签从「${old}」修改为「${detectedCountry}」？`)) return;
  showToast('正在更新...', 'ok');
  let result;
  try {
    result = await window.electronAPI.updateCompanyCountry(currentBackcheckCompany, detectedCountry);
  } catch(e) {
    showToast('更新失败（需重启应用生效 main.js 改动）: ' + e.message, 'err');
    return;
  }
  if (result.ok && result.updated > 0) {
    showToast(`✅ 已修正 ${result.updated}/${result.total} 位联系人：${old} → ${detectedCountry}`, 'ok');
    contactsData = await window.electronAPI.getContacts();
    loadBackcheck();
  } else { showToast(`修正失败: ${result.error || '无匹配联系人'}`, 'err'); }
}
function renderBackcheckCard(info, companyName, st) {
  const reportWrap = document.getElementById('backcheck-report-wrap');
  if (!reportWrap) return;

  currentBackcheckCompany = companyName;
  currentBackcheckDetail = info;

  const hasData = info?.raw && info.raw.length > 50;
  const isDone = st?.status === 'done';
  const isResearching = st?.status === 'researching';
  const isPending = st?.status === 'pending';
  const isTimeout = st?.status === 'timeout';
  const isError = st?.status === 'error' || st?.status === 'no_results' || st?.status === 'no_key';

  const rating = info?.rating || 0;

  // 检测国家标签不匹配
  const countryMap = {
    '巴西': 'Brazil', 'brasil': 'Brazil', 'brazil': 'Brazil',
    '墨西哥': 'Mexico', 'méxico': 'Mexico', 'mexico': 'Mexico',
    '智利': 'Chile', 'chile': 'Chile',
    '秘鲁': 'Peru', 'perú': 'Peru', 'peru': 'Peru',
    '哥伦比亚': 'Colombia', 'colombia': 'Colombia',
    '阿根廷': 'Argentina', 'argentina': 'Argentina',
  };
  let detectedCountry = null, countryMismatch = false, contact = null;
  if (info?.country) {
    const rawCountry = info.country.split(/[\n(（⚠]/)[0].trim(); // 提取纯国家名
    for (const [key, std] of Object.entries(countryMap)) {
      if (rawCountry.toLowerCase().includes(key.toLowerCase())) { detectedCountry = std; break; }
    }
    // 对比联系人当前国家标签
    contact = contactsData?.find(c => (c.company || '').trim() === (companyName || '').trim());
    if (detectedCountry && contact && contact.country !== detectedCountry) {
      countryMismatch = true;
    }
  }

  let bodyHtml = '';
  if (hasData || isDone) {
    const mdText = (info.raw || '').replace(/^[^#]*(?=# )/s, '').replace(/^> \*\*国家.*开发价值.*$/gm, '').replace(/\n\n\n+/g, '\n\n');
    const ratingHtml = rating > 0 ? `<div style="margin:8px 0 16px;font-size:13px;color:var(--text-secondary)">开发价值：${ratingStars(rating)} <span style="font-size:11px">(${rating}/5)</span></div>` : '';
    bodyHtml = `<div class="backcheck-report">${ratingHtml}${renderMarkdown(mdText)}</div>`;
  } else if (isError) {
    const msg = st?.progress || st?.message || '背调失败';
    bodyHtml = `<p style="color:var(--danger);padding:20px;text-align:center">${lucide('x-circle',16)} ${msg}</p>
      <p style="color:var(--text-secondary);font-size:12px;text-align:center;margin-top:4px">请确认公司官网地址是否正确，或稍后重试</p>`;
  } else if (isResearching || isPending) {
    bodyHtml = `<p style="color:var(--warning);padding:20px;text-align:center">${lucide('refresh-cw',16,'spin')} ${st?.progress || '处理中...'}</p>`;
  } else if (isTimeout) {
    bodyHtml = `<p style="color:var(--danger);padding:20px;text-align:center">${lucide('clock',16)} 请求超时，请检查请求文件</p>`;
  } else {
    bodyHtml = '<p style="color:var(--text-secondary);padding:20px;text-align:center">点击下方按钮开始背调</p>';
  }
  const showProgress = isResearching || isPending || isTimeout;
  const showStartBtn = !isDone && !isResearching && !isPending;
  const showCancelBtn = isResearching || isPending;

  info._detectedCountry = detectedCountry;
  info._contact = contact;

  // ── 渲染工具栏（固定区）───────────────────────────────────────
  const toolbar = document.getElementById('backcheck-toolbar');
  let toolbarHtml = '';
  if (countryMismatch) {
    toolbarHtml += '<div style="width:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;margin-bottom:6px;background:#fff3e0;border:1px solid #ff9800;border-radius:6px;font-size:12px"><span>⚠️ 真实国家：<b>' + detectedCountry + '</b>，当前：<b>' + escapeHtml(contact?.country || '(空)') + '</b></span><button id="btn-fix-country" style="margin-left:auto;font-size:11px;padding:3px 10px;white-space:nowrap">修正</button></div>';
  }
  toolbarHtml += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
  if (!isResearching && !isPending) {
    toolbarHtml += '<select id="bc-provider" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg)"><option value="deep-research"' + (lastBackcheckProvider==='deep-research'?' selected':'') + '>Exa + DeepSeek</option><option value="serper-deepseek"' + (lastBackcheckProvider==='serper-deepseek'?' selected':'') + '>Google + DeepSeek</option><option value="tavily-deepseek"' + (lastBackcheckProvider==='tavily-deepseek'?' selected':'') + '>Tavily + DeepSeek</option><option value="ds-only"' + (lastBackcheckProvider==='ds-only'?' selected':'') + '>DeepSeek（快速）</option></select>';
  }
  if (showStartBtn) toolbarHtml += '<button id="btn-research">' + lucide('search',14) + ' 开始背调</button>';
  if (isDone) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重新调查</button>';
  if (isError) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重试</button>';
  if (isTimeout) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重新调查</button>';
  if (showCancelBtn) toolbarHtml += '<button id="btn-cancel-research" class="danger" style="font-size:12px;padding:5px 14px">' + lucide('x',12) + ' 取消</button>';
  toolbarHtml += '<button id="btn-open-folder" style="font-size:12px;padding:5px 14px">' + lucide('folder-open',12) + ' 打开文件夹</button>';
  if (contactsSendHistory[companyName]?.stage === 'archived') toolbarHtml += '<button id="btn-reactivate-bc" style="font-size:12px;padding:5px 14px;color:var(--success)">' + lucide('rotate-ccw',12) + ' 重新激活</button>';
  if (isDone && info?.raw) toolbarHtml += '<button id="btn-add-to-queue" style="font-size:12px;padding:5px 14px;background:var(--success);color:#fff">' + lucide('send',12) + ' 加入队列</button>';
  toolbarHtml += '</div>';
  if (toolbar) { toolbar.innerHTML = toolbarHtml; toolbar.style.display = 'flex'; }

  // ── 渲染报告（可滚动区）───────────────────────────────────────
  const progressHtml = showProgress ? '<div style="background:#fff8e1;border:1px solid #ffe0b2;border-radius:6px;padding:12px;margin-top:12px"><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">' + lucide('radio-tower',14) + ' 状态</div><div style="font-size:13px;color:var(--primary)">' + (st?.progress || '等待处理...') + '</div>' + (isPending ? '<div style="font-size:11px;color:var(--warning);margin-top:6px">' + lucide('file-text',12) + ' 请求文件已生成，对 Claude 说「处理背调请求」即可自动完成</div>' : '') + (isTimeout ? '<div style="font-size:11px;color:var(--danger);margin-top:6px">报告未在 10 分钟内生成，请手动检查</div>' : '') + '</div>' : '';

  if (reportWrap) {
    reportWrap.dataset.translated = '0';
    reportWrap.innerHTML = bodyHtml + progressHtml;
  }
  const statusEl = document.getElementById('translate-status');
  if (statusEl) statusEl.style.display = 'none';
  const dsPanel = document.getElementById('deep-search-results');
  if (dsPanel) dsPanel.style.display = 'none';

  // ── Agnes 开发信验证（后台，境外断网时跳过）─────────────────────
  if (isDone && info?.emailBody && foreignNetworkOk) {
    const vBar = document.createElement('div');
    vBar.id = 'email-verify-bar';
    vBar.style.cssText = 'margin-top:12px;padding:8px 12px;border-radius:6px;font-size:11px;display:flex;align-items:center;gap:8px;background:#f5f6fa;border:1px solid var(--border)';
    vBar.innerHTML = lucide('refresh-cw',12,'spin') + ' 正在检查开发信...';
    reportWrap.appendChild(vBar);

    window.electronAPI.verifyEmail(info.emailBody).then(result => {
      if (result?.ok) {
        const pct = Math.round(result.passed / result.total * 100);
        const ok = result.passed === result.total;
        vBar.style.background = ok ? '#e8f5e9' : '#fff3e0';
        vBar.style.border = ok ? '1px solid #a5d6a7' : '1px solid #ffcc02';
        vBar.innerHTML = (ok ? lucide('check-circle',12) : lucide('alert-circle',12))
          + ` 自查通过 ${result.passed}/${result.total} 项` + (ok ? '' : ' — 点击查看详情');
        vBar.style.cursor = ok ? 'default' : 'pointer';
        vBar.title = result.details || '';
        if (!ok) {
          vBar.addEventListener('click', () => {
            alert('开发信自查结果：\n\n' + (result.details || '无详情'));
          });
        }
      } else {
        vBar.innerHTML = lucide('x-circle',12) + ' 验证失败: ' + (result?.error || '未知');
        vBar.style.background = '#ffebee';
      }
    }).catch(e => {
      vBar.innerHTML = lucide('x-circle',12) + ' 验证异常';
      vBar.style.background = '#ffebee';
    });
  }
}

// ── 决策人结果渲染 ──────────────────────────────────────────────
function renderDeepSearchResults(panel, result) {
  const { people, stats, company_info } = result;
  const logisticsPeople = people.filter(p => p.department === 'logistics');
  const managementPeople = people.filter(p => p.department === 'management');
  const otherPeople = people.filter(p => p.department === 'other');

  let html = '';

  // 来源统计
  html += `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;display:flex;gap:16px;flex-wrap:wrap">`;
  html += `<span>${lucide('globe',12)} 官网: ${stats.from_website}人</span>`;
  html += `<span>${lucide('linkedin',12)} LinkedIn: ${stats.from_linkedin}人</span>`;
  html += `<span>🎯 物流/采购: ${stats.logistics}人</span>`;
  html += `</div>`;

  // 物流/采购决策人 — 重点展示
  if (logisticsPeople.length) {
    html += `<div style="margin-bottom:12px">`;
    html += `<div style="font-size:13px;font-weight:600;color:var(--success);margin-bottom:8px">🎯 物流/采购决策人 (${logisticsPeople.length}人)</div>`;
    logisticsPeople.forEach(p => {
      html += renderPersonCard(p, true);
    });
    html += `</div>`;
  }

  // 高管
  if (managementPeople.length) {
    html += `<div style="margin-bottom:12px">`;
    html += `<div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">👔 管理层 (${managementPeople.length}人)</div>`;
    managementPeople.forEach(p => {
      html += renderPersonCard(p, false);
    });
    html += `</div>`;
  }

  // 其他
  if (otherPeople.length) {
    html += `<details style="margin-bottom:8px"><summary style="font-size:12px;color:var(--text-secondary);cursor:pointer">👤 其他人员 (${otherPeople.length}人)</summary><div style="margin-top:8px">`;
    otherPeople.slice(0, 5).forEach(p => {
      html += renderPersonCard(p, false);
    });
    html += `</div></details>`;
  }

  if (!people.length) {
    html += `<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">`;
    html += `未找到决策人信息。<br><span style="font-size:11px">公司官网可能没有团队页面，LinkedIn 可能未登录。</span>`;
    html += `</div>`;
  }

  panel.innerHTML = html;
}

function renderPersonCard(p, highlight) {
  const confidenceDots = p.confidence > 0.5 ? '🟢' : p.confidence > 0.3 ? '🟡' : '⚪';

  return `
    <div class="deep-person-card" style="background:${highlight ? '#f0faf0' : '#f8f9fb'};border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="flex:1;min-width:180px">
        <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(p.name)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHtml(p.title)}</div>
        ${p.location ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px">📍 ${escapeHtml(p.location)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${p.email ? `<span style="font-size:11px;color:var(--text-secondary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.email)}">${confidenceDots} ${escapeHtml(p.email)}</span>` : ''}
        <button class="btn-add-contact secondary" data-cname="${escapeHtml(p.name)}" data-ctitle="${escapeHtml(p.title)}" data-cemail="${escapeHtml(p.email || '')}" style="font-size:11px;padding:3px 8px;cursor:pointer;white-space:nowrap">+ 联系人</button>
      </div>
    </div>`;
}

// 事件代理：点击「添加到联系人」
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-add-contact');
  if (!btn) return;
  const name = btn.dataset.cname;
  if (!name) return;

  const client = {
    company: name.split(' ').slice(-1)[0],
    contactName: name,
    position: btn.dataset.ctitle,
    email: btn.dataset.cemail,
  };

  try {
    const result = await window.electronAPI.importContacts([client]);
    if (result?.added > 0) {
      btn.textContent = '✓ 已添加';
      btn.style.color = 'var(--success)';
      btn.disabled = true;
    } else if (result?.skipped > 0) {
      btn.textContent = '已存在';
      btn.style.color = 'var(--text-secondary)';
      btn.disabled = true;
    }
  } catch {
    btn.textContent = '失败';
    btn.style.color = 'var(--danger)';
  }
});


// ===== 邮件发送 ======================================================
const STAGES_SEND = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
const STAGE_LABELS_SEND = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', archived: '📦 已归档' };
const STAGE_NEXT_SEND = { '': 'cold', cold: 'f1', f1: 'f2', f2: 'f3', f3: 'f4', f4: 'archived', archived: 'archived' };

let sendCompanies = {};
let sendHistory = {};
let selectedCards = {};
let selectedCompanySet = new Set(); // 持久化勾选状态，搜索不清除
let sendStageFilter = 'active';    // active | archived
let discoverPreselectCompany = null; // 从客户开发页面预选公司跳转

async function initEmailSend() {
  if (!templateLib) templateLib = await window.electronAPI.getTemplateLibrary();
  document.getElementById('ws-add-queue').addEventListener('click', addToQueue);
  document.getElementById('monthly-generate-btn')?.addEventListener('click', generateMonthlyReports);
  // 阶段筛选标签
  document.querySelectorAll('.send-stage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.send-stage-tab').forEach(t => {
        t.style.background = 'var(--bg)';
        t.style.color = 'var(--text-secondary)';
        t.classList.remove('active');
      });
      tab.classList.add('active');
      tab.style.background = 'var(--primary)';
      tab.style.color = '#fff';
      sendStageFilter = tab.dataset.stage;
      selectedCompanySet.clear();
      renderCompanyList(document.getElementById('send-search')?.value || '');
    });
  });
  await loadSendContacts();
}


// ── 模板预览 ──────────────────────────────────────────────────────
async function initTemplatePreview() {
  if (!templateLib) templateLib = await window.electronAPI.getTemplateLibrary();
  // 预加载签名
  let sigHtml = '';
  try { const r = await window.electronAPI.loadSignature(); if (r.ok) sigHtml = r.html; } catch {}

  let selType = 'agent', selLang = 'es', selStage = 'cold';

  // 将纯文本邮件转为 HTML（100% 复刻 main.js buildContent 输出）
  function textToHtml(bodyText) {
    const lines = bodyText.split('\n');
    const htmlLines = [];
    let isFirstLine = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const content = (isFirstLine && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${escapeHtml(t)}</strong>`
        : escapeHtml(t);
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${content}</p>`);
      isFirstLine = false;
    }
    return htmlLines.join('\n') + '\n<br>\n' + sigHtml;
  }

  const render = () => {
    if (!templateLib) return;
    const picked = randomPick(selType, selStage, [], false);
    const email = assembleEmail(selLang, picked.hook, picked.pain, picked.proof, picked.cta, picked.followup, selStage, selType, false);
    const html = textToHtml(email);
    const content = document.getElementById('tpl-preview-content');
    if (!content) return;

    // 在正文旁标注来源 ID
    const srcLabels = [];
    if (picked.hook) srcLabels.push('Hook: ' + picked.hook.id);
    if (picked.pain) srcLabels.push('Pain: ' + picked.pain.id);
    if (picked.proof) srcLabels.push('Proof: ' + picked.proof.id);
    if (picked.cta) srcLabels.push('CTA: ' + picked.cta.id);
    if (picked.followup) srcLabels.push('FollowUp: ' + picked.followup.id);

    content.innerHTML = `<div style="margin-bottom:8px;font-size:10px;color:var(--text-secondary)">📋 ${srcLabels.join(' · ')}</div>
      <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:4px">${html}</div>`;
  };

  if (!document.getElementById('tpl-regenerate')?._bound) {
    document.querySelectorAll('.tpl-type').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-type').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selType = b.dataset.val; render();
    }));
    document.querySelectorAll('.tpl-lang').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-lang').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selLang = b.dataset.val; render();
    }));
    document.querySelectorAll('.tpl-stage').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-stage').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selStage = b.dataset.val; render();
    }));
    document.getElementById('tpl-regenerate')?.addEventListener('click', render);
    document.getElementById('tpl-regenerate')._bound = true;
  }
  render();
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

let sendBackcheckStatus = {}; // 发送页面背调评分缓存

async function loadSendContacts() {
  contactsData = await window.electronAPI.getContacts();
  sendHistory = await window.electronAPI.getSendHistory() || {};
  try { sendBackcheckStatus = await window.electronAPI.getBackcheckStatus(); } catch { sendBackcheckStatus = {}; }
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
  // 排序：联系人数 + 背调评分加权（评分 × 2 作为额外权重，高分优先）
  let all = Object.entries(sendCompanies).sort((a, b) => {
    const ra = sendBackcheckStatus[a[0]]?.rating || 0;
    const rb = sendBackcheckStatus[b[0]]?.rating || 0;
    const scoreA = a[1].length + (ra * 2);
    const scoreB = b[1].length + (rb * 2);
    return scoreB - scoreA;
  });
  if (filter) all = all.filter(([n]) => n.toLowerCase().includes(filter));

  const activeList = all.filter(([name]) => sendHistory[name]?.stage !== 'archived');
  const archivedList = all.filter(([name]) => sendHistory[name]?.stage === 'archived');

  let visible;
  if (sendStageFilter === 'archived') { visible = archivedList; }
  else { visible = activeList; }

  const archTab = document.querySelector('.send-stage-tab[data-stage="archived"]');
  if (archTab) archTab.textContent = `📦 已归档 (${archivedList.length})`;

  if (!visible.length) {
    const msg = sendStageFilter === 'archived' ? '暂无已归档公司 — 发完 F4 后自动归档' : '无匹配公司';
    container.innerHTML = `<p style="font-size:12px;color:var(--text-secondary);padding:8px">${msg}</p>`;
    if (sendStageFilter === 'active') updateSelectedCount();
    return;
  }

  const isArchivedView = sendStageFilter === 'archived';

    // 按开发阶段分组
  if (isArchivedView) {
      // 按开发阶段分组
  if (isArchivedView) {
    container.innerHTML = visible.map(function(pair) {
      var name = pair[0], members = pair[1];
      var ctype = members[0]?.clientType || 'unlabeled';
      var tagHtml = clientTypeTag(ctype);
      var ctry = escapeHtml(members[0]?.country || '');
      var hist = sendHistory[name];
      var vipClass = members.length >= 5 ? ' ci-vip' : '';
      var startedStr = hist?.startedAt ? '📅 ' + formatDate(hist.startedAt) : '';
      var daysStr = hist?.startedAt ? '<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">' + daysSince(hist.startedAt) + '</span>' : '';
      var archivedStr = hist?.archivedAt ? '📦 ' + formatDate(hist.archivedAt) : '';
      var subParts = [tagHtml, ctry, startedStr, archivedStr].filter(Boolean);
      return '<div class="send-company-item archived" data-company="' + escapeHtml(name) + '" style="opacity:.7">' +
        '<div class="sci-info">' +
          '<span class="ci-name' + vipClass + '">📦 ' + escapeHtml(name) + daysStr + '</span>' +
          (subParts.length ? '<span class="sci-sub">' + subParts.join(' · ') + '</span>' : '') +
        '</div>' +
        '<button class="btn-reactivate-send" data-company="' + escapeHtml(name) + '" style="font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--success);background:transparent;color:var(--success);cursor:pointer;white-space:nowrap">🔄 重新激活</button>' +
      '</div>';
    }).join('');
  } else {
    // 活跃视图：按阶段分组
    var stageGroups = {};
    var STAGES = ['cold','f1','f2','f3','f4'];
    visible.forEach(function(pair) {
      var name = pair[0], members = pair[1];
      var stage = sendHistory[name]?.stage || 'cold';
      if (!stageGroups[stage]) stageGroups[stage] = [];
      stageGroups[stage].push([name, members]);
    });
    var html = '';
    for (var si = 0; si < STAGES.length; si++) {
      var stage = STAGES[si];
      var items = stageGroups[stage];
      if (!items || !items.length) continue;
      var totalContacts = items.reduce(function(s, p) { return s + p[1].length; }, 0);
      var gid = 'sg-' + stage;
      html += '<div class="send-stage-group">' +
        '<div class="send-stage-head" data-group="' + gid + '" style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f0f2f5;border-bottom:1px solid #e0e0e0;font-size:11px;font-weight:600">' +
          '<span class="sg-arrow" style="display:inline-block;width:10px;font-size:9px;transition:transform .2s">▸</span>' +
          '<span class="stage-badge stage-' + stage + '">' + STAGE_LABELS_SEND[stage] + '</span>' +
          '<span>' + items.length + ' 家 · ' + totalContacts + ' 人</span>' +
        '</div>' +
        '<div class="send-stage-cards" data-group="' + gid + '" style="display:none">' +
          items.map(function(pair) {
            var name = pair[0], members = pair[1];
            var ctype = members[0]?.clientType || 'unlabeled';
            var tagHtml = clientTypeTag(ctype);
            var ctry = escapeHtml(members[0]?.country || '');
            var hist = sendHistory[name];
            var vipClass = members.length >= 5 ? ' ci-vip' : '';
            var startedStr = hist?.startedAt ? '📅 ' + formatDate(hist.startedAt) : '';
            var daysStr = hist?.startedAt ? '<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">' + daysSince(hist.startedAt) + '</span>' : '';
            var subParts = [tagHtml, ctry, startedStr].filter(Boolean);
            var countStyle = members.length >= 20 ? ' style="color:var(--warning);font-weight:600"' : '';
            return '<div class="send-company-item" data-company="' + escapeHtml(name) + '">' +
              '<input type="checkbox" class="sc-check" data-company="' + escapeHtml(name) + '"' + (selectedCompanySet.has(name) ? ' checked' : '') + '>' +
              '<div class="sci-info">' +
                '<span class="ci-name' + vipClass + '">' + escapeHtml(name) + daysStr + '</span>' +
                (subParts.length ? '<span class="sci-sub">' + subParts.join(' · ') + '</span>' : '') +
              '</div>' +
              '<span class="ci-count"' + countStyle + '>' + members.length + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;

    // 阶段折叠
    container.querySelectorAll('.send-stage-head').forEach(function(head) {
      head.addEventListener('click', function() {
        var gid = head.dataset.group;
        var cards = container.querySelector('.send-stage-cards[data-group="' + gid + '"]');
        var arrow = head.querySelector('.sg-arrow');
        if (!cards) return;
        var hidden = cards.style.display === 'none';
        cards.style.display = hidden ? 'block' : 'none';
        if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
      });
    });
    // 默认展开冷开发
    var coldHead = container.querySelector('.send-stage-head[data-group="sg-cold"]');
    if (coldHead) coldHead.click();
  }
  } else {
    // 活跃视图：按阶段分组
    const stageGroups = {};
    const STAGES = ['cold','f1','f2','f3','f4'];
    visible.forEach(([name, members]) => {
      const stage = sendHistory[name]?.stage || 'cold';
      if (!stageGroups[stage]) stageGroups[stage] = [];
      stageGroups[stage].push([name, members]);
    });
    let html = '';
    for (const stage of STAGES) {
      const items = stageGroups[stage];
      if (!items || !items.length) continue;
      const totalContacts = items.reduce((s, [,m]) => s + m.length, 0);
      const gid = 'sg-' + stage;
      html += '<div class="send-stage-group">' +
        '<div class="send-stage-head" data-group="' + gid + '" style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f0f2f5;border-bottom:1px solid #e0e0e0;font-size:11px;font-weight:600">' +
          '<span class="sg-arrow" style="display:inline-block;width:10px;font-size:9px;transition:transform .2s">▸</span>' +
          '<span class="stage-badge stage-' + stage + '">' + STAGE_LABELS_SEND[stage] + '</span>' +
          '<span>' + items.length + ' 家 · ' + totalContacts + ' 人</span>' +
        '</div>' +
        '<div class="send-stage-cards" data-group="' + gid + '" style="display:none">' +
          items.map(([name, members]) => {
            const ctype = members[0]?.clientType || 'unlabeled';
            const tagHtml = clientTypeTag(ctype);
            const ctry = escapeHtml(members[0]?.country || '');
            const hist = sendHistory[name];
            const vipClass = members.length >= 5 ? ' ci-vip' : '';
            const startedStr = hist?.startedAt ? '📅 ' + formatDate(hist.startedAt) : '';
            const daysStr = hist?.startedAt ? '<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">' + daysSince(hist.startedAt) + '</span>' : '';
            const subParts = [tagHtml, ctry, startedStr].filter(Boolean);
            const countStyle = members.length >= 20 ? ' style="color:var(--warning);font-weight:600"' : '';
            return '<div class="send-company-item" data-company="' + escapeHtml(name) + '">' +
              '<input type="checkbox" class="sc-check" data-company="' + escapeHtml(name) + '"' + (selectedCompanySet.has(name) ? ' checked' : '') + '>' +
              '<div class="sci-info">' +
                '<span class="ci-name' + vipClass + '">' + escapeHtml(name) + daysStr + '</span>' +
                (subParts.length ? '<span class="sci-sub">' + subParts.join(' · ') + '</span>' : '') +
              '</div>' +
              '<span class="ci-count"' + countStyle + '>' + members.length + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;

    // 阶段折叠
    container.querySelectorAll('.send-stage-head').forEach(head => {
      head.addEventListener('click', () => {
        const gid = head.dataset.group;
        const cards = container.querySelector('.send-stage-cards[data-group="' + gid + '"]');
        const arrow = head.querySelector('.sg-arrow');
        if (!cards) return;
        const hidden = cards.style.display === 'none';
        cards.style.display = hidden ? 'block' : 'none';
        if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
      });
    });
    // 默认展开冷开发
    container.querySelector('.send-stage-head[data-group="sg-cold"]')?.click();
  }

  if (isArchivedView) {
    container.querySelectorAll('.btn-reactivate-send').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const company = btn.dataset.company;
        if (!confirm(`确定重新激活 ${company}？\n将重置为冷开发阶段，清空序列记录。`)) return;
        btn.disabled = true; btn.textContent = '⏳';
        await window.electronAPI.reactivateCompany(company);
        sendHistory = await window.electronAPI.getSendHistory() || {};
        sendStageFilter = 'active';
        document.querySelectorAll('.send-stage-tab').forEach(t => {
          t.style.background = 'var(--bg)'; t.style.color = 'var(--text-secondary)'; t.classList.remove('active');
        });
        const activeTab = document.querySelector('.send-stage-tab[data-stage="active"]');
        if (activeTab) { activeTab.classList.add('active'); activeTab.style.background = 'var(--primary)'; activeTab.style.color = '#fff'; }
        renderCompanyList(document.getElementById('send-search')?.value || '');
        updateMonthlyReportSection();
        showToast(`${company} 已重新激活`, 'ok');
      });
    });
    updateMonthlyReportSection();
  } else {
    updateSelectedCount();
    container.querySelectorAll('.send-company-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        const cb = el.querySelector('.sc-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      const cb = el.querySelector('.sc-check');
      if (cb) {
        cb.addEventListener('change', (e) => {
          const name = e.target.dataset.company;
          if (e.target.checked) selectedCompanySet.add(name);
          else selectedCompanySet.delete(name);
          updateSelectedCount();
        });
      }
    });
  }

  // 右键菜单：重置状态
  container.oncontextmenu = (e) => {
    const item = e.target.closest('.send-company-item');
    if (!item) return;
    const company = item.dataset.company;
    if (!company) return;
    e.preventDefault();
    // 移除旧菜单
    document.getElementById('ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:13px';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = '<div style="padding:6px 14px;cursor:pointer;color:#333;white-space:nowrap;border-radius:4px;margin:0 4px;transition:background .15s" data-action="reset" onmouseenter="this.style.background=\'#f0f0f0\'" onmouseleave="this.style.background=\'transparent\'">🔄 重置状态</div>';
    menu.querySelector('[data-action="reset"]').onclick = async () => {
      menu.remove();
      if (!confirm(`确定重置 ${company}？\n将清空序列记录，恢复为冷开发阶段。`)) return;
      await window.electronAPI.reactivateCompany(company);
      sendHistory = await window.electronAPI.getSendHistory() || {};
      renderCompanyList(document.getElementById('send-search')?.value || '');
      updateMonthlyReportSection();
      showToast(`${company} 已重置`, 'ok');
    };
    document.body.appendChild(menu);
    // 点击其他地方关闭
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  };
}

function getSelectedCompanies() {
  return [...selectedCompanySet];
}

function updateSelectedCount() {
  const selected = getSelectedCompanies();
  let totalContacts = 0;
  for (const name of selected) {
    totalContacts += (sendCompanies[name] || []).length;
  }
  const countEl = document.getElementById('send-selected-count');
  if (countEl) countEl.textContent = '';
  // 归档视图下隐藏加入队列按钮，显示批量重新激活
  const addBtn = document.getElementById('ws-add-queue');
  const listTitle = document.getElementById('send-list-title');
  const cardsContainer = document.getElementById('send-company-cards');
  const emptyEl = document.getElementById('send-cards-empty');
  if (sendStageFilter === 'archived') {
    if (addBtn) addBtn.style.display = 'none';
    if (listTitle) listTitle.textContent = selected.length ? `已选归档公司 (${selected.length} 家)` : '已归档公司';
    if (cardsContainer) cardsContainer.innerHTML = selected.length
      ? `<div style="text-align:center;padding:40px"><button id="btn-reactivate-all" style="font-size:14px;padding:10px 24px">🔄 全部重新激活 (${selected.length} 家)</button></div>`
      : '';
    if (emptyEl && !selected.length) { emptyEl.textContent = '← 勾选左侧公司，使用「全选」批量激活'; emptyEl.style.display = 'block'; }
    else if (emptyEl) emptyEl.style.display = 'none';
    // 绑定批量重新激活按钮
    if (selected.length) {
      setTimeout(() => {
        document.getElementById('btn-reactivate-all')?.addEventListener('click', async () => {
          if (!confirm(`确定重新激活全部 ${selected.length} 家归档公司？`)) return;
          const btn = document.getElementById('btn-reactivate-all');
          if (btn) { btn.disabled = true; btn.textContent = '⏳ 激活中...'; }
          for (const name of selected) {
            await window.electronAPI.reactivateCompany(name).catch(() => {});
          }
          sendHistory = await window.electronAPI.getSendHistory() || {};
          selectedCompanySet.clear();
          sendStageFilter = 'active';
          document.querySelectorAll('.send-stage-tab').forEach(t => {
            t.style.background = 'var(--bg)'; t.style.color = 'var(--text-secondary)'; t.classList.remove('active');
          });
          const activeTab = document.querySelector('.send-stage-tab[data-stage="active"]');
          if (activeTab) { activeTab.classList.add('active'); activeTab.style.background = 'var(--primary)'; activeTab.style.color = '#fff'; }
          renderCompanyList(document.getElementById('send-search')?.value || '');
          updateMonthlyReportSection();
          showToast(`已重新激活 ${selected.length} 家公司`, 'ok');
        });
      }, 0);
    }
  } else {
    if (addBtn) addBtn.style.display = '';
    if (listTitle) listTitle.textContent = selected.length ? `已选公司 (${selected.length} 家 · ${totalContacts} 人)` : '已选公司';
    renderSelectedCards();
  }
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
  let tc = 0;
  for (const name of selected) { tc += (sendCompanies[name] || []).length; }
  if (title) title.textContent = `已选公司 (${selected.length} 家 · ${tc} 人)`;
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
      const typeTag = clientTypeTag(card.type);
      const typeLabelMap = { agent: '代理模板', direct: '直客模板', unlabeled: '通用模板' };
      const tplLabel = typeLabelMap[card.type] || '通用模板';
      const hist2 = sendHistory[name];
      const startedStr = hist2?.startedAt ? `<span>📅 ${formatDate(hist2.startedAt)}</span>` : '';
      const daysStr2 = hist2?.startedAt ? `<span style="color:var(--accent);font-weight:600">${daysSince(hist2.startedAt)}</span>` : '';
      const tags = [
        typeTag,
        ctry ? `<span>${ctry}</span>` : '',
        `<span>${card.lang.toUpperCase()}</span>`,
        `<span>${emailCount}人</span>`,
        `<span>📝 ${tplLabel}</span>`,
        daysStr2,
        startedStr,
      ].filter(Boolean).join(' · ');
      return `<div class="sc-card">
        <div class="sc-card-header">
          <strong>${escapeHtml(name)}</strong>
          <span class="sc-stage">${STAGE_LABELS_SEND[card.stage]} → ${nextLabel}</span>
          <button class="sc-card-remove" data-company="${escapeHtml(name)}">${lucide('x',14)}</button>
        </div>
        <div class="sc-card-meta">${tags}</div>
      </div>`;
    }).join('');
    container.querySelectorAll('.sc-card-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedCompanySet.delete(btn.dataset.company);
        // 同步取消左侧勾选
        const cb = document.querySelector(`.sc-check[data-company="${CSS.escape(btn.dataset.company)}"]`);
        if (cb) cb.checked = false;
        updateSelectedCount();
      });
    });
  }
}

function randomPick(type, stage, usedSentences, isArgentina) {
  if (!templateLib) return {};
  const usedSet = new Set(usedSentences || []);

  // 从数组随机选取，支持已用排除 + 可选过滤
  const pickFrom = (arr, filterFn) => {
    if (!arr || !arr.length) return null;
    let pool = arr.filter(item => !usedSet.has(item.id));
    if (pool.length === 0) pool = [...arr];
    if (filterFn && pool.some(filterFn)) pool = pool.filter(filterFn);
    if (pool.length === 0) pool = arr.filter(item => !usedSet.has(item.id));
    if (pool.length === 0) pool = [...arr];
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // Hook：阿根廷优先 hooksAR
  const pickHook = (isAR) => {
    if (isAR && templateLib.hooksAR?.length) return pickFrom(templateLib.hooksAR) || pickFrom(templateLib.hooks);
    return pickFrom(templateLib.hooks);
  };

  // CTA：阶段策略驱动
  const pickCTA = (isAR) => {
    const src = (isAR && templateLib.ctasAR?.length) ? templateLib.ctasAR : templateLib.ctas;
    // F3/F4 → 优先 C-4（留门），F2 → 优先 C-3（分享洞察），其余任意
    if (stage === 'f3' || stage === 'f4') return pickFrom(src, item => item.id.endsWith('4')) || pickFrom(src);
    if (stage === 'f2') return pickFrom(src, item => item.id.endsWith('3')) || pickFrom(src);
    return pickFrom(src);
  };

  // F3/F4 不用 Hook/Pain，F4 不用 Proof
  const skipHook = (stage === 'f3' || stage === 'f4');
  const skipPain = (stage === 'f3' || stage === 'f4');
  const skipProof = (stage === 'f4');

  // Proof 阶段策略：F3 只用简洁版（编号以 4 结尾），冷开发/F1/F2 任意
  const pickProof = () => {
    if (stage === 'f3') return pickFrom(templateLib.proofs?.[type], item => item.id.endsWith('4'));
    return pickFrom(templateLib.proofs?.[type]);
  };

  return {
    hook: skipHook ? null : pickHook(isArgentina),
    pain: skipPain ? null : pickFrom(templateLib.painPoints?.[type]),
    proof: skipProof ? null : pickProof(),
    cta: pickCTA(isArgentina),
    followup: (stage !== 'cold' && stage !== 'archived') ? pickFrom(templateLib.followUps?.[stage]) : null,
  };
}

// 邮箱格式校验（与 main.js 保持一致）
const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;
let queueIdCounter = Date.now();

async function addToQueue() {
  const selected = getSelectedCompanies();
  if (!selected.length) return alert('请先勾选左侧公司');
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  // 均匀模式：batch_size 同时控制分组大小和批暂停；多规则：用 group_size
  const GROUP_SIZE = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);
  let added = 0, skippedNoEmail = 0, skippedInvalidEmail = 0, skippedDupOrBounced = 0;
  for (const name of selected) {
    const card = selectedCards[name];
    if (!card) continue;
    const members = sendCompanies[name] || [];
    // 过滤已退信的永久联系人 + 已发送过的联系人
    const sentContacts = new Set((sendHistory[name]?.sentContacts || []).map(e => e.toLowerCase().trim()));
    const bouncedMembers = members.filter(m => m.bounced && m.bounceType !== 'temporary');
    const alreadySent = members.filter(m => sentContacts.has((m.email || '').toLowerCase().trim()));
    let activeMembers = members.filter(m => !bouncedMembers.includes(m) && !alreadySent.includes(m));
    let wasReactivated = false;
    if (!activeMembers.length && members.length > 0) {
      // 非退信、阶段为 cold/空 → 可能是上次发送中断，允许重新发送
      const stage = sendHistory[name]?.stage;
      if (!bouncedMembers.length && (!stage || stage === 'cold')) {
        if (confirm(`⚠️ ${name} 的 ${members.length} 个联系人已标记为「已发送」，但开发阶段仍为冷开发。\n可能上次发送未正常完成。是否清除已发记录并重新发送？`)) {
          await window.electronAPI.reactivateCompany(name);
          sendHistory = await window.electronAPI.getSendHistory() || {};
          const newSentContacts = new Set((sendHistory[name]?.sentContacts || []).map(e => e.toLowerCase().trim()));
          const newActive = members.filter(m => !bouncedMembers.includes(m) && !newSentContacts.has((m.email || '').toLowerCase().trim()));
          if (!newActive.length) { skippedDupOrBounced += members.length; continue; }
          activeMembers = newActive;
          wasReactivated = true;
        } else {
          skippedDupOrBounced += members.length;
          continue;
        }
      } else {
        alert(`⚠️ ${name} 所有联系人已发送或退信（${members.length} 人），跳过`);
        skippedDupOrBounced += members.length;
        continue;
      }
    }
    if (wasReactivated) {
      console.log(`🔄 ${name} 已发送记录已清除，${activeMembers.length} 人可重新发送`);
    } else if (alreadySent.length) {
      console.log(`⏭ ${name} 跳过 ${alreadySent.length} 个已发送联系人`);
    }
    // 清洗 & 校验：trim + 去重 + 正则验证
    const emails = [...new Set(
      activeMembers
        .map(m => (m.email || '').trim())
        .filter(e => e)
    )];
    if (!emails.length) { skippedNoEmail++; continue; }
    // 分离有效 / 无效邮箱
    const valid = emails.filter(e => EMAIL_RE.test(e));
    const invalid = emails.filter(e => !EMAIL_RE.test(e));
    if (!valid.length) { skippedInvalidEmail++; continue; }
    // 警告：部分邮箱无效
    if (invalid.length) {
      if (!confirm(`⚠️ ${name} 有 ${invalid.length} 个邮箱格式异常：\n${invalid.join('\n')}\n\n仅发送给 ${valid.length} 个有效邮箱，是否继续？`)) continue;
    }
    const tpl = card.template;
    const lang = card.lang;
    const subjects = templateLib.subjects?.[card.type] || { es: '', pt: '', en: '' };
    const baseSubject = subjects[lang] ?? subjects.es ?? '';

    // 自动分组，每组 ≤ GROUP_SIZE 人
    const totalGroups = Math.ceil(valid.length / GROUP_SIZE);
    const hist = sendHistory[name];
    const stage = hist?.stage || 'cold';
    const isArgentina = (members[0]?.country || '').toLowerCase().includes('argentina');

    for (let g = 0; g < totalGroups; g++) {
      const groupEmails = valid.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE);
      const tpl = randomPick(card.type, stage, [], isArgentina);
      const body = assembleEmail(lang, tpl.hook, tpl.pain, tpl.proof, tpl.cta, tpl.followup, stage, card.type, isArgentina);
      const batchLabel = totalGroups > 1 ? ` (${g + 1}/${totalGroups})` : '';
      queue.push({
        id: ++queueIdCounter, company: name, to: groupEmails.join(", "), recipients: groupEmails,
        subject: baseSubject, body, status: "pending", addedAt: new Date().toISOString(),
        _stage: stage, _type: card.type, _lang: card.lang, _country: members[0]?.country || '',
        _tplInfo: [tpl.hook?.id, tpl.pain?.id, tpl.proof?.id, tpl.cta?.id, tpl.followup?.id].filter(Boolean).join('·'),
        _groupOf: totalGroups > 1 ? name : undefined, _groupSeq: totalGroups > 1 ? g : undefined, _groupTotal: totalGroups > 1 ? totalGroups : undefined,
        _batchLabel: batchLabel,
        _recipientStatus: groupEmails.map(e => ({ email: e, status: 'pending' })),
      });
      added++;
    }
  }
  if (!added) {
    const reasons = [];
    if (skippedNoEmail) reasons.push(`${skippedNoEmail} 家无邮箱`);
    if (skippedInvalidEmail) reasons.push(`${skippedInvalidEmail} 家邮箱格式无效`);
    if (skippedDupOrBounced) reasons.push(`${skippedDupOrBounced} 家已退信/已发送`);
    return alert(`所选公司无法加入队列：${reasons.join('，')}`);
  }
  if (skippedDupOrBounced > 0) {
    showToast(`已自动跳过 ${skippedDupOrBounced} 个已退信/已发送联系人`, 'warn');
  }
  saveQueue();
  document.getElementById('stat-queue').textContent = queue.filter(e => e.status === 'pending').length;
  // 跳转到发送队列
  navItems.forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="queue"]').classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById('page-queue').classList.add('active');
  renderQueue();
}

document.getElementById('send-select-all')?.addEventListener('click', () => {
  if (sendStageFilter === 'archived') {
    // 归档视图：选中侧边栏所有已归档公司
    selectedCompanySet.clear();
    document.querySelectorAll('#send-company-list .send-company-item.archived').forEach(el => {
      if (el.dataset.company) selectedCompanySet.add(el.dataset.company);
    });
  } else {
    document.querySelectorAll('.sc-check').forEach(cb => {
      cb.checked = true;
      if (cb.dataset.company) selectedCompanySet.add(cb.dataset.company);
    });
  }
  updateSelectedCount();
});
document.getElementById('send-deselect-all')?.addEventListener('click', () => {
  selectedCompanySet.clear();
  document.querySelectorAll('.sc-check').forEach(cb => { cb.checked = false; });
  updateSelectedCount();
});
document.getElementById('send-fill-limit')?.addEventListener('click', async () => {
  // 取消当前选择
  selectedCompanySet.clear();
  document.querySelectorAll('.sc-check').forEach(cb => { cb.checked = false; });
  const stage = document.getElementById('send-fill-stage')?.value || 'cold';
  // 读当日剩余额度
  let limit = 500;
  try { const stats = await window.electronAPI.getDashboardStats(); limit = stats.remaining || 500; } catch {}
  let total = 0;
  // 只选对应阶段的公司，按联系人从多到少
  const allItems = document.querySelectorAll('#send-company-list .send-company-item:not(.archived)');
  // 按联系人数量降序
  const sorted = [...allItems].sort((a, b) => {
    const ca = (sendCompanies[a.dataset.company] || []).length;
    const cb = (sendCompanies[b.dataset.company] || []).length;
    return cb - ca;
  });
  for (const el of sorted) {
    const name = el.dataset.company;
    if (!name) continue;
    if ((sendHistory[name]?.stage || 'cold') !== stage) continue;
    const count = (sendCompanies[name] || []).length;
    if (total + count > limit && total > 0) continue;
    selectedCompanySet.add(name);
    const cb = el.querySelector('.sc-check');
    if (cb) cb.checked = true;
    total += count;
  }
  updateSelectedCount();
  const stageLabel = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4' }[stage] || stage;
  showToast(`[${stageLabel}] 已填充 ${selectedCompanySet.size} 家 · ${total} 人（剩余额度 ${limit}）`, 'ok');
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
const typeIcons = { agent: lucide('globe',14), direct: lucide('building',14), unlabeled: lucide('help-circle',14) };
let tmplSaveTimer = null; // 防抖定时器

// ── 共用工具 ───────────────────────────────────────────────────────
function updatePreview() { /* reserved for future live preview */ }

// 防抖自动保存 + 行内状态指示（仅目标输入框旁显示）
async function autoSaveTemplate(saveFn, ta) {
  clearTimeout(tmplSaveTimer);
  const statusEl = ta?.parentElement?.querySelector('.ts-save-status');
  if (statusEl) { statusEl.textContent = '...'; statusEl.style.color = 'var(--warning)'; }
  tmplSaveTimer = setTimeout(async () => {
    try {
      await saveFn();
      if (statusEl) { statusEl.textContent = '✓'; statusEl.style.color = 'var(--success)'; }
    } catch (e) {
      if (statusEl) { statusEl.textContent = '✗'; statusEl.style.color = 'var(--danger)'; }
    }
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
  }, 800);
}

function showToast(msg, type) {
  const existing = document.getElementById('tmpl-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'tmpl-toast';
  const colors = { ok: '#4caf50', warn: '#ff9800', err: '#f44336' };
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;padding:10px 20px;border-radius:6px;color:#fff;background:${colors[type]||'#333'};font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.2)`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ── 共用质量检查（stageEditor / arEditor 复用）─────────────────────
function runQualityCheck(panel, spamWords, limits) {
  const lim = limits || { es: 150, pt: 155, en: 120 };
  const allAreas = panel.querySelectorAll('textarea');

  function wordCount(text) { return text.trim().split(/\s+/).filter(Boolean).length; }
  function hasSpam(text, lang) {
    const words = spamWords[lang] || [];
    const lower = text.toLowerCase();
    return words.filter(w => lower.includes(w.toLowerCase()));
  }

  const issues = [];
  allAreas.forEach(ta => {
    const lang = ta.classList.contains('ts-es') ? 'es' : ta.classList.contains('ts-pt') ? 'pt' : 'en';
    const limit = lim[lang] || 120;
    const text = ta.value;
    const wc = wordCount(text);
    const spam = hasSpam(text, lang);
    const row = ta.closest('.ts-row');
    const check = row?.querySelector('.ts-check');
    let status = '✅', tip = '';
    if (wc > limit) { status = '⚠️'; tip = `超字数 ${wc}/${limit}词`; issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 超字数 (${wc}/${limit})`); }
    if (spam.length) { status = status === '⚠️' ? '🚫⚠️' : '🚫'; tip = (tip ? tip + '、' : '') + '含垃圾词: ' + spam.slice(0,3).join(', '); issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 含垃圾词: ${spam.slice(0,3).join(', ')}`); }
    if (check) {
      check.textContent = status + ` ${wc}词`;
      if (tip) {
        // 更新已有的 tooltip 文本，或创建新的
        let tt = check.querySelector('.ts-tt');
        if (!tt) {
          tt = document.createElement('span');
          tt.className = 'ts-tt';
          tt.style.cssText = 'position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:5px 10px;border-radius:4px;background:#333;color:#fff;font-size:11px;white-space:nowrap;pointer-events:none;z-index:99;box-shadow:0 2px 8px rgba(0,0,0,.2);display:none';
          check.style.cssText = 'position:relative;cursor:default';
          check.appendChild(tt);
        }
        tt.textContent = tip;
        if (!check._ttBound) {
          check._ttBound = true;
          check.addEventListener('mouseenter', () => { const t = check.querySelector('.ts-tt'); if (t) t.style.display = 'block'; });
          check.addEventListener('mouseleave', () => { const t = check.querySelector('.ts-tt'); if (t) t.style.display = 'none'; });
        }
      }
    }
  });

  // 组内重复检查
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
  const report = panel.querySelector('#quality-report') || document.getElementById('quality-report');
  if (!report) return issues;
  if (issues.length === 0) {
    report.innerHTML = `<div style="color:var(--success);padding:8px;background:#e8f5e9;border-radius:4px">${lucide('check-circle',14)} 全部通过 — 无字数超标、无垃圾词、无重复</div>
      <div style="margin-top:4px;font-size:10px;color:var(--text-secondary)">💡 句库去重以发送时序列记录为准 — 同一序列内不会重复选用相同编号的句子</div>`;
  } else {
    report.innerHTML = `<div style="color:var(--danger);padding:8px;background:#ffebee;border-radius:4px">${lucide('alert-circle',14)} ${issues.length} 个问题：<br>${issues.map(s => '· ' + s).join('<br>')}</div>
      <div style="margin-top:4px;font-size:10px;color:var(--text-secondary)">💡 句库去重以发送时序列记录为准 — 同一序列内不会重复选用相同编号的句子</div>`;
  }
  return issues;
}

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
  // 初始化每阶段独立句库（始终从基础库全新深拷贝，然后应用保存的覆盖层）
  templateLib._stages = {};
  for (const type of Object.keys(TYPES)) {
    templateLib._stages[type] = {};
    for (const stage of STAGES) {
      // 合并标准 + 阿根廷 Hook（编辑器内一同展示，🇦🇷 标记由 id 区分）
      const mergedHooks = [
        ...JSON.parse(JSON.stringify(templateLib.hooks || [])),
        ...JSON.parse(JSON.stringify(templateLib.hooksAR || [])),
      ];
      // 合并标准 + 阿根廷 CTA
      const mergedCtas = [
        ...JSON.parse(JSON.stringify(templateLib.ctas || [])),
        ...JSON.parse(JSON.stringify(templateLib.ctasAR || [])),
      ];
      templateLib._stages[type][stage] = {
        hooks: mergedHooks,
        pains: JSON.parse(JSON.stringify((templateLib.painPoints?.[PAIN_KEY[type]] || []))),
        proofs: JSON.parse(JSON.stringify((templateLib.proofs?.[PROOF_KEY[type]] || []))),
        ctas: mergedCtas,
        followups: JSON.parse(JSON.stringify((templateLib.followUps?.[stage] || []))),
      };
    }
  }
  // 应用保存的 _stages 覆盖层（用户对各阶段句子的修改）
  try {
    const overrides = await window.electronAPI.getTemplateOverrides();
    if (overrides?._stages) {
      templateLib._stages = await window.electronAPI.applyStageOverrides(
        templateLib._stages, overrides._stages
      );
    }
  } catch(e) { console.warn('应用模板覆盖层失败:', e); }
  buildTree();
}

// ── 持久化：将 _stages + subjects + AR 变体写入 data/template-overrides.json ──
async function persistOverrides() {
  if (!templateLib) return;
  await window.electronAPI.saveTemplateOverrides({
    _stages: templateLib._stages,
    subjects: templateLib.subjects,
    hooksAR: templateLib.hooksAR || [],
    ctasAR: templateLib.ctasAR || [],
  });
}

function buildTree() {
  const tree = document.getElementById('tmpl-tree');
  if (!tree) return;

  let html = '<ul class="tmpl-tree-list">';

  // 主题行（独立项）
  html += `<li class="tn-leaf"><div class="tn-label" data-node="subjects">${lucide('tag',14)} 主题行</div></li>`;

  // 三个客户类型下拉分组
  for (const [type, label] of Object.entries(TYPES)) {
    html += `<li class="tn-folder open">`;
    html += `<div class="tn-label tn-folder-title"><span class="tn-arrow">${lucide('chevron-right',14)}</span>${typeIcons[type]} ${label}</div>`;
    html += `<ul class="tn-sublist">`;
    for (const stage of STAGES) {
      html += `<li class="tn-leaf"><div class="tn-label" data-node="${type}|${stage}">${STAGE_LABELS[stage]}</div></li>`;
    }
    html += `</ul></li>`;
  }

  // 🇦🇷 阿根廷变体句库（独立分组）
  html += `<li class="tn-folder">`;
  html += `<div class="tn-label tn-folder-title"><span class="tn-arrow">${lucide('chevron-right',14)}</span>🇦🇷 阿根廷变体</div>`;
  html += `<ul class="tn-sublist">`;
  html += `<li class="tn-leaf"><div class="tn-label" data-node="hooksAR">${lucide('message-circle',14)} Hook (vos)</div></li>`;
  html += `<li class="tn-leaf"><div class="tn-label" data-node="ctasAR">${lucide('send',14)} CTA (vos)</div></li>`;
  html += `</ul></li>`;

  // 垃圾词黑名单（独立项）
  html += `<li class="tn-leaf"><div class="tn-label" data-node="spam">${lucide('alert-circle',14)} 垃圾词黑名单</div></li>`;

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
      else if (node === 'hooksAR') showAREditor('hooks');
      else if (node === 'ctasAR') showAREditor('ctas');
      else showStageEditor(node);
    });
  });
}

function showSubjectEditor() {
  const panel = document.getElementById('tmpl-edit');
  const subs = templateLib.subjects;
  panel.innerHTML = `<h3>${lucide('tag',16)} 主题行</h3>` + Object.entries(TYPES).map(([type, label]) => `
    <div class="tmpl-section"><h4>${label}</h4>
      <div class="tmpl-sentence">
        <span class="ts-id">ES</span><div class="ts-body"><span class="ts-lang">西语</span>
        <textarea data-type="${type}" data-lang="es">${escapeHtml(subs[type]?.es||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">PT</span><div class="ts-body"><span class="ts-lang">葡语</span>
        <textarea data-type="${type}" data-lang="pt">${escapeHtml(subs[type]?.pt||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">EN</span><div class="ts-body"><span class="ts-lang">英语</span>
        <textarea data-type="${type}" data-lang="en">${escapeHtml(subs[type]?.en||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
    </div>
  `).join('');
  panel.querySelectorAll('textarea').forEach(ta => ta.addEventListener('input', function() {
    autoSaveTemplate(async () => {
      document.querySelectorAll('#tmpl-edit textarea').forEach(t => {
        const t2 = t.dataset.type, l2 = t.dataset.lang;
        if (templateLib.subjects[t2]) templateLib.subjects[t2][l2] = t.value;
      });
      await persistOverrides();
    }, this);
  }));
}

function showStageEditor(node) {
  const [type, stage] = node.split('|');
  const stageData = templateLib._stages?.[type]?.[stage];
  if (!stageData) return;
  const panel = document.getElementById('tmpl-edit');

  const groups = [['hooks','Hook 破冰句'],['pains','Pain Point 痛点句'],['proofs','Proof 证明句（完整段落）'],['ctas','CTA 行动呼吁'],['followups','衔接句']];

  // 读垃圾词黑名单
  const spamWords = templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>${typeIcons[type]} ${TYPES[type]} · ${STAGE_LABELS[stage]}</h3>` +
    groups.map(([key, title]) => {
      const items = stageData[key] || [];
      if (!items.length) return '';
      return `<div class="tmpl-section"><h4>${title}</h4>` + items.map((item, i) => `
        <div class="tmpl-sentence" data-key="${key}" data-index="${i}">
          <span class="ts-id">${escapeHtml(item.label || item.id)}${item.id.includes('-A') ? ' 🇦🇷' : ''}</span>
          <div class="ts-body">
            <div class="ts-row">
              <span class="ts-lang">ES</span>
              <span class="ts-check" data-lang="es"></span>
              <textarea class="ts-es">${escapeHtml(item.es||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">PT</span>
              <span class="ts-check" data-lang="pt"></span>
              <textarea class="ts-pt">${escapeHtml(item.pt||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">EN</span>
              <span class="ts-check" data-lang="en"></span>
              <textarea class="ts-en">${escapeHtml(item.en||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
          </div>
        </div>
      `).join('') + '</div>';
    }).join('') +
    `<div id="quality-report" style="margin-top:12px;font-size:12px"></div>`;

  // 共用质量检查 + 自动保存
  const allAreas = panel.querySelectorAll('textarea');
  allAreas.forEach(ta => ta.addEventListener('input', function() {
    runQualityCheck(panel, spamWords);
    autoSaveTemplate(async () => {
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
      await persistOverrides();
    }, this);
  }));
  runQualityCheck(panel, spamWords);
}

function showSpamEditor() {
  const panel = document.getElementById('tmpl-edit');
  const words = templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>${lucide('alert-circle',16)} 垃圾词黑名单</h3>
    <p style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">质量检查实时校验以下词汇，命中任一即标记 🚫</p>
    <div class="tmpl-section"><h4><span style="color:var(--danger)">${lucide('x-circle',14)}</span> 西语禁止词（${words.es.length} 个）</h4>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${words.es.map(w => `<code style="font-size:11px;padding:2px 6px;border-radius:3px;background:#ffebee;color:var(--danger)">${escapeHtml(w)}</code>`).join('')}</div>
    </div>
    <div class="tmpl-section"><h4><span style="color:var(--danger)">${lucide('x-circle',14)}</span> 英语禁止词（${words.en.length} 个）</h4>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${words.en.map(w => `<code style="font-size:11px;padding:2px 6px;border-radius:3px;background:#ffebee;color:var(--danger)">${escapeHtml(w)}</code>`).join('')}</div>
    </div>
    <div class="tmpl-section"><h4><span style="color:var(--text-secondary)">${lucide('help-circle',14)}</span> 上下文规则</h4>
      <div class="spam-rule context"><span class="sr-word">船东名 + 具体运价数字</span><span class="sr-reason">同一封邮件不能同时出现</span></div>
      <div class="spam-rule context"><span class="sr-word">本地仓库 / 本地团队</span><span class="sr-reason">代理模板禁止提及</span></div>
      <div class="spam-rule context"><span class="sr-word">digital / AI / 平台 / technology</span><span class="sr-reason">对海外客户禁用技术词汇</span></div>
    </div>
    <p style="font-size:11px;color:var(--text-secondary);margin-top:12px">修改词库请编辑 templates/general-templates.md 中的「广告词 & 垃圾词黑名单」章节</p>`;
}

// ── 🇦🇷 阿根廷变体编辑器（Hook vos / CTA vos）────────────────────────
function showAREditor(kind) {
  const panel = document.getElementById('tmpl-edit');
  const key = kind === 'hooks' ? 'hooksAR' : 'ctasAR';
  const items = templateLib[key] || [];
  const title = kind === 'hooks' ? '🇦🇷 Hook 阿根廷变体 (vos)' : '🇦🇷 CTA 阿根廷变体 (vos)';
  const desc = kind === 'hooks'
    ? '对阿根廷客户用 vos 替代 tú，更自然更亲切。本句库与标准 Hook 合并用于阿根廷阶段编辑。'
    : '对阿根廷客户使用 vos 变体 + 当地用词。本句库与标准 CTA 合并用于阿根廷阶段编辑。';

  if (!items.length) {
    panel.innerHTML = `<h3>${title}</h3><p style="color:var(--text-secondary);padding:12px">暂无异体句库</p>`;
    return;
  }

  // 读取垃圾词黑名单（复用质量检查）
  const spamWords = templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>${lucide('globe',16)} ${title}</h3>
    <p style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">${desc}</p>` +
    items.map((item, i) => `
      <div class="tmpl-sentence" data-key="${key}" data-index="${i}">
        <span class="ts-id">${escapeHtml(item.label || item.id)}${item.type ? ' ('+item.type+')' : ''}</span>
        <div class="ts-body">
          <div class="ts-row">
            <span class="ts-lang">ES</span>
            <span class="ts-check" data-lang="es"></span>
            <textarea class="ts-es">${escapeHtml(item.es||'')}</textarea>
            <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
          </div>
          ${item.pt ? `<div class="ts-row">
            <span class="ts-lang">PT</span>
            <span class="ts-check" data-lang="pt"></span>
            <textarea class="ts-pt">${escapeHtml(item.pt||'')}</textarea>
            <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
          </div>` : ''}
          <div class="ts-row">
            <span class="ts-lang">EN</span>
            <span class="ts-check" data-lang="en"></span>
            <textarea class="ts-en">${escapeHtml(item.en||'')}</textarea>
            <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
          </div>
        </div>
      </div>
    `).join('') +
    `<div id="quality-report" style="margin-top:12px;font-size:12px"></div>`;

  // 共用质量检查 + 自动保存
  const allAreas = panel.querySelectorAll('textarea');
  allAreas.forEach(ta => ta.addEventListener('input', function() {
    runQualityCheck(panel, spamWords);
    autoSaveTemplate(async () => {
      panel.querySelectorAll('.tmpl-sentence').forEach(el => {
        const idx = parseInt(el.dataset.index);
        const es = el.querySelector('.ts-es')?.value || '';
        const pt = el.querySelector('.ts-pt')?.value || '';
        const en = el.querySelector('.ts-en')?.value || '';
        if (items[idx]) { items[idx].es = es; items[idx].pt = pt; items[idx].en = en; }
      });
      // 同步更新所有 _stages 中对应的 AR 条目
      for (const type of Object.keys(TYPES)) {
        for (const stage of STAGES) {
          const hArr = templateLib._stages?.[type]?.[stage]?.hooks;
          const cArr = templateLib._stages?.[type]?.[stage]?.ctas;
          const tArr = kind === 'hooks' ? hArr : cArr;
          if (!tArr) continue;
          for (const si of items) {
            const d = tArr.find(h => h.id === si.id);
            if (d) { d.es = si.es; d.pt = si.pt; d.en = si.en; }
          }
        }
      }
      await persistOverrides();
    }, this);
  }));
  runQualityCheck(panel, spamWords);
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

function assembleEmail(lang, hook, pain, proof, cta, followup, stage, type, isArgentina) {
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
      _stage: 'monthly', _type: ctype, _lang: lang,
      _recipientStatus: emails.map(e => ({ email: e, status: 'pending' })),
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
function saveQueue() {
  const json = JSON.stringify(queue);
  localStorage.setItem('emailQueue', json);
  // 异步写文件，不阻塞 UI
  window.electronAPI.saveQueue(queue).catch(() => {});
}

// 应用重启后，「发送中」的残留项恢复为「待发送」
async function initQueue() {
  await loadQueue();
  let changed = false;
  queue.forEach(e => {
    // 队列级别
    if (e.status === 'sending') { e.status = 'pending'; changed = true; }
    // 逐人级别：把卡在 sending 的收件人回退为 pending
    if (e._recipientStatus) {
      e._recipientStatus.forEach(r => {
        if (r.status === 'sending') { r.status = 'pending'; changed = true; }
      });
      // 重新计算综合状态
      if (e._recipientStatus.every(r => r.status === 'sent')) {
        if (e.status !== 'sent') { e.status = 'sent'; changed = true; }
      } else if (e._recipientStatus.every(r => r.status === 'failed')) {
        if (e.status !== 'failed') { e.status = 'failed'; changed = true; }
      } else if (e._recipientStatus.some(r => r.status !== 'pending')) {
        e.status = 'pending'; changed = true; // 部分完成 → 回退重发
      }
    }
  });
  if (changed) saveQueue();
  // 恢复上次计时器
  try {
    const state = await window.electronAPI.loadSendState();
    const sec = state.data?.totalSeconds;
    if (sec > 0 && state.data?.status !== 'idle' && state.data?.status !== 'done') {
      const t = document.getElementById('queue-timer-title');
      if (t) {
        t._totalSec = sec;
        const m = Math.floor(sec / 60), s = sec % 60;
        t.textContent = m + ':' + String(s).padStart(2, '0');
        t.style.display = '';
        t.style.color = 'var(--text-secondary)';
      }
    }
  } catch {}
}

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

async function renderQueue() {
  if (!_queueLoaded) await loadQueue();
  syncTestMode();
  // 标题计数：按实际邮件数（联系人），非队列项数
  const countEmails = (e) => e.recipients?.length || (e.to?.split(',')?.length || 1);
  const sentEmails = queue.filter(e => e.status === 'sent' || e.status === 'failed').reduce((s, e) => s + countEmails(e), 0);
  const totalEmails = queue.reduce((s, e) => s + countEmails(e), 0);
  const countEl = document.getElementById('queue-sent-count');
  if (countEl) countEl.textContent = totalEmails ? `(${sentEmails}/${totalEmails})` : '';
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  if (!list) return;
  if (!queue.length) { list.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  // 待发送在上，已完成在底部
  const sorted = [...queue].sort((a, b) => {
    const aDone = a.status === 'sent' || a.status === 'failed';
    const bDone = b.status === 'sent' || b.status === 'failed';
    return aDone === bDone ? 0 : aDone ? 1 : -1;
  });

  const statusIcon = (s) => s === 'sent' ? '✅' : s === 'failed' ? '❌' : s === 'sending' ? '<span class="rc-spin">🔄</span>' : '⏳';
  const statusBadge = (s) => {
    const cls = 'status-' + s;
    const label = { pending: '待发送', sent: '已发送', failed: '失败', sending: '发送中' }[s] || s;
    return `<span class="${cls}" style="font-size:11px;display:flex;align-items:center;gap:3px">${statusIcon(s)} ${label}</span>`;
  };
  const typeLabelMap = { agent: '代理模板', direct: '直客模板', unlabeled: '通用模板' };

  const cardHtml = (e) => {
    const count = e.recipients?.length || (e.to?.split(',')?.length || 1);
    const stageHtml = e._stage
      ? `<span class="stage-badge stage-${e._stage}">${STAGE_LABELS_SEND[e._stage] || e._stage}</span>`
      : '';
    const failInfo = e._error ? `<div style="font-size:10px;color:var(--danger);margin-top:2px">⚠️ ${escapeHtml(e._error)}</div>` : '';
    const tt = clientTypeTag(e._type);
    const tplLabel = typeLabelMap[e._type] || '通用模板';
    const ctry = e._country ? `<span>${escapeHtml(e._country)}</span>` : '';
    const langTag = e._lang ? `<span>${escapeHtml(e._lang).toUpperCase()}</span>` : '';
    const tagsArr = [tt, ctry, langTag, `<span>${count}人</span>`, `<span>📝 ${tplLabel}</span>`].filter(Boolean);
    const tagsHtml = tagsArr.length ? `<div class="qc-tags">${tagsArr.join(' · ')}</div>` : '';
    const retryBtn = e.status === 'failed'
      ? `<button class="qc-retry" data-id="${e.id}">🔄 重发</button>`
      : '';
    const gLabel = e._groupTotal > 1 ? `<span style="font-size:10px;color:var(--text-secondary);margin-left:4px">(${e._groupSeq + 1}/${e._groupTotal})</span>` : '';
    const rs = e._recipientStatus || e.recipients?.map(r => ({ email: r, status: 'pending' })) || [];
    const detailRows = rs.map(r => {
      const err = r._error ? ` <span style="font-size:10px;color:var(--danger)">${escapeHtml(r._error)}</span>` : '';
      return `<div class="qc-recipient ${r.status}"><span>${statusIcon(r.status)}</span><span style="font-family:monospace;flex:1">${escapeHtml(r.email)}</span>${err}</div>`;
    }).join('');
    const cardCls = 'queue-card' + (e.status === 'sending' && sendInProgress ? ' sending' : '');

    const chkId = 'qchk-' + e.id;
    return `<div class="${cardCls}" data-id="${e.id}" data-company="${escapeHtml(e.company || '').replace(/"/g, '&quot;')}">
      <input type="checkbox" class="qc-check" id="${chkId}" data-id="${e.id}" style="position:absolute;top:8px;left:8px;cursor:pointer" onchange="document.getElementById('queue-delete-selected').style.display=document.querySelectorAll('.qc-check:checked').length?'':'none'">
      <div class="qc-header" style="margin-left:24px">
        <span class="qc-company" title="${escapeHtml(e.company)}">${escapeHtml(e.company)}${gLabel}</span>
        ${stageHtml}
        ${statusBadge(e.status)}
      </div>
      <div class="qc-body">
        <div class="qc-to">To: ${escapeHtml(e.recipients?.[0] || e.to?.split(',')[0] || '')}${count > 1 ? ` <span style="font-size:10px">+\u2060${count - 1} 位</span>` : ''}</div>
        <div class="qc-subject" title="${escapeHtml(e.subject)}">${escapeHtml(e.subject)}</div>
      </div>
      <div class="qc-footer">
        ${tagsHtml}
        <span class="qc-expand">▸ 展开</span>
        ${retryBtn}
      </div>
      ${failInfo}
      <div class="qc-detail">${detailRows}</div>
    </div>`;
  };

  // 按公司分组
  const groups = {};
  sorted.forEach(e => {
    const key = e.company || e._groupOf || '未知';
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  // 找出当前正在发送的公司
  const activeCompany = sorted.find(e => e.status === 'sending')?.company || '';
  let activeGroupId = '';

  let html = '';
  // 正在发送的提示条
  if (activeCompany && sendInProgress) {
    html += `<div class="queue-current-bar" id="queue-current-bar">
      <span class="cur-dot"></span> 正在发送：${escapeHtml(activeCompany)}
    </div>`;
  }

  for (const [company, items] of Object.entries(groups)) {
    const totalPeople = items.reduce((sum, e) => sum + (e.recipients?.length || 0), 0);
    const gid = 'qg-' + company.replace(/[^a-zA-Z0-9]/g, '');
    const hasSending = items.some(e => e.status === 'sending');
    const isActive = hasSending && sendInProgress;
    if (isActive) activeGroupId = gid;
    const headCls = 'queue-group-head' + (isActive ? ' active' : '');
    // 仅发送中且未暂停时自动展开 + 显示状态
    const cardDisplay = (hasSending && sendInProgress) ? 'block' : 'none';
    const arrowRotate = (hasSending && sendInProgress) ? 'rotate(90deg)' : '';
    const statusText = (hasSending && sendInProgress)
      ? ` · <span style="color:var(--primary)">${items.filter(e => e.status === 'sending').length}/${items.length} 发送中</span>`
      : '';
    const groupStage = items[0]?._stage || 'cold';
    const stageLabel = STAGE_LABELS_SEND[groupStage] || groupStage;
    html += `<div class="${headCls}" data-group="${gid}" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f5f6f8;border-radius:6px;margin-bottom:2px;font-size:12px;font-weight:600">
      <span class="qg-arrow" style="display:inline-block;width:14px;font-size:10px;transition:transform .2s;transform:${arrowRotate}">▸</span>
      ${escapeHtml(company)}
      <span class="stage-badge stage-${groupStage}" style="font-size:10px">${stageLabel}</span>
      <span style="color:var(--text-secondary);font-weight:400;font-size:11px">${items.length} 组 · ${totalPeople} 人${statusText}</span>
    </div>`;
    html += `<div class="queue-group-cards" data-group="${gid}" style="display:${cardDisplay};margin-bottom:6px;padding-left:4px">`;
    html += items.map(cardHtml).join('');
    html += '</div>';
  }
  list.innerHTML = html;

  // 自动滚动到正在发送的组

  // 分组折叠/展开
  list.querySelectorAll('.queue-group-head').forEach(head => {
    head.addEventListener('click', () => {
      const gid = head.dataset.group;
      const cards = list.querySelector(`.queue-group-cards[data-group="${gid}"]`);
      const arrow = head.querySelector('.qg-arrow');
      if (!cards) return;
      const hidden = cards.style.display === 'none';
      cards.style.display = hidden ? 'block' : 'none';
      if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
    });
  });

  // 卡片点击 → 展开收件人详情
  list.querySelectorAll('.queue-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const detail = card.querySelector('.qc-detail');
      const btn = card.querySelector('.qc-expand');
      if (!detail) return;
      const isOpen = detail.classList.toggle('open');
      if (btn) btn.textContent = isOpen ? '▾ 收起' : '▸ 展开';
    });
  });

  // 重发按钮
  list.querySelectorAll('.qc-retry').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = queue.find(e => e.id == btn.dataset.id);
      if (item) {
        item.status = 'pending';
        delete item._error;
        if (item._recipientStatus) item._recipientStatus.forEach(r => { r.status = 'pending'; delete r._error; });
        saveQueue();
        renderQueue();
      }
    });
  });

  document.getElementById('queue-start').disabled = sendInProgress;
  document.getElementById('queue-pause').disabled = !sendInProgress;

  // 全部折叠/展开（状态保存在 DOM 上，刷新不丢失）
  const foldBtn = document.getElementById('queue-fold-all');
  if (foldBtn) {
    const wasFolded = foldBtn.dataset.folded === 'true';
    if (wasFolded) {
      list.querySelectorAll('.queue-group-head').forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = ''; });
      list.querySelectorAll('.queue-group-cards').forEach(c => c.style.display = 'none');
      foldBtn.textContent = '▸ 全部展开';
    } else {
      list.querySelectorAll('.queue-group-head').forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = 'rotate(90deg)'; });
      list.querySelectorAll('.queue-group-cards').forEach(c => c.style.display = 'block');
      foldBtn.textContent = '▸ 全部折叠';
    }
    foldBtn.onclick = () => {
      const heads = list.querySelectorAll('.queue-group-head');
      const cards = list.querySelectorAll('.queue-group-cards');
      if (foldBtn.dataset.folded !== 'true') {
        heads.forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = ''; });
        cards.forEach(c => c.style.display = 'none');
        foldBtn.textContent = '▸ 全部展开';
        foldBtn.dataset.folded = 'true';
      } else {
        heads.forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = 'rotate(90deg)'; });
        cards.forEach(c => c.style.display = 'block');
        foldBtn.textContent = '▸ 全部折叠';
        foldBtn.dataset.folded = 'false';
      }
    };
  }
}


function statusLabel(s) {
  const map = {
    pending: `${lucide('clock',14)} 待发送`,
    sent: `${lucide('check-circle',14)} 已发送`,
    failed: `${lucide('x-circle',14)} 失败`,
    sending: `${lucide('refresh-cw',14,'spin')} 发送中`,
  };
  return map[s] || s;
}

async function startSend() {
  if (sendInProgress) return;
  sendInProgress = true;
  const pending = queue.filter(e => e.status === 'pending');
  if (!pending.length) { sendInProgress = false; return; }

  // 发送前补全缺失的收件人信息（仅对无 recipients 的旧数据）
  const freshContacts = await window.electronAPI.getContacts();
  const freshCompanies = {};
  for (const c of freshContacts) {
    const name = c.company || '未命名';
    if (!freshCompanies[name]) freshCompanies[name] = [];
    freshCompanies[name].push(c);
  }
  let recipientsFixed = 0;
  for (const item of pending) {
    if (item.recipients && item.recipients.length) continue; // 已有分组数据，不动
    const members = freshCompanies[item.company] || [];
    const allEmails = [...new Set(
      members.map(m => (m.email || '').trim()).filter(e => e && EMAIL_RE.test(e))
    )];
    if (allEmails.length) {
      item.recipients = allEmails;
      item.to = allEmails.join(', ');
      recipientsFixed++;
    }
  }
  if (recipientsFixed > 0) {
    console.log(`🔄 已补全 ${recipientsFixed} 条旧队列的收件人列表`);
  }

  // 仅第一个队列项标记为发送中（聚焦当前任务）
  const firstPending = pending[0];
  if (firstPending) {
    firstPending.status = 'sending';
    if (firstPending._recipientStatus) firstPending._recipientStatus.forEach(r => { if (r.status === 'pending') r.status = 'sending'; });
  }
  const progBar = document.getElementById('queue-progress');
  progBar.style.width = '0%';
  progBar.classList.add('active');
  renderQueue();
  document.getElementById('queue-start').disabled = true;
  document.getElementById('queue-pause').disabled = false;
  document.getElementById('queue-cancel').disabled = false;
  if (unsubscribeProgress) unsubscribeProgress();

  unsubscribeProgress = await window.electronAPI.onSendProgress((data) => {
    if (data.type === 'sent') {
      const item = queue.find(e => e.id === data.id);
      if (item) {
        if (!item._recipientStatus) {
          item._recipientStatus = (item.recipients || []).map(e => ({ email: e, status: 'pending' }));
        }
        // BCC 模式：data.to 是逗号分隔的所有收件人，data.count 是总数
        const sentList = (data.to || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of sentList) {
          const rs = item._recipientStatus.find(r => r.email.toLowerCase().trim() === addr.toLowerCase().trim());
          if (rs) rs.status = 'sent';
        }
        if (item._recipientStatus.every(r => r.status === 'sent')) item.status = 'sent';
        else item.status = 'sending';
      }
    } else if (data.type === 'failed') {
      const item = queue.find(e => e.id === data.id);
      if (item) {
        if (!item._recipientStatus) {
          item._recipientStatus = (item.recipients || []).map(e => ({ email: e, status: 'pending' }));
        }
        const failList = (data.to || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of failList) {
          const rs = item._recipientStatus.find(r => r.email.toLowerCase().trim() === addr.toLowerCase().trim());
          if (rs) { rs.status = 'failed'; rs._error = data.error; }
        }
        item._error = data.error;
        if (item._recipientStatus.every(r => r.status !== 'pending')) {
          item.status = item._recipientStatus.every(r => r.status === 'sent') ? 'sent' : 'failed';
        } else {
          item.status = 'sending';
        }
      }
    } else if (data.type === 'estimate') {
      const el = document.getElementById('queue-estimate');
      if (el) {
        const cd = (data.companyDelayMin || 0) > 0 ? `，公司间隔 ${data.companyDelayMin}~${data.companyDelayMax}s` : '';
        el.style.display = 'block';
        el.textContent = `📊 共 ${data.total} 封${cd}，组间 ${data.avgDelay}s，预计 ${data.estMin}分${data.estSec}秒`;
      }
      // 启动十分钟自动退信扫描
      startAutoBounceInterval();

      // 启动计时器
      const tt = document.getElementById('queue-timer-title');
      if (tt) {
        if (!tt._startedAt) { tt._startedAt = Date.now(); tt._accumulated = 0; }
        tt.style.display = '';
        tt.style.color = '';
        clearInterval(tt._interval);
        tt._interval = setInterval(() => {
          if (!sendInProgress) { tt.style.color = 'var(--text-secondary)'; return; }
          const acc = (tt._accumulated || 0) + Math.floor((Date.now() - tt._startedAt) / 1000);
          const m = Math.floor(acc / 60), s = acc % 60;
          tt.textContent = m + ':' + String(s).padStart(2, '0');
        }, 1000);
      }
    } else if (data.type === 'waiting') {
      // 更新时间窗口等待提示
      const prog = document.getElementById('queue-progress');
      if (prog) prog.title = data.message || '等待发送窗口...';
    } else if (data.type === 'delay') {
      const el = document.getElementById('queue-estimate');
      if (el) {
        const totalSec = data.seconds;
        el.style.display = 'block';
        el.style.color = 'var(--warning)';
        clearTimeout(el._delayTimer);
        el._delayRemaining = totalSec;
        const tick = () => {
          if (sendInProgress === false) {
            el.style.color = 'var(--text-secondary)';
            el._delayTimer = setTimeout(tick, 1000);
            return; // 保持显示，不倒数
          }
          if (el._delayRemaining <= 0) { el.style.display = 'none'; el.style.color = ''; return; }
          const m = Math.floor(el._delayRemaining / 60);
          const s = el._delayRemaining % 60;
          const label = data.company ? ` → ${escapeHtml(data.company)}` : '';
          el.textContent = `⏸️ 批量暂停${label}... ${m} 分 ${s} 秒后继续`;
          el._delayRemaining--;
          el._delayTimer = setTimeout(tick, 1000);
        };
        tick();
      }
    } else if (data.type === 'ratelimit') {
      freezeAndSaveTimer('var(--danger)');
      const el = document.getElementById('queue-estimate');
      if (el) { el.style.display = 'block'; el.textContent = `⚠️ 发送被限流！${data.error || ''} 发送已自动暂停，请等待后手动恢复。`; el.style.color = 'var(--danger)'; }
      sendInProgress = false;
      // 将所有 sending 状态回退为 pending，避免卡住
      queue.forEach(e => {
        if (e.status === 'sending') e.status = 'pending';
        if (e._recipientStatus) e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
      });
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
    } else if (data.type === 'cancelled') {
      resetQueueTimer();
      clearQueueDelayUI();
      sendInProgress = false;
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
      const pb2 = document.getElementById('queue-progress');
      if (pb2) pb2.classList.remove('active');
    } else if (data.type === 'complete') {
      freezeAndSaveTimer('var(--text-secondary)');
      // 已达上限时保留提示，不清除
      const limitEl = document.getElementById('queue-estimate');
      const isAtLimit = limitEl && limitEl.textContent.includes('已达每日上限');
      if (!isAtLimit) clearQueueDelayUI();
      // complete / cancel 时推进阶段
      sendInProgress = false;
      const progBar = document.getElementById('queue-progress');
      if (progBar) progBar.classList.remove('active');
      // 隐藏当前发送指示条
      const curBar = document.getElementById('queue-current-bar');
      if (curBar) curBar.style.display = 'none';
      if (!isAtLimit) document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
      // 测试模式不推进阶段。仅当公司所有联系人都已发送时才推进，防止分批发送导致过早归档
      if (!data._testMode) {
        const companyHasPending = {};
        queue.forEach(e => { if (e.company && e.status === 'pending') companyHasPending[e.company] = true; });
        const sentCompanies = queue.filter(e => e.status === 'sent' && e._stage && !companyHasPending[e.company]).map(e => e.company);
        if (sentCompanies.length) {
          window.electronAPI.advanceStage([...new Set(sentCompanies)]);
        }
      }
    } else if (data.type === 'limit') {
      // 达到每日上限
      const el2 = document.getElementById('queue-estimate');
      if (el2) { el2.style.display = 'block'; el2.style.color = 'var(--danger)'; el2.textContent = `⛔ ${data.message || '已达每日上限'}，今日无法继续发送`; }
      sendInProgress = false;
      document.getElementById('queue-start').disabled = true;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
      sendInProgress = false;
      freezeAndSaveTimer('var(--text-secondary)');
    } else if (data.type === 'paused') {
      freezeAndSaveTimer('var(--warning)');
      // 延迟倒计时保持显示不消失
      const delayEl = document.getElementById('queue-estimate');
      if (delayEl) { delayEl.style.color = 'var(--text-secondary)'; }
      // 暂停：只更新 UI，不推进阶段
      sendInProgress = false;
      const progBar = document.getElementById('queue-progress');
      if (progBar) progBar.classList.remove('active');
      const curBar = document.getElementById('queue-current-bar');
      if (curBar) curBar.style.display = 'none';
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = true;
    }
    // 每完成一个队列项，推进下一个 pending → sending（仅聚焦当前任务）
    if (sendInProgress && (data.type === 'sent' || data.type === 'failed')) {
      const nextP = queue.find(e => e.status === 'pending');
      if (nextP) {
        nextP.status = 'sending';
        if (nextP._recipientStatus) nextP._recipientStatus.forEach(r => { if (r.status === 'pending') r.status = 'sending'; });
      }
    }
    const sent = queue.filter(e => e.status === 'sent' || e.status === 'failed').length;
    const progBar = document.getElementById('queue-progress');
    progBar.style.width = queue.length > 0 ? Math.round((sent / queue.length) * 100) + '%' : '0%';
    if (sendInProgress) progBar.classList.add('active'); else progBar.classList.remove('active');
    renderQueue();
    saveQueue();
  });
  const result = await window.electronAPI.startSend(pending).catch(e => {
    console.error('发送启动失败:', e);
    return { error: e.message };
  });
  // 兜底：发送返回0封时，把卡在 sending 的项回退
  if (!result?.error) {
    setTimeout(() => {
      const stuck = queue.filter(e => e.status === 'sending');
      if (stuck.length && !sendInProgress) {
        console.log('🔄 修复卡住的发送项:', stuck.length);
        stuck.forEach(e => {
          e.status = 'pending';
          if (e._recipientStatus) e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
        });
        saveQueue();
        renderQueue();
      }
    }, 1000);
  }
  // 错误时回退
  if (result?.error) {
    sendInProgress = false;
    pending.forEach(e => {
      if (e.status === 'sending') e.status = 'pending';
      if (e._recipientStatus) e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
    });
    document.getElementById('queue-start').disabled = false;
    document.getElementById('queue-pause').disabled = true;
    document.getElementById('queue-cancel').disabled = true;
    saveQueue();
    renderQueue();
  }
}

document.getElementById('queue-start')?.addEventListener('click', () => { startSend().catch(e => console.error(e)); });
document.getElementById('queue-pause')?.addEventListener('click', async () => {
  await window.electronAPI.pauseSend();
  sendInProgress = false;
  // 将当前 sending 项恢复为 pending
  queue.forEach(e => {
    if (e.status === 'sending') e.status = 'pending';
    if (e._recipientStatus) e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
  });
  saveQueue();
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = true;
  const pb = document.getElementById('queue-progress'); pb.classList.remove('active');
  renderQueue();
});

document.getElementById('queue-cancel')?.addEventListener('click', async () => {
  if (!confirm('确定取消发送？正在发送的邮件将被中断，未发送的恢复为待发送。')) return;
  await window.electronAPI.cancelSend();
  sendInProgress = false;
  // 将 sending 状态的恢复为 pending（含逐人状态）
  queue.forEach(e => {
    if (e.status === 'sending') e.status = 'pending';
    if (e._recipientStatus) e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
  });
  saveQueue();
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = true;
  const pb = document.getElementById('queue-progress'); pb.style.width = '0%'; pb.classList.remove('active');
  renderQueue();
});

function resetQueueTimer() {
  const t = document.getElementById('queue-timer-title');
  if (t) { clearInterval(t._interval); t.textContent = ''; t.style.display = 'none'; t.style.color = ''; delete t._startedAt; delete t._accumulated; }
}
function freezeAndSaveTimer(color) {
  const t = document.getElementById('queue-timer-title');
  if (t) {
    clearInterval(t._interval);
    if (t._startedAt) { t._accumulated = (t._accumulated || 0) + Math.floor((Date.now() - t._startedAt) / 1000); delete t._startedAt; }
    t.style.color = color || 'var(--text-secondary)';
  }
}

// ── 十分钟循环退信扫描（仅队列发送中生效）─────────────────────────────────
function startAutoBounceInterval() {
  clearInterval(autoBounceTimer);
  nextBounceScanAt = Date.now() + 10 * 60 * 1000;
  autoBounceTimer = setInterval(async () => {
    if (!sendInProgress) return; // 没在发送就不扫
    try {
      const result = await window.electronAPI.checkBounces();
      if (result.ok && result.bounced?.length) {
        const contacts = await window.electronAPI.getContacts();
        const contactMap = {};
        contacts.forEach(c => { const e = (c.email || '').toLowerCase().trim(); if (e) contactMap[e] = c; });
        const records = result.bounced.map(b => {
          const email = b.bouncedEmail || '';
          const matched = contactMap[email];
          return { ...b, email, matched: !!matched, company: matched ? matched.company : '', contactId: matched ? matched.id : '' };
        });
        const matched = records.filter(r => r.matched);
        if (matched.length) {
          await window.electronAPI.saveBounceLog(records);
          for (const r of matched) {
            window.electronAPI.updateBounce(r.email, { type: r.type || 'unknown', reason: r.reason || '未知原因' }).catch(()=>{});
          }
          showToast(`📨 自动扫描: ${result.bounced.length} 封退信，${matched.length} 人匹配`, 'warn');
        }
      }
    } catch {}
    nextBounceScanAt = Date.now() + 10 * 60 * 1000;
  }, 10 * 60 * 1000);
}

function clearQueueDelayUI() {
  const el = document.getElementById('queue-estimate');
  if (el) { clearTimeout(el._delayTimer); el.style.display = 'none'; el.style.color = ''; }
}

// ── 队列操作函数（供菜单调用）─────────────────────────────────────────
async function doQueueRefresh() {
  try {
  if (sendInProgress) return alert('发送进行中，请先暂停');
  if (!templateLib) return alert('模板库未加载，请先打开邮件工坊任意页面');
  const pending = queue.filter(e => e.status === 'pending');
  if (!pending.length) return alert('没有待发送的队列项');
  if (!confirm(`确定刷新 ${pending.length} 个待发送队列项？\n将按当前配置重新分组并随机换模板。已完成的不受影响。`)) return;
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  const groupSize = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);
  const companyEmails = {};
  for (const item of pending) {
    const name = item.company;
    if (!companyEmails[name]) companyEmails[name] = { emails: [], meta: item };
    const emails = item.recipients || item.to?.split(',').map(s => s.trim()).filter(Boolean) || [];
    emails.forEach(e => { if (e) companyEmails[name].emails.push(e); });
  }
  if (!sendHistory || !Object.keys(sendHistory).length) {
    try { sendHistory = await window.electronAPI.getSendHistory() || {}; } catch { sendHistory = {}; }
  }
  if (!sendCompanies || !Object.keys(sendCompanies).length) {
    try { const contacts = await window.electronAPI.getContacts();
      sendCompanies = {}; contacts.forEach(c => { const n = c.company; if (!sendCompanies[n]) sendCompanies[n] = []; sendCompanies[n].push(c); });
    } catch { sendCompanies = {}; }
  }
  const newPending = [];
  for (const [name, { emails, meta }] of Object.entries(companyEmails)) {
    const unique = [...new Set(emails)];
    const groups = Math.ceil(unique.length / groupSize);
    const stage = sendHistory[name]?.stage || 'cold';
    const isArgentina = ((sendCompanies[name] || [])[0]?.country || '').toLowerCase().includes('argentina');
    const t = meta._type || 'unlabeled';
    const lang = meta._lang || 'es';
    const subjects = templateLib.subjects?.[t] || { es: '' };
    const baseSubject = subjects[lang] ?? subjects.es ?? '';
    for (let g = 0; g < groups; g++) {
      const groupEmails = unique.slice(g * groupSize, (g + 1) * groupSize);
      const tpl = randomPick(t, stage, [], isArgentina);
      const body = assembleEmail(lang, tpl.hook, tpl.pain, tpl.proof, tpl.cta, tpl.followup, stage, t, isArgentina);
      newPending.push({
        id: ++queueIdCounter, company: name, to: groupEmails.join(', '), recipients: groupEmails,
        subject: baseSubject, body, status: 'pending', addedAt: new Date().toISOString(),
        _stage: stage, _type: t, _lang: lang, _country: meta._country || '',
        _tplInfo: [tpl.hook?.id, tpl.pain?.id, tpl.proof?.id, tpl.cta?.id, tpl.followup?.id].filter(Boolean).join('·'),
        _batchLabel: groups > 1 ? ` (${g + 1}/${groups})` : '',
        _groupOf: groups > 1 ? name : undefined, _groupSeq: groups > 1 ? g : undefined, _groupTotal: groups > 1 ? groups : undefined,
        _recipientStatus: groupEmails.map(e => ({ email: e, status: 'pending' })),
      });
    }
  }
  queue = [...queue.filter(e => e.status !== 'pending'), ...newPending];
  saveQueue();
  renderQueue();
  resetQueueTimer();
  showToast(`已刷新分组：${pending.length} → ${newPending.length} 个队列项（${groupSize} 人/组）`, 'ok');
  } catch(e) { console.error('刷新分组失败:', e); alert('刷新失败: ' + (e.message || '未知错误')); }
}
function doQueueClearDone() {
  queue = queue.filter(e => e.status === 'pending' || e.status === 'sending' ||
    (e._recipientStatus && e._recipientStatus.some(r => r.status === 'pending')));
  saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  const pb = document.getElementById('queue-progress'); pb.style.width = '0%'; pb.classList.remove('active');
  document.getElementById('stat-queue').textContent = queue.reduce((sum, e) =>
    sum + (e._recipientStatus ? e._recipientStatus.filter(r => r.status === 'pending').length : (e.status === 'pending' ? 1 : 0)), 0);
}
function doQueueClearPending() {
  if (sendInProgress) return alert('发送进行中，请先暂停');
  const pending = queue.filter(e => e.status === 'pending');
  if (!pending.length) return alert('没有未发送的邮件');
  if (!confirm(`确定清空 ${pending.length} 个未发送队列项？已完成的不受影响。`)) return;
  queue = queue.filter(e => e.status !== 'pending');
  saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  document.getElementById('stat-queue').textContent = '0';
}
function doQueueClearAll() {
  if (sendInProgress) return alert('发送进行中，请先暂停');
  if (!queue.length) return;
  if (!confirm(`确定清空全部 ${queue.length} 个队列项？此操作不可恢复。`)) return;
  queue = []; saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  document.getElementById('stat-queue').textContent = '0';
}

// 更多菜单
const moreBtn = document.getElementById('queue-more-btn');
const moreMenu = document.getElementById('queue-more-menu');
if (moreBtn && moreMenu) {
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); moreMenu.style.display = moreMenu.style.display === 'none' ? '' : 'none'; });
  document.addEventListener('click', () => { moreMenu.style.display = 'none'; });
  moreMenu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    moreMenu.style.display = 'none';
    if (action === 'refresh') doQueueRefresh();
    else if (action === 'clear-done') doQueueClearDone();
    else if (action === 'clear-pending') doQueueClearPending();
    else if (action === 'clear-all') doQueueClearAll();
  });
}

document.getElementById('queue-delete-selected')?.addEventListener('click', () => {
  const checked = [...document.querySelectorAll('.qc-check:checked')].map(cb => Number(cb.dataset.id));
  if (!checked.length) return;
  if (!confirm(`确定删除 ${checked.length} 个已选队列项？`)) return;
  queue = queue.filter(e => !checked.includes(e.id));
  saveQueue();
  renderQueue();
  document.getElementById('queue-delete-selected').style.display = 'none';
});

document.getElementById('queue-clear')?.addEventListener('click', doQueueClearDone);
document.getElementById('queue-clear-pending')?.addEventListener('click', doQueueClearPending);
document.getElementById('queue-clear-all')?.addEventListener('click', doQueueClearAll);

document.getElementById('queue-bounce-check')?.addEventListener('click', async () => {
  const btn = document.getElementById('queue-bounce-check');
  const resultDiv = document.getElementById('bounce-result');
  btn.disabled = true; btn.innerHTML = `${lucide('refresh-cw',12,'spin')} 检查中...`;
  resultDiv.style.display = 'none';
  try {
    const result = await window.electronAPI.checkBounces();
    resultDiv.style.display = 'block';
    if (result.ok) {
      if (result.bounced.length) {
        resultDiv.style.background = '#fff3e0';
        resultDiv.innerHTML = `<strong>${lucide('download',14)} 发现 ${result.bounced.length} 封退信：</strong><br>` +
          result.bounced.map(b => `· ${escapeHtml(b.subject)} <span style="color:var(--text-secondary)">${escapeHtml(b.date)}</span>`).join('<br>');
      } else {
        resultDiv.style.background = '#e8f5e9';
        resultDiv.innerHTML = `${lucide('check-circle',14)} 未发现退信`;
      }
    } else {
      resultDiv.style.background = '#ffebee';
      resultDiv.innerHTML = `${lucide('x-circle',14)} ${escapeHtml(result.error || '检查失败')}`;
    }
  } catch (e) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#ffebee';
    resultDiv.innerHTML = `${lucide('x-circle',14)} 检查异常: ${escapeHtml(e.message)}`;
  }
  btn.disabled = false; btn.innerHTML = `${lucide('download',14)} 退信检查`;
});


// ===== 工具函数 ======================================================
function findById(arr, id) { return arr?.find(i => i.id === id); }
function truncate(str, len) { return str?.length > len ? str.slice(0, len) + '...' : str; }
function escapeHtml(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;'); }
function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function daysSince(iso) { if (!iso) return ''; const now = new Date(); const then = new Date(iso); const nowUtc = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()); const thenUtc = Date.UTC(then.getUTCFullYear(),then.getUTCMonth(),then.getUTCDate()); const days = Math.floor((nowUtc - thenUtc) / 86400000); return days >= 0 ? `${days}天` : ''; }

// 轻量 Markdown → HTML（处理表格/标题/粗体/列表/分隔线）
function ratingStars(n) {
  const r = Math.min(5, Math.max(0, n));
  return '<span style="color:#f0a500;font-size:11px;letter-spacing:1px">' + '★'.repeat(r) + '☆'.repeat(5 - r) + '</span>';
}

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
  // 6. 无序列表 & 有序列表
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  // 将连续 <li> 包装到 <ul> 或 <ol>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
    if (match.includes('<li>')) return '<ul>' + match + '</ul>'; else return match;
  });
  // 7. 引用块
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // 8. 段落：按双换行切分，每段包 <p>
  const blocks = html.split('\n\n');
  html = blocks.map(b => {
    const trimmed = b.trim();
    if (!trimmed) return '';
    if (/^<(h[1-4]|hr|table|ul|ol|li|div|blockquote)/.test(trimmed)) return trimmed.replace(/\n/g, '');
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
  { id: 'cfg-schedule-group-size', path: 'schedule.group_size' },
  { id: 'cfg-schedule-company-delay-min', path: 'schedule.company_delay_min_seconds' },
  { id: 'cfg-schedule-company-delay-max', path: 'schedule.company_delay_max_seconds' },
  { id: 'cfg-schedule-single-min', path: 'schedule.single_recip_delay_min' },
  { id: 'cfg-schedule-single-max', path: 'schedule.single_recip_delay_max' },
  { id: 'cfg-schedule-template-rotate', path: 'schedule.template_rotate_interval' },
  { id: 'cfg-schedule-batch-size', path: 'schedule.batch_size' },
  { id: 'cfg-schedule-batch-pause-min', path: 'schedule.batch_pause_min' },
  { id: 'cfg-schedule-batch-pause-max', path: 'schedule.batch_pause_max' },

  { id: 'cfg-search-exa-key', path: 'search.exaKey' },
  { id: 'cfg-search-tavily-key', path: 'search.apiKey' },
  { id: 'cfg-search-serper-key', path: 'search.serperKey' },
  { id: 'cfg-agnes-key', path: 'verify.agnesKey' },
  { id: 'cfg-tl-deepseek-key', path: 'translate.deepseek.apiKey' },
  { id: 'cfg-proxy-host', path: 'proxy.host' },
  { id: 'cfg-test-email', path: 'test.email' },
  { id: 'cfg-test-enabled', path: 'test.enabled', isBool: true },
  { id: 'cfg-feishu-url', path: 'feishu.url' },
  { id: 'cfg-imap-host', path: 'imap.host' },
  { id: 'cfg-imap-port', path: 'imap.port' },
  { id: 'cfg-imap-user', path: 'imap.user' },
  { id: 'cfg-imap-pass', path: 'imap.pass' },
  { id: 'cfg-backcheck-filter', path: 'backcheck.filterEnabled', isBool: true },
];

function loadSettingsIntoForm(config) {
  if (!config) return;
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val = key.path.split('.').reduce((o, k) => o?.[k], config);
    if (key.isTime && val != null) {
      const h = String(Math.floor(val)).padStart(2, '0');
      val = h + ':00';
    }
    if (key.isBool) el.checked = !!val;
    else el.value = val ?? '';
  }
  // 飞书 URL 加载时自动提取显示
  const url = config?.feishu?.url || '';
  if (url) {
    document.getElementById('cfg-feishu-base-extracted').value = url.match(/\/base\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    document.getElementById('cfg-feishu-table-extracted').value = url.match(/table[=\/]([a-zA-Z0-9_-]+)/)?.[1] || '';
  }
  // 退信自定义关键词
  const kw = config?.bounce?.keywords || [];
  const kwEl = document.getElementById('cfg-bounce-keywords');
  if (kwEl) kwEl.value = kw.join('\n');
}

function collectSettingsFromForm() {
  const config = {};
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val;
    if (key.isBool) val = el.checked;
    else if (key.isTime) val = parseInt(el.value) || 0; // "19:00" → 19
    else if (el.type === 'number') { const n = Number(el.value); val = isNaN(n) ? 0 : n; }
    else val = el.value;
    getOrSet(config, key.path, val);
  }
  // 模式选择
  const modeEl = document.getElementById('cfg-schedule-mode');
  if (modeEl && modeEl.value) { if (!config.schedule) config.schedule = {}; config.schedule.mode = modeEl.value; }
  // 退信自定义关键词
  const kwEl = document.getElementById('cfg-bounce-keywords');
  if (kwEl) {
    const kw = kwEl.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!config.bounce) config.bounce = {};
    config.bounce.keywords = kw;
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
  // 模式下拉：加载 + 切换
  const modeEl = document.getElementById('cfg-schedule-mode');
  if (modeEl) {
    modeEl.value = config?.schedule?.mode === 'batch' ? 'batch' : 'multi';
    modeEl.addEventListener('change', toggleScheduleMode);
    toggleScheduleMode();
  }
  validateRequired();
  updateScheduleEstimate();
}

function toggleScheduleMode() {
  const mode = document.getElementById('cfg-schedule-mode')?.value || 'multi';
  const multiFields = document.getElementById('cfg-multi-fields');
  const batchFields = document.getElementById('cfg-batch-fields');
  if (multiFields) multiFields.style.display = mode === 'multi' ? '' : 'none';
  if (batchFields) batchFields.style.display = mode === 'batch' ? '' : 'none';
  updateScheduleEstimate();
  // 自动保存模式，防止重启丢失
  saveModeOnly(mode).catch(() => {});
}

async function saveModeOnly(mode) {
  const config = await window.electronAPI.loadConfig() || {};
  if (!config.schedule) config.schedule = {};
  config.schedule.mode = mode;
  await window.electronAPI.saveConfig(config);
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

// 飞书 URL 自动提取
document.getElementById('cfg-feishu-url')?.addEventListener('input', (e) => {
  const url = e.target.value;
  const base = url.match(/\/base\/([a-zA-Z0-9_-]+)/)?.[1] || '';
  const table = url.match(/table[=\/]([a-zA-Z0-9_-]+)/)?.[1] || '';
  document.getElementById('cfg-feishu-base-extracted').value = base;
  document.getElementById('cfg-feishu-table-extracted').value = table;
});

// 自动保存：监听所有设置输入变化
let settingSaveTimer = null;
document.querySelectorAll('#page-settings input, #page-settings select, #page-settings textarea').forEach(el => {
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

// 预计发送时长（设置页灰字，双模式）
function updateScheduleEstimate() {
  const el = document.getElementById('cfg-schedule-estimate');
  if (!el) return;
  // getNumOr: 区分「用户填0」和「留空」— 留空用默认值，0 就是 0
  const getNumOr = (id, fallback) => {
    const input = document.getElementById(id);
    if (!input || input.value.trim() === '') return fallback;
    const v = Number(input.value);
    return isNaN(v) ? fallback : v;
  };
  const max = getNumOr('cfg-schedule-max', 500);
  if (max <= 0) { el.innerHTML = ''; return; }
  const mode = document.getElementById('cfg-schedule-mode')?.value || 'multi';

  let totalSec, detail;
  if (mode === 'batch') {
    const batchSize = getNumOr('cfg-schedule-batch-size', 10);
    const pauseMin = getNumOr('cfg-schedule-batch-pause-min', 150);
    const pauseMax = getNumOr('cfg-schedule-batch-pause-max', 210);
    const avgPause = (pauseMin + pauseMax) / 2;
    const batches = Math.ceil(max / batchSize);
    totalSec = Math.round((batches - 1) * avgPause);
    detail = `${batches} 批 × ${batchSize} 封，批间暂停 ${pauseMin}~${pauseMax}s`;
  } else {
    const avgItemDelay = (getNumOr('cfg-schedule-min-delay', 10) + getNumOr('cfg-schedule-max-delay', 15)) / 2;
    const singleMin = getNumOr('cfg-schedule-single-min', 60);
    const singleMax = getNumOr('cfg-schedule-single-max', 180);
    const avgSingleDelay = (singleMin + singleMax) / 2;
    const companies = Math.ceil(max / 2);
    totalSec = Math.round(max * avgItemDelay + (companies - 1) * avgSingleDelay);
    detail = `${companies} 家公司（按每公司 2 人），切换间 ${singleMin}s~${singleMax}s`;
  }

  if (totalSec <= 0) { el.innerHTML = ''; return; }
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60);
  const timeStr = h > 0 ? `${h} 时 ${m} 分` : `${m} 分`;
  const perHour = totalSec > 0 ? Math.round(max / (totalSec / 3600)) : 0;
  el.innerHTML = `满额 ${max} 封 ≈ <strong>${timeStr}</strong> · 约 <strong>${perHour} 封/时</strong> <span style="color:#999">（${detail}）</span>`;
}
['cfg-schedule-mode','cfg-schedule-max','cfg-schedule-min-delay','cfg-schedule-max-delay','cfg-schedule-company-delay-min','cfg-schedule-company-delay-max','cfg-schedule-group-size','cfg-schedule-single-min','cfg-schedule-single-max','cfg-schedule-batch-size','cfg-schedule-batch-pause-min','cfg-schedule-batch-pause-max'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === 'cfg-schedule-mode' ? 'change' : 'input', updateScheduleEstimate);
});

// IMAP 连接测试
document.getElementById('cfg-imap-test')?.addEventListener('click', async () => {
  const btn = document.getElementById('cfg-imap-test');
  const result = document.getElementById('cfg-imap-result');
  btn.disabled = true; btn.textContent = '连接中...';
  result.textContent = ''; result.style.color = '';
  const cfg = {
    host: document.getElementById('cfg-imap-host')?.value || '',
    port: Number(document.getElementById('cfg-imap-port')?.value) || 993,
    user: document.getElementById('cfg-imap-user')?.value || '',
    pass: document.getElementById('cfg-imap-pass')?.value || '',
  };
  try {
    const r = await window.electronAPI.testImap(cfg);
    result.textContent = r.ok ? '✅ ' + r.message : '❌ ' + (r.error || '连接失败');
    result.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
  } catch (e) {
    result.textContent = '❌ ' + e.message;
    result.style.color = 'var(--danger)';
  }
  btn.disabled = false; btn.textContent = '测试连接';
});

// ===== 退信检测页 ====================================================
let bounceRecords = [];

function renderBounceTable() {
  const groupsEl = document.getElementById('bounce-groups');
  const empty = document.getElementById('bounce-empty');
  const status = document.getElementById('bounce-status');
  if (!bounceRecords.length) {
    if (groupsEl) groupsEl.innerHTML = '';
    if (empty) { empty.style.display = 'block'; empty.textContent = '点击「检查退信」扫描邮箱中的退信邮件'; }
    if (status) status.textContent = '';
    // 隐藏一键删除按钮
    const dABtn = document.getElementById('bounce-del-all-btn');
    if (dABtn) dABtn.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (status) status.textContent = `共 ${bounceRecords.length} 条（${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}）`;

  // 分组（只显示已匹配联系人的退信，unknown 归入临时）
  const groups = { permanent: [], temporary: [] };
  for (const r of bounceRecords) {
    if (!r.matched) continue;
    const key = r.type === 'permanent' ? 'permanent' : 'temporary';
    groups[key].push(r);
  }
  const groupDefs = [
    { key: 'permanent', label: '永久', icon: '◆', color: 'var(--danger)', itemColor: '#f44336' },
    { key: 'temporary', label: '暂时', icon: '◇', color: 'var(--warning)', itemColor: '#ff9800' },
  ];

  let html = '';
  for (const g of groupDefs) {
    const items = groups[g.key] || [];
    if (!items.length) continue;
    html += `<div class="bounce-group" style="margin-bottom:8px">`;
    html += `<div class="bounce-group-head" style="font-size:12px;font-weight:600;color:${g.color};padding:4px 0;border-bottom:1px solid #eee;cursor:pointer;display:flex;align-items:center;gap:4px" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none';this.querySelector('.bounce-arrow').textContent=this.nextElementSibling.style.display==='none'?'▸':'▾'">`;
    html += `<span class="bounce-arrow" style="font-size:10px;width:10px">▾</span>`;
    html += `${g.label} (${items.length})`;
    html += `</div>`;
    html += `<div class="bounce-group-body">`;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const timeStr = r.date ? new Date(r.date).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      html += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px solid #f5f5f5;overflow:hidden">`;
      html += `<span style="color:${g.itemColor};flex-shrink:0">${g.icon}</span>`;
      html += `<span style="font-family:monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1">${escapeHtml(r.email || '未识别')}</span>`;
      html += `<span style="color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1">${escapeHtml(r.company || '')}</span>`;
      html += `<span style="color:var(--text-secondary);font-size:11px;white-space:nowrap;margin-left:auto;flex-shrink:0">${timeStr}</span>`;
      html += `<span style="font-size:10px;color:${g.itemColor};white-space:nowrap;flex-shrink:0">${g.label}</span>`;
      html += `<span class="bounce-del-btn" data-email="${escapeHtml(r.email)}" data-idx="${i}" data-group="${g.key}" style="cursor:pointer;color:var(--danger);font-size:11px;flex-shrink:0;padding:0 4px" title="删除联系人">✕</span>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  if (groupsEl) {
    groupsEl.innerHTML = html;
    // 单条删除
    groupsEl.querySelectorAll('.bounce-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email;
        if (!confirm(`删除联系人 ${email}？`)) return;
        const contacts = await window.electronAPI.getContacts();
        const contact = contacts.find(c => (c.email || '').toLowerCase().trim() === email.toLowerCase().trim());
        if (contact?.id) await window.electronAPI.deleteContact(contact.id);
        // 从记录中移除
        bounceRecords = bounceRecords.filter(r => (r.email || '').toLowerCase().trim() !== email.toLowerCase().trim());
        await window.electronAPI.saveBounceLog(bounceRecords);
        renderBounceTable();
      });
    });
  }
  // 一键删除按钮
  const delAllBtn = document.getElementById('bounce-del-all-btn');
  if (delAllBtn) {
    const matchedCount = bounceRecords.filter(r => r.matched).length;
    delAllBtn.style.display = matchedCount > 0 ? '' : 'none';
    if (matchedCount > 0) delAllBtn.textContent = `一键删除全部 (${matchedCount})`;
  }
}

async function initBouncePage() {
  const runBtn = document.getElementById('bounce-run-btn');
  const clearBtn = document.getElementById('bounce-clear-btn');
  const status = document.getElementById('bounce-status');
  const empty = document.getElementById('bounce-empty');
  const groupsEl = document.getElementById('bounce-groups');

  // 加载历史记录
  if (!runBtn._bound) {
    runBtn._bound = true;
    try {
      const log = await window.electronAPI.loadBounceLog();
      if (log.ok && log.data.length) {
        bounceRecords = log.data;
        renderBounceTable();
      }
    } catch {}

    // 自动检测：上次发信在10分钟~24小时内 → 自动扫一次
    try {
      const st = await window.electronAPI.loadSendState();
      if (st?.data?.startedAt) {
        const since = (Date.now() - new Date(st.data.startedAt).getTime()) / 1000;
        if (since > 600 && since < 86400) setTimeout(() => runBtn.click(), 500);
      }
    } catch {}

    // 倒计时更新
    const countdownEl = document.getElementById('bounce-countdown');
    if (countdownEl && !countdownEl._timer) {
      countdownEl._timer = setInterval(() => {
        if (nextBounceScanAt > 0) {
          const rem = Math.max(0, Math.round((nextBounceScanAt - Date.now()) / 1000));
          const m = Math.floor(rem / 60), s = rem % 60;
          countdownEl.textContent = rem > 0 ? `下次扫描: ${m}:${String(s).padStart(2, '0')}` : '即将扫描...';
        } else {
          countdownEl.textContent = '';
        }
      }, 1000);
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.innerHTML = `${lucide('refresh-cw',14,'spin')} 扫描中...`;
      status.textContent = '正在连接邮箱...';
      if (groupsEl) groupsEl.innerHTML = '';
      if (empty) { empty.style.display = 'block'; empty.textContent = '正在扫描...'; }
      try {
        const [result, contacts] = await Promise.all([
          window.electronAPI.checkBounces(),
          window.electronAPI.getContacts(),
        ]);
        if (!result.ok) {
          status.textContent = '❌ ' + (result.error || '检查失败');
          runBtn.disabled = false;
          runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
          return;
        }
        if (!result.bounced.length) {
          bounceRecords = [];
          await window.electronAPI.saveBounceLog([]);
          renderBounceTable();
          status.textContent = '✅ 未发现退信';
          runBtn.disabled = false;
          runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
          return;
        }
        // 匹配联系人
        const contactMap = {};
        for (const c of contacts) {
          const e = (c.email || '').toLowerCase().trim();
          if (e) contactMap[e] = c;
        }
        bounceRecords = result.bounced.map(b => {
          const email = b.bouncedEmail || '';
          const matched = contactMap[email];
          return { ...b, email, matched: !!matched, company: matched ? matched.company : '', contactId: matched ? matched.id : '' };
        });
        bounceRecords.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0));
        for (const r of bounceRecords) {
          if (r.matched && r.email) {
            window.electronAPI.updateBounce(r.email, { type: r.type || 'unknown', reason: r.reason || '未知原因' }).catch(() => {});
          }
        }
        await window.electronAPI.saveBounceLog(bounceRecords);
        renderBounceTable();
        const matchedCount = bounceRecords.filter(r => r.matched).length;
        status.textContent = `发现 ${result.bounced.length} 封退信，${matchedCount} 个匹配联系人`;
      } catch (e) {
        status.textContent = '❌ ' + (e.message || '异常');
      }
      runBtn.disabled = false;
      runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
    });

    clearBtn.addEventListener('click', async () => {
      if (!confirm('确定清除所有退信记录？')) return;
      bounceRecords = [];
      await window.electronAPI.saveBounceLog([]);
      renderBounceTable();
    });

    const delAllBtn = document.getElementById('bounce-del-all-btn');
    delAllBtn?.addEventListener('click', async () => {
      const matched = bounceRecords.filter(r => r.matched);
      if (!matched.length) return;
      if (!confirm(`确定删除全部 ${matched.length} 个退信联系人？此操作不可恢复。`)) return;
      const contacts = await window.electronAPI.getContacts();
      let deleted = 0;
      for (const r of matched) {
        const contact = contacts.find(c => (c.email || '').toLowerCase().trim() === (r.email || '').toLowerCase().trim());
        if (contact?.id) { await window.electronAPI.deleteContact(contact.id); deleted++; }
      }
      bounceRecords = [];
      await window.electronAPI.saveBounceLog([]);
      renderBounceTable();
      showToast(`已删除 ${deleted} 个退信联系人`, 'ok');
    });
  }
}

// ===== 发送总览 ======================================================
let historyFilters = { type: '', lang: '', country: '', stage: '' };
let historyCountries = [];
let historyPage = 0, historyTotal = 0;
const HISTORY_PAGE_SIZE = 500;

async function loadHistoryPage() {
  const q = (document.getElementById('history-search')?.value || '').trim();
  const params = {
    limit: HISTORY_PAGE_SIZE, offset: historyPage * HISTORY_PAGE_SIZE,
    search: q || undefined,
    type: historyFilters.type || undefined,
    lang: historyFilters.lang || undefined,
    country: historyFilters.country || undefined,
    stage: historyFilters.stage || undefined,
  };
  const result = await window.electronAPI.getSendLog(params);
  historyTotal = result.total;
  return result.records;
}

async function renderHistoryTable() {
  const listEl = document.getElementById('history-list');
  const layout = document.getElementById('history-layout');
  const empty = document.getElementById('history-empty');
  const count = document.getElementById('history-count');
  const pagination = document.getElementById('history-pagination');
  const preview = document.getElementById('history-preview');

  const records = await loadHistoryPage();
  const totalPages = Math.ceil(historyTotal / HISTORY_PAGE_SIZE);

  if (count) count.textContent = historyTotal ? `共 ${historyTotal} 封（第 ${historyPage + 1}/${totalPages || 1} 页）` : '';
  // 动态生成国家筛选按钮
  const countryContainer = document.getElementById('history-country-btns');
  if (countryContainer && historyCountries.length > 0) {
    countryContainer.innerHTML = historyCountries.map(c =>
      `<button class="htab${historyFilters.country === c ? ' active' : ''}" data-key="country" data-val="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join('');
    countryContainer.querySelectorAll('.htab').forEach(btn => {
      btn.addEventListener('click', () => {
        historyFilters[btn.dataset.key] = btn.dataset.val;
        document.querySelectorAll(`#history-filter-group .htab[data-key="country"]`).forEach(b => b.classList.toggle('active', b.dataset.val === btn.dataset.val));
        historyPage = 0;
        renderHistoryTable();
      });
    });
  }
  if (!records.length) {
    if (layout) layout.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (pagination) pagination.style.display = 'none';
    if (preview) preview.innerHTML = '<div class="history-preview-empty">← 选择公司查看详情</div>';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (layout) layout.style.display = 'flex';

  // 按公司分组
  const groups = {};
  records.forEach(r => {
    const key = r.company || '未知';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  const entries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  if (listEl) {
    listEl.innerHTML = entries.map(([company, items]) => {
      const r0 = items[0];
      const tags = [];
      const tt = clientTypeTag(r0._type);
      if (tt) tags.push(tt);
      if (r0._country) tags.push(escapeHtml(r0._country));
      if (r0._lang) tags.push(escapeHtml(r0._lang).toUpperCase());
      const tplMap = { agent:'代理模板', direct:'直客模板', unlabeled:'通用模板' };
      tags.push('📝 ' + (tplMap[r0._type] || '通用模板'));
      // 收集去重收件人
      const allTo = [...new Set(items.map(r => r.to).filter(Boolean))];
      const recipientsStr = allTo.join(', ');
      const timeStr = r0.time ? new Date(new Date(r0.time).getTime() + 8*3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
      const stageLbl = { cold:'冷开发',f1:'F1',f2:'F2',f3:'F3',f4:'F4',archived:'已归档',monthly:'月度' }[r0._stage] || '';
      const allIdx = items.map(r => r.index).join('|');
      return `<div class="history-item" data-idx="${allIdx}" data-bodyid="${escapeHtml(r0.bodyId || '')}"
            data-to="${escapeHtml(recipientsStr)}" data-company="${escapeHtml(company)}"
            data-subject="${escapeHtml(r0.subject || '')}" data-stage="${escapeHtml(stageLbl)}"
            data-tags="${escapeHtml(tags.join(' · ') || '—')}" data-status="${r0.status === 'sent' ? '✅ 已发送' : '❌ 失败'}"
            data-time="${escapeHtml(timeStr)}">
        <input type="checkbox" class="hi-check" data-idx="${allIdx}" onclick="event.stopPropagation()">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(company)}</span>
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">${items.length} 封</span>
          </div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tags.join(' · ')}</div>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        listEl.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        showPreview(item.dataset);
      });
    });
  }

  // 分页
  if (pagination && totalPages > 1) {
    pagination.style.display = 'flex';
    let h = `<button ${historyPage === 0 ? 'disabled' : ''} data-p="0">««</button>`;
    h += `<button ${historyPage === 0 ? 'disabled' : ''} data-p="${historyPage - 1}">«</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= historyPage + 1 - 2 && i <= historyPage + 1 + 2)) {
        h += `<button class="${i - 1 === historyPage ? 'active' : ''}" data-p="${i - 1}">${i}</button>`;
      } else if (i === historyPage + 1 - 3 || i === historyPage + 1 + 3) {
        h += '<span>...</span>';
      }
    }
    h += `<button ${historyPage >= totalPages - 1 ? 'disabled' : ''} data-p="${historyPage + 1}">»</button>`;
    h += `<button ${historyPage >= totalPages - 1 ? 'disabled' : ''} data-p="${totalPages - 1}">»»</button>`;
    pagination.innerHTML = h;
    pagination.querySelectorAll('button[data-p]').forEach(btn => {
      btn.addEventListener('click', () => {
        historyPage = parseInt(btn.dataset.p);
        renderHistoryTable();
      });
    });
  } else if (pagination) {
    pagination.style.display = 'none';
  }
}

async function showPreview(d) {
  const preview = document.getElementById('history-preview');
  if (!preview) return;
  let sigHtml = '';
  try { const r = await window.electronAPI.loadSignature(); if (r.ok) sigHtml = r.html; } catch {}
  function textToHtml(bodyText) {
    const lines = bodyText.split('\n');
    const h = [];
    let first = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { h.push('<br>'); continue; }
      if (t === '--' || t === '---') { h.push('<br>'); continue; }
      const c = (first && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${escapeHtml(t)}</strong>`
        : escapeHtml(t);
      h.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${c}</p>`);
      first = false;
    }
    return h.join('\n') + '\n<br>\n' + sigHtml;
  }
  const recipients = (d.to || '').split(',').map(s => s.trim()).filter(Boolean);
  preview.innerHTML =
    `<div class="hp-box">
      <div class="hp-box-head">📧 发送信息</div>
      <div class="hp-box-body">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">${escapeHtml(d.subject || '无主题')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:var(--text-secondary);margin-bottom:8px">
          <span>🕐 ${escapeHtml(d.time || '—')}</span>
          <span>${d.tags || '—'}</span>
          <span>${d.stage || '—'} · ${d.status || ''}</span>
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:3px">收件人（${recipients.length} 位）</div>
        <div class="hp-recipients">${recipients.map(r => '<div>' + escapeHtml(r) + '</div>').join('')}</div>
      </div>
    </div>
    <div class="hp-box" style="flex:1;display:flex;flex-direction:column">
      <div class="hp-box-head">📧 信件内容</div>
      <div class="hp-box-body" style="flex:1;overflow-y:auto">
        <div class="hp-body" id="hp-body-content">${d.bodyid ? '<span style="color:var(--text-secondary)">加载中...</span>' : '<span style="color:var(--text-secondary)">(无邮件正文)</span>'}</div>
      </div>
    </div>`;
  if (d.bodyid) {
    try {
      const body = await window.electronAPI.getSendBody(d.bodyid);
      const bodyEl = document.getElementById('hp-body-content');
      if (bodyEl) bodyEl.innerHTML = body ? textToHtml(body) : '<span style="color:var(--text-secondary)">(无正文)</span>';
    } catch { const bodyEl = document.getElementById('hp-body-content'); if (bodyEl) bodyEl.textContent = '(加载失败)'; }
  }
}

function debounceHistorySearch() {
  clearTimeout(window._historySearchTimer);
  window._historySearchTimer = setTimeout(() => {
    historyPage = 0;
    renderHistoryTable();
  }, 300);
}

async function initHistoryPage() {
  // 预加载所有国家列表（用于筛选按钮）
  try {
    const fullLog = await window.electronAPI.getSendLog({ limit: 99999, offset: 0, search: undefined, type: undefined, lang: undefined, stage: undefined, country: undefined });
    historyCountries = [...new Set((fullLog.records || []).map(r => r._country).filter(Boolean))].sort();
  } catch { historyCountries = []; }
  historyPage = 0;
  renderHistoryTable();

  if (!document.querySelector('#history-filter-group')._bound) {
    document.querySelector('#history-filter-group')._bound = true;

    // 批量操作（只绑定一次）
    document.getElementById('history-sel-all')?.addEventListener('click', () => {
      document.querySelectorAll('.hi-check').forEach(cb => { cb.checked = true; });
    });
    document.getElementById('history-sel-none')?.addEventListener('click', () => {
      document.querySelectorAll('.hi-check').forEach(cb => { cb.checked = false; });
    });
    document.getElementById('history-del-sel')?.addEventListener('click', async () => {
      // 收集每个勾选组的所有 index（用 | 分隔，data-idx 格式：idx1|idx2|...）
      const allIndices = [];
      document.querySelectorAll('.hi-check:checked').forEach(cb => {
        const ids = (cb.dataset.idx || '').split('|').filter(Boolean);
        allIndices.push(...ids);
      });
      if (!allIndices.length) return alert('请先勾选要删除的邮件');
      if (!confirm(`确定删除选中的 ${allIndices.length} 封邮件？此操作不可恢复。`)) return;
      try {
        await window.electronAPI.deleteHistory(allIndices);
        historyPage = 0;
        renderHistoryTable();
        showToast('已删除', 'ok');
      } catch (e) { alert('删除失败: ' + e.message); }
    });
    document.querySelectorAll('#history-filter-group .htab').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const val = btn.dataset.val;
        historyFilters[key] = val;
        document.querySelectorAll(`#history-filter-group .htab[data-key="${key}"]`).forEach(b => b.classList.toggle('active', b.dataset.val === val));
        historyPage = 0;
        renderHistoryTable();
      });
    });
    document.getElementById('history-search')?.addEventListener('input', debounceHistorySearch);
  }
}

// API 快捷入口：点击在浏览器打开对应服务
document.getElementById('page-settings')?.addEventListener('click', async (e) => {
  const link = e.target.closest('.quick-link');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.url;
  if (url) await window.electronAPI.openExternal(url);
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

// ===== 图标初始化 ====================================================
function initIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (!name) return;
    let size = 18;
    if (el.classList.contains('drop-icon')) size = 32;
    else if (el.classList.contains('nav-arrow')) size = 14;
    else if (el.closest('button')) size = 12;
    else if (el.closest('h2')) size = 20;
    else if (el.closest('h3')) size = 16;
    else if (el.closest('h4')) size = 14;
    el.innerHTML = lucide(name, size);
  });
}

// ===== 客户开发 ======================================================
let discoverResults = [];       // 当前搜索结果
let discoverSelectedIdx = null; // 当前选中的结果索引
let discoverActiveTab = 'find'; // 当前激活的 tab

async function initDiscover() {
  // 国家列表（拉美重点市场）
  const countries = ['','Mexico','Brazil','Chile','Peru','Colombia','Argentina','Ecuador','Bolivia','Paraguay','Uruguay','Panama','Costa Rica'];
  const sel = document.getElementById('df-country');
  if (sel && !sel.dataset.filled) {
    sel.dataset.filled = '1';
    countries.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c || '选择国家'; sel.appendChild(o); });
  }

  // Tab 切换
  document.querySelectorAll('.discover-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.discover-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      discoverActiveTab = tab.dataset.tab;
      const isFind = discoverActiveTab === 'find';
      document.getElementById('discover-find-search').style.display = isFind ? '' : 'none';
      document.getElementById('discover-lookup-search').style.display = isFind ? 'none' : '';
      document.getElementById('df-results').style.display = isFind ? '' : 'none';
      document.getElementById('df-stats').style.display = isFind ? (document.getElementById('df-stats').textContent ? '' : 'none') : 'none';
      document.getElementById('dl-results').style.display = isFind ? 'none' : '';
      document.getElementById('dl-format').style.display = isFind ? 'none' : (document.getElementById('dl-format').textContent ? '' : 'none');
      document.querySelector('.discover-results-head').style.display = '';
    });
  });

  // 客户发现搜索
  document.getElementById('df-search')?.addEventListener('click', doDiscoverSearch);
  // 邮箱反查
  document.getElementById('dl-search')?.addEventListener('click', doEmailLookup);
  // 全选
  const fullSelBtn = document.getElementById('df-selectall');
  if (fullSelBtn && !fullSelBtn.dataset.bound) {
    fullSelBtn.dataset.bound = '1';
    fullSelBtn.addEventListener('click', toggleAllDiscover);
  }
  // 导入选中
  document.getElementById('df-import')?.addEventListener('click', () => importSelectedDiscover());

  // 结果列表点击委托
  document.getElementById('df-results')?.addEventListener('click', (e) => {
    const item = e.target.closest('.discover-result-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx);
    if (!isNaN(idx)) selectDiscoverResult(idx);
  });
  document.getElementById('dl-results')?.addEventListener('click', (e) => {
    const item = e.target.closest('.discover-result-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx);
    if (!isNaN(idx)) selectDiscoverResult(idx);
  });

  // 底部栏导航
  document.getElementById('discover-go-backcheck')?.addEventListener('click', () => {
    if (discoverSelectedIdx != null && discoverResults[discoverSelectedIdx]) {
      discoverPreselectCompany = discoverResults[discoverSelectedIdx].company;
    }
    const nav = document.querySelector('[data-page="backcheck"]');
    if (nav) nav.click();
  });
  document.getElementById('discover-go-send')?.addEventListener('click', () => {
    if (discoverSelectedIdx != null && discoverResults[discoverSelectedIdx]) {
      selectedCompanySet.add(discoverResults[discoverSelectedIdx].company);
    }
    const nav = document.querySelector('[data-page="email-send"]');
    if (nav) nav.click();
  });

  // 详情面板操作按钮事件委托
  document.getElementById('discover-detail-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !discoverSelectedIdx || !discoverResults[discoverSelectedIdx]) return;
    const item = discoverResults[discoverSelectedIdx];
    if (btn.id === 'discover-btn-import') await importSingleCompany(item);
    if (btn.id === 'discover-btn-backcheck') await startBackcheckFromDiscover(item.company);
    if (btn.id === 'discover-btn-send') goToSend(item.company);
    if (btn.id === 'discover-btn-deepsearch') deepSearchFromDiscover(item);
  });

  // 确保联系人数据已加载以更新底部栏
  if (!contactsData || !contactsData.length) {
    try { contactsData = await window.electronAPI.getContacts(); } catch {}
  }
  updateDiscoverBottomBar();
}

async function doDiscoverSearch() {
  const btn = document.getElementById('df-search');
  const country = document.getElementById('df-country')?.value || '';
  const industry = document.getElementById('df-industry')?.value || '';
  const role = document.getElementById('df-role')?.value || 'importer';
  const keywords = document.getElementById('df-keywords')?.value || '';
  if (!country) { alert('请选择国家'); return; }

  btn.disabled = true; btn.textContent = '搜索中...';
  document.getElementById('df-results').innerHTML = `<div class="discover-spin">${lucide('refresh-cw',20,'spin')} 正在多平台搜索...</div>`;
  document.getElementById('discover-results-empty').style.display = 'none';
  document.getElementById('discover-detail-empty').style.display = '';
  document.getElementById('discover-detail-content').style.display = 'none';
  discoverResults = [];
  discoverSelectedIdx = null;

  try {
    const r = await window.electronAPI.discoverSearch({ country, industry, role, keywords, limit: '30' });
    if (!r.ok) { document.getElementById('df-results').innerHTML = '<div class="discover-spin">搜索失败</div>'; return; }

    discoverResults = r.companies || [];

    // 统计
    const stats = document.getElementById('df-stats');
    const srcLabels = Object.entries(r.sources || {}).map(([k,v]) => `<span>${k}: ${v}</span>`).join('');
    stats.innerHTML = `找到 <b>${r.total}</b> 家公司 · ${srcLabels}`;
    stats.style.display = '';

    // 计数
    const countEl = document.getElementById('df-count');
    if (countEl) countEl.textContent = `共 ${discoverResults.length} 条`;

    // 渲染
    renderDiscoverResults('df-results', discoverResults);
  } catch(e) {
    document.getElementById('df-results').innerHTML = `<div class="discover-spin">网络错误: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '开始搜索';
}

async function doEmailLookup() {
  const btn = document.getElementById('dl-search');
  const company = document.getElementById('dl-company')?.value?.trim() || '';
  const email = document.getElementById('dl-email')?.value?.trim() || '';
  if (!company && !email) { alert('请输入公司名或已知邮箱'); return; }

  btn.disabled = true; btn.textContent = '反查中...';
  document.getElementById('dl-results').innerHTML = `<div class="discover-spin">${lucide('refresh-cw',20,'spin')} 正在查找邮箱格式...</div>`;
  document.getElementById('dl-format').style.display = 'none';
  document.getElementById('discover-results-empty').style.display = 'none';
  discoverResults = [];
  discoverSelectedIdx = null;

  try {
    const domain = email ? email.split('@')[1] : '';
    const r = await window.electronAPI.discoverLookup({ company, domain });

    if (!r.ok) {
      document.getElementById('dl-results').innerHTML = `<div class="discover-spin">未找到相关信息</div>`;
      btn.disabled = false; btn.textContent = '开始反查';
      return;
    }

    // 显示邮箱格式
    if (r.pattern) {
      document.getElementById('dl-format').innerHTML = `📧 邮箱格式: <span class="dl-format-badge">${r.pattern}</span> · 置信度: ${Math.round(r.confidence*100)}%`;
      document.getElementById('dl-format').style.display = '';
    }

    // 渲染结果
    if (r.people?.length) {
      discoverResults = r.people.map(p => ({
        company: p.name, website: p.email || '', snippet: `${p.title || ''} · ${p.source || ''}`,
        source: p.source || 'inferred', confidence: p.confidence || 0.5,
        extra: { email: p.email, title: p.title }
      }));
      renderDiscoverResults('dl-results', discoverResults);
    } else {
      document.getElementById('dl-results').innerHTML = '<div class="discover-spin">未找到相关人员。尝试输入公司官网邮箱格式。</div>';
    }
  } catch(e) {
    document.getElementById('dl-results').innerHTML = `<div class="discover-spin">网络错误: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '开始反查';
}

function renderDiscoverResults(containerId, companies) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const emptyEl = document.getElementById('discover-results-empty');

  if (!companies?.length) {
    container.innerHTML = '<div class="discover-spin">无结果</div>';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  container.innerHTML = companies.map((c, i) => {
    const badge = c.confidence >= 0.7 ? 'badge-high' : c.confidence >= 0.5 ? 'badge-mid' : 'badge-low';
    const website = c.website || c.extra?.email || '';
    const snippet = c.snippet || c.extra?.title || '';
    return `<div class="discover-result-item" data-idx="${i}">
      <input type="checkbox" data-idx="${i}" data-name="${escapeHtml(c.company)}" data-site="${escapeHtml(website)}" data-snippet="${escapeHtml(snippet)}" onclick="event.stopPropagation()">
      <div class="discover-result-info">
        <div class="dri-name">${escapeHtml(c.company)}</div>
        <div class="dri-meta">${escapeHtml(website)} · ${escapeHtml(snippet)}</div>
      </div>
      <span class="discover-result-badge ${badge}">${c.source} ⭐${(c.confidence||0).toFixed(1)}</span>
    </div>`;
  }).join('');
}

function toggleAllDiscover() {
  const container = discoverActiveTab === 'find'
    ? document.getElementById('df-results')
    : document.getElementById('dl-results');
  if (!container) return;
  const cbs = container.querySelectorAll('input[type=checkbox]');
  const all = [...cbs].every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !all; });
}

async function importSelectedDiscover() {
  const container = discoverActiveTab === 'find'
    ? document.getElementById('df-results')
    : document.getElementById('dl-results');
  if (!container) return;
  const checked = container.querySelectorAll('input[type=checkbox]:checked');
  if (!checked.length) { showToast('请先勾选公司', 'warn'); return; }

  const clients = [...checked].map(cb => ({
    company: cb.dataset.name,
    website: cb.dataset.site,
    email: cb.dataset.site?.includes('@') ? cb.dataset.site : '',
    contactName: '',
    position: cb.dataset.snippet?.includes('@') ? '' : cb.dataset.snippet,
  }));

  const result = await window.electronAPI.importContacts(clients);
  showToast(`导入完成: 新增 ${result?.added || 0}, 已存在 ${result?.skipped || 0}`, 'ok');
  updateDiscoverBottomBar();

  // 刷新当前选中项的详情
  if (discoverSelectedIdx != null && discoverResults[discoverSelectedIdx]) {
    selectDiscoverResult(discoverSelectedIdx);
  }
}

// ── 右侧详情面板 ──────────────────────────────────────────────────
function selectDiscoverResult(idx) {
  discoverSelectedIdx = idx;
  // 高亮结果行
  const activeContainer = discoverActiveTab === 'find'
    ? document.getElementById('df-results')
    : document.getElementById('dl-results');
  if (activeContainer) {
    activeContainer.querySelectorAll('.discover-result-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.idx) === idx);
    });
  }
  renderDiscoverDetail(idx);
}

async function renderDiscoverDetail(idx) {
  const item = discoverResults[idx];
  if (!item) return;

  const emptyEl = document.getElementById('discover-detail-empty');
  const contentEl = document.getElementById('discover-detail-content');
  if (emptyEl) emptyEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'flex';

  // 公司基本信息
  document.getElementById('discover-detail-name').textContent = item.company;
  const website = item.website || item.extra?.email || '';
  document.getElementById('discover-detail-fields').innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">🌐 官网</span><span style="word-break:break-all">${escapeHtml(website) || '--'}</span></div>
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">📌 来源</span><span>${item.source} · 置信度 ${(item.confidence || 0).toFixed(1)}</span></div>
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">📝 摘要</span><span style="color:var(--text-secondary)">${escapeHtml(item.snippet || '--')}</span></div>
  `;

  // 查询工作流状态
  const status = await getWorkflowStatus(item.company);

  // 操作按钮
  const actions = document.getElementById('discover-action-btns');
  let btns = '';
  if (!status.imported) {
    btns += `<button id="discover-btn-import">📥 导入到联系人</button>`;
  } else {
    btns += `<button class="secondary" disabled>✅ 已导入 (${status.contactCount} 位联系人)</button>`;
  }
  if (status.imported && !status.backcheckDone && !status.backcheckActive) {
    btns += `<button id="discover-btn-backcheck">🔬 开始背调</button>`;
  }
  if (status.backcheckActive) {
    btns += `<button class="secondary" disabled>⏳ 背调进行中...</button>`;
  }
  if (status.backcheckDone) {
    btns += `<button class="secondary" disabled>✅ 背调完成 ${ratingStars(status.rating)}</button>`;
  }
  if (status.imported && !status.isArchived) {
    btns += `<button id="discover-btn-send" class="secondary">📧 去发送邮件</button>`;
  }
  if (website && !website.includes('@')) {
    btns += `<button id="discover-btn-deepsearch" class="secondary" style="font-size:12px">🔎 查找决策人</button>`;
  }
  actions.innerHTML = btns;

  // Pipeline
  renderWorkflowPipeline(status);
}

async function getWorkflowStatus(companyName) {
  let contacts = contactsData;
  if (!contacts || !contacts.length) {
    try { contacts = await window.electronAPI.getContacts(); } catch { contacts = []; }
  }
  const backcheckStatus = await window.electronAPI.getBackcheckStatus();
  const sendHistory = (typeof contactsSendHistory !== 'undefined' ? contactsSendHistory : null)
    || await window.electronAPI.getSendHistory().catch(() => ({}))
    || {};

  const companyContacts = contacts.filter(c => (c.company || '').trim() === (companyName || '').trim());
  const bcSt = backcheckStatus[companyName];
  const sendSt = sendHistory[companyName];

  return {
    imported: companyContacts.length > 0,
    contactCount: companyContacts.length,
    backcheckDone: bcSt?.status === 'done',
    backcheckActive: bcSt?.status === 'researching' || bcSt?.status === 'pending',
    rating: bcSt?.rating || 0,
    sendStage: sendSt?.stage || null,
    isArchived: sendSt?.stage === 'archived',
  };
}

function renderWorkflowPipeline(status) {
  const pipeline = document.getElementById('discover-pipeline');
  if (!pipeline) return;
  const steps = [
    { key: 'discovered', label: '已发现', done: true, active: false, meta: '' },
    { key: 'imported', label: '已导入', done: status.imported, active: false,
      meta: status.imported ? `${status.contactCount} 位联系人` : '' },
    { key: 'backcheck', label: '背调完成', done: status.backcheckDone, active: status.backcheckActive,
      meta: status.backcheckDone ? ratingStars(status.rating) : (status.backcheckActive ? '进行中...' : '') },
    { key: 'sending', label: '开发信中', done: !!status.sendStage, active: false,
      meta: status.sendStage ? (status.isArchived ? '📦 已归档' : '阶段: ' + status.sendStage.toUpperCase()) : '' },
  ];

  pipeline.innerHTML = steps.map(step => {
    let cls = 'pending';
    if (step.done) cls = 'done';
    else if (step.active) cls = 'active';
    const dot = step.done ? '✓' : (step.active ? '●' : '○');
    return `<div class="discover-pipeline-step ${cls}">
      <div class="step-dot">${dot}</div>
      <span class="step-label">${step.label}</span>
      <span class="step-meta">${step.meta}</span>
    </div>`;
  }).join('');
}

// ── 工作流操作 ────────────────────────────────────────────────────
async function importSingleCompany(item) {
  const client = {
    company: item.company,
    website: item.website || item.extra?.email || '',
    email: (item.website || '').includes('@') ? item.website : (item.extra?.email || ''),
    contactName: '',
    position: item.snippet || item.extra?.title || '',
  };
  const result = await window.electronAPI.importContacts([client]);
  showToast(`导入完成: 新增 ${result?.added || 0}, 已存在 ${result?.skipped || 0}`, 'ok');

  // 刷新联系人数据
  try { contactsData = await window.electronAPI.getContacts(); } catch {}

  // 刷新详情面板
  if (discoverSelectedIdx != null) selectDiscoverResult(discoverSelectedIdx);
  updateDiscoverBottomBar();
}

async function startBackcheckFromDiscover(companyName) {
  const contacts = contactsData && contactsData.length ? contactsData : await window.electronAPI.getContacts();
  const contact = contacts.find(c => (c.company || '').trim() === (companyName || '').trim());
  if (!contact) { showToast('未找到联系人数据，请先导入', 'err'); return; }

  showToast(`正在启动 ${companyName} 背调...`, 'ok');
  const result = await window.electronAPI.startResearch(contact, 'deep-research');
  if (!result.ok) { showToast(result.message || '启动失败', 'err'); return; }

  // 刷新详情面板
  if (discoverSelectedIdx != null) selectDiscoverResult(discoverSelectedIdx);
  updateDiscoverBottomBar();

  // 自动跳转背调页面
  const nav = document.querySelector('[data-page="backcheck"]');
  if (nav) nav.click();
}

function goToSend(companyName) {
  // 预添加到选中集合
  if (typeof selectedCompanySet !== 'undefined') {
    selectedCompanySet.add(companyName);
  }
  const nav = document.querySelector('[data-page="email-send"]');
  if (nav) nav.click();
}

async function deepSearchFromDiscover(item) {
  const btn = document.getElementById('discover-btn-deepsearch');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `${lucide('refresh-cw',12,'spin')} 搜索中...`;

  const website = item.website || item.extra?.email || '';
  try {
    const result = await window.electronAPI.deepSearchContacts(website, item.company);
    if (result?.people?.length) {
      const peopleList = result.people.slice(0, 8).map(p =>
        `<div style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:12px">
          <span style="font-weight:600">${escapeHtml(p.name || '未知')}</span>
          <span style="color:var(--text-secondary)"> · ${escapeHtml(p.title || '')}</span>
          ${p.email ? `<span style="color:var(--primary)"> · ${escapeHtml(p.email)}</span>` : ''}
          <span style="font-size:10px;color:var(--text-secondary)"> [${p.source}]</span>
        </div>`
      ).join('');
      const fields = document.getElementById('discover-detail-fields');
      if (fields) {
        fields.insertAdjacentHTML('beforeend',
          `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
            <span style="font-size:11px;font-weight:600;color:var(--text-secondary)">🔎 决策人搜索结果:</span>
            ${peopleList}
          </div>`);
      }
    } else {
      showToast('未找到决策人信息', 'warn');
    }
  } catch (e) {
    showToast('决策人搜索失败: ' + e.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '🔎 查找决策人';
}

function updateDiscoverBottomBar() {
  const bar = document.getElementById('discover-bottom-bar');
  const summary = document.getElementById('discover-import-summary');
  if (!bar || !summary) return;

  // 统计当前搜索结果中已导入的联系人
  let totalContacts = 0;
  try {
    const names = new Set(discoverResults.map(r => (r.company || '').trim()).filter(Boolean));
    const allContacts = contactsData || [];
    totalContacts = allContacts.filter(c => names.has((c.company || '').trim())).length;
  } catch {}

  if (totalContacts > 0) {
    bar.style.display = 'flex';
    const uniqueCompanies = new Set();
    try {
      (contactsData || []).forEach(c => {
        if (discoverResults.some(r => (r.company || '').trim() === (c.company || '').trim())) {
          uniqueCompanies.add(c.company);
        }
      });
    } catch {}
    summary.textContent = `已导入 ${uniqueCompanies.size} 家公司 · ${totalContacts} 位联系人`;
  } else {
    bar.style.display = 'none';
  }
}

// ===== 初始化 ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  initIcons();
  await initQueue();  // 先从文件恢复队列
  loadDashboard();
  // 监听自动退信检测通知
  window.electronAPI.onBounceAutoDetected(({ count, matched }) => {
    showToast(`📨 自动退信检测: ${count} 封退信，已标记 ${matched} 人`, 'warn');
  });
  console.log("🚀 Milogin's Prospector v1.3 已就绪");
});
