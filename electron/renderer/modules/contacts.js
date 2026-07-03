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
  S.clientsData = result.clients;
  S.clientsPage = 1;
  let msg = `成功导入 ${S.clientsData.length} 条记录`;
  if (result.invalidEmails?.length) {
    const list = result.invalidEmails.slice(0, 10).map(e => `· ${e.company} → ${e.email}`).join('\n');
    const more = result.invalidEmails.length > 10 ? `\n...等共 ${result.invalidEmails.length} 个` : '';
    msg += `\n\n⚠️ ${result.invalidEmails.length} 个邮箱格式异常：\n${list}${more}`;
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
      S.clientsData = result.clients;
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
    document.querySelectorAll('#contacts-filter .cf-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        S.contactsFilter = tab.dataset.filter;
        S.selectedContactCompany = null;
        renderContactsList();
      });
    });
  }
  renderContactsList();
}

// clientTypeTag / groupByCompany 从 shared.js 导入

export function renderContactsList(filtered) {
  let data = filtered || S.contactsData;

  // 应用类型筛选
  if (S.contactsFilter === 'archived') {
    data = data.filter(c => S.contactsSendHistory[c.company]?.stage === 'archived');
  } else if (S.contactsFilter === 'suspicious') {
    data = data.filter(c => c._suspicious === true);
  } else if (S.contactsFilter === 'sent') {
    data = data.filter(c => !!c._sentBy);
  } else if (S.contactsFilter === 'unsent') {
    data = data.filter(c => !c._sentBy);
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

  // 更新筛选标签（即使列表为空也保持可见，确保用户能切回）
  const tabs = filterBar?.querySelectorAll('.cf-tab');
  if (tabs) {
    const labelMap = {
      all: `全部 ${seenCompanies.size}`,
      agent: `${lucide('globe',13)} 代理 ${counts.agent}`,
      direct: `${lucide('building',13)} 直客 ${counts.direct}`,
      unlabeled: `${lucide('help-circle',13)} 未标签 ${counts.unlabeled}`,
      suspicious: `${lucide("alert-circle",13)} 待确认 ${S.contactsData.filter(c => c._suspicious).length}`,
      archived: `${lucide("archive",13)} 已归档 ${Object.values(S.contactsSendHistory).filter(h => h?.stage === "archived").length}`,
    };
    tabs.forEach(tab => {
      const f = tab.dataset.filter;
      tab.innerHTML = labelMap[f] || f;
      tab.classList.toggle('active', S.contactsFilter === f);
    });
  }

  if (!data.length) {
    if (empty) { empty.style.display = 'block'; empty.textContent = S.contactsFilter === 'archived' ? '暂无已归档客户' : S.contactsFilter === 'suspicious' ? '暂无待确认公司' : S.contactsFilter === 'sent' ? '暂无已发送联系人 — 发送完成后自动标记' : S.contactsFilter === 'unsent' ? '全部已发送' : S.contactsFilter !== 'all' ? '该分类暂无联系人' : '暂无联系人 — 从「导入客户」导入'; }
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

  // 统计
  const vipCount = groups.filter(g => g[1].length >= 5).length;
  if (statsBar) {
    statsBar.style.display = 'block';
    statsBar.textContent = `${data.length} 位联系人 · ${groups.length} 家公司 · ${vipCount} 家可定制客户`;
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

    // 如果之前有选中，恢复选中状态；否则自动选第一个
    if (S.selectedContactCompany && S.contactsGroupMap.has(S.selectedContactCompany)) {
      renderContactDetail(S.selectedContactCompany);
    } else {
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
  const members = S.contactsGroupMap.get(company) || [];
  const ctype = members[0]?.clientType || 'unlabeled';
  const hist = S.contactsSendHistory[company];
  const isArchived = hist?.stage === 'archived';
  detail.innerHTML = `
    <div class="contacts-detail-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>${escapeHtml(company)} · ${members.length} 位联系人 ${clientTypeTag(ctype)}</span>
      <button id="btn-delete-company" class="btn-delete">${lucide('trash-2',14)}</button>
      <button id="btn-backcheck-contact" class="secondary" style="font-size:11px;padding:3px 10px;margin-left:auto">背调</button>
    </div>
    <div class="contacts-detail-body">
      <table>
        <thead><tr><th>国家</th><th>品类</th><th>姓名</th><th>邮箱</th><th>发信账号</th><th>状态</th><th>标签</th><th>操作</th></tr></thead>
        <tbody>
          ${members.map(m => {
            // 兼容旧 tag 字段：tags 数组优先，回退到单值 tag
	            const contactTags = m.tags || [];
	            const TAG_DISPLAY = {
	              autoreply: { label: '自动回复', color: '#e6a817' },
	              reached: { label: '已触达', color: '#22a644' },
	              replied: { label: '有回复', color: '#3b82f6' },
	              bounced_by_contact: { label: '退回', color: '#8b8b8b' },
	              auto_reply: { label: '自动回复', color: '#e6a817' },
		              left_company: { label: '已离职', color: '#d93025' },
	            };
	            // ── 状态列（优先级取最高）────────────────────────────────────
            const STATUS_PRIORITY = ['left_company','bounced_by_contact','replied','autoreply','auto_reply','reached'];
            const topTag = STATUS_PRIORITY.find(t => contactTags.includes(t));
            const STATUS_MAP = {
              left_company: { label: '已离职', dot: '#d93025' },
              bounced_by_contact: { label: '退信', dot: '#8b8b8b' },
              replied: { label: '有回复', dot: '#3b82f6' },
              autoreply: { label: '自动回复', dot: '#e6a817' },
              auto_reply: { label: '自动回复', dot: '#e6a817' },
              reached: { label: '已触达', dot: '#22a644' },
            };
            const st = STATUS_MAP[topTag] || { label: '未触达', dot: 'var(--text-secondary)' };
            const statusHtml = `<span style="font-size:11px;display:flex;align-items:center;gap:5px;white-space:nowrap"><span style="width:7px;height:7px;border-radius:50%;background:${st.dot};flex-shrink:0"></span>${st.label}</span>`;
            const tagsHtml = contactTags.length
	              ? contactTags.map(t => {
	                  const info = TAG_DISPLAY[t] || { label: t, color: 'var(--text-secondary)' };
	                  return `<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:${info.color}18;color:${info.color};white-space:nowrap" title="右键切换标签">${info.label}</span>`;
	                }).join(' ')
	              : `<span style="font-size:10px;color:var(--text-secondary)">—</span>`;
            const nameDisplay = (m.firstName || m.lastName) ? `${m.firstName || ''} ${m.lastName || ''}`.trim() : (m.contactName || '—');
            return `
            <tr data-contact-id="${m.id}" style="${m.bounced ? 'opacity:.5' : ''}">
              <td>${escapeHtml(m.country)}</td>
              <td>${escapeHtml(m.category)}</td>
              <td>${escapeHtml(nameDisplay)}</td>
              <td>${escapeHtml(m.email)}</td>
              <td style="font-size:11px;color:var(--text-secondary)">${m._sentAccount ? escapeHtml(m._sentAccount) + ' · ' + (m._sentAt||'').slice(0,10) : '—'}</td>
              <td>${statusHtml}</td>
              <td>${tagsHtml}</td>
              <td><button class="btn-delete" data-id="${m.id}">${lucide('trash-2',13)}</button></td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
      ${isArchived ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;display:flex;align-items:center;gap:8px"><span style="font-size:13px">${lucide('archive',13)} 已归档 — 不参与常规序列</span><button id="btn-reactivate-contact" style="margin-left:auto;font-size:12px;padding:4px 12px">${lucide('refresh-cw',12)} 重新激活</button></div>` : ''}
    </div>
  `;

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
        { val: 'autoreply', label: '自动回复', color: '#e6a817' },
        { val: 'replied', label: '有回复', color: '#3b82f6' },
        { val: 'reached', label: '已触达', color: '#22a644' },
      ];

      // 生成单选菜单项
      const tagItems = TAG_OPTIONS.map(t => {
        const isActive = currentTag === t.val;
        const check = isActive ? '✓' : '';
        return `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:8px;color:${t.color};${isActive ? 'font-weight:600' : ''}" data-action="select" data-tag="${t.val}" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">${check} ${t.label}</div>`;
      }).join('');

      menu.innerHTML = tagItems +
        `<div style="border-top:1px solid var(--border);margin:4px 0"></div>` +
        `<div style="padding:6px 14px;cursor:pointer;white-space:nowrap;color:var(--text-secondary)" data-action="clear" onmouseenter="this.style.background='var(--border)'" onmouseleave="this.style.background='transparent'">清除标签</div>`;

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

      document.body.appendChild(menu);
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  }
}


// 搜索
document.getElementById('contacts-search')?.addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (!q) { renderContactsList(); return; }
  const results = await window.electronAPI.searchContacts(q);
  S.selectedContactCompany = null; // 搜索后重置选中
  renderContactsList(results);
});

// 「添加客户」→ 弹出录入框
document.getElementById('contacts-add-btn')?.addEventListener('click', () => {
  showModal({
    title: '添加联系人',
    type: 'info',
    message: `<div style="display:flex;flex-direction:column;gap:8px">
        <style>
          #ac-company,#ac-email,#ac-country,#ac-category,#ac-firstname,#ac-lastname,#ac-type{width:100%;box-sizing:border-box;font-size:12px;padding:7px 10px;border:1px solid #e0e0e0;border-radius:8px;outline:none;background:#fafafa;transition:border-color .15s}
          #ac-company:focus,#ac-email:focus,#ac-country:focus,#ac-category:focus,#ac-firstname:focus,#ac-lastname:focus,#ac-type:focus{border-color:var(--primary);background:#fff}
        </style>
        <div><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">公司名</label><input id="ac-company" placeholder="必填"></div>
        <div><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">邮箱</label><input id="ac-email" placeholder="必填"></div>
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">国家</label><input id="ac-country" placeholder="如 Mexico"></div>
          <div style="flex:1"><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">品类</label><input id="ac-category" placeholder="如 freight forwarder"></div>
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">名</label><input id="ac-firstname" placeholder="如 Julio"></div>
          <div style="flex:1"><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">姓</label><input id="ac-lastname" placeholder="如 Gallegos"></div>
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label style="display:block;font-size:10px;color:#999;margin-bottom:2px;font-weight:500">类型</label><select id="ac-type"><option value="unlabeled">未标签</option><option value="agent">代理</option><option value="direct">直客</option></select></div>
        </div>
      </div>`,
    buttons: [
      { text: '取消', value: false },
      { text: '确定添加', value: 'ok', primary: true },
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
        clientType: document.getElementById('ac-type')?.value || 'unlabeled',
        addedAt: new Date().toISOString(),
      };
      await window.electronAPI.importContacts([contact]);
      await CS.refreshContacts();
      renderContactsList();
      showToast(`已添加 ${company}`, 'ok');
    },
  });
});
// ── AI 分类按钮 ──────────────────────────────────────────────────────────
document.getElementById('contacts-ai-classify-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('contacts-ai-classify-btn');
  btn.disabled = true; btn.textContent = 'AI 分类中...';
  try {
    const r = await window.electronAPI.classifyContactsAI();
    if (r.ok) { await CS.refreshContacts(); renderContactsList(); showToast(`AI 分类完成: ${r.updated}/${r.total} 个重新分类`, 'ok'); }
    else showToast(r.error || 'AI 分类失败', 'err');
  } catch (e) { showToast('AI 分类异常', 'err'); }
  btn.disabled = false; btn.textContent = 'AI 分类';
  renderContactsList();
});
window.__pageHandlers['contacts'] = loadContacts;
window.__pageHandlers['clients'] = renderClientsTable;
