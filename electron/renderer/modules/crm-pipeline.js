// ── Prospector — CRM 漏斗管道 ──────────────────────────────────────────────
"use strict";

import { escapeHtml, lucide, showToast } from './shared.js';

const STAGES = [
  { stage: "触达中", color: "#ff9800" },
  { stage: "报价中", color: "#2196f3" },
  { stage: "试单", color: "#8e24aa" },
  { stage: "合作中", color: "#4caf50" },
  { stage: "已流失", color: "#d93025" },
];

let _pipelineData = null;   // { columns: [...] }
let _expandedStage = null;  // 当前展开的阶段名
let _currentDetailId = null;
let _reminderTimers = {};

// ═══════════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════════

export async function initCrmPipeline() {
  await refreshPipeline();

  const searchInput = document.getElementById('crm-search');
  const countrySelect = document.getElementById('crm-country-filter');

  if (searchInput) {
    let _debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(() => refreshPipeline(), 300);
    });
  }
  if (countrySelect) {
    countrySelect.addEventListener('change', () => refreshPipeline());
  }

  window.electronAPI.onCrmChanged(() => refreshPipeline());
  setInterval(() => checkReminders(), 5 * 60 * 1000);
  checkReminders();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 漏斗渲染
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshPipeline() {
  const container = document.getElementById('crm-pipeline');
  if (!container) return;

  const search = document.getElementById('crm-search')?.value?.trim() || '';
  const country = document.getElementById('crm-country-filter')?.value || '';

  const r = await window.electronAPI.crmListPipeline({ search, country });
  if (!r.ok) {
    container.innerHTML = `<div class="crm-empty">加载失败: ${escapeHtml(r.error)}</div>`;
    return;
  }

  _pipelineData = r.data;
  const { columns } = r.data;
  const maxCount = Math.max(...columns.map(c => c.contacts.length), 1);
  const hasAny = columns.some(c => c.contacts.length > 0);

  if (!hasAny) {
    container.innerHTML = `<div class="crm-empty">
      <p>暂无跟进中的客户</p>
      <p style="font-size:12px;color:var(--text-secondary)">发送邮件后，已触达的客户会自动出现在这里</p>
    </div>`;
    document.getElementById('crm-detail-panel').style.display = 'none';
    return;
  }

  container.innerHTML = `
    <div class="funnel-section">
      ${columns.map(col => {
        const pct = Math.max(Math.round((col.contacts.length / maxCount) * 100), 15);
        const isExpanded = _expandedStage === col.stage;
        const stageDef = STAGES.find(s => s.stage === col.stage) || { color: '#999' };
        return `
          <div class="funnel-row ${isExpanded ? 'expanded' : ''}" data-stage="${col.stage}">
            <div class="funnel-bar" style="width:${pct}%;background:${stageDef.color}15;border-left:3px solid ${stageDef.color}" data-stage="${col.stage}">
              <span class="funnel-dot" style="background:${stageDef.color}"></span>
              <span class="funnel-label">${col.label}</span>
              <span class="funnel-count">${col.contacts.length}</span>
              <span class="funnel-arrow">${lucide(isExpanded ? 'chevron-down' : 'chevron-right', 14)}</span>
            </div>
            ${isExpanded ? renderContactList(col) : ''}
          </div>`;
      }).join('')}
    </div>
  `;

  // 点击漏斗条展开/收起
  container.querySelectorAll('.funnel-bar').forEach(bar => {
    bar.addEventListener('click', () => {
      const stage = bar.dataset.stage;
      _expandedStage = _expandedStage === stage ? null : stage;
      refreshPipeline();
    });
  });

  // 点击联系人行
  container.querySelectorAll('.funnel-contact-row').forEach(row => {
    row.addEventListener('click', () => {
      const contactId = row.dataset.contactId;
      openDetailPanel(contactId);
      container.querySelectorAll('.funnel-contact-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });
  });

  // 阶段切换
  container.querySelectorAll('.funnel-stage-select').forEach(sel => {
    sel.addEventListener('click', async (e) => {
      e.stopPropagation();
      const contactId = sel.dataset.contactId;
      const currentStage = sel.dataset.stage;
      showStagePicker(sel, contactId, currentStage);
    });
  });

  // 恢复详情面板
  if (_currentDetailId) {
    const activeRow = container.querySelector(`.funnel-contact-row[data-contact-id="${_currentDetailId}"]`);
    if (activeRow) activeRow.classList.add('active');
    else closeDetailPanel();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 展开后的联系人列表
// ═══════════════════════════════════════════════════════════════════════════════

function renderContactList(col) {
  const contacts = col.contacts;
  if (!contacts.length) {
    return `<div class="funnel-contact-list"><div class="funnel-contact-empty">该阶段暂无联系人</div></div>`;
  }
  return `
    <div class="funnel-contact-list">
      ${contacts.map(c => {
        const reminder = c._extra?.crmReminder;
        const nextAt = reminder?.nextFollowupAt;
        let timeHtml = '';
        if (nextAt) {
          const t = new Date(nextAt).getTime();
          const overdue = t <= Date.now();
          const soon = !overdue && t <= Date.now() + 24 * 3600 * 1000;
          timeHtml = `<span class="funnel-time ${overdue ? 'overdue' : soon ? 'soon' : ''}">${overdue ? '⏰ 逾期' : soon ? '⏰ ' + fmtDate(nextAt) : '📅 ' + fmtDate(nextAt)}</span>`;
        }
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '—';
        const color = STAGES.find(s => s.stage === col.stage)?.color || '#999';
        return `
          <div class="funnel-contact-row" data-contact-id="${c.id}">
            <span class="funnel-contact-name">${escapeHtml(name)}</span>
            <span class="funnel-contact-company">${escapeHtml(c.company || '—')}</span>
            <span class="funnel-contact-country">${escapeHtml(c.country || '')}</span>
            ${timeHtml}
            <span class="funnel-stage-select" data-contact-id="${c.id}" data-stage="${col.stage}" style="background:${color}15;color:${color}" title="切换阶段">● ${col.stage}</span>
          </div>`;
      }).join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 阶段选择器
// ═══════════════════════════════════════════════════════════════════════════════

function showStagePicker(anchor, contactId, currentStage) {
  document.getElementById('stage-picker-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'stage-picker-popup';
  popup.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';
  const rect = anchor.getBoundingClientRect();
  popup.style.left = Math.min(rect.left, window.innerWidth - 160) + 'px';
  popup.style.top = (rect.bottom + 4 > window.innerHeight - 200 ? rect.top - 200 : rect.bottom + 4) + 'px';

  popup.innerHTML = STAGES.map(s => {
    const isCurrent = s.stage === currentStage;
    return `<div style="padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;${isCurrent ? 'font-weight:600' : ''}" data-stage="${s.stage}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'">
      <span style="width:7px;height:7px;border-radius:50%;background:${s.color};flex-shrink:0"></span>${isCurrent ? ' ✓' : ''} ${s.stage}
    </div>`;
  }).join('');

  popup.querySelectorAll('[data-stage]').forEach(div => {
    div.addEventListener('click', async () => {
      const newStage = div.dataset.stage;
      popup.remove();
      if (newStage === currentStage) return;
      const r = await window.electronAPI.crmSetStage(contactId, newStage);
      if (r.ok) {
        showToast(`已移至「${newStage}」`, 'ok');
        await refreshPipeline();
      } else {
        showToast(r.error || '操作失败', 'err');
      }
    });
  });

  document.body.appendChild(popup);
  const close = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 详情面板（保持不变）
// ═══════════════════════════════════════════════════════════════════════════════

async function openDetailPanel(contactId) {
  _currentDetailId = contactId;
  const panel = document.getElementById('crm-detail-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  panel.innerHTML = `<div class="crm-detail-loading">${lucide('loader-2', 16, 'spin')} 加载中...</div>`;

  const r = await window.electronAPI.crmGetDetail(contactId);
  if (!r.ok) {
    panel.innerHTML = `<div class="crm-detail-error">加载失败: ${escapeHtml(r.error)}</div>`;
    return;
  }

  const { contact, notes, interactions } = r.data;
  const prefs = contact._extra?.crmPreferences || {};
  const reminder = contact._extra?.crmReminder || {};

  panel.innerHTML = `
    <div class="crm-detail-header">
      <span class="crm-detail-name">${escapeHtml([contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email)}</span>
      <button id="crm-detail-close" class="crm-detail-close-btn">${lucide('x', 16)}</button>
    </div>
    <div class="crm-detail-tabs">
      <button class="crm-tab active" data-tab="info">基本信息</button>
      <button class="crm-tab" data-tab="prefs">偏好设置</button>
      <button class="crm-tab" data-tab="reminder">跟进提醒</button>
      <button class="crm-tab" data-tab="timeline">时间线</button>
    </div>
    <div class="crm-detail-body">
      <div class="crm-tab-content active" data-content="info">${renderInfoTab(contact)}</div>
      <div class="crm-tab-content" data-content="prefs">${renderPrefsTab(contactId, prefs)}</div>
      <div class="crm-tab-content" data-content="reminder">${renderReminderTab(contactId, reminder)}</div>
      <div class="crm-tab-content" data-content="timeline">${renderTimelineTab(contactId, notes, interactions)}</div>
    </div>
  `;

  // Tab 切换
  panel.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = panel.querySelector(`[data-content="${tab.dataset.tab}"]`);
      if (target) target.classList.add('active');
    });
  });

  document.getElementById('crm-detail-close')?.addEventListener('click', closeDetailPanel);

  // 偏好保存
  panel.querySelectorAll('.crm-pref-input').forEach(input => {
    let _debounce;
    input.addEventListener('change', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(async () => {
        const prefs = {};
        panel.querySelectorAll('.crm-pref-input').forEach(el => {
          const key = el.dataset.prefKey;
          if (key === 'cargoTypes' && el.type === 'checkbox') {
            if (el.checked) prefs[key] = [...(prefs[key] || []), el.value];
          } else if (key !== 'cargoTypes') {
            prefs[key] = el.value;
          }
        });
        const checkedCargo = panel.querySelectorAll('.crm-pref-input[data-pref-key="cargoTypes"]:checked');
        if (checkedCargo.length) prefs.cargoTypes = [...checkedCargo].map(cb => cb.value);
        await window.electronAPI.crmUpdateExtra(contactId, { crmPreferences: prefs });
      }, 300);
    });
  });

  // 提醒保存
  panel.querySelectorAll('.crm-reminder-input').forEach(input => {
    input.addEventListener('change', async () => {
      const patch = {};
      panel.querySelectorAll('.crm-reminder-input').forEach(el => { patch[el.dataset.remKey] = el.value; });
      const r = await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: patch });
      if (r.ok) { scheduleReminderTimer(contactId, patch.nextFollowupAt); showToast('提醒已更新', 'ok'); }
    });
  });

  // 备注
  const noteBtn = panel.querySelector('#crm-add-note-btn');
  const noteInput = panel.querySelector('#crm-note-input');
  if (noteBtn && noteInput) {
    noteBtn.addEventListener('click', async () => {
      const content = noteInput.value.trim();
      if (!content) return;
      const r2 = await window.electronAPI.crmSaveNote(contactId, content);
      if (r2.ok) {
        noteInput.value = '';
        showToast('备注已保存', 'ok');
        const detail = await window.electronAPI.crmGetDetail(contactId);
        if (detail.ok) {
          const tl = panel.querySelector('[data-content="timeline"]');
          if (tl) tl.innerHTML = renderTimelineTab(contactId, detail.data.notes, detail.data.interactions);
        }
      }
    });
  }
}

function closeDetailPanel() {
  _currentDetailId = null;
  const panel = document.getElementById('crm-detail-panel');
  if (panel) panel.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab 渲染
// ═══════════════════════════════════════════════════════════════════════════════

function renderInfoTab(contact) {
  const rows = [
    ['姓名', [contact.firstName, contact.lastName].filter(Boolean).join(' ')],
    ['邮箱', contact.email], ['公司', contact.company],
    ['国家', contact.country], ['职位', contact.title || contact.position],
    ['电话', contact.phone], ['LinkedIn', contact.linkedin],
    ['阶段', contact.opp_stage || contact._status],
  ];
  return rows.map(([l, v]) => `<div class="crm-field-row"><label>${l}</label><span>${escapeHtml(v || '—')}</span></div>`).join('');
}

function renderPrefsTab(contactId, prefs) {
  const ROUTES = ['南美西','南美东','加勒比','中美','墨西哥','欧洲','亚洲','非洲'];
  const ROLES = ['决策者','影响者','信息提供者'];
  const SENS = ['高','中','低'];
  const VOLS = ['<100TEU','100-500TEU','500-2000TEU','>2000TEU'];
  const CARGOS = ['普货','危险品','冷藏','超规'];
  const sel = (k, opts, cur) => `<select class="crm-pref-input" data-pref-key="${k}"><option value="">—</option>${opts.map(o => `<option value="${o}" ${o===cur?'selected':''}>${o}</option>`).join('')}</select>`;

  return `
    <div class="crm-field-row"><label>偏好航线</label>${sel('preferredRoutes', ROUTES, prefs.preferredRoutes)}</div>
    <div class="crm-field-row"><label>货物类型</label><div style="display:flex;flex-wrap:wrap;gap:4px">${CARGOS.map(ct => `<label style="font-size:11px;display:flex;align-items:center;gap:3px"><input type="checkbox" class="crm-pref-input" data-pref-key="cargoTypes" value="${ct}" ${(prefs.cargoTypes||[]).includes(ct)?'checked':''}>${ct}</label>`).join('')}</div></div>
    <div class="crm-field-row"><label>决策角色</label>${sel('decisionRole', ROLES, prefs.decisionRole)}</div>
    <div class="crm-field-row"><label>价格敏感度</label>${sel('priceSensitivity', SENS, prefs.priceSensitivity)}</div>
    <div class="crm-field-row"><label>偏好港口</label><input class="crm-pref-input" data-pref-key="preferredPorts" value="${escapeHtml(prefs.preferredPorts||'')}" placeholder="上海/宁波"></div>
    <div class="crm-field-row"><label>年货量</label>${sel('annualVolume', VOLS, prefs.annualVolume)}</div>
    <div class="crm-field-row"><label>备注</label><textarea class="crm-pref-input" data-pref-key="memo" rows="3" placeholder="自由备注...">${escapeHtml(prefs.memo||'')}</textarea></div>
  `;
}

function renderReminderTab(contactId, reminder) {
  const nextAt = reminder.nextFollowupAt || '';
  const note = reminder.followupNote || '';
  return `
    <div class="crm-field-row"><label>下次跟进日期</label><input type="datetime-local" class="crm-reminder-input" data-rem-key="nextFollowupAt" value="${escapeHtml(nextAt)}"></div>
    <div class="crm-field-row"><label>提醒备注</label><input class="crm-reminder-input" data-rem-key="followupNote" value="${escapeHtml(note)}" placeholder="如：确认报价、发合同"></div>
    ${nextAt ? `<div class="crm-field-row"><span style="font-size:11px;color:var(--text-secondary)">${isOverdue(nextAt)?'🔴 已逾期':isSoon(nextAt)?'🟠 即将到期':'🟢 正常'}</span></div>` : ''}
  `;
}

function renderTimelineTab(contactId, notes, interactions) {
  const items = [
    ...((notes||[]).map(n => ({ type:'note', time:n.created_at, content:n.content }))),
    ...((interactions||[]).map(i => ({ type:i.type, time:i.created_at, subject:i.subject, snippet:i.snippet }))),
  ].sort((a,b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 50);

  const listHtml = items.length ? items.map(item => `
    <div class="crm-timeline-item">
      <div class="crm-timeline-dot ${item.type==='note'?'is-note':''}"></div>
      <div class="crm-timeline-body">
        <div class="crm-timeline-time">${fmtDateTime(item.time)}</div>
        ${item.subject?`<div class="crm-timeline-subject">${escapeHtml(item.subject)}</div>`:''}
        <div class="crm-timeline-snippet">${escapeHtml(item.snippet||item.content||'')}</div>
      </div>
    </div>`).join('') : '<div style="color:var(--text-secondary);padding:12px;font-size:12px">暂无记录</div>';

  return listHtml + `
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
      <textarea id="crm-note-input" rows="2" placeholder="添加跟进备注..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px"></textarea>
      <button id="crm-add-note-btn" class="primary" style="font-size:12px;padding:6px 14px;margin-top:6px">保存备注</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 提醒管理
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleReminderTimer(contactId, nextAt) {
  if (_reminderTimers[contactId]) { clearTimeout(_reminderTimers[contactId]); delete _reminderTimers[contactId]; }
  if (!nextAt) return;
  const delay = new Date(nextAt).getTime() - Date.now();
  if (delay <= 0) return;
  _reminderTimers[contactId] = setTimeout(() => { refreshPipeline(); delete _reminderTimers[contactId]; }, delay);
}

async function checkReminders() {
  try {
    const r = await window.electronAPI.crmCheckReminders();
    if (!r.ok) return;
    const dot = document.getElementById('crm-nav-dot');
    if (dot) {
      const total = (r.data.due?.length || 0) + (r.data.overdue?.length || 0);
      dot.style.display = total > 0 ? 'inline-block' : 'none';
      dot.textContent = total > 9 ? '9+' : String(total);
    }
  } catch { /* 静默 */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════════════════════

function fmtDate(iso) { try { const d = new Date(iso); return `${d.getMonth()+1}/${d.getDate()}`; } catch { return ''; } }
function fmtDateTime(iso) { try { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; } catch { return iso||''; } }
function isOverdue(iso) { try { return new Date(iso).getTime() <= Date.now(); } catch { return false; } }
function isSoon(iso) { try { return new Date(iso).getTime() <= Date.now() + 24*3600*1000; } catch { return false; } }

// ── 页面处理器 ──────────────────────────────────────────────────────────────
window.__pageHandlers = window.__pageHandlers || {};
window.__pageHandlers['crm'] = initCrmPipeline;
