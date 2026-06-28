const S = window.S;
import { lucide,showAlert,showConfirm,showToast,escapeHtml,ratingStars,initIcons } from './shared.js';

// ===== 客户开发 ======================================================

export async function initDiscover() {
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
      S.discoverActiveTab = tab.dataset.tab;
      const isFind = S.discoverActiveTab === 'find';
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
    if (S.discoverSelectedIdx != null && S.discoverResults[S.discoverSelectedIdx]) {
      S.discoverPreselectCompany = S.discoverResults[S.discoverSelectedIdx].company;
    }
    const nav = document.querySelector('[data-page="backcheck"]');
    if (nav) nav.click();
  });
  document.getElementById('discover-go-send')?.addEventListener('click', () => {
    if (S.discoverSelectedIdx != null && S.discoverResults[S.discoverSelectedIdx]) {
      S.selectedCompanySet.add(S.discoverResults[S.discoverSelectedIdx].company);
    }
    const nav = document.querySelector('[data-page="email-send"]');
    if (nav) nav.click();
  });

  // 详情面板操作按钮事件委托
  document.getElementById('discover-detail-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !S.discoverSelectedIdx || !S.discoverResults[S.discoverSelectedIdx]) return;
    const item = S.discoverResults[S.discoverSelectedIdx];
    if (btn.id === 'discover-btn-import') await importSingleCompany(item);
    if (btn.id === 'discover-btn-backcheck') await startBackcheckFromDiscover(item.company);
    if (btn.id === 'discover-btn-send') goToSend(item.company);
    if (btn.id === 'discover-btn-deepsearch') deepSearchFromDiscover(item);
  });

  // 确保联系人数据已加载以更新底部栏
  if (!S.contactsData || !S.contactsData.length) {
    try { S.contactsData = await window.electronAPI.getContacts(); } catch {}
  }
  updateDiscoverBottomBar();
}

export async function doDiscoverSearch() {
  const btn = document.getElementById('df-search');
  const country = document.getElementById('df-country')?.value || '';
  const industry = document.getElementById('df-industry')?.value || '';
  const role = document.getElementById('df-role')?.value || 'importer';
  const keywords = document.getElementById('df-keywords')?.value || '';
  if (!country) { await showAlert('请选择国家'); return; }

  btn.disabled = true; btn.textContent = '搜索中...';
  document.getElementById('df-results').innerHTML = `<div class="discover-spin">${lucide('refresh-cw',20,'spin')} 正在多平台搜索...</div>`;
  document.getElementById('discover-results-empty').style.display = 'none';
  document.getElementById('discover-detail-empty').style.display = '';
  document.getElementById('discover-detail-content').style.display = 'none';
  S.discoverResults = [];
  S.discoverSelectedIdx = null;

  try {
    const r = await window.electronAPI.discoverSearch({ country, industry, role, keywords, limit: '30' });
    if (!r.ok) { document.getElementById('df-results').innerHTML = '<div class="discover-spin">搜索失败</div>'; return; }

    S.discoverResults = r.companies || [];

    // 统计
    const stats = document.getElementById('df-stats');
    const srcLabels = Object.entries(r.sources || {}).map(([k,v]) => `<span>${k}: ${v}</span>`).join('');
    stats.innerHTML = `找到 <b>${r.total}</b> 家公司 · ${srcLabels}`;
    stats.style.display = '';

    // 计数
    const countEl = document.getElementById('df-count');
    if (countEl) countEl.textContent = `共 ${S.discoverResults.length} 条`;

    // 渲染
    renderDiscoverResults('df-results', S.discoverResults);
  } catch(e) {
    document.getElementById('df-results').innerHTML = `<div class="discover-spin">网络错误: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '开始搜索';
}

export async function doEmailLookup() {
  const btn = document.getElementById('dl-search');
  const company = document.getElementById('dl-company')?.value?.trim() || '';
  const email = document.getElementById('dl-email')?.value?.trim() || '';
  if (!company && !email) { await showAlert('请输入公司名或已知邮箱'); return; }

  btn.disabled = true; btn.textContent = '反查中...';
  document.getElementById('dl-results').innerHTML = `<div class="discover-spin">${lucide('refresh-cw',20,'spin')} 正在查找邮箱格式...</div>`;
  document.getElementById('dl-format').style.display = 'none';
  document.getElementById('discover-results-empty').style.display = 'none';
  S.discoverResults = [];
  S.discoverSelectedIdx = null;

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
      S.discoverResults = r.people.map(p => ({
        company: p.name, website: p.email || '', snippet: `${p.title || ''} · ${p.source || ''}`,
        source: p.source || 'inferred', confidence: p.confidence || 0.5,
        extra: { email: p.email, title: p.title }
      }));
      renderDiscoverResults('dl-results', S.discoverResults);
    } else {
      document.getElementById('dl-results').innerHTML = '<div class="discover-spin">未找到相关人员。尝试输入公司官网邮箱格式。</div>';
    }
  } catch(e) {
    document.getElementById('dl-results').innerHTML = `<div class="discover-spin">网络错误: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '开始反查';
}

export function renderDiscoverResults(containerId, companies) {
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

export function toggleAllDiscover() {
  const container = S.discoverActiveTab === 'find'
    ? document.getElementById('df-results')
    : document.getElementById('dl-results');
  if (!container) return;
  const cbs = container.querySelectorAll('input[type=checkbox]');
  const all = [...cbs].every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !all; });
}

export async function importSelectedDiscover() {
  const container = S.discoverActiveTab === 'find'
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
  if (S.discoverSelectedIdx != null && S.discoverResults[S.discoverSelectedIdx]) {
    selectDiscoverResult(S.discoverSelectedIdx);
  }
}

// ── 右侧详情面板 ──────────────────────────────────────────────────
export function selectDiscoverResult(idx) {
  S.discoverSelectedIdx = idx;
  // 高亮结果行
  const activeContainer = S.discoverActiveTab === 'find'
    ? document.getElementById('df-results')
    : document.getElementById('dl-results');
  if (activeContainer) {
    activeContainer.querySelectorAll('.discover-result-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.idx) === idx);
    });
  }
  renderDiscoverDetail(idx);
}

export async function renderDiscoverDetail(idx) {
  const item = S.discoverResults[idx];
  if (!item) return;

  const emptyEl = document.getElementById('discover-detail-empty');
  const contentEl = document.getElementById('discover-detail-content');
  if (emptyEl) emptyEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'flex';

  // 公司基本信息
  document.getElementById('discover-detail-name').textContent = item.company;
  const website = item.website || item.extra?.email || '';
  document.getElementById('discover-detail-fields').innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">${lucide('globe',11)} 官网</span><span style="word-break:break-all">${escapeHtml(website) || '--'}</span></div>
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">${lucide('pin',11)} 来源</span><span>${item.source} · 置信度 ${(item.confidence || 0).toFixed(1)}</span></div>
    <div style="display:flex;gap:6px;margin-bottom:4px"><span style="color:var(--text-secondary);min-width:48px;font-size:11px;font-weight:600">${lucide('file-text',11)} 摘要</span><span style="color:var(--text-secondary)">${escapeHtml(item.snippet || '--')}</span></div>
  `;

  // 查询工作流状态
  const status = await getWorkflowStatus(item.company);

  // 操作按钮
  const actions = document.getElementById('discover-action-btns');
  let btns = '';
  if (!status.imported) {
    btns += `<button id="discover-btn-import">${lucide('download',12)} 导入到联系人</button>`;
  } else {
    btns += `<button class="secondary" disabled>${lucide('check-circle',11)} 已导入 (${status.contactCount} 位联系人)</button>`;
  }
  if (status.imported && !status.backcheckDone && !status.backcheckActive) {
    btns += `<button id="discover-btn-backcheck">${lucide('search',12)} 开始背调</button>`;
  }
  if (status.backcheckActive) {
    btns += `<button class="secondary" disabled>${lucide('loader-circle',11,'spin')} 背调进行中...</button>`;
  }
  if (status.backcheckDone) {
    btns += `<button class="secondary" disabled>${lucide('check-circle',11)} 背调完成 ${ratingStars(status.rating)}</button>`;
  }
  if (status.imported && !status.isArchived) {
    btns += `<button id="discover-btn-send" class="secondary">${lucide('mail',12)} 去发送邮件</button>`;
  }
  if (website && !website.includes('@')) {
    btns += `<button id="discover-btn-deepsearch" class="secondary" style="font-size:12px">🔎 查找决策人</button>`;
  }
  actions.innerHTML = btns;

  // Pipeline
  renderWorkflowPipeline(status);
}

export async function getWorkflowStatus(companyName) {
  let contacts = S.contactsData;
  if (!contacts || !contacts.length) {
    try { contacts = await window.electronAPI.getContacts(); } catch { contacts = []; }
  }
  const backcheckStatus = await window.electronAPI.getBackcheckStatus();
  const sh = (typeof S.contactsSendHistory !== 'undefined' ? S.contactsSendHistory : null)
    || await window.electronAPI.getSendHistory().catch(() => ({}))
    || {};

  const companyContacts = contacts.filter(c => (c.company || '').trim() === (companyName || '').trim());
  const bcSt = backcheckStatus[companyName];
  const sendSt = sh[companyName];

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

export function renderWorkflowPipeline(status) {
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
export async function importSingleCompany(item) {
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
  try { S.contactsData = await window.electronAPI.getContacts(); } catch {}

  // 刷新详情面板
  if (S.discoverSelectedIdx != null) selectDiscoverResult(S.discoverSelectedIdx);
  updateDiscoverBottomBar();
}

export async function startBackcheckFromDiscover(companyName) {
  const contacts = S.contactsData && S.contactsData.length ? S.contactsData : await window.electronAPI.getContacts();
  const contact = contacts.find(c => (c.company || '').trim() === (companyName || '').trim());
  if (!contact) { showToast('未找到联系人数据，请先导入', 'err'); return; }

  showToast(`正在启动 ${companyName} 背调...`, 'ok');
  const result = await window.electronAPI.startResearch(contact, 'deep-research');
  if (!result.ok) { showToast(result.message || '启动失败', 'err'); return; }

  // 刷新详情面板
  if (S.discoverSelectedIdx != null) selectDiscoverResult(S.discoverSelectedIdx);
  updateDiscoverBottomBar();

  // 自动跳转背调页面
  const nav = document.querySelector('[data-page="backcheck"]');
  if (nav) nav.click();
}

export function goToSend(companyName) {
  // 预添加到选中集合
  if (typeof S.selectedCompanySet !== 'undefined') {
    S.selectedCompanySet.add(companyName);
  }
  const nav = document.querySelector('[data-page="email-send"]');
  if (nav) nav.click();
}

export async function deepSearchFromDiscover(item) {
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

export function updateDiscoverBottomBar() {
  const bar = document.getElementById('discover-bottom-bar');
  const summary = document.getElementById('discover-import-summary');
  if (!bar || !summary) return;

  // 统计当前搜索结果中已导入的联系人
  let totalContacts = 0;
  try {
    const names = new Set(S.discoverResults.map(r => (r.company || '').trim()).filter(Boolean));
    const allContacts = S.contactsData || [];
    totalContacts = allContacts.filter(c => names.has((c.company || '').trim())).length;
  } catch {}

  if (totalContacts > 0) {
    bar.style.display = 'flex';
    const uniqueCompanies = new Set();
    try {
      (S.contactsData || []).forEach(c => {
        if (S.discoverResults.some(r => (r.company || '').trim() === (c.company || '').trim())) {
          uniqueCompanies.add(c.company);
        }
      });
    } catch {}
    summary.textContent = `已导入 ${uniqueCompanies.size} 家公司 · ${totalContacts} 位联系人`;
  } else {
    bar.style.display = 'none';
  }
}

window.__pageHandlers['discover'] = initDiscover;
