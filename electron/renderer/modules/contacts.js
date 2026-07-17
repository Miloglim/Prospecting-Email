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
  S.clientsExtraCols = result.unrecognizedCols || [];
  S.clientsPage = 1;
  if (fileInput) fileInput.value = ''; // 重置 input，允许重复导入同一文件
  const valid = S.clientsData.length;
  const flow = [];
  if (result.totalEmailsInSheet != null) flow.push(`<b>${result.totalEmailsInSheet}</b> 个邮箱`);
  if (result.noCompanyCount > 0) flow.push(`<span style="color:#e65100">${result.noCompanyCount} 无公司名</span>`);
  if (result.noEmailCount > 0) flow.push(`<span style="color:#e65100">-${result.noEmailCount} 无邮箱</span>`);
  if (result.splitCount > 0) flow.push(`<span style="color:#22a644">+${result.splitCount} 拆分</span>`);
  const flowHtml = flow.length ? `<div style="font-size:12px;color:#888;margin-bottom:8px">${flow.join(' &nbsp;→&nbsp; ')}</div>` : '';
  const items = [];
  if (result.noEmailCount > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e65100">${lucide('mail',14)} ${result.noEmailCount} 条无邮箱 — 保存后标为「待补邮箱」</div>`);
  if (result.noCompanyCount > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#888">${lucide('building',14)} ${result.noCompanyCount} 条无公司名 — 标为「未命名公司」</div>`);
  if (result.splitCount > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#22a644">${lucide('scissors',14)} ${result.splitCount} 个多邮箱单元格已自动拆分</div>`);
  if (result.invalidEmails?.length) {
    const list = result.invalidEmails.slice(0, 8).map(e => `<div style="font-size:11px;padding:2px 0">${escapeHtml(e.company)} → ${escapeHtml(e.email)}</div>`).join('');
    const more = result.invalidEmails.length > 8 ? `<div style="font-size:11px;color:#888">...等共 ${result.invalidEmails.length} 个</div>` : '';
    items.push(`<div style="margin-top:4px"><div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e5484d;margin-bottom:4px">${lucide('alert-triangle',14)} ${result.invalidEmails.length} 个邮箱格式异常</div><div style="margin-left:22px;max-height:120px;overflow-y:auto;color:#666">${list}${more}</div></div>`);
  }
  if (result.unrecognizedCols?.length) {
    items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#999;margin-top:4px">${lucide('search',14)} 未识别的列：${result.unrecognizedCols.map(c => escapeHtml(c)).join('、')}</div>`);
  }
  const itemsHtml = items.length ? `<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">${items.join('')}</div>` : '';
  const msg = `<div style="text-align:center;margin-bottom:4px"><b style="font-size:16px;color:#22a644">${lucide('check-circle',18)} ${valid} 条</b></div>${flowHtml}${itemsHtml}`;
  await showAlert(msg);
  renderClientsTable();
}

const KNOWN_FIELDS = [
  { key: 'company', label: '公司名' },
  { key: 'firstName', label: '名' },
  { key: 'lastName', label: '姓' },
  { key: 'contactName', label: '联系人' },
  { key: 'email', label: '邮箱' },
  { key: 'country', label: '国家' },
  { key: 'category', label: '品类' },
  { key: 'website', label: '网站' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'position', label: '职位' },
  { key: 'phone', label: '电话' },
  { key: 'assignee', label: '跟进人' },
  { key: 'contactPerson', label: '对接人' },
  { key: 'stage', label: '阶段' },
  { key: 'clientType', label: '类型' },
];

export function renderClientsTable() {
  const table = document.getElementById('clients-table');
  const tbody = table?.querySelector('tbody');
  const theadRow = table?.querySelector('thead tr');
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

  // 检测哪些已知字段有实际数据（company/email 始终显示）
  const CORE_KEYS = new Set(['company', 'email']);
  const dataCols = KNOWN_FIELDS.filter(f => {
    if (CORE_KEYS.has(f.key)) return true;
    return S.clientsData.some(c => c[f.key] && String(c[f.key]).trim());
  });
  const extraCols = S.clientsExtraCols || [];
  // 合并列顺序：已知字段 + 未识别字段
  const allCols = [
    ...dataCols.map(f => ({ ...f, isExtra: false })),
    ...extraCols.map(col => ({ key: col, label: col, isExtra: true })),
  ];

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = '';
  if (toolbar) toolbar.style.display = 'flex';
  if (count) count.textContent = `共 ${S.clientsData.length} 条记录（第 ${S.clientsPage}/${Math.ceil(S.clientsData.length / S.PAGE_SIZE)} 页）`;

  // 动态表头（最后一列留给删除按钮）
  if (theadRow) {
    theadRow.innerHTML = '<th>#</th>' + allCols.map(col => {
      const extraStyle = col.isExtra ? 'color:#999;font-weight:400' : '';
      return `<th style="white-space:nowrap;${extraStyle}">${escapeHtml(col.label)}</th>`;
    }).join('') + '<th style="width:30px"></th>';
  }

  // 异常联系人置顶排序
  const sorted = [...S.clientsData].sort((a, b) => {
    const aBad = (a._emailStatus === 'no_email' || a._emailStatus === 'invalid_email' || a._noCompany) ? 1 : 0;
    const bBad = (b._emailStatus === 'no_email' || b._emailStatus === 'invalid_email' || b._noCompany) ? 1 : 0;
    return bBad - aBad;
  });

  // 分页切片
  const start = (S.clientsPage - 1) * S.PAGE_SIZE;
  const pageData = sorted.slice(start, start + S.PAGE_SIZE);

  if (tbody) {
    tbody.innerHTML = pageData.map((c, i) => {
      const cells = allCols.map(col => {
        const val = col.isExtra
          ? ((c._extra && c._extra[col.key]) || '')
          : (c[col.key] || '');
        const extraStyle = col.isExtra ? 'color:#aaa;font-size:0.9em' : '';
        return `<td style="white-space:nowrap;${extraStyle}">${escapeHtml(String(val))}</td>`;
      }).join('');
      // 异常行高亮 + 删除按钮
      let rowStyle = '', delBtn = '';
      const isBad = c._emailStatus === 'no_email' || c._emailStatus === 'invalid_email' || c._noCompany;
      if (c._emailStatus === 'no_email') rowStyle = 'background:#fff8e1';
      else if (c._emailStatus === 'invalid_email') rowStyle = 'background:#fce4ec';
      else if (c._noCompany) rowStyle = 'background:#fce4ec';
      if (isBad) {
        const globalIdx = sorted.indexOf(c);
        delBtn = `<td><button class="del-bad-row" data-idx="${globalIdx}" style="background:none;border:none;color:#c62828;cursor:pointer;font-size:14px;padding:0 4px;line-height:1" title="移除此行">✕</button></td>`;
      } else {
        delBtn = '<td></td>';
      }
      return `<tr${rowStyle ? ` style="${rowStyle}"` : ''}><td>${start + i + 1}</td>${cells}${delBtn}</tr>`;
    }).join('');

    // 异常行删除按钮事件
    tbody.querySelectorAll('.del-bad-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = sorted[parseInt(btn.dataset.idx)]; // 按排序后位置找回原始对象
        const realIdx = S.clientsData.indexOf(c);
        if (realIdx >= 0) {
          S.clientsData.splice(realIdx, 1);
          renderClientsTable();
        }
      });
    });
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
  const items = [];
  items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#22a644">${lucide('user-plus',16)} <b>${result.added}</b> 位新增</div>`);
  if (result.updated > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#888">${lucide('refresh-cw',14)} ${result.updated} 条表内重复（已合并）</div>`);
  if (result.skipped > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e65100">${lucide('alert-circle',14)} ${result.skipped} 条无邮箱跳过</div>`);
  if (result.noEmailImported > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e65100">${lucide('mail',14)} ${result.noEmailImported} 条标为「待补邮箱」</div>`);
  if (result.writeFailed > 0) items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e5484d">${lucide('x-circle',14)} ${result.writeFailed} 条写入失败</div>`);
  if (result.invalidEmail > 0) {
    const list = (result.invalidEmails || []).slice(0, 5).map(e => `<div style="font-size:11px;padding:1px 0">${escapeHtml(e.company)} → ${escapeHtml(e.email)}</div>`).join('');
    const more = result.invalidEmail > 5 ? `<div style="font-size:11px;color:#888">...等共 ${result.invalidEmail} 个</div>` : '';
    items.push(`<div style="margin-top:4px"><div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e5484d;margin-bottom:2px">${lucide('alert-triangle',14)} ${result.invalidEmail} 个格式异常</div><div style="margin-left:22px;color:#666">${list}${more}</div></div>`);
  }
  const msg = `<div style="text-align:center;margin-bottom:6px"><b style="font-size:16px">${lucide('database',18)} 总计 ${result.total} 位联系人</b></div>${items.join('')}`;
  await showAlert(msg);
  // 导入成功后清除预览
  S.clientsData = [];
  S.clientsExtraCols = [];
  S.clientsPage = 1;
  if (fileInput) fileInput.value = '';
  renderClientsTable();
});

// 「清除」
document.getElementById('clients-clear-btn')?.addEventListener('click', () => {
  S.clientsData = [];
  S.clientsExtraCols = [];
  S.clientsPage = 1;
  if (fileInput) fileInput.value = '';
  renderClientsTable();
});

// 主进程通知清空 → 同步清理渲染进程缓存
window.electronAPI?.onContactsCleared?.((_) => {
  S.contactsData = [];
  S.contactsGroupMap = new Map();
  S.sendCompanies = {};
  S.sendHistory = {};
  try { localStorage.removeItem('inbox-viewed'); } catch { /* 降级 */ }
  try { localStorage.removeItem('send-queue'); } catch { /* 降级 */ }
  S.contactsFilter = 'all';
  S.selectedContactCompany = null;
  renderContactsList();
});

// ===== 联系人 ========================================================

export async function loadContacts() {
  await CS.syncContactsUI();
  // 诊断：打印分类统计
  const diag = { agent: 0, direct: 0, unlabeled: 0, no_email: 0, invalid_email: 0, noField: 0 };
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
  // ponytail: 保留搜索状态 — 搜索框有值时自动过滤，保持 filtered 模式避免自动选中
  const si = document.getElementById('contacts-search');
  if (!filtered && si && si.value.trim()) {
    const q = si.value.trim().toLowerCase();
    S._searchQuery = q;
    filtered = S.contactsData.filter(c => (c.company || '').toLowerCase().includes(q));
  } else if (!filtered) {
    S._searchQuery = '';
  }
  let data = filtered || S.contactsData;

  // 应用筛选
  if (S.contactsFilter === 'archived') {
    data = data.filter(c => S.contactsSendHistory[c.company]?.stage === 'archived');
  } else if (S.contactsFilter === 'anomaly') {
    data = data.filter(c => c._suspicious === 1 || (c.email && (c.email.endsWith('@no.email') || c.email.endsWith('@placeholder.local') || !S.EMAIL_RE.test(c.email))));
  } else if (S.contactsFilter === 'has_phone') {
    data = data.filter(c => c.phone && c.phone.trim());
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
  const counts = { agent: 0, direct: 0, unlabeled: 0, no_email: 0, invalid_email: 0 };
  let anomalyCount = 0;
  const seenCompanies = new Set();
  for (const c of S.contactsData) {
    const key = c.company;
    const ct = c.clientType || 'unlabeled';
    if (!seenCompanies.has(key)) {
      seenCompanies.add(key);
      counts[ct] = (counts[ct] || 0) + 1;
    }
    if (ct === 'no_email' || ct === 'invalid_email' || ct === 'no_company') anomalyCount++;
  }

  // 更新筛选标签
  _updateFilterTabs(seenCompanies.size, counts);

  if (!data.length) {
    if (empty) { empty.style.display = 'block'; empty.textContent = S.contactsFilter === 'archived' ? '暂无已归档客户' : S.contactsFilter === 'anomaly' ? '🎉 没有异常联系人' : S.contactsFilter?.startsWith('tag:') ? '该标签暂无联系人' : S.contactsFilter !== 'all' ? '该分类暂无联系人' : '暂无联系人 — 从「导入客户」导入'; }
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
    const noEmailCount = S.contactsData.filter(c => (c.email || '').endsWith('@no.email')).length;
    statsBar.textContent = `${S.contactsData.length} 位联系人（${noEmailCount} 无邮箱） · ${allGroups.length} 家公司 · ${vipCount} 家可定制客户`;
  }

  // 左侧公司列表
  if (sidebar) {
    // 把 groups 暂存到 sidebar 上，供事件委托读取
    sidebar._groups = groups;
    sidebar.innerHTML = groups.map(([company, members], i) => {
      const ctype = members[0]?.clientType || 'unlabeled';
      const tagHtml = clientTypeTag(ctype);
      const ctry = escapeHtml(members[0]?.country || '');
      const hist = S.contactsSendHistory[company];
      const stageLabel = hist?.stage ? `<span class="ci-stage-badge ci-stage-${hist.stage}">${S.STAGE_LABELS_SEND[hist.stage] || hist.stage.toUpperCase()}</span>` : '';
      const vipClass = members.length >= 5 ? ' ci-vip' : '';
      const subParts = [tagHtml, ctry, stageLabel].filter(Boolean);
      return `
      <div class="contact-item${S.selectedContactCompany === company ? ' active' : ''}" data-idx="${i}">
        <div class="ci-main">
          <span class="ci-name${vipClass}">${escapeHtml(company)}</span>
          <span class="ci-count">${members.length}</span>
        </div>
        <div class="ci-sub">${subParts.join(' · ')}</div>
      </div>`;
    }).join('');

    // 设 dataset 供 CSS 选择器查询（事件委托不依赖此属性）
    sidebar.querySelectorAll('.contact-item').forEach((item, i) => {
      if (groups[i]) item.dataset.company = groups[i][0];
    });

    // ponytail: 事件委托 — 绑一次，永不因 DOM 重建失效
    if (!sidebar._delegated) {
      sidebar._delegated = true;
      sidebar.addEventListener('click', (e) => {
        const item = e.target.closest('.contact-item');
        if (!item) return;
        const idx = parseInt(item.dataset.idx);
        const groups = sidebar._groups || [];
        const company = groups[idx] ? groups[idx][0] : '';
        if (!company) return;
        sidebar.querySelectorAll('.contact-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        S.selectedContactCompany = company;
        try { renderContactDetail(company); } catch (err) {
          console.error('renderContactDetail 崩溃:', err);
          const detail = document.getElementById('contacts-detail');
          if (detail) detail.innerHTML = `<p style="color:#e5484d;padding:12px">渲染失败: ${escapeHtml(err.message)}<br><span style="font-size:10px;color:#999">${escapeHtml(err.stack||'')}</span></p>`;
        }
      });

      // 右键菜单：删除公司
      sidebar.addEventListener('contextmenu', async (e) => {
        const item = e.target.closest('.contact-item');
        if (!item) return;
        e.preventDefault();
        const idx = parseInt(item.dataset.idx);
        const groups = sidebar._groups || [];
        const company = groups[idx] ? groups[idx][0] : '';
        if (!company) return;
        const members = groups[idx] ? groups[idx][1] : [];

        document.getElementById('ctx-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'ctx-menu';
        menu.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px 0;min-width:160px;font-size:12px';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.innerHTML = `
          <div style="padding:6px 14px;cursor:pointer;color:#e5484d;display:flex;align-items:center;gap:6px" data-action="delete" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'">${lucide('trash-2',13)} 删除公司（${members.length} 人）</div>
        `;
        menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          menu.remove();
          if (!await showConfirm(`确定删除「${company}」及其全部 ${members.length} 位联系人？\n此操作不可恢复。`)) return;
          const result = await window.electronAPI.deleteCompany(company);
          showToast(`已删除 ${result.deleted} 位联系人`, 'ok');
          S.contactsData = S.contactsData.filter(c => c.company !== company);
          S.contactsGroupMap.delete(company);
          if (S.selectedContactCompany === company) {
            S.selectedContactCompany = null;
            const detail = document.getElementById('contacts-detail');
            if (detail) detail.innerHTML = '<p style="color:var(--text-secondary);padding:12px">选择左侧公司查看详情</p>';
          }
          renderContactsList();
        });
        document.body.appendChild(menu);
        const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
        setTimeout(() => document.addEventListener('click', close), 0);
      });
    }

    

// 通过公司名查找侧边栏项（基于 _groups 索引，避免 HTML 属性编码问题）
    const _findItem = (companyName) => {
      const idx = (sidebar._groups || []).findIndex(g => g[0] === companyName);
      if (idx < 0) return null;
      return sidebar.querySelector(`.contact-item[data-idx="${idx}"]`);
    };

// 搜索结果只有一家公司时自动展开，方便查看
    if (filtered && groups.length === 1) {
      S.selectedContactCompany = groups[0][0];
      const item = _findItem(S.selectedContactCompany);
      if (item) item.classList.add('active');
      renderContactDetail(S.selectedContactCompany);
    } else if (S.selectedContactCompany && S.contactsGroupMap.has(S.selectedContactCompany)) {
      renderContactDetail(S.selectedContactCompany);
    } else if (!filtered) {
      S.selectedContactCompany = groups[0]?.[0] || null;
      if (S.selectedContactCompany) {
        const firstItem = _findItem(S.selectedContactCompany);
        if (firstItem) firstItem.classList.add('active');
        renderContactDetail(S.selectedContactCompany);
      }
    }
  }
}

// ── 列宽拖拽 + localStorage 记忆 ──────────────────────────────────────
function enableColResize(table, storageKey) {
  if (!table || table.dataset.resizeReady) return;
  table.dataset.resizeReady = '1';
  const cols = table.querySelectorAll('thead th');
  if (!cols.length) return;

  // 读取已保存的列宽
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('colWidths_' + storageKey)) || {}; } catch { /* 降级 */ }

  // 恢复列宽
  cols.forEach((th, i) => {
    const w = saved[i];
    if (w) { th.style.width = w + 'px'; th.style.minWidth = w + 'px'; }
  });

  // 给每个 th 加拖拽把手
  cols.forEach((th, i) => {
    if (i === cols.length - 1) return; // 最后一列不拖
    const handle = document.createElement('div');
    handle.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:2;background:transparent;transition:background .15s';
    handle.addEventListener('mouseenter', () => { handle.style.background = 'var(--primary)'; });
    handle.addEventListener('mouseleave', () => { if (!handle._dragging) handle.style.background = 'transparent'; });
    th.style.position = 'relative';
    th.appendChild(handle);

    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      handle._dragging = true;
      handle.style.background = 'var(--primary)';
      startX = e.clientX;
      startW = th.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const diff = ev.clientX - startX;
        const newW = Math.max(40, startW + diff);
        th.style.width = newW + 'px'; th.style.minWidth = newW + 'px';
        const idx = Array.from(cols).indexOf(th);
        table.querySelectorAll('tbody tr').forEach(tr => {
          const td = tr.children[idx];
          if (td) { td.style.width = newW + 'px'; td.style.minWidth = newW + 'px'; }
        });
      };
      const onUp = () => {
        handle._dragging = false;
        handle.style.background = 'transparent';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 保存所有列宽
        const widths = {};
        cols.forEach((c, j) => { widths[j] = c.offsetWidth; });
        try { localStorage.setItem('colWidths_' + storageKey, JSON.stringify(widths)); } catch { /* 降级 */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── 联系人详情表列定义 ──────────────────────────────────────────────
const DETAIL_COLS = [
  { key: 'first_name', label: '名', always: false },
  { key: 'last_name', label: '姓', always: false },
  { key: 'email', label: '邮箱', always: false },
  { key: 'title', label: '职位', always: false },
  { key: 'phone', label: '电话', always: false },
  { key: 'linkedin', label: '领英', always: false },
  { key: 'country', label: '国家', always: false },
  { key: 'category', label: '品类', always: false },
  { key: 'client_type', label: '客户类型', always: false },
  { key: 'stage', label: '阶段', always: false },
  { key: '_status', label: '状态', always: true },
  { key: 'opp_stage', label: '机会', always: false },
  { key: '_tags', label: '标签', always: false },
  { key: 'contact_person', label: '对接人', always: false },
  { key: 'assignee', label: '跟进人', always: false },
  { key: '_followup', label: '备注', always: false },
  { key: '_actions', label: '操作', always: true },
];

function _getColVis() {
  try { return JSON.parse(localStorage.getItem('detailCols') || '{}'); } catch { return {}; }
}
function _saveColVis(vis) {
  try { localStorage.setItem('detailCols', JSON.stringify(vis)); } catch { /* 降级 */ }
}
function _isColVisible(key, vis) {
  if (vis[key] !== undefined) return vis[key];
  return true; // 默认全显示
}

// ── 列显隐切换下拉 ──────────────────────────────────────────────────
function _showColToggle(anchorEl) {
  document.getElementById('col-toggle-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'col-toggle-popup';
  popup.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:8px 0;min-width:160px;font-size:12px;max-height:60vh;overflow-y:auto';
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = (rect.right - 160) + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';

  const vis = _getColVis();
  const items = DETAIL_COLS.filter(c => !c.always).map(c => {
    const show = _isColVisible(c.key, vis);
    return `<div style="padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px" data-key="${c.key}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'"><input type="checkbox" ${show ? 'checked' : ''} style="pointer-events:none;margin:0"> ${c.label}</div>`;
  }).join('');

  popup.innerHTML = items;
  popup.querySelectorAll('[data-key]').forEach(div => {
    div.addEventListener('click', () => {
      const key = div.dataset.key;
      const newVis = _getColVis();
      const willShow = !_isColVisible(key, vis);
      newVis[key] = willShow;
      _saveColVis(newVis);
      // 原地更新复选框状态 + 重渲详情（popup 保持打开）
      const cb = div.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = willShow;
      vis[key] = willShow;
      if (S.selectedContactCompany) renderContactDetail(S.selectedContactCompany);
    });
  });

  document.body.appendChild(popup);
  const close = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ponytail: 更新筛选栏标签计数（不重建列表）。无参时自动从 S.contactsData 计算。
function _updateFilterTabs(totalCompanies, clientCounts) {
  const filterBar = document.getElementById('contacts-filter');
  const tabs = filterBar?.querySelectorAll('.cf-tab');
  if (!tabs) return;
  // 无参调用时自动计算
  if (totalCompanies === undefined) {
    const seen = new Set();
    clientCounts = { agent: 0, direct: 0, unlabeled: 0 };
    for (const c of S.contactsData) {
      const key = c.company;
      if (!seen.has(key)) { seen.add(key); const ct = c.clientType || 'unlabeled'; clientCounts[ct] = (clientCounts[ct] || 0) + 1; }
    }
    totalCompanies = seen.size;
  }
  const tagCounts = { reached: 0, left_company: 0, replied: 0, autoreply: 0, bounced_by_contact: 0 };
  for (const c of S.contactsData) {
    for (const t of (c.tags || [])) { if (tagCounts[t] !== undefined) tagCounts[t]++; }
  }
  let anomalyCount = 0;
  for (const c of S.contactsData) {
    const ct = c.clientType || 'unlabeled';
    if (ct === 'no_email' || ct === 'invalid_email' || ct === 'no_company') anomalyCount++;
  }
  const labelMap = {
    all: `全部 ${totalCompanies}`,
    agent: `代理 ${clientCounts.agent || 0}`,
    direct: `直客 ${clientCounts.direct || 0}`,
    unlabeled: `未标签 ${clientCounts.unlabeled || 0}`,
    anomaly: `⚠️ 异常 ${anomalyCount}`,
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
  });
}

// ponytail: 内联编辑后局部更新侧边栏条目，避免重建整个列表
function _updateSidebarItem(contactId) {
  const c = S.contactsData.find(x => x.id === contactId);
  if (!c) return;
  const company = c.company || c.company_name || '';
  const sidebar = document.getElementById('contacts-sidebar');
  if (!sidebar) return;
  const item = sidebar.querySelector(`.contact-item[data-company="${CSS.escape(company)}"]`);
  if (!item) return;
  const members = S.contactsGroupMap.get(company) || [];
  const ctype = members[0]?.clientType || 'unlabeled';
  const ctry = escapeHtml(members[0]?.country || '');
  const hist = S.contactsSendHistory[company];
  const stageLabel = hist?.stage ? `<span class="ci-stage-badge ci-stage-${hist.stage}">${S.STAGE_LABELS_SEND[hist.stage] || hist.stage.toUpperCase()}</span>` : '';
  const subParts = [clientTypeTag(ctype), ctry, stageLabel].filter(Boolean);
  const subEl = item.querySelector('.ci-sub');
  if (subEl) subEl.innerHTML = subParts.join(' · ');
  // 更新计数
  const countEl = item.querySelector('.ci-count');
  if (countEl) countEl.textContent = members.length;
}

export function renderContactDetail(company) {
  const detail = document.getElementById('contacts-detail');
  if (!detail || !company) return;
  // 保存滚动位置，渲染后恢复（垂直+水平）
  const scrollTop = detail.scrollTop;
  const bodyEl = detail.querySelector('.contacts-detail-body');
  const bodyScrollLeft = bodyEl ? bodyEl.scrollLeft : 0;
  let members = S.contactsGroupMap.get(company) || [];
  if (S._searchQuery) {
    const q = S._searchQuery.toLowerCase();
    const companyMatch = (company || '').toLowerCase().includes(q);
    if (!companyMatch) {
      members = members.filter(m => (m.email || '').toLowerCase().includes(q) || (m.firstName || '').toLowerCase().includes(q) || (m.lastName || '').toLowerCase().includes(q) || (m.contactName || '').toLowerCase().includes(q));
    }
    if (!members.length) return;
  }
  const ctype = members[0]?.clientType || 'unlabeled';
  const hist = S.contactsSendHistory[company];
  const isArchived = hist?.stage === 'archived';
  const extraKeys = [...new Set(members.flatMap(m => Object.keys(m._extra || {})))].filter(Boolean);

  // 列显隐
  const colVis = _getColVis();
  const visibleCols = DETAIL_COLS.filter(c => c.always || _isColVisible(c.key, colVis));

  // ── 构建列头和数据单元格 ──────────────────────────────────────────
  const STAGE_LABEL = { cold:'冷开发', f1:'F1', f2:'F2', f3:'F3', f4:'F4' };
  const TYPE_LABEL = { agent:'代理', direct:'直客', unlabeled:'通用' };
  const OPP_LABEL = { '待开发':'待开发','触达中':'触达中','报价中':'报价中','试单':'试单','合作中':'合作中','已流失':'已流失' };
  const STATUS_LABEL = { '':'未触达', reached:'已触达', replied:'有回复', autoreply:'自动回复', bounced_by_contact:'退信', left_company:'已离职' };

  const _th = (col, isExtra) => {
    const style = isExtra ? 'color:#999;font-weight:400' : '';
    return `<th style="white-space:nowrap;${style}">${escapeHtml(isExtra ? col.key : col.label)}</th>`;
  };
  const _td = (m, col, isExtra) => {
    if (isExtra) return `<td style="color:#aaa;font-size:0.9em">${escapeHtml(String((m._extra || {})[col.key] || ''))}</td>`;
    switch (col.key) {
      case 'first_name': return `<td data-field="first_name" class="editable">${escapeHtml(m.firstName || m.first_name || '')}</td>`;
      case 'last_name': return `<td data-field="last_name" class="editable">${escapeHtml(m.lastName || m.last_name || '')}</td>`;
      case 'email': {
        const isNoEmail = (m.email || '').endsWith('@no.email');
        return `<td data-field="email" class="editable" data-value="${escapeHtml(m.email)}">${isNoEmail ? '<span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 6px;border-radius:8px;cursor:text;display:inline-flex;align-items:center;gap:2px">'+lucide('mail',10)+' 无邮箱</span>' : escapeHtml(m.email)}</td>`;
      }
      case 'title': return `<td data-field="title" class="editable">${escapeHtml(m.title || m.position || '')}</td>`;
      case 'phone': return `<td data-field="phone" class="editable">${escapeHtml(m.phone || '')}</td>`;
      case 'linkedin': return `<td data-field="linkedin" class="editable">${escapeHtml(m.linkedin || '')}</td>`;
      case 'country': return `<td data-field="country" data-select="country" class="editable">${escapeHtml(m.country || m.company_country || '')}</td>`;
      case 'category': return `<td data-field="category" class="editable">${escapeHtml(m.category || '')}</td>`;
      case 'client_type': return `<td data-field="client_type" data-select="client_type" data-labels="${escapeHtml(JSON.stringify(TYPE_LABEL))}" class="editable">${TYPE_LABEL[m.clientType||m.client_type]||'通用'}</td>`;
      case 'stage': {
        // ponytail: stage 是公司级概念，统一读 send-history，避免和 contact.stage 不同步
        const company = m.company || m.company_name || '';
        const hist = S.contactsSendHistory[company];
        const st = hist?.stage || 'cold';
        return `<td data-field="stage" data-select="stage" data-labels="${escapeHtml(JSON.stringify(STAGE_LABEL))}" class="editable" data-company="${escapeHtml(company)}"><span class="stage-badge stage-${st}" style="font-size:10px;padding:1px 6px;border-radius:8px">${STAGE_LABEL[st]||st}</span></td>`;
      }
      case '_status': {
        const tags = m.tags || [];
        const PRIORITY = ['left_company','bounced_by_contact','replied','autoreply','auto_reply','reached'];
        const top = PRIORITY.find(t => tags.includes(t)) || (m.is_bounced || m.bounced ? 'bounced_by_contact' : '');
        const label = STATUS_LABEL[top] || '未触达';
        const DOT = { reached:'#3b82f6', replied:'#22a644', autoreply:'#e6a817', bounced_by_contact:'#e5484d', left_company:'#d93025' };
        const dot = DOT[top] || 'var(--text-secondary)';
        return `<td data-field="_status" data-select="_status" data-labels="${escapeHtml(JSON.stringify(STATUS_LABEL))}" class="editable"><span style="font-size:11px;display:flex;align-items:center;gap:5px;white-space:nowrap"><span style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0"></span>${label}</span></td>`;
      }
      case 'opp_stage': return `<td data-field="opp_stage" data-select="opp_stage" data-labels="${escapeHtml(JSON.stringify(OPP_LABEL))}" class="editable">${OPP_LABEL[m.opp_stage]||m.opp_stage||'待开发'}</td>`;
      case '_tags': {
        const ts = (m.tags || []).join(',');
        return `<td class="tag-cell" data-contact-id="${m.id}" data-tags="${escapeHtml(JSON.stringify(m.tags || []))}" style="font-size:10px;max-width:100px;overflow:hidden;text-overflow:ellipsis;cursor:pointer">${ts ? `<span style="background:#e3f2fd;color:#1565c0;padding:1px 5px;border-radius:6px;font-size:9px">${escapeHtml(ts)}</span>` : '<span style="color:#ccc">—</span>'}</td>`;
      }
      case 'contact_person': return `<td data-field="contact_person" class="editable">${escapeHtml(m.contact_person || '')}</td>`;
      case 'assignee': return `<td data-field="assignee" class="editable">${escapeHtml(m.assignee||'')}</td>`;
      case '_followup': return `<td><span class="followup-btn" data-id="${m.id}" style="font-size:11px;cursor:pointer;color:var(--text-secondary)">备注</span></td>`;
      case '_actions': return `<td><button class="btn-edit-contact" data-id="${m.id}" style="margin-right:4px">${lucide('pencil',13)}</button><button class="btn-delete" data-id="${m.id}">${lucide('trash-2',13)}</button></td>`;
      default: return `<td>${escapeHtml(String(m[col.key] || ''))}</td>`;
    }
  };

  // 外部字段
  const extraCols = extraKeys.map(k => ({ key: k, label: k }));

  detail.innerHTML = `
    <div class="contacts-detail-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>${escapeHtml(company)} · ${members.length} 位联系人 ${clientTypeTag(ctype)}</span>
      <button id="btn-delete-company" class="btn-delete">${lucide('trash-2',14)}</button>
      <button id="btn-col-toggle" class="secondary" style="font-size:11px;padding:3px 8px;margin-left:auto" title="列设置">${lucide('columns',13)}</button>
      <button id="btn-backcheck-contact" class="secondary" style="font-size:11px;padding:3px 10px">背调</button>
      ${S.contactsFilter === 'tag:bounced_by_contact' ? `<button id="btn-delete-bounced" class="secondary" style="font-size:11px;padding:3px 10px;color:#e5484d;border-color:#e5484d">删除全部退信</button>` : ''}
    </div>
    <div class="contacts-detail-body" style="overflow-x:auto">
      <table style="white-space:nowrap">
        <thead><tr>${visibleCols.map(c => _th(c, false)).join('')}${extraCols.map(c => _th(c, true)).join('')}</tr></thead>
        <tbody>
          ${members.map(m => `
            <tr data-contact-id="${m.id}">
              ${visibleCols.map(c => _td(m, c, false)).join('')}
              ${extraCols.map(c => _td(m, c, true)).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${isArchived ? `<div style="margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;display:flex;align-items:center;gap:8px"><span style="font-size:13px">${lucide('archive',13)} 已归档 — 不参与常规序列</span><button id="btn-reactivate-contact" style="margin-left:auto;font-size:12px;padding:4px 12px">${lucide('refresh-cw',12)} 重新激活</button></div>` : ''}
    </div>
  `;
  // 恢复滚动位置
  if (scrollTop > 0) detail.scrollTop = scrollTop;
  if (bodyScrollLeft > 0) { const b = detail.querySelector('.contacts-detail-body'); if (b) b.scrollLeft = bodyScrollLeft; }
  // 列设置按钮
  const colBtn = document.getElementById('btn-col-toggle');
  if (colBtn) colBtn.addEventListener('click', (e) => { e.stopPropagation(); _showColToggle(colBtn); });

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
      CS.syncContactsUI();
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
      CS.syncContactsUI();
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

  // ── 删除按钮 ──────────────────────────────────────────────────────
  detail.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const contact = members.find(m => m.id === btn.dataset.id);
      if (!contact) return;
      if (!await showConfirm('确定删除该联系人？')) return;
      await window.electronAPI.deleteContact(contact.id);
      S.contactsData = S.contactsData.filter(c => c.id !== contact.id);
      const newMembers = S.contactsGroupMap.get(company) || [];
      const idx = newMembers.findIndex(m => m.id === contact.id);
      if (idx >= 0) newMembers.splice(idx, 1);
      CS.syncContactsUI();
    });
  });

    // ── 列宽拖拽 + 记忆 ────────────────────────────────────────────────
  const table = detail.querySelector('table');
  if (table) enableColResize(table, 'contacts-detail');

  // ── 标签多选下拉 ──────────────────────────────────────────────────
  detail.querySelectorAll('.tag-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactId = cell.dataset.contactId;
      const contact = members.find(m => m.id === contactId);
      if (!contact) return;
      const currentTags = contact.tags || [];

      document.getElementById('tag-popup')?.remove();
      const popup = document.createElement('div');
      popup.id = 'tag-popup';
      popup.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:8px 0;min-width:180px;font-size:12px';
      const rect = cell.getBoundingClientRect();
      popup.style.left = rect.left + 'px';
      popup.style.top = (rect.bottom + 4) + 'px';

      const TAG_OPTIONS = [
        { val: 'reached', label: '已触达', color: '#3b82f6' },
        { val: 'replied', label: '有回复', color: '#22a644' },
        { val: 'autoreply', label: '自动回复', color: '#e6a817' },
        { val: 'bounced_by_contact', label: '退信', color: '#e5484d' },
        { val: 'left_company', label: '已离职', color: '#d93025' },
      ];

      const currentTag = currentTags[0] || '';
      const items = TAG_OPTIONS.map(t => {
        const active = currentTag === t.val;
        return `<div style="padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;color:${t.color};${active ? 'font-weight:600' : ''}" data-tag="${t.val}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'"><span style="width:7px;height:7px;border-radius:50%;background:${t.color};flex-shrink:0"></span>${active ? ' ●' : ''} ${t.label}</div>`;
      }).join('');

      popup.innerHTML = items +
        `<div style="border-top:1px solid var(--border);margin:4px 0"></div>` +
        `<div style="padding:5px 14px;cursor:pointer;color:var(--text-secondary);font-size:11px" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'">清除标签</div>`;

      popup.querySelectorAll('[data-tag]').forEach(div => {
        div.addEventListener('click', async () => {
          const tagVal = div.dataset.tag;
          // 单选：再次点击同一标签则取消
          const newTags = currentTag === tagVal ? [] : [tagVal];
          popup.remove();
          await window.electronAPI.setContactTags(contactId, newTags);
          contact.tags = newTags;
          const newMembers = S.contactsGroupMap.get(company) || [];
          const idx = newMembers.findIndex(m => m.id === contactId);
          if (idx >= 0) newMembers[idx].tags = newTags;
          renderContactDetail(company);
        });
      });

      popup.lastElementChild.addEventListener('click', async () => {
        popup.remove();
        await window.electronAPI.setContactTags(contactId, []);
        contact.tags = [];
        const newMembers = S.contactsGroupMap.get(company) || [];
        const idx = newMembers.findIndex(m => m.id === contactId);
        if (idx >= 0) newMembers[idx].tags = [];
        renderContactDetail(company);
      });

      document.body.appendChild(popup);
      const close = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  });

    // ── 行内编辑：单击编辑、下拉切换 ────────────────────────────────────────
  const tbody = detail.querySelector('tbody');
  if (!tbody) return;

  const SELECT_OPTS = {
    country: ['Brazil','Mexico','Colombia','Chile','Peru','Argentina','Ecuador','Portugal','Spain','United States','China'],
    client_type: ['agent','direct','unlabeled'],
    stage: ['cold','f1','f2','f3','f4'],
    opp_stage: ['待开发','触达中','报价中','试单','合作中','已流失'],
    _status: ['', 'reached','replied','autoreply','bounced_by_contact','left_company'],
  };

  const INPUT_STYLE = 'min-width:140px;padding:5px 8px;border:2px solid var(--primary);border-radius:6px;font-size:12px;background:var(--card-bg);color:var(--text);outline:none;box-shadow:0 0 0 3px rgba(26,26,26,.08)';
  const SELECT_STYLE = 'min-width:120px;padding:4px 6px;border:2px solid var(--primary);border-radius:6px;font-size:11px;background:var(--card-bg);color:var(--text);outline:none;box-shadow:0 0 0 3px rgba(26,26,26,.08)';

  tbody.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const td = e.target.closest('td.editable');
    const tr = e.target.closest('tr');
    if (!td || !tr) return;
    const contactId = tr.dataset.contactId;
    if (!contactId || td.querySelector('input,select')) return;

    const field = td.dataset.field;
    const selType = td.dataset.select;

    if (selType) {
      // 下拉选择
      const orig = td.textContent.trim();
      const opts = SELECT_OPTS[selType] || [];
      const labels = td.dataset.labels ? JSON.parse(td.dataset.labels) : {};
      const select = document.createElement('select');
      select.style.cssText = SELECT_STYLE;
      opts.forEach((o) => {
        const opt = document.createElement('option'); opt.value = o;
        opt.textContent = labels[o] || o;
        if ((labels[o] || o) === orig || o === orig) opt.selected = true;
        select.appendChild(opt);
      });
      td.textContent = ''; td.appendChild(select); select.focus();
      let _saved = false;
      const save = async (val) => {
        if (_saved) return; _saved = true;
        select.remove();
        td.textContent = labels[val] || val;
        // ponytail: _status 空值(=未触达)是合法操作，不能和普通字段空值一样直接跳过
        if ((!val && selType !== '_status') || (labels[val] || val) === orig) return;
        const ref = S.contactsData.find(c => c.id === contactId);
        if (!ref) return;
        if (selType === 'client_type') {
          const company = ref.company || ref.company_name || '';
          const members = S.contactsData.filter(c => (c.company || c.company_name) === company);
          if (members.length > 1 && !await showConfirm(`「${company}」下 ${members.length} 人将全部改为「${labels[val] || val}」？`)) { td.textContent = orig; return; }
          for (const m of members) { await window.electronAPI.upsertContact({ id: m.id, email: m.email, client_type: val }); m.clientType = val; }
        } else if (selType === '_status') {
          const tagVal = val || ''; // 空字符串 = 清除标签 = 未触达
          await window.electronAPI.setContactTags(contactId, tagVal ? [tagVal] : []);
          ref.tags = tagVal ? [tagVal] : [];
          const members2 = S.contactsGroupMap.get(ref.company || ref.company_name || '');
          if (members2) { const mx = members2.find(x => x.id === contactId); if (mx) mx.tags = tagVal ? [tagVal] : []; }
        } else if (selType === 'country') {
          const contact = S.contactsData.find(c => c.id === contactId);
          if (contact?.company_id) { await window.electronAPI.updateCompany(contact.company_id, { country: val }); contact.country = val; }
        } else {
          const ref2 = S.contactsData.find(c => c.id === contactId);
          if (ref2) { await window.electronAPI.upsertContact({ id: contactId, email: ref2.email, [field]: val }); ref2[field] = val; }
        }
        // 刷新详情
        if (S.selectedContactCompany) renderContactDetail(S.selectedContactCompany);
        // stage 是公司级字段 → 手动同步 send-history + 侧边栏，不走 syncContactsUI（会被磁盘覆盖）
        if (field === 'stage' || selType === 'stage') {
          const company = td.dataset.company || S.contactsData.find(c => c.id === contactId)?.company || '';
          if (company && S.contactsSendHistory[company]) { S.contactsSendHistory[company].stage = val; }
          _updateSidebarItem(contactId);
        } else {
          CS.syncContactsUI();
        }
      };
      select.addEventListener('change', () => save(select.value));
      select.addEventListener('blur', () => { setTimeout(() => save(select.value), 100); });
      return;
    }

    // 文本输入
    if (!field) return;
    const orig = td.dataset.value || td.textContent.trim(); // ponytail: data-value 优先（如无邮箱占位符）
    const isNoEmail = orig.endsWith('@no.email');
    const input = document.createElement('input');
    input.value = isNoEmail ? '' : (orig === '—' ? '' : orig);
    input.style.cssText = INPUT_STYLE;
    td.textContent = ''; td.appendChild(input); input.focus(); input.select();
    const restore = () => {
      if (isNoEmail) td.innerHTML = '<span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 6px;border-radius:8px;cursor:text;display:inline-flex;align-items:center;gap:2px">'+lucide('mail',10)+' 无邮箱</span>';
      else td.textContent = orig || '—';
    };
    const save = async () => {
      if (!input.parentNode) return; // ponytail: blur 在 Enter/Escape 移除 DOM 后二次触发，此时 input 已不在 DOM 中
      const val = input.value.trim(); input.remove();
      if (val === orig || (val === '' && orig === '—') || (isNoEmail && !val)) { restore(); return; }
      td.textContent = val || '—';
      const ref = S.contactsData.find(c => c.id === contactId);
      if (ref) {
        const payload = { id: contactId, [field]: val };
        // 改邮箱时用旧邮箱做 upsert 定位，新邮箱做值
        if (field === 'email') payload.email = val;
        else payload.email = ref.email;
        await window.electronAPI.upsertContact(payload);
        // 只刷新当前公司详情，不重建整个列表
        ref[field] = val;
        if (field === 'email') ref.email = val;
        const company = ref.company || ref.company_name || '';
        const members = S.contactsGroupMap.get(company);
        if (members) {
          const m = members.find(x => x.id === contactId);
          if (m) { m[field] = val; if (field === 'email') m.email = val; }
        }
      }
      if (S.selectedContactCompany) renderContactDetail(S.selectedContactCompany);
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { input.remove(); restore(); } });
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
      CS.syncContactsUI();
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
    if (r.ok) { CS.syncContactsUI(); showToast(`AI 分类完成: ${r.updated} 人 / ${r.total} 家公司`, 'ok'); }
    else showToast(r.error || 'AI 分类失败', 'err');
  } catch (e) { showToast('AI 分类异常', 'err'); }
  btn.disabled = false; btn.textContent = 'AI 分类';
  renderContactsList();
});
// ── 编辑联系人弹窗 ──────────────────────────────────────────────────────────
// ── 跟进备注弹窗 ──────────────────────────────────────────────────────────
async function showFollowupEditor(contact) {
  const notes = await window.electronAPI.listNotes(contact.id) || [];
  const listHtml = notes.length
    ? `<div class="fu-list">${notes.map(n => `<div class="fu-item"><div class="fu-time">${new Date(n.created_at).toLocaleString('zh-CN')} <span style="cursor:pointer;color:#e5484d;margin-left:8px" data-del="${n.id}">✕</span></div>${escapeHtml(n.content)}</div>`).join('')}</div>`
    : '<div style="color:var(--text-secondary);font-size:12px;margin-bottom:12px">暂无备注</div>';

  showModal({
    title: `备注 — ${escapeHtml(contact.firstName || contact.contactName || contact.email)}`,
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
      ${listHtml}
      <textarea class="fu-input" id="fu-input" placeholder="输入备注..."></textarea>`,
    buttons: [
      { text: '取消', value: false },
      { text: '保存', value: 'ok', primary: true },
    ],
    onReady: () => {
      // 删除按钮事件
      document.querySelectorAll('[data-del]').forEach(el => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.electronAPI.deleteNote(el.dataset.del);
          showFollowupEditor(contact); // 刷新列表
        });
      });
    },
    onClose: async (val) => {
      if (val !== 'ok') return;
      const text = document.getElementById('fu-input')?.value?.trim();
      if (!text) { showToast('内容为空', 'warn'); return false; }
      await window.electronAPI.addNote(contact.id, text);
      renderContactDetail(contact.company);
      showToast('已保存', 'ok');
    },
  });

// 统一刷新入口：主进程 IPC 事件 + 渲染进程内部事件都走同一条路
function _onContactsSync() {
  if (document.getElementById('page-contacts')?.classList.contains('active')) {
    renderContactsList();
  }
}
window.electronAPI.onContactsChanged(_onContactsSync);
document.addEventListener('contacts:sync', _onContactsSync);
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
      CS.syncContactsUI();
      showToast('已保存', 'ok');
    },
  });
}
