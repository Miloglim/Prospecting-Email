// ── Prospector — CRM 跟进管道 ──────────────────────────────────────────────
"use strict";

import { escapeHtml, lucide, showToast } from './shared.js';

// 后端存英文 key，前端显示中文 label
const STAGES = [
  { key: "报价中", color: "#2196f3" },
  { key: "试单",   color: "#8e24aa" },
  { key: "合作中", color: "#4caf50" },
  { key: "已流失", color: "#b0b0b0" },
  { key: "触达中", color: "#ff9800" },
];

let _pipelineData = null;
let _currentDetailId = null;
let _reminderTimers = {};

export async function initCrmPipeline() {
  await refreshPipeline();

  const si = document.getElementById('crm-search');
  const cs = document.getElementById('crm-country-filter');
  if (si) { let t; si.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refreshPipeline, 300); }); }
  if (cs) cs.addEventListener('change', refreshPipeline);

  window.electronAPI.onCrmChanged(() => refreshPipeline());
  window.electronAPI.onContactsChanged(() => refreshPipeline());
  setInterval(() => checkReminders(), 5 * 60 * 1000);
  checkReminders();
}

async function refreshPipeline() {
  const el = document.getElementById('crm-pipeline');
  if (!el) return;

  const search = document.getElementById('crm-search')?.value?.trim() || '';
  const country = document.getElementById('crm-country-filter')?.value || '';

  const r = await window.electronAPI.crmListPipeline({ search, country });
  if (!r.ok) { el.innerHTML = `<div class="crm-empty">${escapeHtml(r.error)}</div>`; return; }

  _pipelineData = r.data;
  const { columns } = r.data;
  const hasAny = columns.some(c => c.contacts.length > 0);

  if (!hasAny) {
    el.innerHTML = `<div class="crm-empty"><p>暂无跟进中的客户</p><p style="font-size:12px;color:var(--text-secondary)">发送邮件后，已触达的客户会自动出现在这里</p></div>`;
    document.getElementById('crm-detail-panel').style.display = 'none';
    return;
  }

  el.innerHTML = columns.map(col => renderStage(col)).join('');

  el.querySelectorAll('.crm-contact-row').forEach(row => {
    row.addEventListener('click', () => {
      const cid = row.dataset.contactId;
      openDetailPanel(cid);
      el.querySelectorAll('.crm-contact-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });
  });

  el.querySelectorAll('.crm-stage-badge').forEach(badge => {
    badge.addEventListener('click', e => {
      e.stopPropagation();
      showStagePicker(badge, badge.dataset.contactId, badge.dataset.stage);
    });
  });

  if (_currentDetailId) {
    const row = el.querySelector(`.crm-contact-row[data-contact-id="${_currentDetailId}"]`);
    if (row) row.classList.add('active'); else closeDetailPanel();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 阶段区块
// ═══════════════════════════════════════════════════════════════════════════════

function renderStage(col) {
  const color = col.color || '#999';
  const label = col.label || '';
  const rows = col.contacts.length
    ? col.contacts.map(c => renderContact(c, col.key, label, color)).join('')
    : `<div class="crm-contact-row crm-contact-none">暂无</div>`;

  return `
    <div class="crm-stage-block">
      <div class="crm-stage-head" style="border-left:3px solid ${color}">
        <span class="crm-stage-dot" style="background:${color}"></span>
        <span class="crm-stage-label">${col.label}</span>
        <span class="crm-stage-count">${col.contacts.length}</span>
      </div>
      <div class="crm-stage-body">${rows}</div>
    </div>`;
}

function renderContact(c, stageKey, label, color) {
  const reminder = c._extra?.crmReminder;
  const nextAt = reminder?.nextFollowupAt;
  let timeHtml = '';
  if (nextAt) {
    const t = new Date(nextAt).getTime();
    const cls = t <= Date.now() ? 'overdue' : t <= Date.now() + 24*3600*1000 ? 'soon' : '';
    timeHtml = `<span class="crm-time ${cls}">${t <= Date.now() ? '⏰ 逾期' : '⏰ ' + fmtDate(nextAt)}</span>`;
  }
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '—';

  return `
    <div class="crm-contact-row" data-contact-id="${c.id}">
      <span class="crm-contact-name">${escapeHtml(name)}</span>
      <span class="crm-contact-co">${escapeHtml(c.company || '—')}</span>
      <span class="crm-contact-ctry">${escapeHtml(c.country || '')}</span>
      ${timeHtml}
      <span class="crm-stage-badge" data-contact-id="${c.id}" data-stage="${stageKey}" style="background:${color}18;color:${color}">${label}</span>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 阶段切换
// ═══════════════════════════════════════════════════════════════════════════════

function showStagePicker(anchor, contactId, cur) {
  document.getElementById('stage-picker-popup')?.remove();
  const p = document.createElement('div');
  p.id = 'stage-picker-popup';
  p.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';
  const rect = anchor.getBoundingClientRect();
  p.style.left = Math.min(rect.left, window.innerWidth - 160) + 'px';
  p.style.top = (rect.bottom + 4 > window.innerHeight - 200 ? rect.top - 200 : rect.bottom + 4) + 'px';

  p.innerHTML = STAGES.map(s => {
    const is = s.key === cur;
    return `<div style="padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;${is?'font-weight:600':''}" data-s="${s.key}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'"><span style="width:7px;height:7px;border-radius:50%;background:${s.color};flex-shrink:0"></span>${is?' ✓':''} ${s.key}</div>`;
  }).join('');

  p.querySelectorAll('[data-s]').forEach(d => {
    d.addEventListener('click', async () => {
      const ns = d.dataset.s; p.remove();
      if (ns === cur) return;
      const r = await window.electronAPI.crmSetStage(contactId, ns);
      showToast(r.ok ? `已移至「${ns}」` : r.error || '失败', r.ok ? 'ok' : 'err');
      if (r.ok) refreshPipeline();
    });
  });

  document.body.appendChild(p);
  const close = ev => { if (!p.contains(ev.target)) { p.remove(); document.removeEventListener('click', close); } };
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
  panel.innerHTML = `<div class="crm-detail-loading">${lucide('loader-2',16,'spin')} 加载中...</div>`;

  const r = await window.electronAPI.crmGetDetail(contactId);
  if (!r.ok) { panel.innerHTML = `<div class="crm-detail-error">${escapeHtml(r.error)}</div>`; return; }

  const { contact, notes, interactions } = r.data;
  const prefs = contact._extra?.crmPreferences || {};
  const reminder = contact._extra?.crmReminder || {};

  panel.innerHTML = `
    <div class="crm-detail-header"><span class="crm-detail-name">${escapeHtml([contact.firstName,contact.lastName].filter(Boolean).join(' ')||contact.email)}</span><button id="crm-detail-close" class="crm-detail-close-btn">${lucide('x',16)}</button></div>
    <div class="crm-detail-tabs">
      <button class="crm-tab active" data-tab="info">基本信息</button>
      <button class="crm-tab" data-tab="prefs">偏好设置</button>
      <button class="crm-tab" data-tab="followup">跟进记录</button>
    </div>
    <div class="crm-detail-body">
      <div class="crm-tab-content active" data-content="info">${infoTab(contact)}</div>
      <div class="crm-tab-content" data-content="prefs">${prefsTab(contactId,prefs)}</div>
      <div class="crm-tab-content" data-content="followup">${followupTab(contactId, reminder, notes, interactions)}</div>
    </div>`;

  panel.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const tgt = panel.querySelector(`[data-content="${tab.dataset.tab}"]`);
      if (tgt) tgt.classList.add('active');
    });
  });

  document.getElementById('crm-detail-close')?.addEventListener('click', closeDetailPanel);

  // 偏好保存
  panel.querySelectorAll('.crm-pref-input').forEach(inp => {
    let db;
    inp.addEventListener('change', () => {
      clearTimeout(db);
      db = setTimeout(async () => {
        const prefs = {};
        panel.querySelectorAll('.crm-pref-input').forEach(el => {
          const k = el.dataset.prefKey;
          if (k === 'cargoTypes' && el.type === 'checkbox') { if (el.checked) prefs[k] = [...(prefs[k]||[]), el.value]; }
          else if (k !== 'cargoTypes') prefs[k] = el.value;
        });
        const cc = panel.querySelectorAll('.crm-pref-input[data-pref-key="cargoTypes"]:checked');
        if (cc.length) prefs.cargoTypes = [...cc].map(cb => cb.value);
        await window.electronAPI.crmUpdateExtra(contactId, { crmPreferences: prefs });
      }, 300);
    });
  });

  // 下次跟进日期变更即保存
  const nextFollowupEl = panel.querySelector('#crm-next-followup');
  if (nextFollowupEl) {
    nextFollowupEl.addEventListener('change', async () => {
      const val = nextFollowupEl.value;
      const r2 = await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: val } });
      if (r2.ok) { scheduleReminder(contactId, val); showToast('已更新','ok'); }
    });
  }

  // 添加记录按钮 → 展开表单
  const addBtn = panel.querySelector('#crm-add-record-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const form = panel.querySelector('#crm-record-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
      if (form.style.display === 'block') panel.querySelector('#crm-record-content')?.focus();
    });
  }

  // 保存记录
  const saveBtn = panel.querySelector('#crm-record-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const content = panel.querySelector('#crm-record-content')?.value?.trim();
      if (!content) { showToast('请输入内容','warn'); return; }
      const r3 = await window.electronAPI.crmSaveNote(contactId, content);
      if (r3.ok) {
        panel.querySelector('#crm-record-content').value = '';
        panel.querySelector('#crm-record-form').style.display = 'none';
        showToast('已保存','ok');
        const d = await window.electronAPI.crmGetDetail(contactId);
        if (d.ok) {
          const fl = panel.querySelector('[data-content="followup"]');
          if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
          // 重新绑定事件
          rebindFollowupEvents(panel, contactId);
        }
      }
    });
  }

  // 取消
  panel.querySelector('#crm-record-cancel')?.addEventListener('click', () => {
    panel.querySelector('#crm-record-form').style.display = 'none';
  });
}

function closeDetailPanel() {
  _currentDetailId = null;
  const p = document.getElementById('crm-detail-panel');
  if (p) p.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tab 内容
// ═══════════════════════════════════════════════════════════════════════════════

function infoTab(c) {
  return [['姓名',[c.firstName,c.lastName].filter(Boolean).join(' ')],['邮箱',c.email],['公司',c.company],['国家',c.country],['职位',c.title||c.position],['电话',c.phone],['LinkedIn',c.linkedin],['标签',(c.tags||[]).join(', ')||'—']]
    .map(([l,v]) => `<div class="crm-field-row"><label>${l}</label><span>${escapeHtml(v||'—')}</span></div>`).join('');
}

function prefsTab(cid, prefs) {
  const sel = (k,o,v) => `<select class="crm-pref-input" data-pref-key="${k}"><option value="">—</option>${o.map(x => `<option value="${x}" ${x===v?'selected':''}>${x}</option>`).join('')}</select>`;
  return `
    <div class="crm-field-row"><label>偏好航线</label>${sel('preferredRoutes',['南美西','南美东','加勒比','中美','墨西哥','欧洲','亚洲','非洲'],prefs.preferredRoutes)}</div>
    <div class="crm-field-row"><label>货物类型</label><div style="display:flex;flex-wrap:wrap;gap:4px">${['普货','危险品','冷藏','超规'].map(ct => `<label style="font-size:11px;display:flex;align-items:center;gap:3px"><input type="checkbox" class="crm-pref-input" data-pref-key="cargoTypes" value="${ct}" ${(prefs.cargoTypes||[]).includes(ct)?'checked':''}>${ct}</label>`).join('')}</div></div>
    <div class="crm-field-row"><label>决策角色</label>${sel('decisionRole',['决策者','影响者','信息提供者'],prefs.decisionRole)}</div>
    <div class="crm-field-row"><label>价格敏感度</label>${sel('priceSensitivity',['高','中','低'],prefs.priceSensitivity)}</div>
    <div class="crm-field-row"><label>偏好港口</label><input class="crm-pref-input" data-pref-key="preferredPorts" value="${escapeHtml(prefs.preferredPorts||'')}" placeholder="上海/宁波"></div>
    <div class="crm-field-row"><label>年货量</label>${sel('annualVolume',['<100TEU','100-500TEU','500-2000TEU','>2000TEU'],prefs.annualVolume)}</div>
    <div class="crm-field-row"><label>备注</label><textarea class="crm-pref-input" data-pref-key="memo" rows="3" placeholder="自由备注...">${escapeHtml(prefs.memo||'')}</textarea></div>`;
}

function followupTab(cid, reminder, notes, interactions) {
  const na = reminder.nextFollowupAt || '';
  // 合并 notes + interactions 按时间倒序
  const items = [
    ...((notes||[]).map(n => ({ type:'note', time:n.created_at, content:n.content }))),
    ...((interactions||[]).map(i => ({ type:i.type, time:i.created_at, subject:i.subject, snippet:i.snippet }))),
  ].sort((a,b) => new Date(b.time)-new Date(a.time)).slice(0,50);

  const listHtml = items.length ? items.map(i => `
    <div class="crm-followup-item">
      <div class="crm-followup-time">${fmtDT(i.time)} ${i.type==='stage_changed'?'🔄':i.type==='note'?'📝':'📧'}</div>
      ${i.subject?`<div style="font-size:12px;font-weight:500">${escapeHtml(i.subject)}</div>`:''}
      <div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all">${escapeHtml(i.snippet||i.content||'')}</div>
    </div>`).join('')
    : '<div style="color:var(--text-secondary);padding:12px 0;font-size:12px">暂无记录</div>';

  return `
    <div class="crm-followup-top">
      <div class="crm-field-row"><label>下次跟进</label><input type="datetime-local" id="crm-next-followup" value="${escapeHtml(na)}" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px"></div>
      <button id="crm-add-record-btn" class="primary" style="width:100%;margin-top:8px;padding:8px;font-size:13px">+ 添加跟进记录</button>
    </div>
    <div id="crm-record-form" class="crm-record-form" style="display:none;margin-top:8px">
      <input type="datetime-local" id="crm-record-date" value="${fmtDT(new Date().toISOString()).slice(0,16)}" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;margin-bottom:6px">
      <textarea id="crm-record-content" rows="3" placeholder="记录内容..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:4px;font-size:12px"></textarea>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="crm-record-save" class="primary" style="flex:1;padding:6px;font-size:12px">保存</button>
        <button id="crm-record-cancel" class="secondary" style="padding:6px 12px;font-size:12px">取消</button>
      </div>
    </div>
    <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);font-weight:600">记录列表</div>
    <div class="crm-followup-list">${listHtml}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 提醒
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleReminder(cid, na) {
  if (_reminderTimers[cid]) { clearTimeout(_reminderTimers[cid]); delete _reminderTimers[cid]; }
  if (!na) return;
  const d = new Date(na).getTime() - Date.now();
  if (d <= 0) return;
  _reminderTimers[cid] = setTimeout(() => { refreshPipeline(); delete _reminderTimers[cid]; }, d);
}

async function checkReminders() {
  try {
    const r = await window.electronAPI.crmCheckReminders();
    if (!r.ok) return;
    const dot = document.getElementById('crm-nav-dot');
    if (dot) {
      const n = (r.data.due?.length||0)+(r.data.overdue?.length||0);
      dot.style.display = n>0?'inline-block':'none';
      dot.textContent = n>9?'9+':String(n);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
function fmtDate(i) { try { const d=new Date(i); return `${d.getMonth()+1}/${d.getDate()}`; } catch { return ''; } }
function fmtDT(i) { try { const d=new Date(i); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; } catch { return i||''; } }
function isOverdue(i) { try { return new Date(i).getTime()<=Date.now(); } catch { return false; } }
function isSoon(i) { try { return new Date(i).getTime()<=Date.now()+24*3600*1000; } catch { return false; } }

function rebindFollowupEvents(panel, contactId) {
  const nf = panel.querySelector('#crm-next-followup');
  if (nf) nf.addEventListener('change', async () => {
    await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: nf.value } });
    scheduleReminder(contactId, nf.value); showToast('已更新','ok');
  });
  const ab = panel.querySelector('#crm-add-record-btn');
  if (ab) ab.addEventListener('click', () => {
    const f = panel.querySelector('#crm-record-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
    if (f.style.display === 'block') panel.querySelector('#crm-record-content')?.focus();
  });
  const sb = panel.querySelector('#crm-record-save');
  if (sb) sb.addEventListener('click', async () => {
    const c = panel.querySelector('#crm-record-content')?.value?.trim();
    if (!c) { showToast('请输入内容','warn'); return; }
    const r3 = await window.electronAPI.crmSaveNote(contactId, c);
    if (r3.ok) {
      panel.querySelector('#crm-record-content').value = '';
      panel.querySelector('#crm-record-form').style.display = 'none';
      showToast('已保存','ok');
      const d = await window.electronAPI.crmGetDetail(contactId);
      if (d.ok) {
        const fl = panel.querySelector('[data-content="followup"]');
        if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
        rebindFollowupEvents(panel, contactId);
      }
    }
  });
  panel.querySelector('#crm-record-cancel')?.addEventListener('click', () => {
    panel.querySelector('#crm-record-form').style.display = 'none';
  });
}

window.__pageHandlers = window.__pageHandlers || {};
window.__pageHandlers['crm'] = initCrmPipeline;
