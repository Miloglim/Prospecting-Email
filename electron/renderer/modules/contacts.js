const S = window.S;
import CS from './company-state.js';
import { lucide,showAlert,showConfirm,showToast,escapeHtml,formatDate,daysSince,initIcons,findById,ratingStars,renderMarkdown,renderPagination,pollBackcheckStatus,showModal,clientTypeTag,groupByCompany } from './shared.js';

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

export async function doImport(file) {
  const filePath = window.electronAPI.getFilePath(file);
  const result = await window.electronAPI.importFile(filePath);
  if (result.error) { await showAlert('导入失败: ' + result.error); return; }
  S.clientsData = result.clients || [];
  S.clientsPage = 1;
  let msg = `成功导入 ${S.clientsData.length} 条记录`;
  if (result.invalidEmails?.length) {
    const list = result.invalidEmails.slice(0, 10).map(e => `· ${e.company} → ${e.email}`).join('\n');
    const more = result.invalidEmails.length > 10 ? `\n...等共 ${result.invalidEmails.length} 个` : '';
    msg += `\n\n⚠️ ${result.invalidEmails.length} 个邮箱格式异常：\n${list}${more}`;
  }
  if (result.unrecognizedCols?.length) {
    msg += `\n\n🔍 未识别的列（${result.unrecognizedCols.length}）：${result.unrecognizedCols.join('、')}`;
  }
  await showAlert(msg);
  renderClientsTable();
}

export function renderClientsTable() {
  const table = document.getElementById('clients-table');
  const tbody = table?.querySelector('tbody');
  const empty = document.getElementById('clients-empty');
  const toolbar = document.getElementById('clients-toolbar');
  const count = document.getElementById('clients-count');
  const pagination = document.getElementById('clients-pagination');

  if (!S.clientsData.length) {
    if (table) table.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    if (pagination) pagination.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = '';
  if (toolbar) toolbar.style.display = 'flex';
  if (count) count.textContent = `共 ${S.clientsData.length} 条记录（第 ${S.clientsPage}/${Math.ceil(S.clientsData.length / S.PAGE_SIZE)} 页）`;

  // 分页切片
  const start = (S.clientsPage - 1) * S.PAGE_SIZE;
  const pageData = S.clientsData.slice(start, start + S.PAGE_SIZE);

  if (tbody) {
    tbody.innerHTML = pageData.map((c, i) => {
      const nameDisplay = (c.firstName || c.lastName) ? `${c.firstName || ''} ${c.lastName || ''}`.trim() : (c.contactName || '—');
      return `
      <tr>
        <td>${start + i + 1}</td>
        <td>${escapeHtml(c.company)}</td>
        <td>${escapeHtml(nameDisplay)}</td>
        <td>${escapeHtml(c.country)}</td>
        <td>${escapeHtml(c.category)}</td>
        <td>${escapeHtml(c.email)}</td>
      </tr>
    `}).join('');
  }

  // 分页控件
  renderPagination(pagination, S.clientsData.length, S.clientsPage, (p) => {
    S.clientsPage = p;
    renderClientsTable();
  });
}

// 「保存到联系人」
document.getElementById('clients-import-btn')?.addEventListener('click', async () => {
  if (!S.clientsData.length) return await showAlert('没有可导入的数据');
  const result = await window.electronAPI.importContacts(S.clientsData);
  let msg = `新增 ${result.added} 位联系人（总计 ${result.total} 位）`;
  if (result.skipped > 0) msg += `\n跳过 ${result.skipped} 条重复记录`;
  if (result.writeFailed > 0) msg += `\n❌ ${result.writeFailed} 条写入数据库失败（参数缺失，请检查导入数据）`;
  if (result.invalidEmail > 0) {
    const list = (result.invalidEmails || []).slice(0, 10).map(e => `· ${e.company} → ${e.email}`).join('\n');
    const more = result.invalidEmail > 10 ? `\n...等共 ${result.invalidEmail} 个` : '';
    msg += `\n\n⚠️ ${result.invalidEmail} 个邮箱格式异常：\n${list}${more}`;
  }
  await showAlert(msg);
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
      await showAlert('请在设置页填写飞书多维表格完整地址（含 /base/xxx?table=xxx）');
    btn.disabled = false; btn.innerHTML = `${lucide('file-spreadsheet',14)} 从飞书导入`;
      return;
    }
    const result = await window.electronAPI.importFeishu(baseToken, tableId);
    if (result.error) { await showAlert('导入失败:\n' + result.error + '\n\n请将显示内容反馈给开发者'); }
    else {
      S.clientsData = result.clients || [];
      S.clientsPage = 1;
      let msg = `✅ ${S.clientsData.length} 条`;
      if (result.suspiciousCount > 0) {
        msg += `\n\n📊 飞书共 ${result.rawCount} 行，${result.suspiciousCount} 行公司名异常已标记「待确认」`;
      }
      await showAlert(msg);
      renderClientsTable();
    }
  } catch (e) { await showAlert('飞书导入异常: ' + e.message); }
  btn.disabled = false; btn.innerHTML = `${lucide('file-spreadsheet',14)} 从飞书导入`;
});

// 「清除」
document.getElementById('clients-clear-btn')?.addEventListener('click', () => {
  S.clientsData = [];
  S.clientsPage = 1;
  renderClientsTable();
});

// ===== 联系人 ========================================================

export async function loadContacts() {
  await CS.refreshContacts();
  await CS.refreshContactsSendHistory();
  // 诊断：打印分类统计
  const diag = { agent: 0, direct: 0, unlabeled: 0, noField: 0 };
  const seen = new Set();
  for (const c of S.contactsData) {
    if (!seen.has(c.company)) { seen.add(c.company); diag[c.clientType || 'noField']++; }
  }
  // 绑定筛选标签事件（仅一次）
  if (!window._contactsFilterBound) {
    window._contactsFilterBound = true;
    // 三分组独立筛选
    S.contactsFilter = 'all';
    document.querySelectorAll('#contacts-filter .cf-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('#contacts-filter .cf-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        S.contactsFilter = tab.dataset.filter;
        S.selectedContactCompany = null;
        renderContactsList();
      });
    });
  }
  renderContactsList();
  // 如果有预设搜索词（如从收件箱跳转过来），自动触发搜索
  const si = document.getElementById('contacts-search');
  if (si && si.value.trim()) si.dispatchEvent(new Event('input'));
}

// clientTypeTag / groupByCompany 从 shared.js 导入

export function renderContactsList(filtered) {
  let data = filtered || S.contactsData;

  // 应用筛选
  if (S.contactsFilter === 'archived') {
    data = data.filter(c => S.contactsSendHistory[c.company]?.stage === 'archived');
  } else if (S.contactsFilter?.startsWith('tag:')) {
    const tag = S.contactsFilter.slice(4);
    data = data.filter(c => (c.tags || []).includes(tag));
  } else if (S.contactsFilter !== 'all') {
    data = data.filter(c => (c.clientType || 'unlabeled') === S.contactsFilter);
  }

  const sidebar = document.getElementById('contacts-sidebar');
  const detail = document.getElementById('contacts-detail');
  const layout = document.getElementById('contacts-layout');
  const filterBar = document.getElementById('contacts-filter');
  const empty = document.getElementById('contacts-empty');
  const statsBar = document.getElementById('contacts-summary');

  // 统计各类型公司数（始终基于全部数据，不受筛选影响）
  const counts = { agent: 0, direct: 0, unlabeled: 0 };
  const seenCompanies = new Set();
  for (const c of S.contactsData) {
    const key = c.company;
    if (!seenCompanies.has(key)) {
      seenCompanies.add(key);
      counts[c.clientType || 'unlabeled']++;
    }
  }

  // 更新筛选标签
  const tabs = filterBar?.querySelectorAll('.cf-tab');
  if (tabs) {
    const tagCounts = { reached: 0, left_company: 0, replied: 0, autoreply: 0, bounced_by_contact: 0 };
    for (const c of S.contactsData) {
      for (const t of (c.tags || [])) { if (tagCounts[t] !== undefined) tagCounts[t]++; }
    }
    const labelMap = {
      all: `全部 ${seenCompanies.size}`,
      agent: `代理 ${counts.agent}`,
      direct: `直客 ${counts.direct}`,
      unlabeled: `未标签 ${counts.unlabeled}`,
      'tag:reached': `已触达 ${tagCounts.reached}`,
      'tag:left_company': `已离职 ${tagCounts.left_company}`,
      'tag:replied': `有回复 ${tagCounts.replied}`,
      'tag:autoreply': `自动回复 ${tagCounts.autoreply}`,
      'tag:bounced_by_contact': `退信 ${tagCounts.bounced_by_contact}`,
      archived: `已归档 ${Object.values(S.contactsSendHistory).filter(h => h?.stage === 'archived').length}`,
    };
    tabs.forEach(tab => {
      const f = tab.dataset.filter;
      tab.innerHTML = labelMap[f] || f;
      tab.classList.toggle('active', S.contactsFilter === f);
    });
  }

  if (!data.length) {
    if (empty) { empty.style.display = 'block'; empty.textContent = S.contactsFilter === 'archived' ? '暂无已归档客户' : S.contactsFilter?.startsWith('tag:') ? '该标签暂无联系人' : S.contactsFilter !== 'all' ? '该分类暂无联系人' : '暂无联系人 — 从「导入客户」导入'; }
    if (layout) layout.style.display = 'none';
    if (statsBar) statsBar.style.display = 'none';
    if (filterBar) filterBar.style.display = 'flex';
    if (sidebar) sidebar.innerHTML = '';
    if (detail) detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
    S.contactsGroupMap.clear();
    S.selectedContactCompany = null;
    return;
  }

  if (empty) empty.style.display = 'none';
  if (layout) layout.style.display = 'flex';
  if (filterBar) filterBar.style.display = 'flex';

  const groups = groupByCompany(data).sort((a, b) => b[1].length - a[1].length);

  // 快速查找表
  S.contactsGroupMap.clear();
  for (const [company, members] of groups) {
    S.contactsGroupMap.set(company, members);
  }

  // 统计（始终基于全部数据，不受筛选影响）
  if (statsBar) {
    const allGroups = groupByCompany(S.contactsData);
    const vipCount = allGroups.filter(g => g[1].length >= 5).length;
    statsBar.style.display = 'inline';
    statsBar.textContent = `${S.contactsData.length} 位联系人 · ${allGroups.length} 家公司 · ${vipCount} 家可定制客户`;
  }

  // 左侧公司列表
  if (sidebar) {
    sidebar.innerHTML = groups.map(([company, members]) => {
      const ctype = members[0]?.clientType || 'unlabeled';
      const tagHtml = clientTypeTag(ctype);
      const ctry = escapeHtml(members[0]?.country || '');
      const hist = S.contactsSendHistory[company];
      const stageLabel = hist?.stage ? `<span class="ci-stage-badge ci-stage-${hist.stage}">${S.STAGE_LABELS_SEND[hist.stage] || hist.stage.toUpperCase()}</span>` : '';
      const vipClass = members.length >= 5 ? ' ci-vip' : '';
      const subParts = [tagHtml, ctry, stageLabel].filter(Boolean);
      return `
      <div class="contact-item${S.selectedContactCompany === company ? ' active' : ''}" data-company="${escapeHtml(company)}">
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
        S.selectedContactCompany = item.dataset.company;
        renderContactDetail(S.selectedContactCompany);
      });

    });

    

// 搜索结果只有一家公司时自动展开，方便查看
    if (filtered && groups.length === 1) {
      S.selectedContactCompany = groups[0][0];
      const item = sidebar.querySelector(`[data-company="${escapeHtml(S.selectedContactCompany)}"]`);
      if (item) item.classList.add('active');
      renderContactDetail(S.selectedContactCompany);
    } else if (S.selectedContactCompany && S.contactsGroupMap.has(S.selectedContactCompany)) {
      renderContactDetail(S.selectedContactCompany);
    } else if (!filtered) {
      S.selectedContactCompany = groups[0]?.[0] || null;
      if (S.selectedContactCompany) {
        const firstItem = sidebar.querySelector(`[data-company="${escapeHtml(S.selectedContactCompany)}"]`);
        if (firstItem) firstItem.classList.add('active');
        renderContactDetail(S.selectedContactCompany);
      }
    }
  }
}

export function renderContactDetail(company) {
  const detail = document.getElementById('contacts-detail');
  if (!detail) return;
  let members = S.contactsGroupMap.get(company) || [];
  // 有搜索词时仅显示命中的联系人
  if (S._searchQuery) {
    const q = S._searchQuery.toLowerCase();
    members = members.filter(m => (m.email || '').toLowerCase().includes(q) || (m.firstName || '').toLowerCase().includes(q) || (m.lastName || '').toLowerCase().includes(q) || (m.contactName || '').toLowerCase().includes(q));
    if (!members.length) return; // 无匹配则不渲染
  }
  const ctype = members[0]?.clientType || 'unlabeled';
  const hist = S.contactsSendHistory[company];
  const isArchived = hist?.stage === 'archived';
  detail.innerHTML = `
    <div class="contacts-detail-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>${escapeHtml(company)} · ${members.length} 位联系人 ${clientTypeTag(ctype)}</span>
      <button id="btn-delete-company" class="btn-delete">${lucide('trash-2',14)}</button>
      <button id="btn-backcheck-contact" class="secondary" style="font-size:11px;padding:3px 10px;margin-left:auto">背调</button>
      ${S.contactsFilter === 'tag:bounced_by_contact' ? `<button id="btn-delete-bounced" class="secondary" style="font-size:11px;padding:3px 10px;color:#e5484d;border-color:#e5484d">删除全部退信</button>` : ''}
    </div>
    <div class="contacts-detail-body" style="overflow-x:auto">
      <table style="white-space:nowrap">
        <thead><tr><th>公司</th><th>名</th><th>姓</th><th>邮箱</th><th>职位</th><th>电话</th><th>领英</th><th>国家</th><th>品类</th><th>客户类型</th><th>阶段</th><th>状态</th><th>机会</th><th>标签</th><th>对接人</th><th>跟进人</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>
          ${members.map(m => {
            const contactTags = m.tags || [];
            const STATUS_PRIORITY = ['left_company','bounced_by_contact','replied','autoreply','auto_reply','reached'];
            const topTag = STATUS_PRIORITY.find(t => contactTags.includes(t));
            const STATUS_MAP = { left_company: { label: '已离职', dot: '#d93025' }, bounced_by_contact: { label: '退信', dot: '#e5484d' }, replied: { label: '有回复', dot: '#22a644' }, autoreply: { label: '自动回复', dot: '#e6a817' }, auto_reply: { label: '自动回复', dot: '#e6a817' }, reached: { label: '已触达', dot: '#3b82f6' } };
            let st = STATUS_MAP[topTag];
            if (!st && (m.is_bounced || m.bounced)) st = { label: '退信', dot: '#e5484d' };
            if (!st) st = { label: '未触达', dot: 'var(--text-secondary)' };
            const statusHtml = `<span style="font-size:11px;display:flex;align-items:center;gap:5px;white-space:nowrap"><span style="width:7px;height:7px;border-radius:50%;background:${st.dot};flex-shrink:0"></span>${st.label}</span>`;
            const hasFollowups = (m.followups || []).length > 0;
            const nameDisplay = (m.firstName || m.lastName) ? `${m.firstName||''} ${m.lastName||''}`.trim() : (m.contactName || '—');
            const STAGE_LABEL = { cold:'冷开发', f1:'F1', f2:'F2', f3:'F3', f4:'F4' };
            const TYPE_LABEL = { agent:'代理', direct:'直客', unlabeled:'通用' };
            const OPP_LABEL = { '待开发':'待开发','触达中':'触达中','报价中':'报价中','试单':'试单','合作中':'合作中','已流失':'已流失' };
            const tagStr = (m.tags || []).join(',');
            return `
            <tr data-contact-id="${m.id}">
              <td>${escapeHtml(m.company || m.company_name || '')}</td>
              <td>${escapeHtml(m.firstName || m.first_name || '')}</td>
              <td>${escapeHtml(m.lastName || m.last_name || '')}</td>
              <td>${escapeHtml(m.email)}</td>
              <td>${escapeHtml(m.title || m.position || '')}</td>
              <td>${escapeHtml(m.phone || '')}</td>
              <td>${escapeHtml(m.linkedin || '')}</td>
              <td>${escapeHtml(m.country || m.company_country || '')}</td>
              <td>${escapeHtml(m.category || '')}</td>
              <td>${TYPE_LABEL[m.clientType||m.client_type]||'通用'}</td>
              <td><span class="stage-badge stage-${m.stage||m._stage||'cold'}" style="font-size:10px;padding:1px 6px;border-radius:8px">${STAGE_LABEL[m.stage||m._stage]||'cold'}</span></td>
              <td>${statusHtml}</td>
              <td>${OPP_LABEL[m.opp_stage]||m.opp_stage||'待开发'}</td>
              <td style="font-size:10px;max-width:100px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(tagStr)}</td>
              <td>${escapeHtml(m.contact_person || '')}</td>
              <td>${escapeHtml(m.assignee||'')}</td>
              <td>${hasFollowups ? `<span class="followup-btn" data-id="${m.id}" style="font-size:11px;cursor:pointer;color:var(--primary);font-weight:600">${m.followups.length}条</span>` : `<span class="followup-btn" data-id="${m.id}" style="font-size:11px;cursor:pointer;color:var(--text-secondary)">备注</span>`}</td>
              <td><button class="btn-edit-contact" data-id="${m.id}" style="margin-right:4px">${lucide('pencil',13)}</button><button class="btn-delete" data-id="${m.id}">${lucide('trash-2',13)}</button></td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
      ${isArchived ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;display:flex;align-items:center;gap:8px"><span style="font-size:13px">${lucide('archive',13)} 已归档 — 不参与常规序列</span><button id="btn-reactivate-contact" style="margin-left:auto;font-size:12px;padding:4px 12px">${lucide('refresh-cw',12)} 重新激活</button></div>` : ''}
    </div>
  `;
  // 编辑按钮
  detail.querySelectorAll('.btn-edit-contact').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contact = members.find(m => m.id === btn.dataset.id);
      if (contact) showContactEditor(contact);
    });
  });

  // 跟进备注按钮
  detail.querySelectorAll('.followup-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const contact = members.find(m => m.id === id);
      if (contact) showFollowupEditor(contact);
    });
  });

  // 删除按钮（支持10分钟免提示）
  detail.querySelectorAll('.btn-delete:not(#btn-delete-company)').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let ok = (S._deleteSkipUntil || 0) > Date.now();
      if (!ok) {
        const r = await showConfirm('确定删除该联系人？', { skipText: '10分钟免提示' });
        if (!r) return;
        if (r === 'skip') S._deleteSkipUntil = Date.now() + 600000;
      }
      await window.electronAPI.deleteContact(btn.dataset.id);
      // 从内存数据中移除
      S.contactsData = S.contactsData.filter(c => c.id !== btn.dataset.id);
      // 从当前公司成员中移除
      const members = S.contactsGroupMap.get(company);
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
        S.contactsGroupMap.delete(company);
        const item = document.querySelector(`.contact-item[data-company="${escapeHtml(company)}"]`);
        if (item) item.remove();
        S.selectedContactCompany = null;
        detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
      }
    });
  });

  // 清除退信标记
  detail.querySelectorAll('.btn-clear-bounce').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.electronAPI.clearBounce(btn.dataset.email);
      await CS.refreshContacts();
      renderContactsList();
    });
  });

  // 删除公司按钮（支持10分钟免提示）
  const delCoBtn = document.getElementById('btn-delete-company');
  if (delCoBtn) {
    delCoBtn.addEventListener('click', async () => {
      let ok = (S._deleteSkipUntil || 0) > Date.now();
      if (!ok) {
        const r = await showConfirm(`确定删除「${company}」及其全部 ${members.length} 位联系人？\n此操作不可恢复。`, { skipText: '10分钟免提示' });
        if (!r) return;
        if (r === 'skip') S._deleteSkipUntil = Date.now() + 600000;
      }
      const result = await window.electronAPI.deleteCompany(company);
      showToast(`已删除 ${result.deleted} 位联系人`, 'ok');
      // 清空详情区
      S.contactsData = S.contactsData.filter(c => c.company !== company);
      S.contactsGroupMap.delete(company);
      detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
      S.selectedContactCompany = null;
      renderContactsList();
    });
  }

  // 删除全部退信联系人
  const delBouncedBtn = document.getElementById('btn-delete-bounced');
  if (delBouncedBtn) {
    delBouncedBtn.addEventListener('click', async () => {
      const allMembers = S.contactsGroupMap.get(company) || [];
      const bounced = allMembers.filter(m => (m.tags || []).includes('bounced_by_contact'));
      if (!bounced.length) { showToast('该公司无退信联系人', 'warn'); return; }
      let ok = (S._deleteSkipUntil || 0) > Date.now();
      if (!ok) {
        const r = await showConfirm(`确定删除 ${company} 的全部 ${bounced.length} 个退信联系人？`, { skipText: '10分钟免提示' });
        if (!r) return;
        if (r === 'skip') S._deleteSkipUntil = Date.now() + 600000;
      }
      for (const m of bounced) { await window.electronAPI.deleteContact(m.id); }
      await CS.refreshContacts();
      renderContactsList();
      showToast(`已删除 ${bounced.length} 个退信联系人`, 'ok');
    });
  }

  // 发起背调按钮
  const bcBtn = document.getElementById('btn-backcheck-contact');
  if (bcBtn) {
    bcBtn.addEventListener('click', async () => {
      const contact = members[0];
      if (!contact) return;
      // 检查背调筛选设置
      const cfg = await window.electronAPI.loadConfig().catch(() => ({}));
      if (cfg?.backcheck?.filterEnabled && members.length < 5) {
        showToast('该公司被背调筛选隐藏（<5位联系人），请前往设置关闭「仅显示高价值客户」', 'warn');
        return;
      }
      showToast(`正在启动 ${company} 背调...`, 'ok');
      const result = await window.electronAPI.startResearch(contact, 'deep-research');
      if (!result.ok) { showToast(result.message || '启动失败', 'err'); return; }
      CS.setDiscoverPreselect($1);
      const nav = document.querySelector('[data-page="backcheck"]');
      if (nav) nav.click();
    });
  }

  // 重新激活按钮
  const reactBtn = document.getElementById('btn-reactivate-contact');
  if (reactBtn) {
    reactBtn.addEventListener('click', async () => {
      if (!await showConfirm(`确定重新激活 ${company}？\n将重置为冷开发阶段，清空序列记录。`)) return;
      await window.electronAPI.reactivateCompany(company);
      await CS.refreshContactsSendHistory();
      renderContactsList();
    });
  }

  // 右键标签菜单（多选切换）
  const tagTable = detail.querySelector('tbody');
  if (tagTable) {
    tagTable.addEventListener('contextmenu', async (e) => {
      const row = e.target.closest('tr[data-contact-id]');
      if (!row) return;
      e.preventDefault();
      const contactId = row.dataset.contactId;
      const contact = members.find(m => m.id === contactId);
      if (!contact) return;

      document.getElementById('ctx-menu')?.remove();
      const menu = document.createElement('div');
      menu.id = 'ctx-menu';
      menu.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:180px;font-size:12px';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';

      // 当前标签，单选：只取第一个有效标签
      const currentTags = contact.tags || [];
      const currentTag = currentTags[0] || '';
      const TAG_OPTIONS = [
        { val: 'reached', label: '已触达', color: '#3b82f6' },
        { val: 'left_company', label: '已离职', color: '#d93025' },
        null, // 分隔线
        { val: 'replied', label: '有回复', color: '#22a644' },
        { val: 'autoreply', label: '自动回复', color: '#e6a817' },
        { val: 'bounced_by_contact', label: '退信', color: '#e5484d' },
      ];

      // 生成单选菜单项（手动标签 / 自动标签 分栏）
      const tagItems = TAG_OPTIONS.map(t => {
        if (!t) return `<div style="border-top:1px solid var(--border);margin:4px 0"></div>`;
        const isActive = currentTag === t.val;
        return `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:8px;color:${t.color};${isActive ? 'font-weight:600' : ''}" data-action="select" data-tag="${t.val}" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'"><span style="width:7px;height:7px;border-radius:50%;background:${t.color};flex-shrink:0"></span>${isActive ? '✓' : ''} ${t.label}</div>`;
      }).join('');

      menu.innerHTML = tagItems +
        `<div style="border-top:1px solid var(--border);margin:4px 0"></div>` +
        `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap" data-action="edit" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">编辑联系人</div>` +
        `<div style="border-top:1px solid var(--border);margin:4px 0"></div>` +
        `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap;color:var(--text-secondary)" data-action="clear" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">清除标签</div>` +
        `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap;color:#e5484d" data-action="delete" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">删除联系人</div>`;

      // 点击选中单个标签（再次点击同一标签则取消）
      menu.querySelectorAll('[data-action="select"]').forEach(item => {
        item.addEventListener('click', async () => {
          const tagVal = item.dataset.tag;
          const newTags = currentTag === tagVal ? [] : [tagVal];
          menu.remove();
          await window.electronAPI.setContactTags(contactId, newTags);
          // 更新内存
          contact.tags = newTags;
          // 刷新详情
          const newMembers = S.contactsGroupMap.get(company) || [];
          const idx = newMembers.findIndex(m => m.id === contactId);
          if (idx >= 0) { newMembers[idx].tags = newTags; }
          renderContactDetail(company);
        });
      });

      // 清除全部标签
      menu.querySelector('[data-action="clear"]').addEventListener('click', async () => {
        menu.remove();
        await window.electronAPI.setContactTags(contactId, []);
        contact.tags = [];
        const newMembers = S.contactsGroupMap.get(company) || [];
        const idx = newMembers.findIndex(m => m.id === contactId);
        if (idx >= 0) { newMembers[idx].tags = []; }
        renderContactDetail(company);
      });

      // 编辑联系人
      menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
        menu.remove();
        showContactEditor(contact);
      });

      // 删除联系人
      menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        menu.remove();
        if (!await showConfirm('确定删除该联系人？')) return;
        await window.electronAPI.deleteContact(contact.id);
        S.contactsData = S.contactsData.filter(c => c.id !== contact.id);
        const newMembers = S.contactsGroupMap.get(company) || [];
        const idx = newMembers.findIndex(m => m.id === contact.id);
        if (idx >= 0) newMembers.splice(idx, 1);
        await CS.refreshContacts();
        renderContactsList();
      });

      document.body.appendChild(menu);
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  }

    // ── 行内编辑：单击编辑、下拉切换 ────────────────────────────────────────
  const tbody = detail.querySelector('tbody');
  if (!tbody) return;

  const EDITABLE_COLS = new Set([1, 2, 3, 4, 5, 6, 8, 14, 15]);
  const SELECT_COLS = {
    7: { type: 'country', opts: ['Brazil','Mexico','Colombia','Chile','Peru','Argentina','Ecuador','Portugal','Spain','United States','China'] },
    9: { type: 'client_type', opts: ['agent','direct','unlabeled'], labels: {agent:'代理',direct:'直客',unlabeled:'通用'} },
    10: { type: 'stage', opts: ['cold','f1','f2','f3','f4'], labels: {cold:'冷开发',f1:'F1',f2:'F2',f3:'F3',f4:'F4'} },
    12: { type: 'opp_stage', opts: ['待开发','触达中','报价中','试单','合作中','已流失'] },
  };

  tbody.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const td = e.target.closest('td');
    const tr = e.target.closest('tr');
    if (!td || !tr) return;
    const cells = tr.querySelectorAll('td');
    const colIdx = Array.from(cells).indexOf(td);
    const contactId = tr.dataset.contactId;
    if (!contactId || td.querySelector('input,select')) return;

    const sel = SELECT_COLS[colIdx];
    if (sel) {
      const orig = td.textContent.trim();
      const select = document.createElement('select');
      select.style.cssText = 'width:100%;padding:1px 2px;border:1px solid var(--accent);border-radius:3px;font-size:10px;background:var(--bg);color:var(--text)';
      sel.opts.forEach((o) => {
        const opt = document.createElement('option'); opt.value = o;
        opt.textContent = sel.labels ? sel.labels[o] || o : o;
        const cur = (sel.labels ? sel.labels[o] : o);
        if (cur === orig || o === orig) opt.selected = true;
        select.appendChild(opt);
      });
      td.textContent = ''; td.appendChild(select); select.focus();
      let _selectSaved = false;
      const saveSelect = async (val) => {
        if (_selectSaved) return; _selectSaved = true;
        td.textContent = sel.labels ? sel.labels[val] || val : val;
        if (!val || val === orig) return;
        const ref = S.contactsData.find(c => c.id === contactId);
        if (!ref) return;
        if (sel.type === 'client_type') {
          const company = ref.company || ref.company_name || '';
          const members = S.contactsData.filter(c => (c.company || c.company_name) === company);
          if (members.length > 1 && !await showConfirm('「' + company + '」下 ' + members.length + ' 位联系人将全部改为「' + (sel.labels?.[val] || val) + '」？')) { td.textContent = orig; return; }
          for (const m of members) await window.electronAPI.upsertContact({ id: m.id, email: m.email, client_type: val });
        } else if (sel.type === 'country') {
          const contact = S.contactsData.find(c => c.id === contactId);
          if (contact?.company_id) await window.electronAPI.updateCompany(contact.company_id, { country: val });
        } else {
          const ref2 = S.contactsData.find(c => c.id === contactId);
          if (ref2) await window.electronAPI.upsertContact({ id: contactId, email: ref2.email, [sel.type]: val });
        }
        await CS.refreshContacts(); renderContactsList();
      };
      select.addEventListener('change', () => saveSelect(select.value));
      select.addEventListener('blur', () => { setTimeout(() => saveSelect(select.value), 100); });
      return;
    }

    if (EDITABLE_COLS.has(colIdx)) {
      const orig = td.textContent.trim();
      const input = document.createElement('input');
      input.value = orig === '—' ? '' : orig;
      input.style.cssText = 'width:100%;padding:2px 4px;border:1px solid var(--accent);border-radius:3px;font-size:11px;background:var(--bg);color:var(--text)';
      td.textContent = ''; td.appendChild(input); input.focus(); input.select();
      const saveInput = async () => {
        const val = input.value.trim(); input.remove();
        td.textContent = val || orig;
        if (val === orig) return;
        const fields = ['_','first_name','last_name','email','title','phone','linkedin','_','category','_','_','_','_','_','contact_person','assignee'];
        const field = fields[colIdx];
        if (!field || field === '_') return;
        const ref3 = S.contactsData.find(c => c.id === contactId);
        if (ref3) await window.electronAPI.upsertContact({ id: contactId, email: ref3.email, [field]: val });
        await CS.refreshContacts();
      };
      input.addEventListener('blur', saveInput);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveInput(); } if (ev.key === 'Escape') { input.remove(); td.textContent = orig; } });
    }
  });

}

// 搜索
document.getElementById('contacts-search')?.addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  S._searchQuery = q || '';
  if (!q) { renderContactsList(); return; }
  const results = await window.electronAPI.searchContacts(q);
  S.selectedContactCompany = null; // 搜索后重置选中
  renderContactsList(results);
});

// 「添加客户」→ 弹出录入框
document.getElementById('contacts-add-btn')?.addEventListener('click', () => {
  showModal({
    title: '添加联系人',
    closeOnOverlay: false,
    message: `
      <style>
        .ac-form { display:flex; flex-direction:column; gap:12px; }
        .ac-row { display:flex; gap:12px; }
        .ac-field { flex:1; display:flex; flex-direction:column; gap:3px; }
        .ac-field label { font-size:11px; font-weight:500; color:var(--text-secondary); }
        .ac-field input, .ac-field select { padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:var(--bg); color:var(--text); outline:none; }
        .ac-field input:focus, .ac-field select:focus { border-color:var(--primary); }
      </style>
      <div class="ac-form">
        <div class="ac-field"><label>公司名</label><input id="ac-company" placeholder="必填"></div>
        <div class="ac-field"><label>邮箱</label><input id="ac-email" placeholder="必填"></div>
        <div class="ac-row">
          <div class="ac-field"><label>名</label><input id="ac-firstname" placeholder="如 Julio"></div>
          <div class="ac-field"><label>姓</label><input id="ac-lastname" placeholder="如 Gallegos"></div>
        </div>
        <div class="ac-row">
          <div class="ac-field"><label>国家</label><input id="ac-country" placeholder="如 Mexico"></div>
          <div class="ac-field"><label>品类</label><input id="ac-category" placeholder="如 freight forwarder"></div>
        </div>
        <div class="ac-row">
          <div class="ac-field"><label>职位</label><input id="ac-position" placeholder="如 Manager"></div>
          <div class="ac-field"><label>电话</label><input id="ac-phone" placeholder="如 +52 555..."></div>
        </div>
        <div class="ac-row">
          <div class="ac-field"><label>类型</label><select id="ac-type"><option value="unlabeled">未标签</option><option value="agent">代理</option><option value="direct">直客</option></select></div>
        </div>
      </div>`,
    buttons: [
      { text: '取消', value: false },
      { text: '添加', value: 'ok', primary: true },
    ],
    onClose: async (val) => {
      if (val !== 'ok') return;
      const company = document.getElementById('ac-company')?.value.trim();
      const email = document.getElementById('ac-email')?.value.trim();
      if (!company || !email) { showToast('公司名和邮箱为必填', 'warn'); return false; }
      const firstName = document.getElementById('ac-firstname')?.value.trim() || '';
      const lastName = document.getElementById('ac-lastname')?.value.trim() || '';
      const contact = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        company, email,
        firstName, lastName,
        contactName: `${firstName} ${lastName}`.trim(),
        country: document.getElementById('ac-country')?.value.trim() || '',
        category: document.getElementById('ac-category')?.value.trim() || '',
        position: document.getElementById('ac-position')?.value.trim() || '',
        phone: document.getElementById('ac-phone')?.value.trim() || '',
        clientType: document.getElementById('ac-type')?.value || 'unlabeled',
        tags: [],
        addedAt: new Date().toISOString(),
      };
      await window.electronAPI.importContacts([contact]);
      await CS.refreshContacts();
      renderContactsList();
      showToast(`已添加 ${company}`, 'ok');
    },
  });
});
// ── 删除记录按钮 ──────────────────────────────────────────────────────────
document.getElementById('contacts-del-log-btn')?.addEventListener('click', async () => {
  const log = await window.electronAPI.getDeletedContactsLog();
  if (!log.length) { showToast('暂无删除记录', 'info'); return; }
  showModal({
    title: `删除记录 (${log.length}条，保留5天)`,
    message: `
      <style>.dl-table{width:100%;border-collapse:collapse;font-size:12px}.dl-table th,.dl-table td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--border)}.dl-table th{color:var(--text-secondary);font-weight:500}</style>
      <table class="dl-table"><thead><tr><th>邮箱</th><th>公司</th><th>删除时间</th></tr></thead>
      <tbody>${log.map(e => `<tr><td>${escapeHtml(e.email)}</td><td>${escapeHtml(e.company)}</td><td>${new Date(e.ts).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table>`,
    buttons: [{ text: '关闭', value: true, primary: true }],
  });
});
// ── AI 分类按钮 ──────────────────────────────────────────────────────────
document.getElementById('contacts-ai-classify-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('contacts-ai-classify-btn');
  btn.disabled = true; btn.textContent = 'AI 分类中...';
  try {
    const r = await window.electronAPI.classifyContactsAI();
    if (r.ok) { await CS.refreshContacts(); renderContactsList(); showToast(`AI 分类完成: ${r.updated} 人 / ${r.total} 家公司`, 'ok'); }
    else showToast(r.error || 'AI 分类失败', 'err');
  } catch (e) { showToast('AI 分类异常', 'err'); }
  btn.disabled = false; btn.textContent = 'AI 分类';
  renderContactsList();
});
// ── 编辑联系人弹窗 ──────────────────────────────────────────────────────────
// ── 跟进备注弹窗 ──────────────────────────────────────────────────────────
function showFollowupEditor(contact) {
  const notes = contact.followups || [];
  showModal({
    title: `跟进备注 — ${escapeHtml(contact.firstName || contact.contactName || contact.email)}`,
    closeOnOverlay: false,
    message: `
      <style>
        .fu-list { max-height:200px; overflow-y:auto; margin-bottom:12px; }
        .fu-item { padding:8px 10px; border-bottom:1px solid var(--border); font-size:12px; line-height:1.5; }
        .fu-item:last-child { border-bottom:none; }
        .fu-time { font-size:10px; color:var(--text-secondary); margin-bottom:2px; }
        .fu-input { width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:var(--bg); color:var(--text); outline:none; resize:vertical; min-height:60px; }
        .fu-input:focus { border-color:var(--primary); }
      </style>
      ${notes.length ? `<div class="fu-list">${notes.slice().reverse().map(n => `<div class="fu-item"><div class="fu-time">${new Date(n.ts).toLocaleString('zh-CN')}</div>${escapeHtml(n.text)}</div>`).join('')}</div>` : '<div style="color:var(--text-secondary);font-size:12px;margin-bottom:12px">暂无跟进记录</div>'}
      <textarea class="fu-input" id="fu-input" placeholder="输入跟进备注..."></textarea>`,
    buttons: [
      { text: '取消', value: false },
      { text: '保存', value: 'ok', primary: true },
    ],
    onClose: async (val) => {
      if (val !== 'ok') return;
      const text = document.getElementById('fu-input')?.value?.trim();
      if (!text) { showToast('内容为空', 'warn'); return false; }
      const r = await window.electronAPI.saveFollowup(contact.id, text);
      if (r.ok) {
        contact.followups = r.followups;
        renderContactDetail(contact.company);
        showToast('已保存', 'ok');
      } else {
        showToast(r.error || '保存失败', 'err');
      }
    },
  });

// 热刷新：主进程通知联系人数据变化时自动更新
window.electronAPI.onContactsChanged(() => {
  if (document.getElementById('page-contacts')?.classList.contains('active')) {
    CS.refreshContacts();
    renderContactsList();
  }
});
}
// 编辑器 Tab 切换（模块级事件委托）
// 编辑器 Tab 切换（mousedown 避免被 modal 按钮处理拦截）
document.addEventListener('mousedown', (e) => {
  const tab = e.target.closest('.ec-tab');
  if (!tab) return;
  const tabs = tab.parentElement;
  if (!tabs?.classList.contains('ec-tabs')) return;
  e.preventDefault();
  tabs.querySelectorAll('.ec-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  const form = tabs.parentElement;
  form.querySelectorAll('.ec-panel').forEach(p => p.classList.remove('active'));
  const panel = form.querySelector('[data-panel="' + tab.dataset.tab + '"]');
  if (panel) panel.classList.add('active');
});

window.__pageHandlers['contacts'] = loadContacts;
window.__pageHandlers['clients'] = renderClientsTable;

function showContactEditor(contact) {
  showModal({
    title: '编辑联系人',
    closeOnOverlay: false,
    message: `
      <style>
        .modal-card { max-height:85vh; width:460px; }
        .modal-body { overflow-y:auto; min-height:240px; }
        .ec-form { display:flex; flex-direction:column; gap:10px; position:relative; min-height:260px; }
        .ec-field input, .ec-field select { width:100%; box-sizing:border-box; }
        .ec-tabs { display:flex; gap:0; border-bottom:1px solid var(--border); margin-bottom:12px; }
        .ec-tab { padding:7px 14px; font-size:12px; cursor:pointer; user-select:none; background:transparent; color:var(--text-secondary); border-bottom:2px solid transparent; transition:color .15s,border-color .15s; display:inline-block; }
        .ec-tab.active { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
        .ec-panel { position:absolute; visibility:hidden; flex-direction:column; gap:10px; width:100%; }
        .ec-panel.active { position:relative; visibility:visible; }
        .ec-row { display:flex; gap:10px; }
        .ec-field { flex:1; display:flex; flex-direction:column; gap:3px; }
        .ec-field label { font-size:11px; font-weight:500; color:var(--text-secondary); }
        .ec-field input, .ec-field select { padding:7px 10px; border:1px solid var(--border); border-radius:6px; font-size:12px; background:var(--bg); color:var(--text); outline:none; }
        .ec-field input:focus, .ec-field select:focus { border-color:var(--primary); }
      </style>
      <div class="ec-tabs">
        <span class="ec-tab active" data-tab="basic">基本信息</span>
        <span class="ec-tab" data-tab="contact">联系</span>
        <span class="ec-tab" data-tab="tracking">客户去向</span>
        <span class="ec-tab" data-tab="status">状态</span>
      </div>
      <div class="ec-form">
        <div class="ec-panel active" data-panel="basic">
          <div class="ec-row">
            <div class="ec-field"><label>名</label><input id="ec-firstname" value="${escapeHtml(contact.firstName || '')}"></div>
            <div class="ec-field"><label>姓</label><input id="ec-lastname" value="${escapeHtml(contact.lastName || '')}"></div>
          </div>
          <div class="ec-field"><label>邮箱</label><input id="ec-email" value="${escapeHtml(contact.email || '')}"></div>
          <div class="ec-field"><label>公司</label><input id="ec-company" value="${escapeHtml(contact.company || contact.company_name || '')}"></div>
          <div class="ec-row">
            <div class="ec-field"><label>国家</label><input id="ec-country" value="${escapeHtml(contact.country || '')}"></div>
            <div class="ec-field"><label>品类</label><input id="ec-category" value="${escapeHtml(contact.category || '')}"></div>
          </div>
          <div class="ec-field"><label>网站</label><input id="ec-website" value="${escapeHtml(contact.website || contact.company_website || '')}"></div>
        </div>
        <div class="ec-panel" data-panel="contact">
          <div class="ec-row">
            <div class="ec-field"><label>职位</label><input id="ec-position" value="${escapeHtml(contact.position || contact.title || '')}"></div>
            <div class="ec-field"><label>电话</label><input id="ec-phone" value="${escapeHtml(contact.phone || '')}"></div>
          </div>
          <div class="ec-field"><label>领英</label><input id="ec-linkedin" value="${escapeHtml(contact.linkedin || '')}"></div>
        </div>
        <div class="ec-panel" data-panel="tracking">
          <div class="ec-field"><label>对接人</label><input id="ec-contact-person" value="${escapeHtml(contact.contact_person || '')}" placeholder="对方公司的联系人"></div>
          <div class="ec-field"><label>跟进人</label><input id="ec-assignee" value="${escapeHtml(contact.assignee || '')}" placeholder="我方跟进人员"></div>
        </div>
        <div class="ec-panel" data-panel="status">
          <div class="ec-row">
            <div class="ec-field"><label>客户类型</label><select id="ec-client-type">
              <option value="unlabeled" ${contact.clientType === 'unlabeled' ? 'selected' : ''}>未标签</option>
              <option value="agent" ${contact.clientType === 'agent' ? 'selected' : ''}>代理</option>
              <option value="direct" ${contact.clientType === 'direct' ? 'selected' : ''}>直客</option>
            </select></div>
            <div class="ec-field"><label>阶段</label><select id="ec-stage">
              <option value="cold" ${(contact.stage || contact._stage) === 'cold' ? 'selected' : ''}>冷开发</option>
              <option value="f1" ${(contact.stage || contact._stage) === 'f1' ? 'selected' : ''}>F1</option>
              <option value="f2" ${(contact.stage || contact._stage) === 'f2' ? 'selected' : ''}>F2</option>
              <option value="f3" ${(contact.stage || contact._stage) === 'f3' ? 'selected' : ''}>F3</option>
              <option value="f4" ${(contact.stage || contact._stage) === 'f4' ? 'selected' : ''}>F4</option>
            </select></div>
          </div>
          <div class="ec-field"><label>机会阶段</label><select id="ec-opp-stage">
            <option value="待开发" ${(contact.opp_stage || '待开发') === '待开发' ? 'selected' : ''}>待开发</option>
            <option value="触达中" ${contact.opp_stage === '触达中' ? 'selected' : ''}>触达中</option>
            <option value="报价中" ${contact.opp_stage === '报价中' ? 'selected' : ''}>报价中</option>
            <option value="试单" ${contact.opp_stage === '试单' ? 'selected' : ''}>试单</option>
            <option value="合作中" ${contact.opp_stage === '合作中' ? 'selected' : ''}>合作中</option>
            <option value="已流失" ${contact.opp_stage === '已流失' ? 'selected' : ''}>已流失</option>
          </select></div>
          <div class="ec-field"><label>跟进备注</label><input id="ec-followup" value="${escapeHtml(contact.followup_note || contact.followupNote || '')}"></div>
        </div>
      </div>`,
    buttons: [
      { text: '取消', value: false },
      { text: '保存', value: 'ok', primary: true },
    ],
    onClose: async (val) => {
      if (val !== 'ok') return;
      const updated = {
        id: contact.id,
        company: document.getElementById('ec-company')?.value?.trim() || contact.company,
        email: document.getElementById('ec-email')?.value?.trim() || contact.email,
        firstName: document.getElementById('ec-firstname')?.value?.trim() || '',
        lastName: document.getElementById('ec-lastname')?.value?.trim() || '',
        country: document.getElementById('ec-country')?.value?.trim() || '',
        website: document.getElementById('ec-website')?.value?.trim() || '',
        category: document.getElementById('ec-category')?.value?.trim() || '',
        position: document.getElementById('ec-position')?.value?.trim() || '',
        phone: document.getElementById('ec-phone')?.value?.trim() || '',
        linkedin: document.getElementById('ec-linkedin')?.value?.trim() || '',
        clientType: document.getElementById('ec-client-type')?.value || 'unlabeled',
        stage: document.getElementById('ec-stage')?.value || 'cold',
        opp_stage: document.getElementById('ec-opp-stage')?.value || '待开发',
        contact_person: document.getElementById('ec-contact-person')?.value?.trim() || '',
        assignee: document.getElementById('ec-assignee')?.value?.trim() || '',
        followup_note: document.getElementById('ec-followup')?.value?.trim() || '',
        tags: contact.tags,
      };
      await window.electronAPI.upsertContact(updated);
      await CS.refreshContacts();
      renderContactsList();
      showToast('已保存', 'ok');
    },
  });
}
