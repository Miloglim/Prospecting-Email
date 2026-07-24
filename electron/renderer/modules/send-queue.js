const S = window.S;
import CS from './company-state.js';
import { lucide,showAlert,showConfirm,escapeHtml,truncate,formatDate,daysSince,statusLabel,findById,initIcons,showModal,clientTypeTag } from './shared.js';
import { randomPick, assembleEmail } from './templates.js';

// ===== 发送队列 =======================================================

// ponytail: 将 sending → 回退并重算队列项状态（暂停/限流/卡住/错误共用）
function _rollbackSendingStatus(e) {
  if (e._recipientStatus) {
    e._recipientStatus.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
    const sentN = e._recipientStatus.filter(r => r.status === 'sent').length;
    const failN = e._recipientStatus.filter(r => r.status === 'failed').length;
    const total = e._recipientStatus.length;
    e.status = sentN === total ? 'sent' : failN === total ? 'failed' : 'pending';
  } else {
    e.status = 'pending';
  }
}

export function saveQueue() {
  // ponytail: 只写磁盘文件，localStorage 仅做冷启动兜底（loadQueue 时）
  window.electronAPI.saveQueue(S.queue).catch(() => {});
}

// 应用重启后，「发送中」的残留项恢复为「待发送」
export async function initQueue() {
  await S.loadQueue();
  // 首次进入队列页自动追回历史阶段（仅执行一次）
  if (!S._catchupDone) {
    S._catchupDone = true;
    try {
      const r = await window.electronAPI.catchupStage();
      if (r?.caught > 0) showAlert(`阶段追回: ${r.caught} 家公司 cold → f1`, 'ok');
    } catch { /* 追回失败不阻塞 UI */ }
  }
  let changed = false;
  S.queue.forEach(e => {
    // 队列级别
    if (e.status === 'sending') { e.status = 'pending'; changed = true; }
    // 逐人级别：把卡在 sending 的收件人回退为 pending
    if (e._recipientStatus) {
      e._recipientStatus.forEach(r => {
        if (r.status === 'sending') { r.status = 'pending'; changed = true; }
      });
      // 重新计算综合状态
      if (e._recipientStatus.every(r => r.status === 'sent')) {
        if (e.status !== 'sent') { e.status = 'sent'; changed = true; }
      } else if (e._recipientStatus.every(r => r.status === 'failed')) {
        if (e.status !== 'failed') { e.status = 'failed'; changed = true; }
      } else if (e._recipientStatus.some(r => r.status !== 'pending')) {
        e.status = 'pending'; changed = true; // 部分完成 → 回退重发
      }
    }
  });
  if (changed) saveQueue();
  // 恢复上次计时器
  try {
    const state = await window.electronAPI.loadSendState();
    const sec = state.data?.totalSeconds;
    if (sec > 0 && state.data?.status !== 'idle' && state.data?.status !== 'done') {
      const t = document.getElementById('queue-timer-title');
      if (t) {
        t._totalSec = sec;
        const m = Math.floor(sec / 60), s = sec % 60;
        t.textContent = m + ':' + String(s).padStart(2, '0');
        t.style.display = '';
        t.style.color = 'var(--text-secondary)';
      }
    }
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
  // 恢复延迟倒计时
  try {
    const raw = localStorage.getItem('_delay');
    if (raw) {
      const d = JSON.parse(raw);
      if (d.sec > 0) {
        const el = document.getElementById('queue-estimate');
        if (el) {
          el.style.display = 'block';
          el.style.color = '';
          el._delayRemaining = d.sec;
          const label = d.label ? ` → ${escapeHtml(d.label)}` : '';
          el.textContent = `批量暂停${label}... ${Math.floor(d.sec/60)} 分 ${d.sec%60} 秒后继续`;
        }
      }
    }
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
}

export async function syncTestMode() {
  try {
    const config = await window.electronAPI.loadConfig();
    const testEnabled = !!(config && config.test && config.test.enabled);
    const testEmail = config?.test?.email || '';
    const tsEl = document.getElementById('queue-test-status');
    const testBtn = document.getElementById('queue-test-send');
    const liveLogBtn = document.getElementById('btn-live-log');
    if (tsEl) {
      tsEl.textContent = testEnabled ? `测试模式: ${testEmail}` : '';
    }
    if (testBtn) {
      testBtn.style.display = (testEnabled && testEmail) ? '' : 'none';
    }
    if (liveLogBtn) {
      liveLogBtn.style.display = (testEnabled && testEmail) ? '' : 'none';
    }
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
}

export async function renderQueue() {
  if (!S._queueLoaded) await S.loadQueue();
  syncTestMode();
  // 标题计数：按实际邮件数（联系人），非队列项数
  const countEmails = (e) => e.recipients?.length || (e.to?.split(',')?.length || 1);
  const sentEmails = S.queue.filter(e => e.status === 'sent' || e.status === 'failed').reduce((s, e) => s + countEmails(e), 0);
  const totalEmails = S.queue.reduce((s, e) => s + countEmails(e), 0);
  const countEl = document.getElementById('queue-sent-count');
  if (countEl) countEl.textContent = totalEmails ? `(${sentEmails}/${totalEmails})` : '';
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  if (!list) return;
  if (!S.queue.length) { list.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  // 待发送在上，已完成在底部
  const sorted = [...S.queue].sort((a, b) => {
    const aDone = a.status === 'sent' || a.status === 'failed';
    const bDone = b.status === 'sent' || b.status === 'failed';
    return aDone === bDone ? 0 : aDone ? 1 : -1;
  });

  const statusIcon = (s) => s === 'sent'
    ? lucide('check-circle',14)
    : s === 'failed'
      ? lucide('x-circle',14)
      : s === 'sending'
        ? lucide('refresh-cw',14,'spin')
        : lucide('clock',14);
  const statusBadge = (s) => {
    const cls = 'status-' + s;
    const label = { pending: '待发送', sent: '已发送', failed: '失败', sending: '发送中' }[s] || s;
    return `<span class="${cls}" style="font-size:11px;display:flex;align-items:center;gap:3px">${statusIcon(s)} ${label}</span>`;
  };
  const typeLabelMap = { agent: '代理模板', direct: '直客模板', unlabeled: '通用模板' };

  // 聚合各公司的联系人标签（用于队列卡片展示）
  const companyTagMap = {};
  const TAG_LABEL = { reaching: '触达中', quoting: '报价中', trial: '试单', cooperating: '合作中', lost: '已流失', reached: '已触达' };
  const TAG_COLOR = { reaching: '#ff9800', quoting: '#2196f3', trial: '#8e24aa', cooperating: '#4caf50', lost: '#b0b0b0', reached: '#22a644' };
  try {
    const contacts = S.contactsData || await window.electronAPI.getContacts();
    for (const c of contacts) {
      const name = c.company || '未命名';
      if (!companyTagMap[name]) companyTagMap[name] = new Set();
      const tags = c.tags || [];
      for (const t of tags) companyTagMap[name].add(t);
    }
  } catch { /* 渲染层降级：操作失败不影响 UI */ }

  const cardHtml = (e) => {
    const count = e.recipients?.length || (e.to?.split(',')?.length || 1);
    const stageHtml = e._stage
      ? `<span class="stage-badge stage-${e._stage}">${S.STAGE_LABELS_SEND[e._stage] || e._stage}</span>`
      : '';
    const failInfo = e._error ? `<div style="font-size:10px;color:var(--danger);margin-top:2px">${escapeHtml(e._error)}</div>` : '';
    const tt = clientTypeTag(e._type);
    const tplLabel = e._templateLabel || typeLabelMap[e._type] || '通用模板';
    const tplSourceTag = e._templateSource === 'user'
      ? `<span style="font-weight:600;color:var(--primary)">${escapeHtml(tplLabel)}</span>`
      : `<span style="color:var(--text-secondary)">${escapeHtml(tplLabel)}</span>`;
    const ctry = e._country ? `<span>${escapeHtml(e._country)}</span>` : '';
    const langTag = e._lang ? `<span>${escapeHtml(e._lang).toUpperCase()}</span>` : '';
    // 联系人标签徽章
    const contactTagSet = companyTagMap[e.company];
    const contactTagBadges = contactTagSet && contactTagSet.size
      ? [...contactTagSet].map(t => {
          const label = TAG_LABEL[t] || t;
          const color = TAG_COLOR[t] || 'var(--text-secondary)';
          return `<span style="font-size:10px;padding:0 5px;border-radius:8px;background:${color}18;color:${color};white-space:nowrap">${label}</span>`;
        }).join(' ')
      : '';
    const tagsArr = [tt, ctry, langTag, `<span>${count}人</span>`, tplSourceTag, contactTagBadges].filter(Boolean);
    const tagsHtml = tagsArr.length ? `<div class="qc-tags">${tagsArr.join(' · ')}</div>` : '';
    const retryBtn = e.status === 'failed'
      ? `<button class="qc-retry" data-id="${e.id}">${lucide('refresh-cw',12)} 重发</button>`
      : '';
    const gLabel = e._groupTotal > 1 ? `<span style="font-size:10px;color:var(--text-secondary);margin-left:4px">(${e._groupSeq + 1}/${e._groupTotal})</span>` : '';
    const rs = e._recipientStatus || e.recipients?.map(r => ({ email: r, status: 'pending' })) || [];
    // 部分发送进度（不展开也能看到）
    const sentCount = rs.filter(r => r.status === 'sent').length;
    const failCount = rs.filter(r => r.status === 'failed').length;
    const totalCount = rs.length;
    const partialHint = (sentCount > 0 || failCount > 0) && (sentCount + failCount) < totalCount
      ? `<div style="font-size:11px;color:var(--text-secondary);margin:2px 0;display:flex;align-items:center;gap:4px">
          ${lucide('users',12)} ${sentCount}/${totalCount} 已发${failCount > 0 ? ` · ${failCount} 失败` : ''}
        </div>`
      : '';
    const cardCls = 'queue-card' + (e.status === 'sending' && S.sendInProgress ? ' sending' : '');

    const chkId = 'qchk-' + e.id;
    return `<div class="${cardCls}" data-id="${e.id}" data-company="${escapeHtml(e.company || '').replace(/"/g, '&quot;')}">
      <input type="checkbox" class="qc-check" id="${chkId}" data-id="${e.id}" style="position:absolute;top:12px;left:14px;cursor:pointer" onchange="document.getElementById('queue-delete-selected').style.display=document.querySelectorAll('.qc-check:checked').length?'':'none'">
      <div class="qc-header" style="margin-left:24px">
        <span class="qc-company" title="${escapeHtml(e.company)}">${escapeHtml(e.company)}${gLabel}</span>
        ${stageHtml}
        ${statusBadge(e.status)}
      </div>
      <div class="qc-body">
        <div class="qc-to">To: ${escapeHtml(e.recipients?.[0] || e.to?.split(',')[0] || '')}${count > 1 ? ` <span style="font-size:10px">+\u2060${count - 1} 位</span>` : ''}</div>
        <div class="qc-subject" title="${escapeHtml(e.subject)}">${escapeHtml(e.subject)}</div>
        ${partialHint}
      </div>
      <div class="qc-footer">
        ${tagsHtml}
        <span class="qc-expand">${lucide('chevron-down',12)} 展开</span>
        ${retryBtn}
      </div>
      ${failInfo}
      <div class="qc-detail"></div>
    </div>`;
  };

  // 按公司分组
  const groups = {};
  sorted.forEach(e => {
    const key = e.company || e._groupOf || '未知';
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  // 找出当前正在发送的公司
  const activeCompany = sorted.find(e => e.status === 'sending')?.company || '';
  let activeGroupId = '';

  let html = '';
  // 正在发送的提示条
  if (activeCompany && S.sendInProgress) {
    html += `<div class="queue-current-bar" id="queue-current-bar">
      <span class="cur-dot"></span> 正在发送：${escapeHtml(activeCompany)}${S._currentAccountLabel ? ` · ${escapeHtml(S._currentAccountLabel)}` : ''}
    </div>`;
  }

  for (const [company, items] of Object.entries(groups)) {
    const totalPeople = items.reduce((sum, e) => sum + (e.recipients?.length || 0), 0);
    const gid = 'qg-' + company.replace(/[^a-zA-Z0-9]/g, '');
    const hasSending = items.some(e => e.status === 'sending');
    const isActive = hasSending && S.sendInProgress;
    if (isActive) activeGroupId = gid;
    const headCls = 'queue-group-head' + (isActive ? ' active' : '');
    // 仅发送中且未暂停时自动展开 + 显示状态
    const cardDisplay = (hasSending && S.sendInProgress) ? 'block' : 'none';
    const arrowRotate = (hasSending && S.sendInProgress) ? 'rotate(90deg)' : '';
    const statusText = (hasSending && S.sendInProgress)
      ? ` · <span style="color:var(--primary)">${items.filter(e => e.status === 'sending').length}/${items.length} 发送中</span>`
      : '';
    const groupStage = items[0]?._stage || 'cold';
    const stageLabel = S.STAGE_LABELS_SEND[groupStage] || groupStage;
    html += `<div class="${headCls}" data-group="${gid}" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f5f6f8;border-radius:6px;margin-bottom:2px;font-size:12px;font-weight:600">
      <span class="qg-arrow" style="display:inline-block;width:14px;font-size:10px;transition:transform .2s;transform:${arrowRotate}">▸</span>
      ${escapeHtml(company)}
      <span class="stage-badge stage-${groupStage}" style="font-size:10px">${stageLabel}</span>
      <span style="color:var(--text-secondary);font-weight:400;font-size:11px">${items.length} 组 · ${totalPeople} 人${statusText}</span>
    </div>`;
    html += `<div class="queue-group-cards" data-group="${gid}" style="display:${cardDisplay};margin-bottom:6px;padding-left:4px">`;
    html += items.map(cardHtml).join('');
    html += '</div>';
  }
  list.innerHTML = html;

  // ponytail: 事件委托 — 单一监听器处理所有卡片交互
  if (!list._delegated) {
    list._delegated = true;
    list.addEventListener('click', (ev) => {
      // ── 重发按钮 ──
      const retryBtn = ev.target.closest('.qc-retry');
      if (retryBtn) {
        ev.stopPropagation();
        const item = S.queue.find(e => e.id == retryBtn.dataset.id);
        if (item) {
          item.status = 'pending';
          delete item._error;
          if (item._recipientStatus) item._recipientStatus.forEach(r => { r.status = 'pending'; delete r._error; });
          saveQueue();
          renderQueue();
        }
        return;
      }

      // ── 分组折叠/展开 ──
      const head = ev.target.closest('.queue-group-head');
      if (head) {
        const gid = head.dataset.group;
        const cards = list.querySelector(`.queue-group-cards[data-group="${gid}"]`);
        const arrow = head.querySelector('.qg-arrow');
        if (!cards) return;
        const hidden = cards.style.display === 'none';
        cards.style.display = hidden ? 'block' : 'none';
        if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
        return;
      }

      // ── 卡片点击 → 懒渲染 + 展开收件人详情 ──
      const card = ev.target.closest('.queue-card');
      if (!card || ev.target.closest('button')) return;
      const detail = card.querySelector('.qc-detail');
      const btn = card.querySelector('.qc-expand');
      if (!detail) return;
      const isOpen = !detail.classList.contains('open');
      if (isOpen) {
        detail.classList.add('open');
        // 懒渲染：首次展开时生成收件人列表
        if (!detail.children.length) {
          const id = card.dataset.id;
          const item = S.queue.find(e => e.id == id);
          const rs = item?._recipientStatus || item?.recipients?.map(r => ({ email: r, status: 'pending' })) || [];
          detail.innerHTML = rs.map(r => {
            const err = r._error ? ` <span style="font-size:10px;color:var(--danger)">${escapeHtml(r._error)}</span>` : '';
            const icon = r.status === 'sent' ? lucide('check-circle',14) : r.status === 'failed' ? lucide('x-circle',14) : r.status === 'sending' ? lucide('refresh-cw',14,'spin') : lucide('clock',14);
            return `<div class="qc-recipient ${r.status}"><span>${icon}</span><span style="font-family:monospace;flex:1">${escapeHtml(r.email)}</span>${err}</div>`;
          }).join('');
        }
        if (btn) btn.innerHTML = `<span style="display:inline-block;transform:rotate(180deg)">${lucide('chevron-down',12)}</span> 收起`;
      } else {
        detail.classList.remove('open');
        if (btn) btn.innerHTML = `${lucide('chevron-down',12)} 展开`;
      }
    });
  }

  document.getElementById('queue-start').disabled = S.sendInProgress;
  document.getElementById('queue-pause').disabled = !S.sendInProgress;
  document.getElementById('queue-cancel').disabled = S.sendInProgress || !S.queue.length;  // 发送中 或 队列空 时不可取消

  // 全部折叠/展开（状态保存在 DOM 上，刷新不丢失）
  const foldBtn = document.getElementById('queue-fold-all');
  if (foldBtn) {
    const wasFolded = foldBtn.dataset.folded === 'true';
    if (wasFolded) {
      list.querySelectorAll('.queue-group-head').forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = ''; });
      list.querySelectorAll('.queue-group-cards').forEach(c => c.style.display = 'none');
      foldBtn.innerHTML = lucide('chevron-right',12) + ' 全部展开';
    } else {
      list.querySelectorAll('.queue-group-head').forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = 'rotate(90deg)'; });
      list.querySelectorAll('.queue-group-cards').forEach(c => c.style.display = 'block');
      foldBtn.innerHTML = lucide('chevron-down',12) + ' 全部折叠';
    }
    foldBtn.onclick = () => {
      const heads = list.querySelectorAll('.queue-group-head');
      const cards = list.querySelectorAll('.queue-group-cards');
      if (foldBtn.dataset.folded !== 'true') {
        heads.forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = ''; });
        cards.forEach(c => c.style.display = 'none');
        foldBtn.innerHTML = lucide('chevron-right',12) + ' 全部展开';
        foldBtn.dataset.folded = 'true';
      } else {
        heads.forEach(h => { const a = h.querySelector('.qg-arrow'); if (a) a.style.transform = 'rotate(90deg)'; });
        cards.forEach(c => c.style.display = 'block');
        foldBtn.innerHTML = lucide('chevron-down',12) + ' 全部折叠';
        foldBtn.dataset.folded = 'false';
      }
    };
  }
}



export async function startSend() {
  if (S.sendInProgress) return;
  // 恢复暂停的发送，不清队列不重启
  if (S._sendPaused) {
    S._sendPaused = false;
    S.sendInProgress = true;
    if (!S._advancedThisRun) S._advancedThisRun = new Set(); // 恢复后继续追踪
    const startBtn = document.getElementById('queue-start');
    if (startBtn) startBtn.innerHTML = '<span data-icon="chevron-right"></span> 开始发送';
    startBtn.disabled = true;
    document.getElementById('queue-pause').disabled = false;
    document.getElementById('queue-progress')?.classList.add('active');
    const el = document.getElementById('queue-estimate');
    if (el) el.style.color = 'var(--warning)';
    resumeTimer();
    renderQueue(); // 立即恢复「正在发送」指示条
    await window.electronAPI.resumeSend();
    return;
  }
  S.sendInProgress = true;
  S._sendPaused = false;
  S._advancedThisRun = new Set(); // ponytail: 本轮已递进公司追踪，防止批量推进重复递进
  const pending = S.queue.filter(e => e.status === 'pending');
  if (!pending.length) { S.sendInProgress = false; return; }

  // 发送前补全缺失的收件人信息（仅对无 recipients 的旧数据）
  const freshContacts = await window.electronAPI.getContacts();
  const freshCompanies = {};
  for (const c of freshContacts) {
    const name = c.company || '未命名';
    if (!freshCompanies[name]) freshCompanies[name] = [];
    freshCompanies[name].push(c);
  }
  let recipientsFixed = 0;
  for (const item of pending) {
    if (item.recipients && item.recipients.length) continue; // 已有分组数据，不动
    const members = freshCompanies[item.company] || [];
    const allEmails = [...new Set(
      members.map(m => (m.email || '').trim()).filter(e => e && S.EMAIL_RE.test(e))
    )];
    if (allEmails.length) {
      item.recipients = allEmails;
      item.to = allEmails.join(', ');
      recipientsFixed++;
    }
  }
  // ponytail: 旧队列收件人补全已在上方处理，静默执行

  // 仅第一个队列项标记为发送中（聚焦当前任务）
  const firstPending = pending[0];
  if (firstPending) {
    firstPending.status = 'sending';
    if (firstPending._recipientStatus) firstPending._recipientStatus.forEach(r => { if (r.status === 'pending') r.status = 'sending'; });
  }
  const progBar = document.getElementById('queue-progress');
  progBar.style.width = '0%';
  progBar.classList.add('active');
  const estEl = document.getElementById('queue-estimate');
  if (estEl) estEl.style.color = 'var(--warning)';
  renderQueue();
  document.getElementById('queue-start').disabled = true;
  document.getElementById('queue-pause').disabled = false;
  document.getElementById('queue-cancel').disabled = true;  // 发送中不可取消
  if (S.unsubscribeProgress) S.unsubscribeProgress();

  S.unsubscribeProgress = await window.electronAPI.onSendProgress(async (data) => {
    if (data.type === 'sent') {
      // 记录当前发送账号
      if (data.accountLabel) S._currentAccountLabel = data.accountLabel;
      const item = S.queue.find(e => e.id === data.id);
      if (item) {
        if (!item._recipientStatus) {
          item._recipientStatus = (item.recipients || []).map(e => ({ email: e, status: 'pending' }));
        }
        // BCC 模式：data.to 是逗号分隔的所有收件人，data.count 是总数
        const sentList = (data.to || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of sentList) {
          const rs = item._recipientStatus.find(r => r.email.toLowerCase().trim() === addr.toLowerCase().trim());
          if (rs) rs.status = 'sent';
        }
        if (item._recipientStatus.every(r => r.status === 'sent')) item.status = 'sent';
        else item.status = 'sending';
      }
    } else if (data.type === 'skipped') {
      // 引擎检测到全部已发，跳过：直接标记为 sent 并推进
      const item = S.queue.find(e => e.id === data.id);
      if (item) {
        if (item._recipientStatus) {
          item._recipientStatus.forEach(r => { if (r.status !== 'sent' && r.status !== 'failed') r.status = 'sent'; });
        }
        item.status = 'sent';
      }
    } else if (data.type === 'failed') {
      const item = S.queue.find(e => e.id === data.id);
      if (item) {
        if (!item._recipientStatus) {
          item._recipientStatus = (item.recipients || []).map(e => ({ email: e, status: 'pending' }));
        }
        const failList = (data.to || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of failList) {
          const rs = item._recipientStatus.find(r => r.email.toLowerCase().trim() === addr.toLowerCase().trim());
          if (rs) { rs.status = 'failed'; rs._error = data.error; }
        }
        item._error = data.error;
        if (item._recipientStatus.every(r => r.status !== 'pending')) {
          item.status = item._recipientStatus.every(r => r.status === 'sent') ? 'sent' : 'failed';
        } else {
          item.status = 'sending';
        }
      }
    } else if (data.type === 'sending') {
    } else if (data.type === 'estimate') {
      // 不显示 — 延迟消息会自动接管
      // 启动十分钟自动退信扫描
      startAutoBounceInterval();

      // 启动计时器
      const tt = document.getElementById('queue-timer-title');
      if (tt) {
        if (!tt._startedAt) { tt._startedAt = Date.now(); tt._accumulated = 0; }
        tt.style.display = '';
        clearInterval(tt._interval);
        tt._interval = setInterval(() => {
          if (!S.sendInProgress) return;
          const acc = (tt._accumulated || 0) + Math.floor((Date.now() - tt._startedAt) / 1000);
          const m = Math.floor(acc / 60), s = acc % 60;
          tt.textContent = m + ':' + String(s).padStart(2, '0');
        }, 1000);
      }
    } else if (data.type === 'waiting') {
      // 更新时间窗口等待提示
      const prog = document.getElementById('queue-progress');
      if (prog) prog.title = data.message || '等待发送窗口...';
    } else if (data.type === 'delay') {
      const el = document.getElementById('queue-estimate');
      if (el) {
        const totalSec = data.seconds;
        el.style.display = 'block';
        el.style.color = 'var(--warning)';
        clearTimeout(el._delayTimer);
        el._delayRemaining = totalSec;
        const tick = () => {
          if (S.sendInProgress === false) {
            // 颜色由 paused/resume 事件管理，tick 不动
            el._delayTimer = setTimeout(tick, 1000);
            localStorage.setItem('_delay', JSON.stringify({ sec: el._delayRemaining, label: data.company || '' }));
            return;
          }
          if (el._delayRemaining <= 0) {
            el.textContent = '📤 发送中...';
            el.style.color = 'var(--primary)';
            localStorage.removeItem('_delay');
            return;
          }
          const m = Math.floor(el._delayRemaining / 60);
          const s = el._delayRemaining % 60;
          const label = data.company ? ` → ${escapeHtml(data.company)}` : '';
          el.textContent = `批量暂停${label}... ${m} 分 ${s} 秒后继续`;
          el._delayRemaining--;
          el._delayTimer = setTimeout(tick, 1000);
        };
        tick();
      }
    } else if (data.type === 'ratelimit') {
      freezeAndSaveTimer('var(--danger)');
      const el = document.getElementById('queue-estimate');
      if (el) { el.style.display = 'block'; el.textContent = `发送被限流！${data.error || ''} 发送已自动暂停，请等待后手动恢复。`; el.style.color = 'var(--danger)'; }
      S.sendInProgress = false;
      // 将 sending 回退，保留已发送的部分进度
      S.queue.forEach(e => { if (e.status === 'sending') _rollbackSendingStatus(e); });
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = false;
    } else if (data.type === 'cancelled') {
      S._sendPaused = false;
      resetQueueTimer();
      clearQueueDelayUI();
      S.sendInProgress = false;
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = false;
      const pb2 = document.getElementById('queue-progress');
      if (pb2) pb2.classList.remove('active');
    } else if (data.type === 'complete') {
      S._sendPaused = false;
      localStorage.removeItem('_delay');
      freezeAndSaveTimer('var(--text-secondary)');
      // 已达上限时保留提示，不清除
      const limitEl = document.getElementById('queue-estimate');
      const isAtLimit = limitEl && limitEl.textContent.includes('已达每日上限');
      if (!isAtLimit) clearQueueDelayUI();
      // complete / cancel 时推进阶段
      S.sendInProgress = false;
      const progBar = document.getElementById('queue-progress');
      if (progBar) progBar.classList.remove('active');
      // 隐藏当前发送指示条
      const curBar = document.getElementById('queue-current-bar');
      if (curBar) curBar.style.display = 'none';
      if (!isAtLimit) document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = false;
      // 测试模式不推进阶段。仅当公司所有联系人都已发送时才推进，防止分批发送导致过早归档
      if (!data._testMode) {
        const companyHasPending = {};
        S.queue.forEach(e => { if (e.company && e.status === 'pending') companyHasPending[e.company] = true; });
        // ponytail: 排除 per-item handler 已递进的公司，避免同一轮发送递进两次
        const alreadyAdvanced = S._advancedThisRun || new Set();
        const sentCompanies = S.queue.filter(e => e.status === 'sent' && e._stage && !companyHasPending[e.company] && !alreadyAdvanced.has(e.company)).map(e => e.company);
        if (sentCompanies.length) {
          const newHist = await window.electronAPI.advanceStage([...new Set(sentCompanies)]);
          if (newHist) { Object.assign(S.contactsSendHistory, newHist); CS.syncContactsUI(); }
        }
        S._advancedThisRun = null; // 本轮结束，清理追踪
      }
    } else if (data.type === 'limit') {
      // 达到每日上限
      const el2 = document.getElementById('queue-estimate');
      if (el2) { el2.style.display = 'block'; el2.style.color = 'var(--danger)'; el2.textContent = `⛔ ${data.message || '已达每日上限'}，今日无法继续发送`; }
      S.sendInProgress = false;
      document.getElementById('queue-start').disabled = true;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = false;
      S.sendInProgress = false;
      freezeAndSaveTimer('var(--text-secondary)');
    } else if (data.type === 'paused') {
      S._sendPaused = true;
      const startBtn = document.getElementById('queue-start');
      if (startBtn) startBtn.innerHTML = '<span data-icon="chevron-right"></span> 继续发送';
      freezeAndSaveTimer('var(--warning)');
      const delayEl = document.getElementById('queue-estimate');
      if (delayEl) { delayEl.style.color = 'var(--text-secondary)'; }
      // 暂停：只更新 UI，不推进阶段
      S.sendInProgress = false;
      const progBar = document.getElementById('queue-progress');
      if (progBar) progBar.classList.remove('active');
      const curBar = document.getElementById('queue-current-bar');
      if (curBar) curBar.style.display = 'none';
      document.getElementById('queue-start').disabled = false;
      document.getElementById('queue-pause').disabled = true;
      document.getElementById('queue-cancel').disabled = false;
    }
    // 每完成一个队列项，推进下一个 pending → sending（仅聚焦当前任务）
    if (S.sendInProgress && (data.type === 'sent' || data.type === 'failed' || data.type === 'skipped')) {
      const nextP = S.queue.find(e => e.status === 'pending');
      if (nextP) {
        nextP.status = 'sending';
        if (nextP._recipientStatus) nextP._recipientStatus.forEach(r => { if (r.status === 'pending') r.status = 'sending'; });
      }
      // 热更新：检查刚完成的公司是否全部发完，是则立即推进阶段
      if (data.type === 'sent' || data.type === 'skipped') {
        const justDone = S.queue.find(e => e.id === data.id);
        if (justDone && justDone.company && justDone._stage) {
          const items = S.queue.filter(e => e.company === justDone.company);
          const hasPending = items.some(e => e.status === 'pending');
          const allDone = items.every(e => e.status === 'sent');
          if (!hasPending && allDone) {
            const newHist = await window.electronAPI.advanceStage([justDone.company]);
            if (newHist) { Object.assign(S.contactsSendHistory, newHist); CS.syncContactsUI(); }
            if (S._advancedThisRun) S._advancedThisRun.add(justDone.company);
          }
        }
      }
    }
    const sent = S.queue.filter(e => e.status === 'sent' || e.status === 'failed').length;
    const progBar = document.getElementById('queue-progress');
    progBar.style.width = S.queue.length > 0 ? Math.round((sent / S.queue.length) * 100) + '%' : '0%';
    if (S.sendInProgress) progBar.classList.add('active'); else progBar.classList.remove('active');
    renderQueue();
    saveQueue();
  });
  const result = await window.electronAPI.startSend(pending).catch(e => {
    console.error('发送启动失败:', e);
    return { error: e.message };
  });
  // 兜底：发送返回0封时，把卡在 sending 的项回退
  if (!result?.error) {
    setTimeout(() => {
      const stuck = S.queue.filter(e => e.status === 'sending');
      if (stuck.length && !S.sendInProgress) {
        stuck.forEach(e => _rollbackSendingStatus(e));
        saveQueue();
        renderQueue();
      }
    }, 1000);
  }
  // 错误时回退，保留已发送的部分进度
  if (result?.error) {
    S.sendInProgress = false;
    pending.forEach(e => { if (e.status === 'sending') _rollbackSendingStatus(e); });
    document.getElementById('queue-start').disabled = false;
    document.getElementById('queue-pause').disabled = true;
    document.getElementById('queue-cancel').disabled = false;
    saveQueue();
    renderQueue();
  }
}

document.getElementById('queue-start')?.addEventListener('click', () => { startSend().catch(e => console.error(e)); });
document.getElementById('queue-pause')?.addEventListener('click', async () => {
  await window.electronAPI.pauseSend();
  S._sendPaused = true;
  S.sendInProgress = false;
  const startBtn = document.getElementById('queue-start');
  if (startBtn) startBtn.innerHTML = '<span data-icon="chevron-right"></span> 继续发送';
  // 暂停：仅回退正在发送中（实际未发出）的收件人，保留已发送的部分进度
  S.queue.forEach(e => { if (e.status === 'sending') _rollbackSendingStatus(e); });
  saveQueue();
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = false;
  const pb = document.getElementById('queue-progress'); pb.classList.remove('active');
  renderQueue();
});

document.getElementById('queue-cancel')?.addEventListener('click', async () => {
  await window.electronAPI.cancelSend();
  localStorage.removeItem('_delay');
  S._sendPaused = false;
  S.sendInProgress = false;
  S.queue = []; saveQueue();
  resetQueueTimer();
  clearQueueDelayUI();
  document.getElementById('queue-start').disabled = false;
  document.getElementById('queue-start').innerHTML = '<span data-icon="chevron-right"></span> 开始发送';
  document.getElementById('queue-pause').disabled = true;
  document.getElementById('queue-cancel').disabled = false;
  document.getElementById('queue-delete-selected').style.display = 'none';
  const pb = document.getElementById('queue-progress'); pb.style.width = '0%'; pb.classList.remove('active');
  renderQueue();
});

export function resetQueueTimer() {
  const t = document.getElementById('queue-timer-title');
  if (t) { clearInterval(t._interval); t.textContent = ''; t.style.display = 'none'; t.style.color = ''; delete t._startedAt; delete t._accumulated; }
}
// ── 测试发送按钮 ──────────────────────────────────────────────────
document.getElementById('queue-test-send')?.addEventListener('click', async () => {
  const btn = document.getElementById('queue-test-send');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '发送中...';

  try {
    // ponytail: 生成简短测试正文，使用模板库的第一个 hook
    const config = await window.electronAPI.loadConfig().catch(() => ({}));
    if (!S.templateLib) await CS.refreshTemplateLib();
    const hook = S.templateLib?.hooks?.[0];
    const testCompany = config?.test?.company || 'Demo Company';
    const senderName = config?.sender?.bodyName || 'Zayne';
    const subject = config?.test?.company
      ? `Propuesta logística — ${testCompany}`
      : 'Propuesta logística — Mensaje de prueba';

    let body;
    if (hook) {
      body = assembleEmail('es', hook, null, null, null, null, 'cold', 'unlabeled', senderName, undefined);
    } else {
      body = `Buen día,\n\nSoy ${senderName}, de YQN. Somos un agente de carga con operaciones en las principales rutas de Asia a Latinoamérica.\n\nSi en algún momento necesitan apoyo logístico, estoy a su disposición.\n\nSaludos,`;
    }

    const result = await window.electronAPI.sendTestOne({ body, subject });
    if (result.ok) {
      showAlert(`测试邮件已发送 → ${result.to}`, 'ok');
    } else {
      showAlert(`❌ 发送失败: ${result.error}`, 'err');
    }
  } catch (e) {
    showAlert(`❌ 发送异常: ${e.message}`, 'err');
  }

  btn.disabled = false;
  btn.textContent = '发送测试';
});
// ── 实时日志按钮 ──────────────────────────────────────────────────────
document.getElementById('btn-live-log')?.addEventListener('click', () => {
  window.electronAPI.openLogFile();
});

export function freezeAndSaveTimer(_color) {
  const t = document.getElementById('queue-timer-title');
  if (t) {
    clearInterval(t._interval);
    if (t._startedAt) { t._accumulated = (t._accumulated || 0) + Math.floor((Date.now() - t._startedAt) / 1000); delete t._startedAt; }
  }
}
export function resumeTimer() {
  const t = document.getElementById('queue-timer-title');
  if (t && t._accumulated != null) {
    t._startedAt = Date.now(); t.style.display = '';
    clearInterval(t._interval);
    t._interval = setInterval(() => {
      if (!S.sendInProgress) return;
      const acc = (t._accumulated || 0) + Math.floor((Date.now() - t._startedAt) / 1000);
      const m = Math.floor(acc / 60), s = acc % 60;
      t.textContent = m + ':' + String(s).padStart(2, '0');
    }, 1000);
  }
}

// ── 五分钟循环退信扫描（仅队列发送中生效）─────────────────────────────────
export function startAutoBounceInterval() {
  clearInterval(S.autoBounceTimer);
  S.nextBounceScanAt = Date.now() + 5 * 60 * 1000;
  S.autoBounceTimer = setInterval(async () => {
    if (!S.sendInProgress) return; // 没在发送就不扫
    try {
      const result = await window.electronAPI.checkBounces();
      if (result.ok && result.bounced?.length) {
        const contacts = await window.electronAPI.getContacts();
        const contactMap = {};
        contacts.forEach(c => { const e = (c.email || '').toLowerCase().trim(); if (e) contactMap[e] = c; });
        const records = result.bounced.map(b => {
          const email = b.bouncedEmail || '';
          const matched = contactMap[email];
          return { ...b, email, matched: !!matched, company: matched ? matched.company : '', contactId: matched ? matched.id : '' };
        });
        const matched = records.filter(r => r.matched);
        if (matched.length) {
          await window.electronAPI.saveBounceLog(records);
          for (const r of matched) {
            window.electronAPI.updateBounce(r.email, { type: r.type || 'unknown', reason: r.reason || '未知原因' }).catch(()=>{});
          }
          showAlert(`📨 自动扫描: ${result.bounced.length} 封退信，${matched.length} 人匹配`, 'warn');
        }
      }
    } catch { /* 渲染层降级：操作失败不影响 UI */ }
    S.nextBounceScanAt = Date.now() + 10 * 60 * 1000;
  }, 10 * 60 * 1000);
}

export function clearQueueDelayUI() {
  const el = document.getElementById('queue-estimate');
  if (el) { clearTimeout(el._delayTimer); el.style.display = 'none'; el.style.color = ''; }
}

// ── 队列操作函数（供菜单调用）─────────────────────────────────────────
export async function doQueueRefresh() {
  try {
  if (S.sendInProgress) return await showAlert('发送进行中，请先暂停');
  if (!S.templateLib) await CS.refreshTemplateLib();
  const pending = S.queue.filter(e => e.status === 'pending');
  if (!pending.length) return await showAlert('没有待发送的队列项');
  if (!await showConfirm(`确定刷新 ${pending.length} 个待发送队列项？\n将按当前配置重新分组并随机换模板。已完成的不受影响。`)) return;
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  const groupSize = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);

  // ponytail: 加载用户模板，刷新时保留用户模板来源
  let userTemplates = [];
  try { userTemplates = await window.electronAPI.listUserTemplates(); } catch { /* 渲染层降级：操作失败不影响 UI */ }

  const companyEmails = {};
  for (const item of pending) {
    const name = item.company;
    if (!companyEmails[name]) companyEmails[name] = { emails: [], meta: item };
    const emails = item.recipients || item.to?.split(',').map(s => s.trim()).filter(Boolean) || [];
    emails.forEach(e => { if (e) companyEmails[name].emails.push(e); });
  }
  if (!S.sendHistory || !Object.keys(S.sendHistory).length) {
    try { await CS.refreshSendHistory(); } catch { S.sendHistory = {}; }
  }
  if (!S.sendCompanies || !Object.keys(S.sendCompanies).length) {
    try { const contacts = await window.electronAPI.getContacts();
      S.sendCompanies = {}; contacts.forEach(c => { const n = c.company; if (!S.sendCompanies[n]) S.sendCompanies[n] = []; S.sendCompanies[n].push(c); });
    } catch { S.sendCompanies = {}; }
  }
  const newPending = [];
  for (const [name, { emails, meta }] of Object.entries(companyEmails)) {
    const unique = [...new Set(emails)];
    const groups = Math.ceil(unique.length / groupSize);
    const stage = S.sendHistory[name]?.stage || 'cold';
    const t = meta._type || 'unlabeled';
    const lang = meta._lang || 'es';

    // ponytail: 保留用户模板来源
    const isUserTpl = meta._templateSource === 'user';
    const members = S.sendCompanies[name] || [];
    const firstNameDisplay = members[0]?.firstName || '';
    let userTpl = null;
    let baseSubject = '';
    if (isUserTpl) {
      const tplId = (meta._tplInfo || '').replace('user:', '');
      userTpl = userTemplates.find(ut => ut.id === tplId);
      if (userTpl) {
        const companyDisplay = (!name || name.includes('未命名') || name.includes('⚠️')) ? 'Estimado cliente' : name;
        baseSubject = (userTpl.subject || '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
        // 正文在 per-group 循环中处理
      }
    }
    if (!baseSubject) {
      const subjects = S.templateLib.subjects?.[t] || { es: '' };
      const companyDisplay = (!name || name.includes('未命名') || name.includes('⚠️')) ? 'Estimado cliente' : name;
      baseSubject = (subjects[lang] ?? subjects.es ?? '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
    }

    for (let g = 0; g < groups; g++) {
      const groupEmails = unique.slice(g * groupSize, (g + 1) * groupSize);
      let body;
      let tplInfo;

      if (userTpl && g === 0) {
        // 用户模板：第一组用原文
        const companyDisplay = (!name || name.includes('未命名') || name.includes('⚠️')) ? 'Estimado cliente' : name;
        body = (userTpl.body || '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
        tplInfo = `user:${userTpl.id}`;
      } else {
        // 预设库拼装：每组随机选，不追踪重复
        const picked = randomPick(t, stage, []);
        body = assembleEmail(lang, picked.hook, picked.pain, picked.proof, picked.cta, picked.followup, stage, t, config?.sender?.bodyName, firstNameDisplay);
        tplInfo = [picked.hook?.id, picked.pain?.id, picked.proof?.id, picked.cta?.id, picked.followup?.id].filter(Boolean).join('·');
      }

      newPending.push({
        id: ++S.queueIdCounter, company: name, companyId: members[0]?.companyId || '', to: groupEmails.join(', '), recipients: groupEmails,
        subject: baseSubject, body, status: 'pending', addedAt: new Date().toISOString(),
        _stage: stage, _type: t, _lang: lang, _country: meta._country || '',
        _tplInfo: tplInfo,
        _templateSource: isUserTpl ? 'user' : 'preset',
        _batchLabel: groups > 1 ? ` (${g + 1}/${groups})` : '',
        _groupOf: groups > 1 ? name : undefined, _groupSeq: groups > 1 ? g : undefined, _groupTotal: groups > 1 ? groups : undefined,
        _recipientStatus: groupEmails.map(e => ({ email: e, status: 'pending' })),
      });
    }
  }
  S.queue = [...S.queue.filter(e => e.status !== 'pending'), ...newPending];
  saveQueue();
  renderQueue();
  resetQueueTimer();
  showAlert(`已刷新分组：${pending.length} → ${newPending.length} 个队列项（${groupSize} 人/组）`, 'ok');
  } catch(e) { console.error('刷新分组失败:', e); await showAlert('刷新失败: ' + (e.message || '未知错误')); }
}
export function doQueueClearDone() {
  S.queue = S.queue.filter(e => e.status === 'pending' || e.status === 'sending' ||
    (e._recipientStatus && e._recipientStatus.some(r => r.status === 'pending')));
  saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  const pb = document.getElementById('queue-progress'); pb.style.width = '0%'; pb.classList.remove('active');
  document.getElementById('stat-queue').textContent = S.queue.filter(e => e.status === 'pending').length;
}
export async function doQueueClearPending() {
  if (S.sendInProgress) return await showAlert('发送进行中，请先暂停');
  const pending = S.queue.filter(e => e.status === 'pending');
  if (!pending.length) return await showAlert('没有未发送的邮件');
  if (!await showConfirm(`确定清空 ${pending.length} 个未发送队列项？已完成的不受影响。`)) return;
  S.queue = S.queue.filter(e => e.status !== 'pending');
  saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  document.getElementById('stat-queue').textContent = '0';
}
export async function doQueueClearAll() {
  if (S.sendInProgress) return await showAlert('发送进行中，请先暂停');
  if (!S.queue.length) return;
  if (!await showConfirm(`确定清空全部 ${S.queue.length} 个队列项？此操作不可恢复。`)) return;
  S.queue = []; saveQueue(); renderQueue(); clearQueueDelayUI(); resetQueueTimer();
  document.getElementById('stat-queue').textContent = '0';
}

// 更多菜单
const moreBtn = document.getElementById('queue-more-btn');
const moreMenu = document.getElementById('queue-more-menu');
if (moreBtn && moreMenu) {
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); moreMenu.style.display = moreMenu.style.display === 'none' ? '' : 'none'; });
  document.addEventListener('click', () => { moreMenu.style.display = 'none'; });
  moreMenu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    moreMenu.style.display = 'none';
    if (action === 'refresh') doQueueRefresh();
    else if (action === 'clear-done') doQueueClearDone();
    else if (action === 'clear-pending') doQueueClearPending();
    else if (action === 'clear-all') doQueueClearAll();
  });
}


document.getElementById('queue-delete-selected')?.addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.qc-check:checked')].map(cb => Number(cb.dataset.id));
  if (!checked.length) return;
  if (!await showConfirm(`确定删除 ${checked.length} 个已选队列项？`)) return;
  S.queue = S.queue.filter(e => !checked.includes(e.id));
  saveQueue();
  renderQueue();
  document.getElementById('queue-delete-selected').style.display = 'none';
});

document.getElementById('queue-clear')?.addEventListener('click', doQueueClearDone);
document.getElementById('queue-clear-pending')?.addEventListener('click', doQueueClearPending);
document.getElementById('queue-clear-all')?.addEventListener('click', doQueueClearAll);

document.getElementById('queue-bounce-check')?.addEventListener('click', async () => {
  const btn = document.getElementById('queue-bounce-check');
  const resultDiv = document.getElementById('bounce-result');
  btn.disabled = true; btn.innerHTML = `${lucide('refresh-cw',12,'spin')} 检查中...`;
  resultDiv.style.display = 'none';
  try {
    const result = await window.electronAPI.checkBounces();
    resultDiv.style.display = 'block';
    if (result.ok) {
      if (result.bounced.length) {
        resultDiv.style.background = '#fff3e0';
        resultDiv.innerHTML = `<strong>${lucide('download',14)} 发现 ${result.bounced.length} 封退信：</strong><br>` +
          result.bounced.map(b => `· ${escapeHtml(b.subject)} <span style="color:var(--text-secondary)">${escapeHtml(b.date)}</span>`).join('<br>');
      } else {
        resultDiv.style.background = '#e8f5e9';
        resultDiv.innerHTML = `${lucide('check-circle',14)} 未发现退信`;
      }
    } else {
      resultDiv.style.background = '#ffebee';
      resultDiv.innerHTML = `${lucide('x-circle',14)} ${escapeHtml(result.error || '检查失败')}`;
    }
  } catch (e) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#ffebee';
    resultDiv.innerHTML = `${lucide('x-circle',14)} 检查异常: ${escapeHtml(e.message)}`;
  }
  btn.disabled = false; btn.innerHTML = `${lucide('download',14)} 退信检查`;
});

window.__pageHandlers['queue'] = renderQueue;
