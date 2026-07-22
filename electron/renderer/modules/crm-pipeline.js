// ── Prospector — CRM 跟进管道 ──────────────────────────────────────────────
"use strict";

import { escapeHtml, lucide, showToast, showConfirm } from './shared.js';

// 后端存英文 key，前端显示中文 label
const STAGES = [
  { key: "reaching",    label: "触达中", color: "#ff9800" },
  { key: "quoting",     label: "报价中", color: "#2196f3" },
  { key: "trial",       label: "试单",   color: "#8e24aa" },
  { key: "cooperating", label: "合作中", color: "#4caf50" },
  { key: "lost",        label: "已流失", color: "#b0b0b0" },
];

let _pipelineData = null;
let _currentDetailId = null;
let _currentTab = 'info';
let _reminderTimers = {};

export async function initCrmPipeline() {
  await refreshPipeline();
  // 暴露给仪表盘待办点击跳转
  window.__crmOpenDetail = openDetailPanel;
  // 暴露给联系人备注列跳转（定位到跟进记录 tab）
  window.__crmOpenFollowup = (contactId) => {
    _currentTab = 'followup';
    openDetailPanel(contactId);
  };

  const si = document.getElementById('crm-search');
  if (si) { let t; si.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refreshPipeline, 300); }); }

  window.electronAPI.onCrmChanged(() => refreshPipeline());
  // 切回 CRM 页面时自动刷新，捕捉 inbox 自动收件带来的状态变化
  window.__pageHandlers['crm'] = () => refreshPipeline();
  setInterval(() => checkReminders(), 5 * 60 * 1000);
  checkReminders();
}

async function refreshPipeline() {
  const el = document.getElementById('crm-pipeline');
  if (!el) return;

  const search = document.getElementById('crm-search')?.value?.trim() || '';

  const r = await window.electronAPI.crmListPipeline({ search });
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

  // 抽屉折叠
  el.querySelectorAll('.crm-stage-head').forEach(head => {
    head.addEventListener('click', () => {
      const body = head.nextElementSibling;
      const arrow = head.querySelector('.crm-stage-arrow');
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      head.classList.toggle('open', !open);
      if (arrow) arrow.innerHTML = lucide(open ? 'chevron-right' : 'chevron-down', 14);
    });
  });

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
      <div class="crm-stage-head" style="border-left:3px solid ${color}" data-stage="${col.key}">
        <span class="crm-stage-arrow">${lucide('chevron-right', 14)}</span>
        <span class="crm-stage-dot" style="background:${color}"></span>
        <span class="crm-stage-label">${col.label}</span>
        <span class="crm-stage-count">${col.contacts.length}</span>
      </div>
      <div class="crm-stage-body" style="display:none">${rows}</div>
    </div>`;
}

function renderContact(c, stageKey, label, color) {
  const reminder = c._extra?.crmReminder;
  const nextAt = reminder?.nextFollowupAt;
  let noteHtml = c.last_note_at
    ? `<span class="crm-time" title="最后跟进: ${fmtDT(c.last_note_at)}">📝 ${daysAgo(c.last_note_at)}</span>`
    : '<span class="crm-time" style="color:var(--text-secondary)">—</span>';
  let nextHtml = '';
  if (nextAt) {
    const t = new Date(nextAt).getTime();
    const overdue = t <= Date.now();
    const soon = !overdue && t <= Date.now() + 24*3600*1000;
    const cls = overdue ? 'overdue' : soon ? 'soon' : '';
    nextHtml = `<span class="crm-time ${cls}" title="下次跟进: ${fmtDT(nextAt)}">${overdue ? '⏰ 逾期'+daysAgo(nextAt).replace('今天','') : '⏰ '+daysUntil(nextAt)}</span>`;
  }
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '—';

  return `
    <div class="crm-contact-row" data-contact-id="${c.id}">
      <span class="crm-contact-name">${escapeHtml(name)}</span>
      <span class="crm-contact-co">${escapeHtml(c.company || '—')}</span>
      ${nextHtml}${noteHtml}
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
    return `<div style="padding:6px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;${is?'font-weight:600':''}" data-s="${s.key}" onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background='transparent'"><span style="width:7px;height:7px;border-radius:50%;background:${s.color};flex-shrink:0"></span>${is?' ✓':''} ${s.label}</div>`;
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
  _currentTab = 'info'; // 每次打开面板重置 tab，避免邮件往来假性加载中
  const panel = document.getElementById('crm-detail-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.innerHTML = `<div class="crm-detail-loading">${lucide('loader',16,'spin')} 加载中...</div>`;

  const r = await window.electronAPI.crmGetDetail(contactId);
  if (!r.ok) { panel.innerHTML = `<div class="crm-detail-error">${escapeHtml(r.error)}</div>`; return; }

  const { contact, notes, interactions } = r.data;
  const prefs = contact._extra?.crmPreferences || {};
  const reminder = contact._extra?.crmReminder || {};

  panel.innerHTML = `
    <div class="crm-detail-header"><span class="crm-detail-name">${escapeHtml([contact.firstName,contact.lastName].filter(Boolean).join(' ')||contact.email)}<button id="crm-find-contact" class="crm-find-btn" title="在联系人中查找">${lucide('search',13)}</button></span><button id="crm-detail-close" class="crm-detail-close-btn">${lucide('x',16)}</button></div>
    <div class="crm-detail-tabs">
      <button class="crm-tab${_currentTab==='info'?' active':''}" data-tab="info">基本信息</button>
      <button class="crm-tab${_currentTab==='prefs'?' active':''}" data-tab="prefs">偏好设置</button>
      <button class="crm-tab${_currentTab==='followup'?' active':''}" data-tab="followup">跟进记录</button>
      <button class="crm-tab${_currentTab==='emails'?' active':''}" data-tab="emails">邮件往来</button>
    </div>
    <div class="crm-detail-body">
      <div class="crm-tab-content${_currentTab==='info'?' active':''}" data-content="info">${infoTab(contact)}</div>
      <div class="crm-tab-content${_currentTab==='prefs'?' active':''}" data-content="prefs">${prefsTab(contactId,prefs)}</div>
      <div class="crm-tab-content${_currentTab==='followup'?' active':''}" data-content="followup">${followupTab(contactId, reminder, notes, interactions)}</div>
      <div class="crm-tab-content${_currentTab==='emails'?' active':''}" data-content="emails"><div class="crm-detail-loading" style="padding:20px">${lucide('loader',14,'spin')} 加载中...</div></div>
    </div>`;

  let _emailsLoaded = false;
  panel.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      _currentTab = tab.dataset.tab;
      panel.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const tgt = panel.querySelector(`[data-content="${tab.dataset.tab}"]`);
      if (tgt) tgt.classList.add('active');
      if (tab.dataset.tab === 'emails' && !_emailsLoaded) {
        _emailsLoaded = true;
        const r = await window.electronAPI.crmGetContactEmails(contactId);
        if (r.ok && r.data.length) {
          tgt.innerHTML = r.data.map(m => `
            <div class="crm-email-item-wrapper">
              <div class="crm-email-item" data-uid="${escapeHtml(m.uid||'')}" data-account="${escapeHtml(m.account_id||'')}">
                <div class="crm-email-meta">
                  <span style="font-size:11px;color:${m.type==='reply'?'#22a644':m.type==='bounce'?'#d93025':'var(--text-secondary)'};flex-shrink:0">${lucide(m.type==='reply'?'mail':m.type==='bounce'?'alert-circle':'send',12)}</span>
                  <span class="crm-email-subject">${escapeHtml(m.subject||'(无主题)')}</span>
                  <span class="crm-email-date">${escapeHtml(fmtDT(m.date))}</span>
                </div>
                <div class="crm-email-from">${escapeHtml(m.from_name||m.from_addr||'')}</div>
              </div>
              <div class="crm-email-ai" data-uid="${escapeHtml(m.uid||'')}" data-account="${escapeHtml(m.account_id||'')}" style="display:none">
                <div class="crm-email-ai-inner">
                  <span class="crm-email-ai-icon">${lucide('sparkles',11)}</span>
                  <span class="crm-email-ai-text"></span>
                </div>
              </div>
            </div>`).join('');
          // 鼠标悬停展开 AI 总结
          tgt.querySelectorAll('.crm-email-item-wrapper').forEach(wrapper => {
            let _aiTimer = 0, _aiLoaded = false;
            const item = wrapper.querySelector('.crm-email-item');
            const aiCard = wrapper.querySelector('.crm-email-ai');
            const aiText = aiCard.querySelector('.crm-email-ai-text');
            const uid = aiCard.dataset.uid;
            const accountId = aiCard.dataset.account;

            wrapper.addEventListener('mouseenter', () => {
              aiCard.style.display = 'block';
              requestAnimationFrame(() => aiCard.classList.add('open'));
              if (!_aiLoaded) {
                aiText.innerHTML = lucide('loader',11,'spin');
                _aiTimer = setTimeout(async () => {
                  try {
                    // 悬停只读缓存，不调 API；首次点击弹窗时才会真调用
                    const s = await window.electronAPI.aiSummarizeEmail({ uid, accountId, preview: true });
                    if (s.ok && (s.data.summaryBrief || s.data.summary)) {
                      aiText.textContent = (s.data.summaryBrief || s.data.summary || '').replace(/[《》「」『』]/g, '');
                    } else {
                      aiText.textContent = '';
                    }
                  } catch { aiText.textContent = ''; }
                  _aiLoaded = true;
                }, 200);
              }
            });
            wrapper.addEventListener('mouseleave', () => {
              clearTimeout(_aiTimer);
              aiCard.classList.remove('open');
            });
            // transitionend 后隐藏元素
            aiCard.addEventListener('transitionend', () => {
              if (!aiCard.classList.contains('open')) aiCard.style.display = 'none';
            });
          });
          // ponytail: 邮件加载后重新绑定点击事件，因为 bindEmailClicks 在渲染前已执行
          bindEmailClicks(tgt);
        } else {
          tgt.innerHTML = '<div style="color:var(--text-secondary);padding:12px;font-size:12px">' + (r.ok ? '暂无邮件往来' : '加载失败: ' + escapeHtml(r.error||'')) + '</div>';
        }
      }
    });
  });

  document.getElementById('crm-detail-close')?.addEventListener('click', closeDetailPanel);

  // 查找联系人 → 跳转联系人页面搜索
  document.getElementById('crm-find-contact')?.addEventListener('click', () => {
    const q = contact.email || [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    document.querySelector('.nav-item[data-page="contacts"]')?.click();
    setTimeout(() => {
      const si = document.getElementById('contacts-search');
      if (si) { si.value = q; si.dispatchEvent(new Event('input', { bubbles: true })); }
    }, 200);
  });

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

  // 下次跟进日期 → 保存按钮
  panel.querySelector('#crm-followup-save')?.addEventListener('click', async () => {
    const val = panel.querySelector('#crm-next-followup')?.value || '';
    const r2 = await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: val } });
    if (r2.ok) { scheduleReminder(contactId, val); _updateCardTime(contactId, val); showToast('已更新','ok'); }
  });

  // 清除跟进日期
  panel.querySelector('#crm-clear-followup')?.addEventListener('click', async () => {
    const nextFollowupEl = panel.querySelector('#crm-next-followup');
    if (nextFollowupEl) nextFollowupEl.value = '';
    await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: '' } });
    scheduleReminder(contactId, '');
    _updateCardTime(contactId, '');
    panel.querySelector('#crm-clear-followup')?.remove();
    showToast('已清除', 'ok');
  });

  // 保存跟进记录
  panel.querySelector('#crm-record-save')?.addEventListener('click', async () => {
    const content = panel.querySelector('#crm-record-content')?.value?.trim();
    if (!content) { showToast('请输入内容','warn'); return; }
    const r3 = await window.electronAPI.crmSaveNote(contactId, content);
    if (r3.ok) {
      panel.querySelector('#crm-record-content').value = '';
      showToast('已保存','ok');
      refreshPipeline();
      const d = await window.electronAPI.crmGetDetail(contactId);
      if (d.ok) {
        const fl = panel.querySelector('[data-content="followup"]');
        if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
        rebindFollowupEvents(panel, contactId);
      }
    }
  });

  // 删除历史备注
  panel.querySelectorAll('.crm-note-del').forEach(del => {
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!await showConfirm('删除该记录？')) return;
      await window.electronAPI.deleteNote(del.dataset.noteId);
      showToast('已删除','ok');
      refreshPipeline();
      const d = await window.electronAPI.crmGetDetail(contactId);
      if (d.ok) {
        const fl = panel.querySelector('[data-content="followup"]');
        if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
        rebindFollowupEvents(panel, contactId);
      }
    });
  });

  // 邮件详情弹窗（绑定到邮件往来 tab）
  const bindEmailClicks = (container) => {
    container.querySelectorAll('.crm-email-item').forEach(row => {
      if (row._emailBound) return; row._emailBound = true;
      row.addEventListener('click', async () => {
        const uid = row.dataset.uid;
        const acct = row.dataset.account;
        if (!uid) return;
        const r = await window.electronAPI.crmGetEmailBody(uid, acct);
        if (!r.ok) { showToast('无法加载邮件','err'); return; }
        const m = r.data;
        const popup = document.createElement('div');
        popup.className = 'crm-email-popup-overlay';
        popup.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center';
        popup.innerHTML = `<div class="crm-email-popup-card"><div class="crm-email-popup-header"><div><div class="crm-email-popup-subject">${escapeHtml(m.subject||'(无主题)')}</div><div class="crm-email-popup-from">${escapeHtml(m.from_name||'')} &lt;${escapeHtml(m.from_addr||'')}&gt; · ${escapeHtml(m.date||'')}</div></div><button class="crm-detail-close-btn">${lucide('x',16)}</button></div><div class="crm-email-popup-body-wrap"><div class="crm-email-popup-body"></div><div class="crm-email-popup-ai" id="crm-email-popup-ai"><div class="crm-email-popup-ai-header">${lucide('sparkles',14)} AI 分析<button class="crm-ai-retry-btn" id="crm-ai-retry" title="重新分析" style="display:none">${lucide('refresh-cw',12)}</button></div><div class="crm-email-popup-ai-content"><span style="color:var(--text-secondary);font-size:12px">${lucide('loader',12,'spin')} 分析中...</span></div></div></div></div>`;
        document.body.appendChild(popup);
        // 安全渲染邮件正文：去危险标签/事件/伪协议，保留格式标签
        const safeBody = (m.body || '(无内容)')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
          .replace(/<object[\s\S]*?<\/object>/gi, '')
          .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
          .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
          .replace(/\son\w+\s*=\s*\S+/gi, '')
          .replace(/javascript\s*:/gi, 'blocked:');
        popup.querySelector('.crm-email-popup-body').innerHTML = safeBody;
        let _downX = 0, _downY = 0;
        popup.addEventListener('mousedown', (ev) => { _downX = ev.clientX; _downY = ev.clientY; });
        popup.addEventListener('click', (ev) => {
          const moved = Math.abs(ev.clientX - _downX) > 3 || Math.abs(ev.clientY - _downY) > 3;
          if (ev.target === popup && !moved) popup.remove();
        });
        popup.querySelector('.crm-detail-close-btn')?.addEventListener('click', () => popup.remove());

        (async () => {
          const aiContainer = popup.querySelector('#crm-email-popup-ai');
          const aiContent = aiContainer.querySelector('.crm-email-popup-ai-content');
          const retryBtn = aiContainer.querySelector('#crm-ai-retry');
          if (typeof window.electronAPI?.aiSummarizeEmail !== 'function') {
            aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">请重启应用以加载 AI 功能</span>';
            return;
          }

          let _aiLoading = false;
          const loadAi = async (retry) => {
            if (_aiLoading) return;
            _aiLoading = true;
            aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">' + lucide('loader',12,'spin') + ' 分析中...</span>';
            if (retryBtn) retryBtn.style.display = 'none';
            try {
              const s = await window.electronAPI.aiSummarizeEmail({
                uid, accountId: acct || '',
                subject: m.subject || '', body: m.body || '',
                fromName: m.from_name || '',
                contactId: _currentDetailId || '',
                retry,
              });
              if (s.ok && (s.data.summary || s.data.suggestion || s.data.analysis)) {
                const a = s.data;
                const clean = (s) => (s||'').replace(/[《》「」『』]/g, '');
                const insight = clean(a.analysis || a.summary || '');   // 【总结】
                const reasoning = clean(a.strategy || a.suggestion || ''); // 【下一步建议】
                const draft = clean(a.script || '');                      // 【AI回复】
                aiContent.innerHTML = `
                  <div class="crm-ai-insight">${escapeHtml(insight)}</div>
                  ${reasoning ? '<div class="crm-ai-reasoning">' + escapeHtml(reasoning) + '</div>' : ''}
                  ${draft ? `
                  <div class="crm-ai-draft">
                    <div class="crm-ai-draft-label">AI 回复</div>
                    <div class="crm-ai-draft-text">${escapeHtml(draft)}</div>
                    <button class="crm-ai-copy-btn" data-script="${escapeHtml(draft)}">${lucide('copy',12)} 复制话术</button>
                  </div>` : ''}
                  <button class="crm-ai-retry-btn-inline">${lucide('refresh-cw',12)} 换个思路</button>`;
              } else {
                const traceHtml = s._trace ? '<div style="margin-top:8px;font-size:10px;color:var(--text-secondary);border-top:1px solid var(--border);padding-top:6px">' + s._trace.map(t => escapeHtml(t)).join('<br>') + '</div>' : '';
                aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">' + escapeHtml(s.error||'分析暂不可用') + '</span>' + traceHtml + '<button class="crm-ai-retry-btn-inline" style="margin-top:8px">' + lucide('refresh-cw',12) + ' 重试</button>';
              }
            } catch (e) { aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">分析失败: ' + escapeHtml(e.message||'') + '</span><button class="crm-ai-retry-btn-inline" style="margin-top:8px">' + lucide('refresh-cw',12) + ' 重试</button>'; }
            if (retryBtn) retryBtn.style.display = '';
            _aiLoading = false;
          };

          // 事件委托：容器统一处理按钮点击，不依赖单个 bind
          aiContent.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.classList.contains('crm-ai-copy-btn')) {
              const txt = btn.dataset.script;
              navigator.clipboard.writeText(txt).then(() => {
                btn.innerHTML = lucide('check',12) + ' 已复制';
                setTimeout(() => { btn.innerHTML = lucide('copy',12) + ' 复制话术'; }, 2000);
              }).catch(() => showToast('复制失败', 'err'));
            }
            if (btn.classList.contains('crm-ai-retry-btn-inline')) {
              loadAi(true);
            }
          });

          if (retryBtn) retryBtn.addEventListener('click', () => loadAi(true));
          await loadAi(false);
        })();
      });
    });
  };
  bindEmailClicks(panel);

  // 编辑历史备注
  panel.querySelectorAll('.crm-note-edit').forEach(p => {
    p.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const noteId = p.dataset.noteId;
      const item = p.closest('.crm-followup-item');
      const cd = item.querySelector('.crm-note-content');
      const orig = cd.textContent;
      const ta = document.createElement('textarea');
      ta.value = orig; ta.rows = 3;
      ta.style.cssText = 'width:100%;padding:6px;border:1px solid var(--primary);border-radius:4px;font-size:12px';
      cd.replaceWith(ta); ta.focus();
      const save = async () => {
        const val = ta.value.trim();
        if (val === orig) { ta.replaceWith(cd); return; }
        await window.electronAPI.updateNote(noteId, val);
        cd.textContent = val; ta.replaceWith(cd);
        showToast('已更新','ok');
      };
      ta.addEventListener('blur', save);
      ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); } });
    });
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
  return [['姓名',[c.firstName,c.lastName].filter(Boolean).join(' ')],['邮箱',c.email],['公司',c.company],['国家',c.country],['职位',c.title],['电话',c.phone],['LinkedIn',c.linkedin],['标签',(c.tags||[]).join(', ')||'—']]
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
    <div class="crm-field-row crm-field-row-memo"><label>备注</label><textarea class="crm-pref-input" data-pref-key="memo" placeholder="自由备注..." style="width:100%;flex:1;resize:none;font-size:13px;line-height:1.5">${escapeHtml(prefs.memo||'')}</textarea></div>`;
}

function followupTab(cid, reminder, notes, interactions) {
  const na = reminder.nextFollowupAt || '';
  const noteItems = (notes||[]).map(n => ({ id: n.id, time:n.created_at, content:n.content }))
    .sort((a,b) => new Date(b.time)-new Date(a.time)).slice(0,50);

  const notesHtml = noteItems.length ? noteItems.map(i => `
    <div class="crm-followup-item" data-note-id="${i.id||''}">
      <div class="crm-followup-time">
        📝 ${fmtDT(i.time)}
        <span class="crm-note-actions">
          <span class="crm-note-edit" data-note-id="${i.id}" title="编辑">${lucide('pencil',11)}</span>
          <span class="crm-note-del" data-note-id="${i.id}" title="删除">${lucide('trash',11)}</span>
        </span>
      </div>
      <div class="crm-note-content" style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all">${escapeHtml(i.content||'')}</div>
    </div>`).join('')
    : '<div style="color:var(--text-secondary);padding:8px 0;font-size:12px">暂无</div>';

  return `
    <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg);border-radius:6px;margin-bottom:10px">
      <span style="font-size:11px;color:var(--text-secondary);white-space:nowrap">下次跟进</span>
      <input type="datetime-local" id="crm-next-followup" value="${escapeHtml(na)}" style="width:0;flex:1;min-width:0;padding:4px 6px;border:1px solid var(--border);border-radius:5px;font-size:11px;background:var(--card-bg);color:var(--text);font-family:inherit;outline:none">
      <button id="crm-followup-save" style="padding:3px 10px;border:1px solid var(--accent);border-radius:5px;font-size:11px;background:var(--accent);color:#fff;cursor:pointer;white-space:nowrap;font-weight:600">保存</button>
      ${na ? `<button id="crm-clear-followup" title="清除跟进日期" style="padding:2px 4px;border:none;background:none;color:var(--text-secondary);cursor:pointer;font-size:14px;line-height:1;border-radius:3px;flex-shrink:0">${lucide('x',13)}</button>` : ''}
    </div>
    <div style="font-size:12px;color:var(--text-secondary);font-weight:600;margin-bottom:4px">添加记录</div>
    <textarea id="crm-record-content" rows="2" placeholder="记录内容..." style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:12px"></textarea>
    <button id="crm-record-save" class="primary" style="width:100%;margin-top:4px;padding:6px;font-size:12px">保存</button>
    <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px;font-size:12px;color:var(--text-secondary);font-weight:600">历史备注</div>
    <div class="crm-followup-list">${notesHtml}</div>`;
}

function emailsTab(interactions) {
  const items = (interactions||[]).filter(i => i.type !== 'stage_changed').slice(0,30);
  if (!items.length) return '<div style="color:var(--text-secondary);padding:12px;font-size:12px">暂无邮件往来</div>';
  return items.map(i => `
    <div class="crm-email-item" data-uid="${escapeHtml(i.email_uid||'')}" data-account="${escapeHtml(i.email_account||'')}">
      <div class="crm-email-meta">
        <span>${i.direction==='in'?'📥':'📤'} ${escapeHtml(i.subject||'(无主题)')}</span>
        <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">${fmtDT(i.created_at)}</span>
      </div>
      <div class="crm-email-snippet" style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(i.snippet||'')}</div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 提醒
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleReminder(cid, na) {
  if (_reminderTimers[cid]) { clearTimeout(_reminderTimers[cid]); delete _reminderTimers[cid]; }
  if (!na) { refreshPipeline(); return; }
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
function daysAgo(i) { try { const diff=Math.floor((Date.now()-new Date(i).getTime())/86400000); return diff<=0?'今天':diff===1?'1天前':`${diff}天前`; } catch { return ''; } }
function daysUntil(i) { try { const diff=Math.floor((new Date(i).getTime()-Date.now())/86400000); return diff<=0?'今天':diff===1?'1天后':`${diff}天后`; } catch { return ''; } }
function fmtDT(i) { try { const d=new Date(i); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; } catch { return i||''; } }

// 精准更新单张卡片的跟进时间，不重建整个管道
function _updateCardTime(contactId, nextAt) {
  const row = document.querySelector(`.crm-contact-row[data-contact-id="${contactId}"]`);
  if (!row) return;
  const timeSpans = row.querySelectorAll('.crm-time');
  // 更新下次跟进时间（第二个 span，或创建新的）
  if (nextAt) {
    const t = new Date(nextAt).getTime();
    const overdue = t <= Date.now();
    const soon = !overdue && t <= Date.now() + 24*3600*1000;
    const cls = overdue ? 'overdue' : soon ? 'soon' : '';
    const html = `<span class="crm-time ${cls}" title="下次跟进: ${fmtDT(nextAt)}">${overdue ? '⏰ 逾期'+daysAgo(nextAt).replace('今天','') : '⏰ '+daysUntil(nextAt)}</span>`;
    if (timeSpans.length > 1) timeSpans[1].outerHTML = html;
    else if (timeSpans.length === 1) timeSpans[0].insertAdjacentHTML('afterend', html);
  } else {
    if (timeSpans.length > 1) timeSpans[1].remove();
  }
}

function rebindFollowupEvents(panel, contactId) {
  // 绑定保存按钮
  panel.querySelector('#crm-followup-save')?.addEventListener('click', async () => {
    const val = panel.querySelector('#crm-next-followup')?.value || '';
    const r = await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: val } });
    if (r.ok) { scheduleReminder(contactId, val); _updateCardTime(contactId, val); showToast('已更新','ok'); }
  });

  // 清除跟进日期
  panel.querySelector('#crm-clear-followup')?.addEventListener('click', async () => {
    await window.electronAPI.crmUpdateExtra(contactId, { crmReminder: { nextFollowupAt: '' } });
    scheduleReminder(contactId, '');
    _updateCardTime(contactId, '');
    panel.querySelector('#crm-clear-followup')?.remove();
    showToast('已清除', 'ok');
  });

  // 备注保存（仅保存备注，不处理跟进时间）
  panel.querySelector('#crm-record-save')?.addEventListener('click', async () => {
    const c = panel.querySelector('#crm-record-content')?.value?.trim();
    if (!c) { showToast('请输入内容', 'warn'); return; }
    const r3 = await window.electronAPI.crmSaveNote(contactId, c);
    if (r3.ok) {
      panel.querySelector('#crm-record-content').value = '';
      showToast('已保存', 'ok');
      const d = await window.electronAPI.crmGetDetail(contactId);
      if (d.ok) {
        const fl = panel.querySelector('[data-content="followup"]');
        if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
        rebindFollowupEvents(panel, contactId);
      }
    }
  });

  // 删除历史备注
  panel.querySelectorAll('.crm-note-del').forEach(del => {
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!await showConfirm('删除该记录？')) return;
      await window.electronAPI.deleteNote(del.dataset.noteId);
      showToast('已删除','ok');
      refreshPipeline();
      const d = await window.electronAPI.crmGetDetail(contactId);
      if (d.ok) {
        const fl = panel.querySelector('[data-content="followup"]');
        if (fl) fl.innerHTML = followupTab(contactId, d.data.contact._extra?.crmReminder || {}, d.data.notes, d.data.interactions);
        rebindFollowupEvents(panel, contactId);
      }
    });
  });

  // 邮件详情弹窗（绑定到邮件往来 tab）
  const bindEmailClicks = (container) => {
    container.querySelectorAll('.crm-email-item').forEach(row => {
      if (row._emailBound) return; row._emailBound = true;
      row.addEventListener('click', async () => {
        const uid = row.dataset.uid;
        const acct = row.dataset.account;
        if (!uid) return;
        const r = await window.electronAPI.crmGetEmailBody(uid, acct);
        if (!r.ok) { showToast('无法加载邮件','err'); return; }
        const m = r.data;
        const popup = document.createElement('div');
        popup.className = 'crm-email-popup-overlay';
        popup.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center';
        popup.innerHTML = `<div class="crm-email-popup-card"><div class="crm-email-popup-header"><div><div class="crm-email-popup-subject">${escapeHtml(m.subject||'(无主题)')}</div><div class="crm-email-popup-from">${escapeHtml(m.from_name||'')} &lt;${escapeHtml(m.from_addr||'')}&gt; · ${escapeHtml(m.date||'')}</div></div><button class="crm-detail-close-btn">${lucide('x',16)}</button></div><div class="crm-email-popup-body-wrap"><div class="crm-email-popup-body"></div><div class="crm-email-popup-ai" id="crm-email-popup-ai"><div class="crm-email-popup-ai-header">${lucide('sparkles',14)} AI 分析<button class="crm-ai-retry-btn" id="crm-ai-retry" title="重新分析" style="display:none">${lucide('refresh-cw',12)}</button></div><div class="crm-email-popup-ai-content"><span style="color:var(--text-secondary);font-size:12px">${lucide('loader',12,'spin')} 分析中...</span></div></div></div></div>`;
        document.body.appendChild(popup);
        // 安全渲染邮件正文：去危险标签/事件/伪协议，保留格式标签
        const safeBody = (m.body || '(无内容)')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
          .replace(/<object[\s\S]*?<\/object>/gi, '')
          .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
          .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
          .replace(/\son\w+\s*=\s*\S+/gi, '')
          .replace(/javascript\s*:/gi, 'blocked:');
        popup.querySelector('.crm-email-popup-body').innerHTML = safeBody;
        let _downX = 0, _downY = 0;
        popup.addEventListener('mousedown', (ev) => { _downX = ev.clientX; _downY = ev.clientY; });
        popup.addEventListener('click', (ev) => {
          const moved = Math.abs(ev.clientX - _downX) > 3 || Math.abs(ev.clientY - _downY) > 3;
          if (ev.target === popup && !moved) popup.remove();
        });
        popup.querySelector('.crm-detail-close-btn')?.addEventListener('click', () => popup.remove());

        (async () => {
          const aiContainer = popup.querySelector('#crm-email-popup-ai');
          const aiContent = aiContainer.querySelector('.crm-email-popup-ai-content');
          const retryBtn = aiContainer.querySelector('#crm-ai-retry');
          if (typeof window.electronAPI?.aiSummarizeEmail !== 'function') {
            aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">请重启应用以加载 AI 功能</span>';
            return;
          }

          let _aiLoading = false;
          const loadAi = async (retry) => {
            if (_aiLoading) return;
            _aiLoading = true;
            aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">' + lucide('loader',12,'spin') + ' 分析中...</span>';
            if (retryBtn) retryBtn.style.display = 'none';
            try {
              const s = await window.electronAPI.aiSummarizeEmail({
                uid, accountId: acct || '',
                subject: m.subject || '', body: m.body || '',
                fromName: m.from_name || '',
                contactId: _currentDetailId || '',
                retry,
              });
              if (s.ok && (s.data.summary || s.data.suggestion || s.data.analysis)) {
                const a = s.data;
                const clean = (s) => (s||'').replace(/[《》「」『』]/g, '');
                const insight = clean(a.analysis || a.summary || '');   // 【总结】
                const reasoning = clean(a.strategy || a.suggestion || ''); // 【下一步建议】
                const draft = clean(a.script || '');                      // 【AI回复】
                aiContent.innerHTML = `
                  <div class="crm-ai-insight">${escapeHtml(insight)}</div>
                  ${reasoning ? '<div class="crm-ai-reasoning">' + escapeHtml(reasoning) + '</div>' : ''}
                  ${draft ? `
                  <div class="crm-ai-draft">
                    <div class="crm-ai-draft-label">AI 回复</div>
                    <div class="crm-ai-draft-text">${escapeHtml(draft)}</div>
                    <button class="crm-ai-copy-btn" data-script="${escapeHtml(draft)}">${lucide('copy',12)} 复制话术</button>
                  </div>` : ''}
                  <button class="crm-ai-retry-btn-inline">${lucide('refresh-cw',12)} 换个思路</button>`;
              } else {
                const traceHtml = s._trace ? '<div style="margin-top:8px;font-size:10px;color:var(--text-secondary);border-top:1px solid var(--border);padding-top:6px">' + s._trace.map(t => escapeHtml(t)).join('<br>') + '</div>' : '';
                aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">' + escapeHtml(s.error||'分析暂不可用') + '</span>' + traceHtml + '<button class="crm-ai-retry-btn-inline" style="margin-top:8px">' + lucide('refresh-cw',12) + ' 重试</button>';
              }
            } catch (e) { aiContent.innerHTML = '<span style="color:var(--text-secondary);font-size:12px">分析失败: ' + escapeHtml(e.message||'') + '</span><button class="crm-ai-retry-btn-inline" style="margin-top:8px">' + lucide('refresh-cw',12) + ' 重试</button>'; }
            if (retryBtn) retryBtn.style.display = '';
            _aiLoading = false;
          };

          // 事件委托：容器统一处理按钮点击，不依赖单个 bind
          aiContent.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.classList.contains('crm-ai-copy-btn')) {
              const txt = btn.dataset.script;
              navigator.clipboard.writeText(txt).then(() => {
                btn.innerHTML = lucide('check',12) + ' 已复制';
                setTimeout(() => { btn.innerHTML = lucide('copy',12) + ' 复制话术'; }, 2000);
              }).catch(() => showToast('复制失败', 'err'));
            }
            if (btn.classList.contains('crm-ai-retry-btn-inline')) {
              loadAi(true);
            }
          });

          if (retryBtn) retryBtn.addEventListener('click', () => loadAi(true));
          await loadAi(false);
        })();
      });
    });
  };
  bindEmailClicks(panel);

  // 编辑历史备注
  panel.querySelectorAll('.crm-note-edit').forEach(p => {
    p.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const noteId = p.dataset.noteId;
      const item = p.closest('.crm-followup-item');
      const cd = item.querySelector('.crm-note-content');
      const orig = cd.textContent;
      const ta = document.createElement('textarea');
      ta.value = orig; ta.rows = 3;
      ta.style.cssText = 'width:100%;padding:6px;border:1px solid var(--primary);border-radius:4px;font-size:12px';
      cd.replaceWith(ta); ta.focus();
      const save = async () => {
        const val = ta.value.trim();
        if (val === orig) { ta.replaceWith(cd); return; }
        await window.electronAPI.updateNote(noteId, val);
        cd.textContent = val; ta.replaceWith(cd);
        showToast('已更新','ok');
      };
      ta.addEventListener('blur', save);
      ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); } });
    });
  });
}

window.__pageHandlers = window.__pageHandlers || {};
window.__pageHandlers['crm'] = initCrmPipeline;
