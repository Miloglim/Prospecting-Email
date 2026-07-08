// ── 客户开发 — 搜索筛选器 + 结果 + 邮箱获取 ───────────────────────────────
const S = window.S;
import CS from './company-state.js';
import { lucide, showAlert, showConfirm, showToast, escapeHtml } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tag 输入
// ═══════════════════════════════════════════════════════════════════════════════

window._tagKeydown = function(event, wrapId, inputId, storeKey) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    const input = document.getElementById(inputId);
    const val = input.value.trim();
    if (!val) return;
    S['_' + storeKey] = S['_' + storeKey] || [];
    if (!S['_' + storeKey].includes(val)) {
      S['_' + storeKey].push(val);
      renderTags(wrapId, inputId, storeKey);
    }
    input.value = '';
  }
};

window._removeTag = function(wrapId, inputId, storeKey, idx) {
  S['_' + storeKey].splice(idx, 1);
  renderTags(wrapId, inputId, storeKey);
};

function renderTags(wrapId, inputId, storeKey) {
  const wrap = document.getElementById(wrapId);
  const tags = S['_' + storeKey] || [];
  wrap.innerHTML = tags.map((t, i) =>
    `<span class="tag-badge">${escapeHtml(t)}<span onclick="window._removeTag('${wrapId}','${inputId}','${storeKey}',${i})" style="cursor:pointer;margin-left:4px;color:var(--text-secondary)">&times;</span></span>`
  ).join('') + `<input id="${inputId}" class="tag-input" placeholder="${tags.length ? '' : '输入后回车添加'}" onkeydown="window._tagKeydown(event,'${wrapId}','${inputId}','${storeKey}')">`;
}

function getCheckedChips(containerId) {
  const chips = document.querySelectorAll(`#${containerId} .chip.active`);
  return [...chips].map(c => c.dataset.val);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════════

export async function initDiscover() {
  S._nameTags = S._nameTags || ['freight forwarder', 'cargo', 'logistics'];
  S._titleTags = S._titleTags || ['logistics', 'freight', 'shipping', 'procurement', 'sales'];
  S._searchResult = null;
  S._selectedDomain = null;

  renderTags('df-name-tags', 'df-name-input', 'nameTags');
  renderTags('df-title-tags', 'df-title-input', 'titleTags');

  // Chip 点击
  document.querySelectorAll('.chip-group').forEach(group => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chip.classList.toggle('active');
    });
  });

  // 预设 Colombia + 51-200
  document.querySelector('#df-countries .chip[data-val="Colombia"]')?.classList.add('active');
  document.querySelector('#df-sizes .chip[data-val="51,200"]')?.classList.add('active');
  document.querySelector('#df-sizes .chip[data-val="11,50"]')?.classList.add('active');

  document.getElementById('df-search')?.addEventListener('click', doSearch);
  document.getElementById('df-selectall')?.addEventListener('click', toggleAll);
  document.getElementById('df-reveal-company-btn')?.addEventListener('click', revealCompany);
  document.getElementById('df-reveal-selected')?.addEventListener('click', revealSelected);
  document.getElementById('df-save-filter')?.addEventListener('click', saveFilter);
  document.getElementById('df-delete-filter')?.addEventListener('click', deleteFilter);
  document.getElementById('discover-go-backcheck')?.addEventListener('click', goBackcheck);
  document.getElementById('discover-go-send')?.addEventListener('click', goSend);

  document.getElementById('df-results')?.addEventListener('click', (e) => {
    const item = e.target.closest('.discover-result-item');
    if (item?.dataset.domain) selectCompany(item.dataset.domain);
  });

  document.getElementById('df-saved-filters')?.addEventListener('change', (e) => {
    if (e.target.value) loadFilter(e.target.value);
  });

  loadSavedFiltersList();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 搜索
// ═══════════════════════════════════════════════════════════════════════════════

async function doSearch() {
  const countries = getCheckedChips('df-countries');
  if (!countries.length) { await showAlert('请至少选择一个国家'); return; }

  const nameKeywords = S._nameTags || [];
  if (!nameKeywords.length) { await showAlert('请至少输入一个公司名关键词'); return; }

  const sizes = getCheckedChips('df-sizes');
  const finalSizes = sizes.length ? sizes : ['11,50', '51,200'];

  const btn = document.getElementById('df-search');
  btn.disabled = true; btn.textContent = '搜索中...';

  document.getElementById('df-results').innerHTML = `<div class="discover-spin">${lucide('refresh-cw',20,'spin')} 正在搜索公司...</div>`;
  document.getElementById('discover-detail-empty').style.display = '';
  document.getElementById('discover-detail-content').style.display = 'none';

  // 将当前筛选条件临时保存为 profile 传给后端
  const profileId = '_adhoc_search';
  const profile = {
    profileId, label: '临时搜索',
    companyDiscovery: { source: 'apollo', nameKeywords, countries, sizeRanges: finalSizes, maxPagesPerKeyword: 3, perPage: 25 },
    contactFilter: { requireEmail: true, perCompanyLimit: 0,
      titleScoring: { high: S._titleTags || [], medium: ['sales','operations','manager','director','ceo','owner'] } },
    emailReveal: { smartMode: true, smartSampleSize: 3 },
  };
  await window.electronAPI.discoverSaveProfile(profileId, profile);

  try {
    const r = await window.electronAPI.discoverSearch(profileId);
    if (!r.ok) { document.getElementById('df-results').innerHTML = `<div class="discover-spin">${r.error}</div>`; btn.disabled = false; btn.textContent = '🔍 搜索公司（免费）'; return; }

    S._searchResult = r;
    S._selectedDomain = null;
    renderReport(r.report);
    renderCompanyList(r.companies || [], r.report);
  } catch (e) {
    document.getElementById('df-results').innerHTML = `<div class="discover-spin">网络错误: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '🔍 搜索公司（免费）';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 报告条
// ═══════════════════════════════════════════════════════════════════════════════

function renderReport(report) {
  const bar = document.getElementById('df-report-bar');
  if (!bar || !report) return;
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span>🏢 <b>${report.totalCompanies}</b> 家公司</span>
    <span>👤 <b>${report.totalPeople}</b> 个联系人</span>
    <span style="color:var(--text-secondary);font-size:11px">搜索免费 · 获取邮箱消耗 credits</span>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 公司列表
// ═══════════════════════════════════════════════════════════════════════════════

function renderCompanyList(companies, report) {
  const container = document.getElementById('df-results');
  if (!companies?.length) { container.innerHTML = '<div class="discover-spin">无结果，尝试调整筛选条件</div>'; return; }

  const countMap = {};
  if (report?.topCompanies) report.topCompanies.forEach(t => { countMap[t.name] = t.count; });

  container.innerHTML = companies.map(c => {
    const cnt = countMap[c.name] || 0;
    return `<div class="discover-result-item" data-domain="${escapeHtml(c.domain)}">
      <input type="checkbox" data-domain="${escapeHtml(c.domain)}" data-name="${escapeHtml(c.name)}" data-count="${cnt}" onclick="event.stopPropagation()">
      <div class="discover-result-info">
        <div class="dri-name">${escapeHtml(c.name)}</div>
        <div class="dri-meta">${escapeHtml(c.domain)} · ${cnt ? cnt + ' 个联系人' : ''}</div>
      </div>
      ${cnt ? `<span class="dri-count">${cnt}</span>` : ''}
    </div>`;
  }).join('');

  document.getElementById('df-count').textContent = `共 ${companies.length} 家`;
  document.getElementById('discover-results-empty').style.display = 'none';
  document.getElementById('discover-bottom-bar').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 公司详情
// ═══════════════════════════════════════════════════════════════════════════════

async function selectCompany(domain) {
  S._selectedDomain = domain;
  document.querySelectorAll('#df-results .discover-result-item').forEach(el => {
    el.classList.toggle('active', el.dataset.domain === domain);
  });

  document.getElementById('discover-detail-empty').style.display = 'none';
  const content = document.getElementById('discover-detail-content');
  content.style.display = 'flex';

  try {
    const r = await window.electronAPI.discoverCompanyDetail(domain);
    if (!r.ok) { content.innerHTML = `<p>${r.error}</p>`; return; }

    document.getElementById('discover-detail-name').textContent = r.companyName || domain;
    document.getElementById('discover-detail-fields').innerHTML = `
      <div>🌐 ${escapeHtml(domain)}</div>
      <div>👥 ${r.total} 人 · 📧 ${r.withEmail} 有邮箱</div>
    `;
    document.getElementById('discover-detail-contact-count').textContent = `${r.withEmail} 可获取邮箱`;

    const list = document.getElementById('discover-detail-people');
    const withEmail = (r.people || []).filter(p => p.hasEmail);
    const noEmail = (r.people || []).filter(p => !p.hasEmail);

    list.innerHTML = [
      ...withEmail.map(p =>
        `<div class="dp-item" style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border-light, #f0f0f0)">
          <input type="checkbox" data-person="${p.personId}" data-name="${escapeHtml(p.firstName + ' ' + p.lastName)}" data-title="${escapeHtml(p.title)}">
          <span>📧 <b>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</b></span>
          <span style="color:var(--text-secondary);font-size:11px;margin-left:auto">${escapeHtml(p.title)}</span>
        </div>`
      ),
      ...noEmail.slice(0, 3).map(p =>
        `<div class="dp-item" style="color:var(--text-secondary);padding:3px 0;font-size:11px">✖ ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)} — ${escapeHtml(p.title)}</div>`
      ),
    ].join('');

    const btn = document.getElementById('df-reveal-company-btn');
    if (btn && withEmail.length > 0) {
      btn.style.display = '';
      btn.textContent = `✉️ 获取邮箱 (${withEmail.length} 人)`;
      btn.dataset.domain = domain;
      btn.dataset.count = withEmail.length;
    }
  } catch (e) {
    content.innerHTML = `<p>加载失败: ${e.message}</p>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 获取邮箱
// ═══════════════════════════════════════════════════════════════════════════════

async function revealCompany() {
  const btn = document.getElementById('df-reveal-company-btn');
  const domain = btn.dataset.domain;
  const count = parseInt(btn.dataset.count) || 10;
  const maxCredits = parseInt(document.getElementById('df-credits')?.value || '50');

  const ok = await showConfirm(`将消耗最多 ${Math.min(count, maxCredits)} credits 获取 ${domain} 的联系人邮箱。确定？`);
  if (!ok) return;

  btn.disabled = true; btn.textContent = '获取中...';

  try {
    const r = await window.electronAPI.discoverReveal('_adhoc_search', maxCredits, domain);
    if (!r.ok) { await showAlert(r.error); btn.disabled = false; btn.textContent = '✉️ 获取邮箱'; return; }

    // 导入到联系人
    const imp = await window.electronAPI.importContacts(r.contacts);
    showToast(`✅ ${imp?.added || r.stats.total} 条联系人已导入 (${r.stats.revealed}c 揭示 + ${r.stats.inferred} 推断)`, 'ok');
    try { await CS.refreshContacts(); } catch {}

    btn.style.display = 'none';
    const result = document.getElementById('discover-reveal-result');
    if (result) { result.style.display = ''; result.textContent = `✅ 已导入 ${imp?.added || r.stats.total} 条`; }

    updateBottomBar();
  } catch (e) {
    showToast('获取失败: ' + e.message, 'err');
  }
  btn.disabled = false;
}

async function revealSelected() {
  const checked = document.querySelectorAll('#df-results input[type=checkbox]:checked');
  if (!checked.length) { showToast('请先勾选公司', 'warn'); return; }

  const domains = [...checked].map(cb => cb.dataset.domain);
  const maxCredits = parseInt(document.getElementById('df-credits')?.value || '50');

  const ok = await showConfirm(`将为 ${domains.length} 家公司获取邮箱，最多 ${maxCredits} credits。确定？`);
  if (!ok) return;

  let total = 0;
  for (const domain of domains) {
    try {
      const r = await window.electronAPI.discoverReveal('_adhoc_search', maxCredits, domain);
      if (r.ok) {
        await window.electronAPI.importContacts(r.contacts);
        total += r.stats?.total || 0;
      }
    } catch {}
  }
  showToast(`✅ 共导入 ${total} 条联系人`, 'ok');
  try { await CS.refreshContacts(); } catch {}
  updateBottomBar();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 筛选条件保存/加载
// ═══════════════════════════════════════════════════════════════════════════════

async function saveFilter() {
  const name = prompt('筛选条件名称（如：哥伦比亚货代）');
  if (!name) return;

  const filter = {
    name,
    countries: getCheckedChips('df-countries'),
    sizes: getCheckedChips('df-sizes'),
    nameKeywords: S._nameTags || [],
    titleKeywords: S._titleTags || [],
    updatedAt: new Date().toISOString(),
  };

  const all = await getSavedFilters();
  all[name] = filter;
  localStorage.setItem('discover-filters', JSON.stringify(all));
  await loadSavedFiltersList();
  showToast('已保存', 'ok');
}

async function loadFilter(name) {
  const all = await getSavedFilters();
  const f = all[name];
  if (!f) return;

  // 恢复 chip 选择
  document.querySelectorAll('#df-countries .chip').forEach(chip => {
    chip.classList.toggle('active', (f.countries || []).includes(chip.dataset.val));
  });
  document.querySelectorAll('#df-sizes .chip').forEach(chip => {
    chip.classList.toggle('active', (f.sizes || []).includes(chip.dataset.val));
  });
  // 恢复 tag
  S._nameTags = f.nameKeywords || [];
  S._titleTags = f.titleKeywords || [];
  renderTags('df-name-tags', 'df-name-input', 'nameTags');
  renderTags('df-title-tags', 'df-title-input', 'titleTags');

  document.getElementById('df-delete-filter').style.display = '';
}

async function deleteFilter() {
  const sel = document.getElementById('df-saved-filters');
  const name = sel.value;
  if (!name) return;
  const ok = await showConfirm(`删除筛选条件 "${name}"？`);
  if (!ok) return;

  const all = await getSavedFilters();
  delete all[name];
  localStorage.setItem('discover-filters', JSON.stringify(all));
  await loadSavedFiltersList();
  document.getElementById('df-delete-filter').style.display = 'none';
  showToast('已删除', 'ok');
}

async function getSavedFilters() {
  try { return JSON.parse(localStorage.getItem('discover-filters') || '{}'); } catch { return {}; }
}

async function loadSavedFiltersList() {
  const sel = document.getElementById('df-saved-filters');
  if (!sel) return;
  const all = await getSavedFilters();
  const names = Object.keys(all);
  sel.innerHTML = '<option value="">已保存...</option>' + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════════════════════

function toggleAll() {
  const cbs = document.querySelectorAll('#df-results input[type=checkbox]');
  const all = [...cbs].every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !all; });
}

function goBackcheck() {
  document.querySelector('[data-page="backcheck"]')?.click();
}
function goSend() {
  document.querySelector('[data-page="email-send"]')?.click();
}

async function updateBottomBar() {
  const contacts = S.contactsData || await window.electronAPI.getContacts().catch(() => []);
  const resultNames = new Set((S._searchResult?.companies || []).map(c => (c.name || '').trim()).filter(Boolean));
  const imported = contacts.filter(c => resultNames.has((c.company || '').trim()));

  const bar = document.getElementById('discover-bottom-bar');
  const summary = document.getElementById('discover-import-summary');
  if (bar) bar.style.display = 'flex';
  if (summary) summary.textContent = imported.length ? `已导入 ${imported.length} 位联系人` : '';
}

window.__pageHandlers['discover'] = initDiscover;
