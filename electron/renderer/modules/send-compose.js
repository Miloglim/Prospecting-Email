// ── 邮件发送 — 阶段卡片点击选中 ────────────────────────────────────────
const S = window.S;
import { lucide, showToast, escapeHtml, countryToLang, daysSince } from './shared.js';
import { randomPick, assembleEmail, matchUserTemplates } from './templates.js';
import { saveQueue } from './send-queue.js';
import CS from './company-state.js';

const STAGES = [
  { key: 'cold', label: '冷开发', color: '#9e9e9e' },
  { key: 'f1', label: 'F1', color: '#2196f3' },
  { key: 'f2', label: 'F2', color: '#ff9800' },
  { key: 'f3', label: 'F3', color: '#8e24aa' },
  { key: 'f4', label: 'F4', color: '#4caf50' },
  { key: 'reached', label: '已触达', color: '#9e9e9e', disabled: true },
  { key: 'autoreply', label: '自动回复', color: '#e6a817' },
];

const STAGE_MAP = {};
STAGES.forEach(s => STAGE_MAP[s.key] = s);

let _addedStages = [];

// ── 初始化 ────────────────────────────────────────────────────────────────
export async function initEmailSend() {
  if (!S.templateLib) await CS.refreshTemplateLib();

  const tplBtn = document.getElementById('send-tpl-mode');
  if (tplBtn) {
    const config = await window.electronAPI.loadConfig().catch(() => ({}));
    const mode = config?.template?.mode || 'adaptive';
    tplBtn.dataset.mode = mode;
    tplBtn.textContent = mode === 'general' ? '用户模板' : '自适应';
    if (mode === 'general') tplBtn.classList.add('user');

    tplBtn.addEventListener('click', async () => {
      const cur = tplBtn.dataset.mode;
      const next = cur === 'general' ? 'adaptive' : 'general';
      tplBtn.dataset.mode = next;
      tplBtn.textContent = next === 'general' ? '用户模板' : '自适应';
      tplBtn.classList.toggle('user', next === 'general');
      const cfg = await window.electronAPI.loadConfig().catch(() => ({}));
      if (!cfg.template) cfg.template = {};
      cfg.template.mode = next;
      await window.electronAPI.saveConfig(cfg);
    });
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
  renderView();
}

export function renderSendView() { renderView(); }

function renderView() {
  renderStageCards();
  renderPreview();
}

// ── 从分类数据中提取阶段统计 ──────────────────────────────────────────────
function getStageData() {
  const cl = S.contactsClassified;
  if (!cl) return {};
  function entries(key) {
    const raw = cl.sending?.[key] || cl[key] || [];
    const isSideSection = key === 'reached' || key === 'autoreply';
    return raw.map(e => ({
      company: e.company || '',
      stageLabel: e.stageLabel || key,
      clientType: (e.contacts || e.members || [])[0]?.clientType || 'unlabeled',
      country: (e.contacts || e.members || [])[0]?.country || '',
      members: (e.members || e.contacts || []).filter(c => {
        if (isSideSection) return c.email && !c.email.endsWith('@no.email');
        return c.ok !== false && !c.sent && c.email && !c.email.endsWith('@no.email');
      }),
      sendableCount: e.sendableCount || 0,
      sentCount: e.sentCount || 0,
      contactCount: e.contactCount || 0,
    })).filter(e => e.members.length > 0);
  }
  const data = {};
  for (const s of STAGES) data[s.key] = entries(s.key);
  return data;
}

// ── 阶段卡片（点击选中）──────────────────────────────────────────────────
function renderStageCards() {
  const container = document.getElementById('send-stage-cards');
  const summary = document.getElementById('send-summary');
  if (!container) return;
  const data = getStageData();

  container.innerHTML = STAGES.map(s => {
    const entries = data[s.key] || [];
    if (!entries.length) return '';
    const isSide = s.key === 'reached' || s.key === 'autoreply';
    const people = entries.reduce((sum, e) => sum + (isSide ? e.contactCount : e.members.length), 0);
    const selected = _addedStages.includes(s.key);
    const disabled = s.disabled;
    return `<div class="stage-card${disabled ? ' disabled' : ''}${selected ? ' used' : ''}" data-stage="${s.key}">
      <span class="sc-dot" style="background:${s.color}"></span>
      <span class="sc-stage">${s.label}</span>
      <div class="sc-count">${entries.length}家 · ${people}人</div>
    </div>`;
  }).join('');

  // 点击选中/取消
  container.querySelectorAll('.stage-card:not(.disabled)').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      const key = card.dataset.stage;
      if (_addedStages.includes(key)) {
        _addedStages = _addedStages.filter(k => k !== key);
      } else {
        _addedStages.push(key);
      }
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
      summary.textContent = `已选 ${_addedStages.length} 阶段 · ${totalPeople} 人`;
    } else {
      summary.textContent = '';
    }
  }
}

// ── 右侧：预览面板（JS 驱动展开/折叠）──────────────────────────────────
function renderPreview() {
  const list = document.getElementById('send-added-list');
  const head = document.getElementById('send-right-head');
  if (!list) return;

  if (!_addedStages.length) {
    list.innerHTML = '';
    if (head) head.textContent = '点击左侧阶段卡片选择';
    return;
  }

  const data = getStageData();
  let totalCompanies = 0, totalPeople = 0;
  _addedStages.forEach(key => {
    const entries = data[key] || [];
    totalCompanies += entries.length;
    totalPeople += entries.reduce((s, e) => s + e.members.length, 0);
  });

  if (head) head.textContent = `发送预览 · ${_addedStages.length}阶段 · ${totalCompanies}家 · ${totalPeople}人`;

  list.innerHTML = _addedStages.map(key => {
    const s = STAGE_MAP[key] || {};
    const entries = data[key] || [];
    const people = entries.reduce((sum, e) => sum + e.members.length, 0);
    const cRows = entries.map(e => {
      const lang = countryToLang(e.country);
      const langLabel = { es: 'ES', pt: 'PT', en: 'EN' }[lang] || lang;
      const tplLabel = document.getElementById('send-tpl-mode')?.dataset?.mode === 'general' ? '用户' : '自适应';
      const lastSent = daysSince(S.sendHistory?.[e.company]?.lastSent);
      return `<div class="pg-company">
        <span class="pg-cname">${escapeHtml(e.company)}</span>
        <span class="pg-ccount" style="color:var(--text-secondary)">${lastSent}</span>
        <span class="pg-cemail">${escapeHtml(e.country||'')} · ${langLabel} · ${tplLabel}</span>
        <span class="pg-ccount">${e.members.length}人</span>
      </div>`;
    }).join('');

    return `<div class="preview-group" data-stage="${key}">
      <div class="preview-group-head">
        <span class="pg-arrow">▶</span>
        <span class="pg-dot" style="background:${s.color||'#999'}"></span>
        <span class="pg-label">${s.label||key}</span>
        <span class="pg-count">${entries.length}家 · ${people}人</span>
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

// ── 加入发送队列 ──────────────────────────────────────────────────────────
async function addToQueue() {
  if (!_addedStages.length) { showToast('请先点击选择阶段', 'warn'); return; }

  const data = getStageData();
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const GROUP_SIZE = config?.schedule?.batch_size || 10;
  const tplMode = document.getElementById('send-tpl-mode')?.dataset?.mode || 'adaptive';
  const userTemplates = S._userTemplates || [];

  let totalAdded = 0, totalPeople = 0;

  for (const stageKey of _addedStages) {
    const entries = data[stageKey] || [];
    const targets = [];
    for (const e of entries) {
      for (const c of e.members) {
        targets.push({ ...c, company: e.company });
      }
    }
    if (!targets.length) continue;

    // 自动回复联系人：先重置为冷开发
    const isAutoreply = stageKey === 'autoreply';
    if (isAutoreply) {
      const emails = targets.map(c => c.email).filter(Boolean);
      if (emails.length) {
        await window.electronAPI.resetAutoreply(emails);
        // 更新内存：设为 cold 阶段，未发送
        targets.forEach(c => { c.stage = 'cold'; c.sent = false; });
      }
    }

    const stageLabel = isAutoreply ? 'cold' : (targets[0]?.stage || stageKey);

    const groups = [];
    for (let i = 0; i < targets.length; i += GROUP_SIZE) {
      groups.push(targets.slice(i, i + GROUP_SIZE));
    }

    for (const group of groups) {
      const first = group[0];
      const lang = countryToLang(first.country || '');

      let tplSource = 'preset', tplLabel = '自适应', subject, body;
      if (tplMode === 'general' && userTemplates.length) {
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
        _batchLabel: groups.length > 1 ? ` (${totalAdded + 1}/${groups.length})` : '',
        _recipientStatus: recipients.map(e => ({ email: e, status: 'pending' })),
      });
      totalAdded++; totalPeople += recipients.length;
    }
  }

  saveQueue();
  showToast(`已添加 ${totalAdded} 组 · ${totalPeople} 人`, 'ok');
  document.getElementById('stat-queue').textContent = S.queue.filter(e => e.status === 'pending').length;
  _addedStages = [];
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
