// ── Prospecting Email — 渲染进程逻辑 v1.2 ──────────────────────────────

// ===== 全局状态 ======================================================
let templateLib = null;
let currentLang = 'es';
let isEditing = false;
let queue = JSON.parse(localStorage.getItem('emailQueue') || '[]');
let currentAssembled = { es: '', en: '', subject: '' };
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
let allCollapsed = false;

async function loadContacts() {
  contactsData = await window.electronAPI.getContacts();
  renderContactsGrouped();
}

function groupByCompany(data) {
  const groups = {};
  for (const c of data) {
    const key = c.company || '未命名';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  // 按公司名字母排序
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
}

function renderContactsGrouped(filtered) {
  const data = filtered || contactsData;
  const container = document.getElementById('contacts-groups');
  const empty = document.getElementById('contacts-empty');
  const statsBar = document.getElementById('contacts-stats');

  if (!data.length) {
    if (empty) empty.style.display = 'block';
    if (container) container.innerHTML = '';
    if (statsBar) statsBar.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  // 按人数降序排列
  const groups = groupByCompany(data).sort((a, b) => b[1].length - a[1].length);

  // 统计
  const vipCount = groups.filter(g => g[1].length >= 5).length;
  if (statsBar) {
    statsBar.style.display = 'flex';
    statsBar.innerHTML = `<span>👥 <strong>${data.length}</strong> 位联系人</span><span>🏢 <strong>${groups.length}</strong> 家公司</span><span>⭐ <strong>${vipCount}</strong> 可定制客户</span>`;
  }

  if (container) {
    container.innerHTML = groups.map(([company, members]) => `
      <div class="contact-group${allCollapsed ? ' collapsed' : ''}">
        <div class="contact-group-header">
          <span class="contact-group-title">
            <span class="contact-group-arrow">▼</span>
            ${escapeHtml(company)}
            <span class="contact-group-count">${members.length} 人</span>
            ${members.length >= 5 ? '<span class="badge-vip">可定制</span>' : ''}
          </span>
          <span style="font-size:11px;color:var(--text-secondary)">${escapeHtml(members[0]?.country || '')}</span>
        </div>
        <div class="contact-group-body">
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
        </div>
      </div>
    `).join('');

    // 折叠/展开
    container.querySelectorAll('.contact-group-header').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('collapsed');
      });
    });

    // 删除单个联系人
    container.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('确定删除该联系人？')) return;
        await window.electronAPI.deleteContact(btn.dataset.id);
        contactsData = contactsData.filter(c => c.id !== btn.dataset.id);
        renderContactsGrouped();
      });
    });
  }
}

// 一键折叠/展开
document.getElementById('contacts-collapse-all')?.addEventListener('click', () => {
  allCollapsed = !allCollapsed;
  document.querySelectorAll('.contact-group').forEach(g => {
    if (allCollapsed) g.classList.add('collapsed');
    else g.classList.remove('collapsed');
  });
  const btn = document.getElementById('contacts-collapse-all');
  btn.textContent = allCollapsed ? '📂 一键展开' : '📂 一键折叠';
});

// 一键删除全部
document.getElementById('contacts-delete-all')?.addEventListener('click', async () => {
  if (!confirm('确定删除全部联系人？此操作不可恢复！')) return;
  await window.electronAPI.deleteAllContacts();
  contactsData = [];
  renderContactsGrouped();
});

// 搜索
document.getElementById('contacts-search')?.addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (!q) { renderContactsGrouped(); return; }
  const results = await window.electronAPI.searchContacts(q);
  renderContactsGrouped(results);
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
    let badge = '⬜';
    if (st?.status === 'researching') badge = '🔄';
    else if (st?.status === 'pending_claude') badge = '📋';
    else if (st?.status === 'done') badge = st.rating ? ratingStars(st.rating) : '✅';
    return `<div class="backcheck-company" data-company="${escapeHtml(company)}">${escapeHtml(company)} <span style="font-size:11px">(${members.length}人)</span> <span style="font-size:12px">${badge}</span></div>`;
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
      if (updatedSt?.status === 'researching') badge = '🔄';
      else if (updatedSt?.status === 'done') badge = updatedSt.rating ? ratingStars(updatedSt.rating) : '✅';
      const span = el.querySelector('span:last-child');
      if (span) span.textContent = badge;
    });
  });
}

function renderBackcheckCard(info, companyName, st) {
  const card = document.getElementById('backcheck-card');
  if (!card) return;

  const hasData = info?.raw && info.raw.length > 50;
  // 每次重新读取状态（确保最新）
  const isDone = st?.status === 'done';
  const isResearching = st?.status === 'researching';

  let bodyHtml = '';
  if (hasData || isDone) {
    // 直接渲染报告全文（轻量 Markdown → HTML）
    const mdText = info.raw || '';
    bodyHtml = `<div class="backcheck-report">${renderMarkdown(mdText)}</div>`;
  } else if (isResearching) {
    bodyHtml = '<p style="color:var(--warning);padding:20px;text-align:center">🔄 正在自动搜索中，请稍候...</p>';
  } else {
    bodyHtml = '<p style="color:var(--text-secondary);padding:20px;text-align:center">点击下方按钮开始背调</p>';
  }

  // 星级评定
  const rating = info?.rating || 0;
  const ratingHtml = rating > 0 ? `<div style="font-size:16px;margin-bottom:12px">货代开发价值：${ratingStars(rating)} <span style="font-size:12px;color:var(--text-secondary)">(${rating}/5)</span></div>` : '';

  const isPendingClaude = st?.status === 'pending_claude';
  const progress = st?.progress || '';

  card.innerHTML = `
    ${ratingHtml}
    ${bodyHtml}
    ${(isResearching || isPendingClaude) ? `
      <div style="background:#f8f9fb;border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:12px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">📡 后台状态</div>
        <div style="font-size:13px;color:var(--primary)">${progress || (isPendingClaude ? '等待 Claude Code 处理...' : '正在搜索...')}</div>
        ${isPendingClaude ? '<div style="font-size:11px;color:var(--warning);margin-top:6px">⚠️ 自动搜索网络不通，已生成请求文件，请到 Claude Code 说「处理背调请求」</div>' : ''}
      </div>
    ` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;border-top:1px solid var(--border);padding-top:12px;flex-wrap:wrap">
      ${(!isDone && !isPendingClaude) ? `<button id="btn-research" ${isResearching ? 'disabled' : ''}>🔍 ${isResearching ? '调查中...' : '开始背调'}</button>` : ''}
      ${isDone ? `<button class="secondary" disabled>${rating > 0 ? ratingStars(rating) + ' 已评定' : '✅ 已完成背调'}</button>` : ''}
      ${isPendingClaude ? `<button class="secondary" style="color:var(--warning)" disabled>⏳ 等待 Claude Code</button>` : ''}
      ${isDone ? '<button id="btn-recheck" class="secondary">🔄 重新调查</button>' : ''}
      ${isResearching ? '<button id="btn-cancel-research" class="secondary danger">✕ 取消</button>' : ''}
      ${isPendingClaude ? '<button id="btn-cancel-research" class="secondary danger">✕ 取消</button>' : ''}
    </div>
    <div style="text-align:center;margin-top:8px">
      <button id="btn-open-folder" class="secondary" style="font-size:12px;padding:6px 16px">📂 打开报告文件夹</button>
    </div>
  `;

  // 开始背调按钮
  document.getElementById('btn-research')?.addEventListener('click', async () => {
    const contact = contactsData.find(c => c.company === companyName);
    if (!contact) return alert('未找到联系人信息');
    const result = await window.electronAPI.startResearch(contact);
    if (result.ok) {
      // 自动轮询等待完成
      const btn = document.getElementById('btn-research');
      if (btn) { btn.disabled = true; btn.textContent = '🔄 调查中...'; }
      pollBackcheckStatus(companyName, () => {
        loadBackcheck();
        // 自动点击该公司显示结果
        setTimeout(() => {
          const el = document.querySelector(`.backcheck-company[data-company="${escapeHtml(companyName)}"]`);
          if (el) el.click();
        }, 200);
      });
    }
  });

  // 重新调查
  document.getElementById('btn-recheck')?.addEventListener('click', async () => {
    const contact = contactsData.find(c => c.company === companyName);
    if (!contact) return;
    await window.electronAPI.startResearch(contact);
    pollBackcheckStatus(companyName, () => {
      loadBackcheck();
      setTimeout(() => {
        const el = document.querySelector(`.backcheck-company[data-company="${escapeHtml(companyName)}"]`);
        if (el) el.click();
      }, 200);
    });
  });

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
}


// ===== 邮件工坊 ======================================================
async function initEmailSend() {
  if (!templateLib) templateLib = await window.electronAPI.getTemplateLibrary();

  document.getElementById('ws-stage').onchange = () => { randomizeTemplate(); };
  document.getElementById('ws-type').onchange = () => { randomizeTemplate(); };

  document.querySelectorAll('.lang-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentLang = tab.dataset.lang;
      document.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('preview-body-es').style.display = currentLang === 'es' ? 'block' : 'none';
      document.getElementById('preview-body-en').style.display = currentLang === 'en' ? 'block' : 'none';
    });
  });

  document.getElementById('ws-add-queue').addEventListener('click', addToQueue);

  await loadSendContacts();
  randomizeTemplate();
}

let sendCompanies = {};

async function loadSendContacts() {
  contactsData = await window.electronAPI.getContacts();
  if (!contactsData.length) {
    document.getElementById('send-company-list').innerHTML = '<p style="font-size:12px;color:var(--text-secondary);padding:8px">暂无联系人</p>';
    return;
  }

  // 按公司分组
  sendCompanies = {};
  for (const c of contactsData) {
    const name = c.company || '未命名';
    if (!sendCompanies[name]) sendCompanies[name] = [];
    sendCompanies[name].push(c);
  }

  renderCompanyList();
}

function renderCompanyList(filter) {
  const container = document.getElementById('send-company-list');
  let companies = Object.entries(sendCompanies).sort((a,b) => b[1].length - a[1].length);
  if (filter) companies = companies.filter(([n]) => n.toLowerCase().includes(filter));

  container.innerHTML = companies.length
    ? companies.map(([name, members]) => `<div class="send-company-item" data-company="${escapeHtml(name)}">${escapeHtml(name)}<span class="sc-count">${members.length}</span></div>`).join('')
    : '<p style="font-size:12px;color:var(--text-secondary);padding:8px">无匹配公司</p>';

  container.querySelectorAll('.send-company-item').forEach(el => {
    el.addEventListener('click', () => {
      container.querySelectorAll('.send-company-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectSendCompany(el.dataset.company);
    });
  });
}

function selectSendCompany(companyName) {
  const members = sendCompanies[companyName] || [];
  const recipDiv = document.getElementById('send-recipients');
  recipDiv.innerHTML = `<span style="font-size:13px;font-weight:600;margin-right:8px">${escapeHtml(companyName)}</span>` +
    members.map(m => `<label><input type="checkbox" class="rcpt-check" data-email="${escapeHtml(m.email||'')}" checked> ${escapeHtml(m.email||'无邮箱')}</label>`).join('');

  // 存公司名供队列使用
  window._sendCompany = companyName;
  window._sendMembers = members;
}

// 获取当前勾选的收件人
function getCheckedRecipients() {
  const checks = document.querySelectorAll('.rcpt-check:checked');
  return Array.from(checks).map(cb => cb.dataset.email).filter(Boolean);
}

// 搜索
document.getElementById('send-search')?.addEventListener('input', (e) => {
  renderCompanyList(e.target.value.toLowerCase());
});

// 随机模板
document.getElementById('ws-random')?.addEventListener('click', randomizeTemplate);

// 随机编排模板
function randomizeTemplate() {
  if (!templateLib) return;
  const type = document.getElementById('ws-type').value;
  const stage = document.getElementById('ws-stage').value;
  const painKey = PAIN_KEY[type];
  const proofKey = PROOF_KEY[type];
  const pick = (arr) => arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

  const hook = pick(templateLib.hooks);
  const pain = pick(templateLib.painPoints?.[painKey]);
  const proof = pick(templateLib.proofs?.[proofKey]);
  const cta = pick(templateLib.ctas);
  const followup = stage !== 'cold' ? pick(templateLib.followUps?.[stage]) : null;

  const subjects = templateLib.subjects?.[type] || { es: '', en: '' };
  currentAssembled = {
    es: assembleEmail('es', hook, pain, proof, cta, followup, '', stage),
    en: assembleEmail('en', hook, pain, proof, cta, followup, '', stage),
    subject: subjects,
  };

  document.getElementById('preview-subject').textContent = 'Asunto: ' + (currentAssembled.subject?.[currentLang] || currentAssembled.subject?.es || '');
  document.getElementById('preview-body-es').textContent = currentAssembled.es;
  document.getElementById('preview-body-en').textContent = currentAssembled.en;
  checkSpam(currentAssembled.es, currentAssembled.en);
}

async function loadSenderInfo() {
  try {
    const smtp = await window.electronAPI.checkSmtpStatus();
    document.getElementById('send-from-name').value = smtp.user ? smtp.user.split('@')[0] : '';
    document.getElementById('send-from-email').value = smtp.user || '';
  } catch(e) {}
}

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

  // 主题行
  html += `<li><div class="tn-label tn-leaf-item" data-node="subjects"><span class="tn-arrow"></span>🏷️ 主题行</div></li>`;

  // 三个客户类型 × 五个阶段（平铺列表，无折叠）
  for (const [type, label] of Object.entries(TYPES)) {
    for (const stage of STAGES) {
      html += `<li><div class="tn-label tn-leaf-item" data-node="${type}|${stage}">👤 ${label} · ${STAGE_LABELS[stage]}</div></li>`;
    }
  }

  // 垃圾词黑名单（单一点击，直接打开全配置）
  html += `<li><div class="tn-label tn-leaf-item" data-node="spam">🚫 垃圾词黑名单</div></li>`;

  html += '</ul>';
  tree.innerHTML = html;

  // 列表项点击
  tree.querySelectorAll('.tn-leaf-item').forEach(el => {
    el.addEventListener('click', () => {
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

  panel.innerHTML = `<h3>👤 ${TYPES[type]} · ${STAGE_LABELS[stage]}</h3>` +
    groups.map(([key, title]) => {
      const items = stageData[key] || [];
      if (!items.length) return '';
      return `<div class="tmpl-section"><h4>${title}</h4>` + items.map((item, i) => `
        <div class="tmpl-sentence" data-key="${key}" data-index="${i}">
          <span class="ts-id">${item.id}</span>
          <div class="ts-body">
            <span class="ts-lang">ES</span>
            <textarea class="ts-es">${escapeHtml(item.es||'')}</textarea>
            <span class="ts-lang" style="margin-top:4px">EN</span>
            <textarea class="ts-en">${escapeHtml(item.en||'')}</textarea>
          </div>
        </div>
      `).join('') + '</div>';
    }).join('') +
    `<button id="btn-save-stage" style="margin-top:8px">💾 保存</button>
    <div class="tmpl-skeleton" id="stage-preview"></div>`;

  // 实时预览骨架
  const updatePreview = () => {
    const preview = document.getElementById('stage-preview');
    if (!preview) return;
    const data = stageData;
    const h = data.hooks?.[0]?.es || '';
    const p = data.pains?.[0]?.es || '';
    const pf = data.proofs?.[0]?.es || '';
    const c = data.ctas?.[0]?.es || '';
    const f = data.followups?.[0]?.es || '';
    preview.textContent = [f, h, p, 'Soy Zayne, de YQN. ' + pf, c, 'Saludos,\n--\n金颖哲 Zayne Jin | YQN'].filter(Boolean).join('\n\n');
  };
  updatePreview();
  panel.querySelectorAll('textarea').forEach(ta => ta.addEventListener('input', updatePreview));

  document.getElementById('btn-save-stage')?.addEventListener('click', () => {
    if (!confirm('确定保存该阶段句库修改？')) return;
    panel.querySelectorAll('.tmpl-sentence').forEach(el => {
      const key = el.dataset.key, idx = parseInt(el.dataset.index);
      const es = el.querySelector('.ts-es')?.value || '';
      const en = el.querySelector('.ts-en')?.value || '';
      if (stageData[key] && stageData[key][idx]) {
        stageData[key][idx].es = es;
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

const SIG_STORAGE_KEY = 'emailSignatures';
let signatures = [];
let currentSigId = null;

async function initSignature() {
  const saved = localStorage.getItem(SIG_STORAGE_KEY);
  signatures = saved ? JSON.parse(saved) : [{
    id: 'default',
    label: '默认签名',
    content: '金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\n📧 zayne_jin@trimanshipping.com | 📱 +86 18487665870 | 🌐 www.yqn.com'
  }];
  currentSigId = signatures[0]?.id || null;
  renderSigList();
  if (currentSigId) selectSig(currentSigId);
}

function renderSigList() {
  const container = document.getElementById('sig-items');
  if (!container) return;
  container.innerHTML = signatures.map(s => `
    <div class="sig-item${s.id === currentSigId ? ' active' : ''}" data-id="${s.id}">${escapeHtml(s.label)}</div>
  `).join('');
  container.querySelectorAll('.sig-item').forEach(el => {
    el.addEventListener('click', () => selectSig(el.dataset.id));
  });
}

function selectSig(id) {
  currentSigId = id;
  const sig = signatures.find(s => s.id === id);
  if (!sig) return;
  document.getElementById('sig-label').value = sig.label || '';
  document.getElementById('sig-content').innerHTML = sig.content || '';
  renderSigList();
}

document.getElementById('sig-add')?.addEventListener('click', () => {
  const sig = { id: Date.now().toString(36), label: '新签名', content: '' };
  signatures.push(sig);
  saveSignatures();
  selectSig(sig.id);
});

document.getElementById('sig-save')?.addEventListener('click', () => {
  const sig = signatures.find(s => s.id === currentSigId);
  if (!sig) return;
  sig.label = document.getElementById('sig-label')?.value || '未命名';
  sig.content = document.getElementById('sig-content')?.innerHTML || '';
  saveSignatures();
  renderSigList();
  alert('已保存');
});

document.getElementById('sig-delete')?.addEventListener('click', () => {
  if (!confirm('确定删除该签名？')) return;
  signatures = signatures.filter(s => s.id !== currentSigId);
  saveSignatures();
  currentSigId = signatures[0]?.id || null;
  renderSigList();
  if (currentSigId) selectSig(currentSigId);
  else { document.getElementById('sig-label').value = ''; document.getElementById('sig-content').innerHTML = ''; }
});

function saveSignatures() {
  localStorage.setItem(SIG_STORAGE_KEY, JSON.stringify(signatures));
}

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
  const type = document.getElementById('ws-type').value;
  const stage = document.getElementById('ws-stage').value;
  if (!templateLib) return;
  const painKey = type === 'agent' ? 'agent' : type === 'direct' ? 'direct' : 'unlabeled';
  populateSelect('ws-pain', templateLib.painPoints[painKey]);
  populateSelect('ws-proof', templateLib.proofs[type === 'agent' ? 'agent' : type === 'direct' ? 'direct' : 'unlabeled']);
  const fGroup = document.getElementById('followup-group');
  const fSel = document.getElementById('ws-followup');
  if (stage !== 'cold') {
    fGroup.style.display = 'block';
    populateSelect('ws-followup', templateLib.followUps?.[stage] || []);
  } else { fGroup.style.display = 'none'; }
}

async function updateWorkshop() {
  if (!templateLib) return;
  const type = document.getElementById('ws-type').value;
  const stage = document.getElementById('ws-stage').value;
  const painKey = type === 'agent' ? 'agent' : type === 'direct' ? 'direct' : 'unlabeled';
  const proofKey = painKey;

  const hook = findById(templateLib.hooks, document.getElementById('ws-hook')?.value);
  const pain = findById(templateLib.painPoints[painKey], document.getElementById('ws-pain')?.value);
  const proof = findById(templateLib.proofs[proofKey], document.getElementById('ws-proof')?.value);
  const cta = findById(templateLib.ctas, document.getElementById('ws-cta')?.value);
  const followup = stage !== 'cold' ? findById(templateLib.followUps?.[stage] || [], document.getElementById('ws-followup')?.value) : null;
  const company = document.getElementById('ws-company')?.value?.trim() || '';

  const subjects = await window.electronAPI.getSubjects(type);
  const esBody = assembleEmail('es', hook, pain, proof, cta, followup, company, stage);
  const enBody = assembleEmail('en', hook, pain, proof, cta, followup, company, stage);

  currentAssembled = { es: esBody, en: enBody, subject: subjects };
  document.getElementById('preview-subject').textContent = subjects[currentLang] || subjects.es || '';

  if (!isEditing) {
    document.getElementById('preview-body-es').textContent = esBody;
    document.getElementById('preview-body-en').textContent = enBody;
  }
  document.getElementById('preview-body-es').style.display = currentLang === 'es' ? 'block' : 'none';
  document.getElementById('preview-body-en').style.display = currentLang === 'en' ? 'block' : 'none';
  checkSpam(esBody, enBody);
}

function assembleEmail(lang, hook, pain, proof, cta, followup, company, stage) {
  const t = (item) => item ? (item[lang] || '') : '';
  const lines = [];
  if (stage !== 'cold' && followup) { lines.push(t(followup)); lines.push(''); }
  if (hook) lines.push(t(hook));
  if (company && stage === 'cold') {
    lines.push('');
    lines.push(lang === 'es' ? `Sé que ${company} importa regularmente.` : `I know ${company} imports regularly.`);
  }
  if (pain) { lines.push(''); lines.push(t(pain)); }
  lines.push('');
  const name = lang === 'es' ? 'Soy Zayne, de YQN.' : "I'm Zayne from YQN.";
  if (proof) lines.push(name + ' ' + t(proof)); else lines.push(name);
  if (stage === 'cold') {
    lines.push('');
    lines.push(lang === 'es'
      ? 'Si alguna vez tu operación actual enfrenta una demora o necesitas explorar alternativas, tener un respaldo probado puede ahorrarte semanas.'
      : 'If your current operation ever hits a delay or you need to explore alternatives, having proven backup can save you weeks.');
  }
  if (cta) { lines.push(''); lines.push(t(cta)); }
  lines.push('');
  lines.push(lang === 'es' ? 'Saludos,' : 'Best,');
  lines.push('--');
  lines.push('金颖哲 Zayne Jin | Overseas Sales · LatAm Desk');
  lines.push('YQN Logistics Technology Group');
  lines.push('📧 zayne_jin@trimanshipping.com | 📱 +86 18487665870 | 🌐 www.yqn.com');
  return lines.join('\n');
}

function checkSpam(esText, enText) {
  if (!templateLib?.spamWords) return;
  const esWords = templateLib.spamWords.es || [];
  const enWords = templateLib.spamWords.en || [];
  const esLower = esText.toLowerCase();
  const enLower = enText.toLowerCase();
  const foundEs = esWords.filter(w => esLower.includes(w.toLowerCase()));
  const foundEn = enWords.filter(w => enLower.includes(w.toLowerCase()));
  const allFound = [...new Set([...foundEs, ...foundEn])];
  const badge = document.getElementById('spam-badge');
  if (allFound.length > 0) {
    badge.textContent = `⚠️ 违规词: ${allFound.slice(0, 5).join(', ')}`;
    badge.className = 'spam-badge fail';
  } else {
    badge.textContent = '✅ 通过';
    badge.className = 'spam-badge pass';
  }
}

function toggleEdit() {
  isEditing = !isEditing;
  const esEl = document.getElementById('preview-body-es');
  const enEl = document.getElementById('preview-body-en');
  const btn = document.getElementById('ws-edit-toggle');
  if (isEditing) {
    btn.textContent = '✅ 保存编辑';
    esEl.innerHTML = `<textarea id="edit-es">${escapeHtml(currentAssembled.es)}</textarea>`;
    enEl.innerHTML = `<textarea id="edit-en">${escapeHtml(currentAssembled.en)}</textarea>`;
    document.getElementById('edit-es').addEventListener('input', onEditChange);
    document.getElementById('edit-en').addEventListener('input', onEditChange);
  } else {
    btn.textContent = '✏️ 编辑正文';
    const taEs = document.getElementById('edit-es');
    const taEn = document.getElementById('edit-en');
    if (taEs) currentAssembled.es = taEs.value;
    if (taEn) currentAssembled.en = taEn.value;
    esEl.textContent = currentAssembled.es;
    enEl.textContent = currentAssembled.en;
    checkSpam(currentAssembled.es, currentAssembled.en);
  }
  esEl.style.display = currentLang === 'es' ? 'block' : 'none';
  enEl.style.display = currentLang === 'en' ? 'block' : 'none';
}

function onEditChange() {
  const taEs = document.getElementById('edit-es');
  const taEn = document.getElementById('edit-en');
  if (taEs) currentAssembled.es = taEs.value;
  if (taEn) currentAssembled.en = taEn.value;
  checkSpam(currentAssembled.es, currentAssembled.en);
}

function addToQueue() {
  const recipients = getCheckedRecipients();
  if (!recipients.length) return alert('请选择公司并勾选至少一位联系人');
  const company = window._sendCompany || '未命名';

  randomizeTemplate();
  const body = currentAssembled[currentLang];
  const subject = currentAssembled.subject?.[currentLang] || currentAssembled.subject?.es || '';
  queue.push({ id: Date.now(), company, to: recipients.join(', '), recipients, subject, body, status: 'pending', addedAt: new Date().toISOString() });
  saveQueue();
  document.getElementById('stat-queue').textContent = queue.length;
  alert(`已加入队列: ${company} → ${recipients.length} 位联系人`);
}

function sendNow() {
  const recipient = document.getElementById('ws-recipient')?.value?.trim();
  if (!recipient) return alert('请填写收件人邮箱或从联系人中选择');
  const company = document.getElementById('ws-company')?.value?.trim() || '未命名';
  const body = currentAssembled[currentLang];
  const subject = currentAssembled.subject?.[currentLang] || currentAssembled.subject?.es || '';
  queue.push({ id: Date.now(), company, to: recipient, subject, body, status: 'pending', addedAt: new Date().toISOString() });
  saveQueue();
  navItems.forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="queue"]').classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById('page-queue').classList.add('active');
  renderQueue();
  startSend();
}

// ===== 发送队列 =======================================================
function saveQueue() { localStorage.setItem('emailQueue', JSON.stringify(queue)); }

function renderQueue() {
  const tbody = document.querySelector('#queue-table tbody');
  const empty = document.getElementById('queue-empty');
  if (!tbody) return;
  if (!queue.length) { tbody.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = queue.map((e, i) => {
    const count = e.recipients?.length || (e.to?.split(',')?.length || 1);
    return `
    <tr>
      <td>${i + 1}</td><td>${escapeHtml(e.company)}</td><td>${count} 位收件人</td>
      <td>${escapeHtml(e.subject)}</td><td class="status-${e.status}">${statusLabel(e.status)}</td>
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
  pending.forEach(e => { e.status = 'sending'; });
  renderQueue();
  document.getElementById('queue-start').disabled = true;
  document.getElementById('queue-pause').disabled = false;
  if (unsubscribeProgress) unsubscribeProgress();
  unsubscribeProgress = await window.electronAPI.onSendProgress((data) => {
    if (data.type === 'sent') {
      const item = queue.find(e => e.company === data.company && e.status === 'sending');
      if (item) item.status = 'sent';
    } else if (data.type === 'failed') {
      const item = queue.find(e => e.company === data.company && e.status === 'sending');
      if (item) item.status = 'failed';
    } else if (data.type === 'complete' || data.type === 'paused' || data.type === 'limit') {
      sendInProgress = false;
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
    }
    const sent = queue.filter(e => e.status === 'sent' || e.status === 'failed').length;
    document.getElementById('queue-progress').style.width = queue.length > 0 ? Math.round((sent / queue.length) * 100) + '%' : '0%';
    renderQueue();
    saveQueue();
  });
  window.electronAPI.startSend(pending);
}

document.getElementById('queue-start')?.addEventListener('click', startSend);
document.getElementById('queue-pause')?.addEventListener('click', async () => {
  await window.electronAPI.pauseSend();
  sendInProgress = false;
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  renderQueue();
});
document.getElementById('queue-clear')?.addEventListener('click', () => {
  queue = queue.filter(e => e.status === 'pending' || e.status === 'sending');
  saveQueue();
  renderQueue();
  document.getElementById('queue-progress').style.width = '0%';
  document.getElementById('stat-queue').textContent = queue.length;
});

// ===== 工具函数 ======================================================
function findById(arr, id) { return arr?.find(i => i.id === id); }
function truncate(str, len) { return str?.length > len ? str.slice(0, len) + '...' : str; }
function escapeHtml(str) { return str?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || ''; }
function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// 轻量 Markdown → HTML（处理表格/标题/粗体/列表/分隔线）
function ratingStars(n) { return '⭐'.repeat(Math.min(5, Math.max(1, n))); }

async function pollBackcheckStatus(companyName, onDone) {
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await window.electronAPI.getBackcheckStatus();
    const s = st[companyName];
    // 完成或回落Claude都刷新
    if (s?.status === 'done' || s?.status === 'pending_claude') { onDone(); return; }
    // 超过60秒卡死检测
    if (i > 30 && s?.status === 'researching') {
      // 可能卡死了，标记为 pending_claude
      await window.electronAPI.markBackcheckDone(companyName, 0);
      onDone(); return;
    }
  }
  onDone(); // 90秒超时也刷新
}

function renderMarkdown(md) {
  let html = escapeHtml(md);
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:16px 0 8px;color:var(--primary)">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:20px 0 10px;color:var(--primary)">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="margin:24px 0 12px;color:var(--primary)">$1</h2>');
  // 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 水平线
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0">');
  // 表格：检测连续的 | 行
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 2) return match;
    // 跳过分隔行
    const dataLines = lines.filter(l => !/^\|[\s:\-|]+\|$/.test(l));
    let tableHtml = '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px">';
    dataLines.forEach((line, i) => {
      const cells = line.split('|').filter(c => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      const style = i === 0 ? 'background:#f8f9fb;font-weight:600;text-align:left;padding:8px 12px;border-bottom:1px solid var(--border)' : 'padding:8px 12px;border-bottom:1px solid var(--border)';
      tableHtml += '<tr>' + cells.map(c => `<${tag} style="${style}">${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
  });
  // 无序列表
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:20px">$1</li>');
  // 换行
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');
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

// ===== 初始化 ========================================================
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  console.log('🚀 Prospecting Email v1.2 已就绪');
});
