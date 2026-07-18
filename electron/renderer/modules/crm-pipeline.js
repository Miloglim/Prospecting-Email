// ── Prospector — CRM 看板管道 ──────────────────────────────────────────────
"use strict";

import { escapeHtml, lucide, showToast } from './shared.js';

const STAGE_COLORS = {
  "触达中": "#ff9800",
  "报价中": "#2196f3",
  "试单": "#8e24aa",
  "合作中": "#4caf50",
  "已流失": "#d93025",
};

let _currentDetailId = null;
let _reminderTimers = {}; // contactId → timeoutId

// ═══════════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════════

export async function initCrmPipeline() {
  await refreshPipeline();

  // 筛选栏
  const searchInput = document.getElementById('crm-search');
  const countrySelect = document.getElementById('crm-country-filter');

  if (searchInput) {
    let _debounceTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => refreshPipeline(), 300);
    });
  }

  if (countrySelect) {
    countrySelect.addEventListener('change', () => refreshPipeline());
  }

  // 监听变更事件（其他窗口修改了联系人）
  window.electronAPI.onCrmChanged(() => {
    refreshPipeline();
  });

  // 提醒轮询（每 5 分钟兜底）
  setInterval(() => checkReminders(), 5 * 60 * 1000);
  checkReminders();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 管道刷新
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

  const { columns } = r.data;
  const hasAny = columns.some(col => col.contacts.length > 0);

  if (!hasAny) {
    container.innerHTML = `<div class="crm-empty">
      <p>暂无跟进中的客户</p>
      <p style="font-size:12px;color:var(--text-secondary)">发送邮件后，已触达的客户会自动出现在这里</p>
    </div>`;
    return;
  }

  container.innerHTML = columns.map(col => renderColumn(col)).join('');

  // 点击卡片 → 打开详情
  container.querySelectorAll('.crm-card').forEach(card => {
    card.addEventListener('click', () => {
      const contactId = card.dataset.contactId;
      openDetailPanel(contactId);
      container.querySelectorAll('.crm-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // 阶段切换标签点击
  container.querySelectorAll('.crm-stage-tag').forEach(tag => {
    tag.addEventListener('click', async (e) => {
      e.stopPropagation();
      const contactId = tag.dataset.contactId;
      const currentStage = tag.dataset.stage;
      showStagePicker(tag, contactId, currentStage);
    });
  });

  // 恢复详情面板
  if (_currentDetailId) {
    const activeCard = container.querySelector(`.crm-card[data-contact-id="${_currentDetailId}"]`);
    if (activeCard) {
      activeCard.classList.add('active');
    } else {
      closeDetailPanel();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 渲染单列
// ═══════════════════════════════════════════════════════════════════════════════

function renderColumn(col) {
  const cards = col.contacts.map(c => renderCard(c, col.stage)).join('');
  return `
    <div class="crm-column">
      <div class="crm-col-header">
        <span class="crm-col-dot" style="background:${col.color}"></span>
        <span class="crm-col-label">${col.label}</span>
        <span class="crm-col-count">${col.contacts.length}</span>
      </div>
      <div class="crm-col-cards">${cards || '<div class="crm-card-empty">—</div>'}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 渲染单张卡片
// ═══════════════════════════════════════════════════════════════════════════════

function renderCard(contact, stage) {
  const reminder = contact._extra?.crmReminder;
  const nextAt = reminder?.nextFollowupAt;

  let timeClass = '';
  let timeLabel = '';
  if (nextAt) {
    const t = new Date(nextAt).getTime();
    if (t <= Date.now()) {
      timeClass = 'crm-overdue';
      timeLabel = `⏰ 已逾期`;
    } else if (t <= Date.now() + 24 * 3600 * 1000) {
      timeClass = 'crm-due-soon';
      timeLabel = `⏰ ${formatDate(nextAt)}`;
    } else {
      timeLabel = `📅 ${formatDate(nextAt)}`;
    }
  }

  const country = contact.country || '';
  const company = contact.company || '';
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || '—';
  const color = STAGE_COLORS[stage] || '#999';

  return `
    <div class="crm-card ${timeClass}" data-contact-id="${contact.id}">
      <div class="crm-card-name">${escapeHtml(name)}</div>
      <div class="crm-card-company">${escapeHtml(company)}</div>
      ${country ? `<div class="crm-card-country">🌐 ${escapeHtml(country)}</div>` : ''}
      ${timeLabel ? `<div class="crm-card-time">${timeLabel}</div>` : ''}
      <div class="crm-card-footer">
        <span class="crm-stage-tag" data-contact-id="${contact.id}" data-stage="${stage}" style="background:${color}15;color:${color}" title="点击切换阶段">● ${stage}</span>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 阶段切换弹出选择器
// ═══════════════════════════════════════════════════════════════════════════════

function showStagePicker(anchor, contactId, currentStage) {
  document.getElementById('stage-picker-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'stage-picker-popup';
  popup.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';
  const rect = anchor.getBoundingClientRect();
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';

  const stages = Object.entries(STAGE_COLORS);
  popup.innerHTML = stages.map(([s, color]) => {
    const isCurrent = s === currentStage;
    return `<div style="padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;${isCurrent ? 'font-weight:600' : ''}" data-stage="${s}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'">
      <span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0"></span>
      ${isCurrent ? ' ✓' : ''} ${s}
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
  const close = (ev) => {
    if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 详情面板
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
      <div class="crm-tab-content active" data-content="info">
        ${renderInfoTab(contact)}
      </div>
      <div class="crm-tab-content" data-content="prefs">
        ${renderPrefsTab(contactId, prefs)}
      </div>
      <div class="crm-tab-content" data-content="reminder">
        ${renderReminderTab(contactId, reminder)}
      </div>
      <div class="crm-tab-content" data-content="timeline">
        ${renderTimelineTab(notes, interactions)}
      </div>
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

  // 关闭按钮
  document.getElementById('crm-detail-close')?.addEventListener('click', closeDetailPanel);

  // 偏好表单 — change 即保存
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
        // cargoTypes checkboxes
        const checkedCargo = panel.querySelectorAll('.crm-pref-input[data-pref-key="cargoTypes"]:checked');
        if (checkedCargo.length) prefs.cargoTypes = [...checkedCargo].map(cb => cb.value);

        await window.electronAPI.crmUpdateExtra(contactId, { crmPreferences: prefs });
      }, 300);
    });
  });

  // 提醒日期 — 即时保存 + 本地定时器
  panel.querySelectorAll('.crm-reminder-input').forEach(input => {
    input.addEventListener('change', async () => {
      const reminderPatch = {};
      panel.querySelectorAll('.crm-reminder-input').forEach(el => {
        reminderPatch[el.dataset.remKey] = el.value;
      });
      const r = await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: reminderPatch });
      if (r.ok) {
        scheduleReminderTimer(contactId, reminderPatch.nextFollowupAt);
        showToast('提醒已更新', 'ok');
      }
    });
  });

  // 添加备注
  const noteBtn = panel.querySelector('#crm-add-note-btn');
  const noteInput = panel.querySelector('#crm-note-input');
  if (noteBtn && noteInput) {
    noteBtn.addEventListener('click', async () => {
      const content = noteInput.value.trim();
      if (!content) return;
      const r = await window.electronAPI.crmSaveNote(contactId, content);
      if (r.ok) {
        noteInput.value = '';
        showToast('备注已保存', 'ok');
        // 刷新时间线
        const detail = await window.electronAPI.crmGetDetail(contactId);
        if (detail.ok) {
          const timelineEl = panel.querySelector('[data-content="timeline"]');
          if (timelineEl) timelineEl.innerHTML = renderTimelineTab(detail.data.notes, detail.data.interactions);
        }
      }
    });
  }
}

function closeDetailPanel() {
  _currentDetailId = null;
  const panel = document.getElementById('crm-detail-panel');
  if (panel) panel.style.display = 'none';
  document.querySelectorAll('.crm-card.active').forEach(c => c.classList.remove('active'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab 内容渲染
// ═══════════════════════════════════════════════════════════════════════════════

function renderInfoTab(contact) {
  return `
    <div class="crm-field-row"><label>姓名</label><span>${escapeHtml([contact.firstName, contact.lastName].filter(Boolean).join(' '))}</span></div>
    <div class="crm-field-row"><label>邮箱</label><span>${escapeHtml(contact.email || '—')}</span></div>
    <div class="crm-field-row"><label>公司</label><span>${escapeHtml(contact.company || '—')}</span></div>
    <div class="crm-field-row"><label>国家</label><span>${escapeHtml(contact.country || '—')}</span></div>
    <div class="crm-field-row"><label>职位</label><span>${escapeHtml(contact.title || contact.position || '—')}</span></div>
    <div class="crm-field-row"><label>电话</label><span>${escapeHtml(contact.phone || '—')}</span></div>
    <div class="crm-field-row"><label>LinkedIn</label><span>${escapeHtml(contact.linkedin || '—')}</span></div>
    <div class="crm-field-row"><label>阶段</label><span>${escapeHtml(contact.opp_stage || contact._status || '—')}</span></div>
  `;
}

function renderPrefsTab(contactId, prefs) {
  const ROUTES = ['南美西', '南美东', '加勒比', '中美', '墨西哥', '欧洲', '亚洲', '非洲'];
  const ROLES = ['决策者', '影响者', '信息提供者'];
  const SENSITIVITIES = ['高', '中', '低'];
  const VOLUMES = ['<100TEU', '100-500TEU', '500-2000TEU', '>2000TEU'];
  const CARGO_TYPES = ['普货', '危险品', '冷藏', '超规'];

  const sel = (key, options, current) => `
    <select class="crm-pref-input" data-pref-key="${key}">
      <option value="">—</option>
      ${options.map(o => `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('')}
    </select>`;

  return `
    <div class="crm-field-row"><label>偏好航线</label>${sel('preferredRoutes', ROUTES, prefs.preferredRoutes)}</div>
    <div class="crm-field-row"><label>货物类型</label>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${CARGO_TYPES.map(ct => `<label style="font-size:11px;display:flex;align-items:center;gap:3px"><input type="checkbox" class="crm-pref-input" data-pref-key="cargoTypes" value="${ct}" ${(prefs.cargoTypes || []).includes(ct) ? 'checked' : ''}>${ct}</label>`).join('')}
      </div>
    </div>
    <div class="crm-field-row"><label>决策角色</label>${sel('decisionRole', ROLES, prefs.decisionRole)}</div>
    <div class="crm-field-row"><label>价格敏感度</label>${sel('priceSensitivity', SENSITIVITIES, prefs.priceSensitivity)}</div>
    <div class="crm-field-row"><label>偏好港口</label><input class="crm-pref-input" data-pref-key="preferredPorts" value="${escapeHtml(prefs.preferredPorts || '')}" placeholder="上海/宁波"></div>
    <div class="crm-field-row"><label>年货量</label>${sel('annualVolume', VOLUMES, prefs.annualVolume)}</div>
    <div class="crm-field-row"><label>备注</label><textarea class="crm-pref-input" data-pref-key="memo" rows="3" placeholder="自由备注...">${escapeHtml(prefs.memo || '')}</textarea></div>
  `;
}

function renderReminderTab(contactId, reminder) {
  const nextAt = reminder.nextFollowupAt || '';
  const note = reminder.followupNote || '';
  return `
    <div class="crm-field-row"><label>下次跟进日期</label><input type="datetime-local" class="crm-reminder-input" data-rem-key="nextFollowupAt" value="${escapeHtml(nextAt)}"></div>
    <div class="crm-field-row"><label>提醒备注</label><input class="crm-reminder-input" data-rem-key="followupNote" value="${escapeHtml(note)}" placeholder="如：确认报价、发合同"></div>
    ${nextAt ? `<div class="crm-field-row"><span style="font-size:11px;color:var(--text-secondary)">${isOverdue(nextAt) ? '🔴 已逾期' : isDueSoon(nextAt) ? '🟠 即将到期' : '🟢 正常'}</span></div>` : ''}
  `;
}

function renderTimelineTab(notes, interactions) {
  const items = [
    ...((notes || []).map(n => ({ type: 'note', time: n.created_at, content: n.content, id: n.id }))),
    ...((interactions || []).map(i => ({ type: i.type, time: i.created_at, subject: i.subject, snippet: i.snippet }))),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 50);

  if (!items.length) {
    return `<div style="color:var(--text-secondary);padding:12px;font-size:12px">暂无记录</div>
      <div class="crm-field-row">
        <textarea id="crm-note-input" rows="3" placeholder="添加跟进备注..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px"></textarea>
      </div>
      <button id="crm-add-note-btn" class="primary" style="font-size:12px;padding:6px 14px">保存备注</button>`;
  }

  return items.map(item => `
    <div class="crm-timeline-item">
      <div class="crm-timeline-dot ${item.type === 'note' ? 'is-note' : ''}"></div>
      <div class="crm-timeline-body">
        <div class="crm-timeline-time">${formatDateTime(item.time)}</div>
        ${item.subject ? `<div class="crm-timeline-subject">${escapeHtml(item.subject)}</div>` : ''}
        <div class="crm-timeline-snippet">${escapeHtml(item.snippet || item.content || '')}</div>
      </div>
    </div>
  `).join('') + `
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
      <textarea id="crm-note-input" rows="2" placeholder="添加跟进备注..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px"></textarea>
      <button id="crm-add-note-btn" class="primary" style="font-size:12px;padding:6px 14px;margin-top:6px">保存备注</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 提醒管理
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleReminderTimer(contactId, nextAt) {
  // 清除旧定时器
  if (_reminderTimers[contactId]) {
    clearTimeout(_reminderTimers[contactId]);
    delete _reminderTimers[contactId];
  }

  if (!nextAt) return;
  const target = new Date(nextAt).getTime();
  const delay = target - Date.now();
  if (delay <= 0) return; // 已过期

  _reminderTimers[contactId] = setTimeout(() => {
    // 刷新管道高亮
    refreshPipeline();
    delete _reminderTimers[contactId];
  }, delay);
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

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return ''; }
}

function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return iso || ''; }
}

function isOverdue(iso) {
  try { return new Date(iso).getTime() <= Date.now(); } catch { return false; }
}

function isDueSoon(iso) {
  try { return new Date(iso).getTime() <= Date.now() + 24 * 3600 * 1000; } catch { return false; }
}

// ── 页面处理器注册 ──────────────────────────────────────────────────────────
window.__pageHandlers = window.__pageHandlers || {};
window.__pageHandlers['crm'] = initCrmPipeline;
