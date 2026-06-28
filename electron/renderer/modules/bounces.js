const S = window.S;
import { lucide,showToast,escapeHtml,formatDate,initIcons,showConfirm } from './shared.js';

// ===== 退信检测页 ====================================================

export function renderBounceTable() {
  const groupsEl = document.getElementById('bounce-groups');
  const empty = document.getElementById('bounce-empty');
  const status = document.getElementById('bounce-status');
  if (!S.bounceRecords.length) {
    if (groupsEl) groupsEl.innerHTML = '';
    if (empty) { empty.style.display = 'block'; empty.textContent = '点击「检查退信」扫描邮箱中的退信邮件'; }
    if (status) status.textContent = '';
    // 隐藏一键删除按钮
    const dABtn = document.getElementById('bounce-del-all-btn');
    if (dABtn) dABtn.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (status) status.textContent = `共 ${S.bounceRecords.length} 条（${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}）`;

  // 分组（只显示已匹配联系人的退信，unknown 归入临时）
  const groups = { permanent: [], temporary: [] };
  for (const r of S.bounceRecords) {
    if (!r.matched) continue;
    const key = r.type === 'permanent' ? 'permanent' : 'temporary';
    groups[key].push(r);
  }
  const groupDefs = [
    { key: 'permanent', label: '永久', icon: '◆', color: 'var(--danger)', itemColor: '#f44336' },
    { key: 'temporary', label: '暂时', icon: '◇', color: 'var(--warning)', itemColor: '#ff9800' },
  ];

  let html = '';
  for (const g of groupDefs) {
    const items = groups[g.key] || [];
    if (!items.length) continue;
    html += `<div class="bounce-group" style="margin-bottom:8px">`;
    html += `<div class="bounce-group-head" style="font-size:12px;font-weight:600;color:${g.color};padding:4px 0;border-bottom:1px solid #eee;cursor:pointer;display:flex;align-items:center;gap:4px" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none';this.querySelector('.bounce-arrow').textContent=this.nextElementSibling.style.display==='none'?'▸':'▾'">`;
    html += `<span class="bounce-arrow" style="font-size:10px;width:10px">▾</span>`;
    html += `${g.label} (${items.length})`;
    html += `</div>`;
    html += `<div class="bounce-group-body">`;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const timeStr = r.date ? new Date(r.date).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      html += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px solid #f5f5f5;overflow:hidden">`;
      html += `<span style="color:${g.itemColor};flex-shrink:0">${g.icon}</span>`;
      html += `<span style="font-family:monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1">${escapeHtml(r.email || '未识别')}</span>`;
      html += `<span style="color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1">${escapeHtml(r.company || '')}</span>`;
      html += `<span style="color:var(--text-secondary);font-size:11px;white-space:nowrap;margin-left:auto;flex-shrink:0">${timeStr}</span>`;
      html += `<span style="font-size:10px;color:${g.itemColor};white-space:nowrap;flex-shrink:0">${g.label}</span>`;
      html += `<span class="bounce-del-btn" data-email="${escapeHtml(r.email)}" data-idx="${i}" data-group="${g.key}" style="cursor:pointer;color:var(--danger);font-size:11px;flex-shrink:0;padding:0 4px" title="删除联系人">✕</span>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  if (groupsEl) {
    groupsEl.innerHTML = html;
    // 单条删除
    groupsEl.querySelectorAll('.bounce-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email;
        if (!await showConfirm(`删除联系人 ${email}？`)) return;
        const contacts = await window.electronAPI.getContacts();
        const contact = contacts.find(c => (c.email || '').toLowerCase().trim() === email.toLowerCase().trim());
        if (contact?.id) await window.electronAPI.deleteContact(contact.id);
        // 从记录中移除
        S.bounceRecords = S.bounceRecords.filter(r => (r.email || '').toLowerCase().trim() !== email.toLowerCase().trim());
        await window.electronAPI.saveBounceLog(S.bounceRecords);
        renderBounceTable();
      });
    });
  }
  // 一键删除按钮
  const delAllBtn = document.getElementById('bounce-del-all-btn');
  if (delAllBtn) {
    const matchedCount = S.bounceRecords.filter(r => r.matched).length;
    delAllBtn.style.display = matchedCount > 0 ? '' : 'none';
    if (matchedCount > 0) delAllBtn.textContent = `一键删除全部 (${matchedCount})`;
  }
}

export async function initBouncePage() {
  const runBtn = document.getElementById('bounce-run-btn');
  const clearBtn = document.getElementById('bounce-clear-btn');
  const status = document.getElementById('bounce-status');
  const empty = document.getElementById('bounce-empty');
  const groupsEl = document.getElementById('bounce-groups');

  // 加载历史记录
  if (!runBtn._bound) {
    runBtn._bound = true;
    try {
      const log = await window.electronAPI.loadBounceLog();
      if (log.ok && log.data.length) {
        S.bounceRecords = log.data;
        renderBounceTable();
      }
    } catch {}

    // 自动检测：上次发信在10分钟~24小时内 → 自动扫一次
    try {
      const st = await window.electronAPI.loadSendState();
      if (st?.data?.startedAt) {
        const since = (Date.now() - new Date(st.data.startedAt).getTime()) / 1000;
        if (since > 600 && since < 86400) setTimeout(() => runBtn.click(), 500);
      }
    } catch {}

    // 倒计时更新
    const countdownEl = document.getElementById('bounce-countdown');
    if (countdownEl && !countdownEl._timer) {
      countdownEl._timer = setInterval(() => {
        if (S.nextBounceScanAt > 0) {
          const rem = Math.max(0, Math.round((S.nextBounceScanAt - Date.now()) / 1000));
          const m = Math.floor(rem / 60), s = rem % 60;
          countdownEl.textContent = rem > 0 ? `下次扫描: ${m}:${String(s).padStart(2, '0')}` : '即将扫描...';
        } else {
          countdownEl.textContent = '';
        }
      }, 1000);
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.innerHTML = `${lucide('refresh-cw',14,'spin')} 扫描中...`;
      status.textContent = '正在连接邮箱...';
      if (groupsEl) groupsEl.innerHTML = '';
      if (empty) { empty.style.display = 'block'; empty.textContent = '正在扫描...'; }
      try {
        const [result, contacts] = await Promise.all([
          window.electronAPI.checkBounces(),
          window.electronAPI.getContacts(),
        ]);
        if (!result.ok) {
          status.textContent = '❌ ' + (result.error || '检查失败');
          runBtn.disabled = false;
          runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
          return;
        }
        if (!result.bounced.length) {
          S.bounceRecords = [];
          await window.electronAPI.saveBounceLog([]);
          renderBounceTable();
          status.textContent = '✅ 未发现退信';
          runBtn.disabled = false;
          runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
          return;
        }
        // 匹配联系人
        const contactMap = {};
        for (const c of contacts) {
          const e = (c.email || '').toLowerCase().trim();
          if (e) contactMap[e] = c;
        }
        S.bounceRecords = result.bounced.map(b => {
          const email = b.bouncedEmail || '';
          const matched = contactMap[email];
          return { ...b, email, matched: !!matched, company: matched ? matched.company : '', contactId: matched ? matched.id : '' };
        });
        S.bounceRecords.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0));
        for (const r of S.bounceRecords) {
          if (r.matched && r.email) {
            window.electronAPI.updateBounce(r.email, { type: r.type || 'unknown', reason: r.reason || '未知原因' }).catch(() => {});
          }
        }
        await window.electronAPI.saveBounceLog(S.bounceRecords);
        renderBounceTable();
        const matchedCount = S.bounceRecords.filter(r => r.matched).length;
        status.textContent = `发现 ${result.bounced.length} 封退信，${matchedCount} 个匹配联系人`;
      } catch (e) {
        status.textContent = '❌ ' + (e.message || '异常');
      }
      runBtn.disabled = false;
      runBtn.innerHTML = `${lucide('search',14)} 检查退信`;
    });

    clearBtn.addEventListener('click', async () => {
      if (!await showConfirm('确定清除所有退信记录？')) return;
      S.bounceRecords = [];
      await window.electronAPI.saveBounceLog([]);
      renderBounceTable();
    });

    const delAllBtn = document.getElementById('bounce-del-all-btn');
    delAllBtn?.addEventListener('click', async () => {
      const matched = S.bounceRecords.filter(r => r.matched);
      if (!matched.length) return;
      if (!await showConfirm(`确定删除全部 ${matched.length} 个退信联系人？此操作不可恢复。`)) return;
      const contacts = await window.electronAPI.getContacts();
      let deleted = 0;
      for (const r of matched) {
        const contact = contacts.find(c => (c.email || '').toLowerCase().trim() === (r.email || '').toLowerCase().trim());
        if (contact?.id) { await window.electronAPI.deleteContact(contact.id); deleted++; }
      }
      S.bounceRecords = [];
      await window.electronAPI.saveBounceLog([]);
      renderBounceTable();
      showToast(`已删除 ${deleted} 个退信联系人`, 'ok');
    });
  }
}

window.__pageHandlers['bounces'] = initBouncePage;
