// ── 邮件发送 — 时间桶卡片点击选中 ────────────────────────────────────────
const S = window.S;
import { lucide, showToast, escapeHtml, countryToLang, daysSince } from './shared.js';
import { randomPick, assembleEmail, matchUserTemplates } from './templates.js';
import { saveQueue } from './send-queue.js';
import CS, { TIME_BUCKETS, STAGE_COLORS, STAGE_LABELS } from './company-state.js';

const BUCKET_MAP = {};
TIME_BUCKETS.forEach(s => BUCKET_MAP[s.key] = s);

// reached 和 autoreply 不算时间桶，手动补
const EXTRA_SECTIONS = [
  { key: 'autoreply', label: '自动回复', color: '#e6a817' },
];
const DISABLED_SECTIONS = [
  { key: 'invalid', label: '异常邮箱', color: '#e5484d', disabled: true },
  { key: 'reached', label: '已触达', color: '#9e9e9e' },
];
let _tplMode = 'adaptive'; // 'adaptive' | 'general' | 'custom'
const ALL_SECTIONS = [...TIME_BUCKETS, ...EXTRA_SECTIONS, ...DISABLED_SECTIONS];
const SECTION_MAP = {};
ALL_SECTIONS.forEach(s => SECTION_MAP[s.key] = s);

let _addedStages = [];
let _dailyRemaining = Infinity; // 每日剩余额度，点击卡片时实时比对

// ── 自订信息编辑器 ──────────────────────────────────────────────────────────
function _openCustomEditor() {
  S._customContent = S._customContent || { subject: '', body: '' };
  const overlay = document.createElement('div');
  overlay.className = 'custom-editor-overlay';
  overlay.innerHTML = `<div class="custom-editor-card">
    <div class="ce-header">
      <span>编辑固定发送内容</span>
      <button class="ce-close">${lucide('x', 16)}</button>
    </div>
    <div class="ce-body">
      <input class="ce-subject" placeholder="邮件主题" value="${escapeHtml(S._customContent.subject || '')}">
      <div class="ce-editor" contenteditable="true">${S._customContent.body || ''}</div>
    </div>
    <div class="ce-footer">
      <button class="btn-sec ce-cancel">取消</button>
      <button class="send-btn-primary ce-save" style="width:auto;padding:5px 20px">保存</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.ce-close')?.addEventListener('click', close);
  overlay.querySelector('.ce-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelector('.ce-save')?.addEventListener('click', async () => {
    S._customContent.subject = overlay.querySelector('.ce-subject')?.value || '';
    S._customContent.body = overlay.querySelector('.ce-editor')?.innerHTML || '';
    // 持久化到 config
    try {
      const cfg = await window.electronAPI.loadConfig().catch(() => ({}));
      if (!cfg.template) cfg.template = {};
      cfg.template.customContent = { ...S._customContent };
      await window.electronAPI.saveConfig(cfg);
    } catch { /* 静默 */ }
    close();
    showToast('固定内容已保存', 'ok');
  });
}

// ── 初始化 ────────────────────────────────────────────────────────────────
export async function initEmailSend() {
  // ── 三态切换：自适应 / 用户模板 / 自订信息 ──
  const MODES = ['adaptive', 'general', 'custom'];
  const MODE_LABELS = { adaptive: '自适应', general: '用户模板', custom: '自订信息' };
  const tplBtn = document.getElementById('send-tpl-mode');
  const customDrawer = document.getElementById('send-custom-drawer');
  const customEditBtn = document.getElementById('send-custom-edit');

  // 读取上次模式 + 自订内容
  try {
    const config = await window.electronAPI.loadConfig().catch(() => ({}));
    _tplMode = MODES.includes(config?.template?.mode) ? config.template.mode : 'adaptive';
    if (config?.template?.customContent) {
      S._customContent = config.template.customContent;
    }
  } catch { /* 降级 */ }

  function _applyMode(mode) {
    _tplMode = mode;
    tplBtn.dataset.mode = mode;
    tplBtn.textContent = MODE_LABELS[mode];
    tplBtn.classList.toggle('user', mode === 'general');
    tplBtn.classList.toggle('custom', mode === 'custom');
    // 自订模式抽屉
    if (customDrawer) customDrawer.classList.toggle('open', mode === 'custom');
    // 保存
    try {
      window.electronAPI.loadConfig().then(cfg => {
        if (!cfg.template) cfg.template = {};
        cfg.template.mode = mode;
        window.electronAPI.saveConfig(cfg);
      }).catch(() => {});
    } catch { /* 静默 */ }
    renderView();
  }
  _applyMode(_tplMode);

  if (tplBtn) {
    tplBtn.addEventListener('click', () => {
      const idx = MODES.indexOf(_tplMode);
      _applyMode(MODES[(idx + 1) % MODES.length]);
    });
  }

  // 自订编辑按钮 → 弹出内容编辑窗
  if (customEditBtn) {
    customEditBtn.addEventListener('click', () => _openCustomEditor());
  }

  if (!S.templateLib) {
    try { await CS.refreshTemplateLib(); } catch { /* 降级 */ }
  }

  try { S._userTemplates = await window.electronAPI.listUserTemplates(); } catch { S._userTemplates = []; }

  await loadSendContacts();

  document.getElementById('send-clear')?.addEventListener('click', clearAdded);
  document.getElementById('send-add-queue')?.addEventListener('click', addToQueue);
}

export async function loadSendContacts() {
  await CS.refreshContacts();
  await CS.refreshSendHistory();
  const byName = {};
  for (const c of S.contactsData) {
    const name = c.company || c.company_name || '';
    if (!name) continue;
    if (!byName[name]) byName[name] = [];
    byName[name].push(c);
  }
  S.sendCompanies = byName;
  if (!S.contactsClassified) await CS.syncContactsUI();
  // 刷新每日剩余额度（直接读仪表盘）
  try {
    const stats = await window.electronAPI.getDashboardStats();
    _dailyRemaining = stats.remaining ?? 0;
  } catch { _dailyRemaining = Infinity; }
  renderView();
}

export async function renderSendView() {
  try {
    const stats = await window.electronAPI.getDashboardStats();
    _dailyRemaining = stats.remaining ?? 0;
  } catch { _dailyRemaining = Infinity; }
  await CS.refreshSendHistory();
  await CS.syncContactsUI();
  renderView();
}

function renderView() {
  renderStageCards();
  renderPreview();
}

// ── 从分类数据中按时间桶提取统计 ────────────────────────────────────────────
function getBucketData() {
  const cl = S.contactsClassified;
  if (!cl) return {};
  function entries(key) {
    const raw = cl.sending?.[key] || cl[key] || [];
    const isSide = key === 'reached' || key === 'autoreply';
    return raw.map(e => ({
      company: e.company || '',
      stageLabel: e.stageLabel || key,
      clientType: (e.contacts || e.members || [])[0]?.clientType || 'unlabeled',
      country: (e.contacts || e.members || [])[0]?.country || '',
      members: (e.members || e.contacts || []).filter(c => {
        if (isSide) return c.email && !c.email.endsWith('@no.email');
        return c.ok !== false && c.email && !c.email.endsWith('@no.email');
      }),
      sendableCount: e.sendableCount || 0,
      contactCount: e.contactCount || 0,
    })).filter(e => e.members.length > 0);
  }
  const data = {};
  for (const s of ALL_SECTIONS) data[s.key] = entries(s.key);
  return data;
}

// ── 时间桶卡片（点击选中）──────────────────────────────────────────────────
function renderStageCards() {
  const container = document.getElementById('send-stage-cards');
  const summary = document.getElementById('send-summary');
  if (!container) return;
  const data = getBucketData();

  container.innerHTML = ALL_SECTIONS.map(s => {
    const entries = data[s.key] || [];
    if (!entries.length) return '';
    const isSide = s.key === 'reached' || s.key === 'autoreply';
    const people = entries.reduce((sum, e) => sum + (isSide ? e.contactCount : e.members.length), 0);
    const selected = _addedStages.includes(s.key);
    // 自订模式下已触达可选取
    let disabled = s.disabled || (s.key === 'reached' && _tplMode !== 'custom');
    return `<div class="stage-card${disabled ? ' disabled' : ''}${selected ? ' used' : ''}" data-stage="${s.key}">
      <span class="sc-dot" style="background:${s.key === 'reached' && !disabled ? '#2196f3' : s.color}"></span>
      <span class="sc-stage">${s.label}</span>
      <div class="sc-count">${entries.length}家 · ${people}人</div>
    </div>`;
  }).join('');

  // 点击选中/取消（实时比对剩余额度）
  container.querySelectorAll('.stage-card:not(.disabled)').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const key = card.dataset.stage;
      if (_addedStages.includes(key)) {
        _addedStages = _addedStages.filter(k => k !== key);
        renderView();
        return;
      }
      // 已满额则拒绝后续加入
      const curPeople = _addedStages.reduce((s, k) => s + (data[k] || []).reduce((ss, e) => ss + e.members.length, 0), 0);
      if (_dailyRemaining !== Infinity && curPeople >= _dailyRemaining) {
        showToast(`额度已满：已选 ${curPeople} 人，剩余 ${_dailyRemaining} 人`, 'warn');
        return;
      }
      _addedStages.push(key);
      renderView();
    });
  });

  // 底部汇总
  if (summary) {
    if (_addedStages.length) {
      let totalPeople = 0;
      _addedStages.forEach(key => {
        const entries = data[key] || [];
        totalPeople += entries.reduce((s, e) => s + e.members.length, 0);
      });
      const capped = _dailyRemaining !== Infinity ? Math.min(totalPeople, _dailyRemaining) : totalPeople;
      const limitStr = _dailyRemaining !== Infinity ? ` / 剩余${_dailyRemaining}人` : '';
      summary.textContent = `已选 ${_addedStages.length} 组 · ${capped} 人${limitStr}`;
    } else {
      summary.textContent = _dailyRemaining !== Infinity ? `今日剩余 ${_dailyRemaining} 人` : '';
    }
  }
}

// ── 右侧：预览面板（按额度截断）─────────────────────────────────────────
function renderPreview() {
  const list = document.getElementById('send-added-list');
  const head = document.getElementById('send-right-head');
  if (!list) return;

  if (!_addedStages.length) {
    list.innerHTML = '';
    if (head) head.textContent = '点击左侧卡片选择';
    return;
  }

  const data = getBucketData();

  // 收集所有选中桶的展平联系人列表，按阶段优先级排序
  const STAGE_ORDER = { f4: 5, f3: 4, f2: 3, f1: 2, cold: 1 };
  let rawContacts = [];
  for (const key of _addedStages) {
    for (const e of (data[key] || [])) {
      for (const c of e.members) {
        rawContacts.push({ contact: c, company: e.company, country: e.country, bucket: key });
      }
    }
  }
  rawContacts.sort((a, b) => (STAGE_ORDER[b.contact.stage] || 0) - (STAGE_ORDER[a.contact.stage] || 0));

  const rawTotal = rawContacts.length;
  const limit = _dailyRemaining !== Infinity ? _dailyRemaining : rawTotal;
  const cappedPeople = Math.min(rawTotal, limit);

  if (head) head.textContent = `发送预览 · ${_addedStages.length}组 · ${cappedPeople}人${rawTotal > limit ? `（${rawTotal}人中截断）` : ''}`;

  // 按额度截断，按公司重新分组
  let remaining = limit;
  const compMap = new Map(); // company → { members, country, bucket }
  for (const { contact, company, country, bucket } of rawContacts) {
    if (remaining <= 0) break;
    const key = company + '|' + bucket;
    if (!compMap.has(key)) compMap.set(key, { company, country, bucket, members: [], _origCount: 0 });
    const ce = compMap.get(key);
    ce.members.push(contact);
    remaining--;
  }
  // 算原始总数
  for (const key of _addedStages) {
    for (const e of (data[key] || [])) {
      const mk = e.company + '|' + key;
      if (compMap.has(mk)) compMap.get(mk)._origCount = e.members.length;
    }
  }
  const truncatedEntries = [...compMap.values()];

  list.innerHTML = _addedStages.map(key => {
    const s = SECTION_MAP[key] || {};
    const bucketEntries = truncatedEntries.filter(e => {
      // 找到属于此桶的条目（通过原始数据查找）
      return (data[key] || []).some(orig => orig.company === e.company);
    });
    if (!bucketEntries.length) return '';
    const people = bucketEntries.reduce((sum, e) => sum + e.members.length, 0);

    const cRows = bucketEntries.map(e => {
      const lang = countryToLang(e.country);
      const langLabel = { es: 'ES', pt: 'PT', en: 'EN' }[lang] || lang;
      const curMode = _tplMode;
      const tplLabel = curMode === 'custom' ? '自订' : (curMode === 'general' ? '用户' : '自适应');
      const lastSent = daysSince(S.sendHistory?.[e.company]?.lastSent);
      const stages = [...new Set(e.members.map(c => c.stage).filter(Boolean))];
      const stageTags = stages.map(st => `<span style="display:inline-block;background:${STAGE_COLORS[st]||'#999'};color:#fff;font-size:10px;padding:0 5px;border-radius:8px">${STAGE_LABELS[st]||st}</span>`).join('');
      const cutHint = e._origCount > e.members.length ? ` <span style="color:#e6a817;font-size:10px">(${e.members.length}/${e._origCount})</span>` : '';
      return `<div class="pg-company">
        <span class="pg-cname">${escapeHtml(e.company)}${stageTags ? ' ' + stageTags : ''}${cutHint}</span>
        <span class="pg-ccount" style="color:var(--text-secondary)">${lastSent}</span>
        <span class="pg-cemail">${escapeHtml(e.country||'')} · ${langLabel} · ${tplLabel}</span>
        <span class="pg-ccount">${e.members.length}人</span>
      </div>`;
    }).join('');

    return `<div class="preview-group" data-stage="${key}">
      <div class="preview-group-head">
        <span class="pg-arrow">▶</span>
        <span class="pg-label">${s.label||key}</span>
        <span class="pg-count">${bucketEntries.length}家 · ${people}人</span>
        <span class="pg-remove" data-stage="${key}">✕</span>
      </div>
      <div class="preview-group-body hidden">${cRows || '<div style="font-size:11px;color:#ccc">无可发联系人</div>'}</div>
    </div>`;
  }).join('');

  // JS 驱动展开/折叠
  list.querySelectorAll('.preview-group-head').forEach(h => {
    h.addEventListener('click', () => {
      const group = h.parentElement;
      const body = group.querySelector('.preview-group-body');
      if (body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        group.classList.add('open');
      } else {
        body.classList.add('hidden');
        group.classList.remove('open');
      }
    });
  });

  // 移除按钮
  list.querySelectorAll('.pg-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _addedStages = _addedStages.filter(k => k !== btn.dataset.stage);
      renderView();
    });
  });
}

function clearAdded() {
  _addedStages = [];
  renderView();
}

// ── 加入发送队列（按额度截断）────────────────────────────────────────────
async function addToQueue() {
  if (!_addedStages.length) { showToast('请先点击选择卡片', 'warn'); return; }

  const data = getBucketData();

  // 获取剩余额度
  let quota = _dailyRemaining;
  if (quota === Infinity) {
    try {
      const stats = await window.electronAPI.getDashboardStats();
      quota = stats.remaining ?? 0;
    } catch { quota = 9999; }
  }

  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const GROUP_SIZE = config?.schedule?.batch_size || 10;
  const userTemplates = S._userTemplates || [];
  // 初始化 S._customContent（防止 undefined）
  if (!S._customContent) S._customContent = { subject: '', body: '' };

  // 收集所有选中桶的全部联系人（按桶顺序、按公司顺序展平）
  let allTargets = [];
  for (const bucketKey of _addedStages) {
    const entries = data[bucketKey] || [];
    for (const e of entries) {
      // 自动回复联系人先标记
      const isAutoreply = bucketKey === 'autoreply';
      for (const c of e.members) {
        allTargets.push({ ...c, company: e.company, stage: c.stage || 'cold', _isAutoreply: isAutoreply });
      }
    }
  }

  // 处理自动回复重置
  const arEmails = allTargets.filter(c => c._isAutoreply).map(c => c.email).filter(Boolean);
  if (arEmails.length) {
    try { await window.electronAPI.resetAutoreply(arEmails); } catch { /* 静默 */ }
    allTargets.forEach(c => { if (c._isAutoreply) c.stage = 'cold'; });
  }

  // 按阶段优先级排序：高阶段优先（f4 > f3 > f2 > f1 > cold），确保跟进客户不被新手挤掉
  const STAGE_ORDER = { f4: 5, f3: 4, f2: 3, f1: 2, cold: 1 };
  allTargets.sort((a, b) => (STAGE_ORDER[b.stage] || 0) - (STAGE_ORDER[a.stage] || 0));

  const totalSelected = allTargets.length;

  // 按额度截断
  const added = allTargets.slice(0, quota);
  const cut = allTargets.length - added.length;

  if (!added.length) {
    showToast('今日额度已用完', 'warn');
    return;
  }

  // 取组内出现最多的 stage
  const _dominantStage = (contacts) => {
    const tally = {};
    for (const c of contacts) { const s = c.stage || 'cold'; tally[s] = (tally[s] || 0) + 1; }
    let best = 'cold', max = 0;
    for (const [s, n] of Object.entries(tally)) { if (n > max) { max = n; best = s; } }
    return best;
  };

  // 按 GROUP_SIZE 分组入队
  let totalAdded = 0, totalPeople = 0;
  for (let i = 0; i < added.length; i += GROUP_SIZE) {
    const group = added.slice(i, i + GROUP_SIZE);
    const first = group[0];
    const lang = countryToLang(first.country || '');
    const stageLabel = _dominantStage(group);

    let tplSource = 'preset', tplLabel = '自适应', subject, body;
    // ── 自订模式：统一使用预设内容 ──
    if (_tplMode === 'custom') {
      const cc = S._customContent || {};
      subject = (cc.subject || '').replace(/\{\{company\}\}/g, first.company).replace(/\{\{firstName\}\}/g, first.firstName);
      body = (cc.body || '').replace(/\{\{company\}\}/g, first.company).replace(/\{\{firstName\}\}/g, first.firstName);
      tplSource = 'custom'; tplLabel = '自订信息';
    } else if (_tplMode === 'general' && userTemplates.length) {
      const matched = matchUserTemplates(userTemplates, first.clientType, stageLabel, lang);
      if (matched.length) {
        const tpl = matched[Math.floor(Math.random() * matched.length)];
        subject = (tpl.subject || '').replace(/\{\{company\}\}/g, first.company).replace(/\{\{firstName\}\}/g, first.firstName);
        body = (tpl.body || '').replace(/\{\{company\}\}/g, first.company).replace(/\{\{firstName\}\}/g, first.firstName);
        tplSource = 'user'; tplLabel = tpl.name || '用户模板';
      }
    }
    if (!body) {
      const tpl = randomPick(first.clientType, stageLabel, []);
      const subs = S.templateLib?.subjects?.[first.clientType] || { es: '', pt: '', en: '' };
      subject = (subs[lang] || subs.es || subs.en || '').replace(/\{\{company\}\}/g, first.company).replace(/\{\{firstName\}\}/g, first.firstName);
      body = assembleEmail(lang, tpl.hook, tpl.pain, tpl.proof, tpl.cta, tpl.followup, stageLabel, first.clientType, config?.sender?.bodyName, first.firstName);
    }

    const recipients = group.map(c => c.email);
    S.queue.push({
      id: ++S.queueIdCounter, company: first.company, companyId: '',
      to: recipients.join(', '), recipients, subject, body, status: 'pending',
      addedAt: new Date().toISOString(),
      _stage: stageLabel, _type: first.clientType, _lang: lang,
      _country: first.country || '',
      _tplInfo: tplSource === 'user' ? 'user:tpl' : `${stageLabel}:auto`,
      _templateSource: tplSource, _templateLabel: tplLabel,
      _batchLabel: '',
      _recipientStatus: recipients.map(e => ({ email: e, status: 'pending' })),
    });
    totalAdded++; totalPeople += recipients.length;
  }

  saveQueue();
  const msg = cut > 0
    ? `已加入 ${totalPeople} 人（${totalSelected} 人中截断，${cut} 人因额度不足未加入）`
    : `已添加 ${totalAdded} 组 · ${totalPeople} 人`;
  showToast(msg, cut > 0 ? 'warn' : 'ok');
  document.getElementById('stat-queue').textContent = S.queue.filter(e => e.status === 'pending').length;
  _addedStages = [];
  // 刷新剩余额度
  _dailyRemaining = Math.max(0, quota - totalPeople);
  renderView();
  setTimeout(() => document.querySelector('[data-page="queue"]')?.click(), 300);
}

// ── 热更新 ────────────────────────────────────────────────────────────────
window.electronAPI.onHistoryChanged(() => {
  if (document.getElementById('page-email-send')?.classList.contains('active')) {
    CS.refreshSendHistory();
    CS.syncContactsUI().then(() => renderView());
  }
});

// ── 模板预览 ──────────────────────────────────────────────────────────────

const TPL_TYPES = { agent: '代理', direct: '直客', unlabeled: '未标签', general: '通用' };
const TPL_STAGES = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', general: '通用' };
const TPL_LANGS = { es: 'ES', pt: 'PT', general: '通用' };

export async function initTemplatePreview() {
  if (!S.templateLib) await CS.refreshTemplateLib();
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  let sigHtml = '';
  let sigAcctId = null; // null = 全局签名
  try { const r = await window.electronAPI.loadSignature(); if (r.ok) sigHtml = r.html; } catch { /* 渲染层降级 */ }

  // 签名列表
  let sigAccounts = [{ id: null, label: '全局签名' }];
  try {
    const ar = await window.electronAPI.getAccountStatus();
    if (ar.ok && ar.data) sigAccounts.push(...ar.data.filter(a => a.active).map(a => ({ id: a.id, label: a.label || a.email })));
  } catch { /* 降级 */ }

  async function loadSignature(acctId) {
    try { const r = await window.electronAPI.loadSignature(acctId); sigHtml = r.ok ? r.html : ''; } catch { sigHtml = ''; }
  }

  let selType = 'agent', selLang = 'es', selStage = 'cold', selSource = 'preset';

  function textToHtml(bodyText) {
    const lines = bodyText.split('\n');
    const htmlLines = [];
    let first = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const c = (first && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${escapeHtml(t)}</strong>` : escapeHtml(t);
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${c}</p>`);
      first = false;
    }
    return htmlLines.join('\n') + '\n<br>\n' + sigHtml;
  }

  const render = async () => {
    const content = document.getElementById('tpl-preview-content');
    if (!content) return;

    if (selSource === 'user') {
      const templates = await window.electronAPI.listUserTemplates().catch(() => []);
      const matched = matchUserTemplates(templates, selType, selStage, selLang);
      if (!matched.length) {
        content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-secondary)"><p style="font-size:14px">该类型/阶段暂无用户模板</p><p style="font-size:12px">请先在「模板工坊 → 用户模板」中创建</p></div>';
        return;
      }
      const tpl = matched[Math.floor(Math.random() * matched.length)];
      const html = textToHtml((tpl.body || '').replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim() || '(空白模板)');
      content.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:10px;color:var(--text-secondary)">${escapeHtml(tpl.name)} · ${TPL_TYPES[tpl.type] || tpl.type} · ${TPL_STAGES[tpl.stage] || tpl.stage} · ${TPL_LANGS[tpl.lang] || tpl.lang}</span>
        <select id="tpl-signature" style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-left:auto;width:auto">${sigAccounts.map(a => `<option value="${a.id||''}"${a.id===sigAcctId||(!a.id&&sigAcctId===null)?' selected':''}>${escapeHtml(a.label)}</option>`).join('')}</select>
      </div>
        <div style="margin-bottom:4px;font-size:11px;color:var(--primary)">${lucide('mail',12)} 主题：${escapeHtml(tpl.subject || '(无)')}</div>
        <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:4px">${html}</div>`;
      _bindSigSelector();
      return;
    }

    if (!S.templateLib) return;
    const picked = randomPick(selType, selStage, [], false);
    const email = assembleEmail(selLang, picked.hook, picked.pain, picked.proof, picked.cta, picked.followup, selStage, selType, config?.sender?.bodyName, undefined);
    const html = textToHtml(email);
    const srcLabels = [];
    if (picked.hook) srcLabels.push('Hook: ' + picked.hook.id);
    if (picked.pain) srcLabels.push('Pain: ' + picked.pain.id);
    if (picked.proof) srcLabels.push('Proof: ' + picked.proof.id);
    if (picked.cta) srcLabels.push('CTA: ' + picked.cta.id);
    if (picked.followup) srcLabels.push('FollowUp: ' + picked.followup.id);
    content.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:10px;color:var(--text-secondary)">${srcLabels.join(' · ')}</span>
      <select id="tpl-signature" style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-left:auto;width:auto">${sigAccounts.map(a => `<option value="${a.id||''}"${a.id===sigAcctId||(!a.id&&sigAcctId===null)?' selected':''}>${escapeHtml(a.label)}</option>`).join('')}</select>
    </div>
      <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:4px">${html}</div>`;
    _bindSigSelector();
  };

  function _bindSigSelector() {
    const sel = document.getElementById('tpl-signature');
    if (!sel || sel._bound) return;
    sel._bound = true;
    sel.addEventListener('change', async () => {
      sigAcctId = sel.value || null;
      await loadSignature(sigAcctId);
      render();
    });
  }

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
    document.querySelectorAll('.tpl-source').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-source').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selSource = b.dataset.val; render();
    }));
    document.getElementById('tpl-regenerate')?.addEventListener('click', () => render());
    if (document.getElementById('tpl-regenerate')) document.getElementById('tpl-regenerate')._bound = true;
  }
  render();
}

window.__pageHandlers['email-send'] = initEmailSend;
window.__pageHandlers['template-preview'] = initTemplatePreview;
