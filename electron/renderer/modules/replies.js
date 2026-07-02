// ── 回复检测页面 ──────────────────────────────────────────────────────────
import { lucide, showToast, escapeHtml, formatDate } from './shared.js';

const ICON_SIZE = 13;

// ── 右键标签菜单 ────────────────────────────────────────────────────────
let _ctxMenu = null;
let _ctxTarget = null;

function initContextMenu() {
  if (_ctxMenu) return;
  _ctxMenu = document.createElement('div');
  _ctxMenu.id = 'reply-ctx-menu';
  _ctxMenu.style.cssText = 'display:none;position:fixed;z-index:9999;background:var(--card-bg,#1e1e1e);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:140px;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  _ctxMenu.innerHTML = `
    <div data-tag="autoreply" style="padding:6px 10px;font-size:12px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px">${lucide('bot',12)} 自动回复</div>
    <div data-tag="replied" style="padding:6px 10px;font-size:12px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px">${lucide('corner-up-left',12)} 客户回复</div>
    <div data-tag="none" style="padding:6px 10px;font-size:12px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px">${lucide('x',12)} 无</div>
  `;
  document.body.appendChild(_ctxMenu);

  _ctxMenu.querySelectorAll('[data-tag]').forEach(item => {
    item.addEventListener('mouseenter', () => item.style.background = 'var(--bg)');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('click', async () => {
      const tag = item.dataset.tag;
      const email = _ctxTarget?.dataset?.email;
      _ctxMenu.style.display = 'none';
      if (!email || !tag) return;

      const contacts = await window.electronAPI.getContacts();
      const contact = contacts.find(c => (c.email || '').toLowerCase().trim() === email.toLowerCase().trim());
      if (!contact) { showToast('未找到联系人', 'warn'); return; }

      if (tag === 'none') {
        await window.electronAPI.setContactTags(contact.id, []);
      } else if (tag === 'autoreply') {
        const tags = [...new Set([...(contact.tags || []), 'autoreply'])].filter(t => t !== 'replied');
        await window.electronAPI.setContactTags(contact.id, tags);
      } else if (tag === 'replied') {
        const tags = [...new Set([...(contact.tags || []), 'replied'])].filter(t => t !== 'autoreply');
        await window.electronAPI.setContactTags(contact.id, tags);
      }
      showToast(`${escapeHtml(email)} → ${tag === 'none' ? '清除标签' : tag === 'autoreply' ? '自动回复' : '客户回复'}`, 'ok');
      renderReplyList();
    });
  });

  document.addEventListener('click', () => { _ctxMenu.style.display = 'none'; });
}

export async function initReplyPage() {
  const runBtn = document.getElementById('reply-run-btn');
  const status = document.getElementById('reply-status');
  const list = document.getElementById('reply-list');
  const empty = document.getElementById('reply-empty');

  initContextMenu();
  renderReplyList();

  if (runBtn._bound) return;
  runBtn._bound = true;
  runBtn.innerHTML = `${lucide('search',ICON_SIZE)} 检查回复`;

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.innerHTML = `${lucide('refresh-cw',ICON_SIZE,'spin')} 扫描中...`;
    status.innerHTML = `${lucide('loader-2',ICON_SIZE,'spin')} 正在扫描收件箱...`;
    status.style.color = 'var(--text-secondary)';
    if (list) list.innerHTML = '';
    if (empty) empty.style.display = 'none';

    try {
      const r = await window.electronAPI.checkReplies();
      if (r.ok && r.replies?.length) {
        status.innerHTML = `${lucide('check-circle',ICON_SIZE)} 发现 <strong>${r.replies.length}</strong> 条回复`;
        status.style.color = 'var(--success)';
        const contacts = await window.electronAPI.getContacts();
        let matched = 0;
        for (const reply of r.replies) {
          if (!reply.from) continue;
          const key = reply.from.toLowerCase().trim();
          for (const c of contacts) {
            if ((c.email || '').toLowerCase().trim() === key) {
              if (!c.replied) {
                c.replied = true;
                c.repliedAt = c.repliedAt || new Date().toISOString();
                c.replySnippet = (reply.snippet || '').slice(0, 200);
                matched++;
              }
            }
          }
        }
        if (matched > 0) showToast(`${lucide('user-check',ICON_SIZE)} 已标记 ${matched} 人`, 'ok');
        await renderReplyListFromData(r.replies);
      } else {
        status.innerHTML = `${lucide('check-circle',ICON_SIZE)} 未发现新回复`;
        status.style.color = 'var(--text-secondary)';
        if (empty) empty.style.display = 'block';
      }
    } catch (e) {
      status.innerHTML = `${lucide('x-circle',ICON_SIZE)} ${escapeHtml(e.message || '检查失败')}`;
      status.style.color = 'var(--danger)';
    }
    runBtn.disabled = false;
    runBtn.innerHTML = `${lucide('search',ICON_SIZE)} 检查回复`;
  });
}

async function renderReplyList() {
  try {
    const r = await window.electronAPI.loadReplyLog();
    if (r.ok && r.data?.length) await renderReplyListFromData(r.data);
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
}

async function renderReplyListFromData(items) {
  const list = document.getElementById('reply-list');
  const empty = document.getElementById('reply-empty');
  if (!list) return;
  if (!items.length) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';

  // 加载联系人，用于匹配 + 标签
  let contactMap = {}; // email → { tags, company, contactName }
  try {
    const contacts = await window.electronAPI.getContacts();
    for (const c of contacts) {
      if (c.email) {
        contactMap[c.email.toLowerCase().trim()] = {
          tags: c.tags || [],
          company: c.company || '',
          name: (c.firstName || c.lastName) ? `${c.firstName || ''} ${c.lastName || ''}`.trim() : (c.contactName || ''),
        };
      }
    }
  } catch { /* 渲染层降级：操作失败不影响 UI */ }

  const grouped = {};
  for (const r of items) {
    const key = r.from || '未知';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const matchedCount = Object.keys(grouped).filter(email => contactMap[email.toLowerCase().trim()]).length;
  const totalCount = Object.keys(grouped).length;
  const matchSummary = document.getElementById('reply-match-summary');
  if (matchSummary) {
    matchSummary.textContent = `已匹配 ${matchedCount}/${totalCount} 个联系人`;
    matchSummary.style.color = matchedCount === totalCount ? 'var(--success)' : matchedCount > 0 ? 'var(--warning)' : 'var(--text-secondary)';
  }

  // 排序：已匹配优先 → 同状态内 reply > bounce > auto-reply > other
  const TYPE_ORDER = { reply: 0, bounce: 1, 'auto-reply': 2, other: 3 };
  const sortedGroups = Object.entries(grouped).sort(([a, ra], [b, rb]) => {
    const ma = !!contactMap[a.toLowerCase().trim()];
    const mb = !!contactMap[b.toLowerCase().trim()];
    if (ma !== mb) return mb - ma; // matched first
    const oa = TYPE_ORDER[ra[0]?.type] ?? 4;
    const ob = TYPE_ORDER[rb[0]?.type] ?? 4;
    return oa - ob;
  });

  const TYPE_DEF = {
    reply:      { cls: 'reply-tag-client', icon: 'corner-up-left', text: '客户回复' },
    bounce:     { cls: 'reply-tag-bounce', icon: 'alert-circle',    text: '退信' },
    'auto-reply': { cls: 'reply-tag-auto', icon: 'bot',             text: '自动回复' },
    other:      { cls: 'reply-tag-other',  icon: 'help-circle',     text: '其他' },
  };

  list.innerHTML = sortedGroups.map(([from, replies]) => {
    const r0 = replies[0];
    const subject = escapeHtml(r0.subject || '无主题');
    const date = formatDate(r0.date);
    const label = r0._accountLabel || '';
    const emailKey = from.toLowerCase().trim();
    const matched = !!contactMap[emailKey];
    const def = TYPE_DEF[r0.type] || TYPE_DEF.other;

    return `<div class="reply-card" data-email="${escapeHtml(from)}" style="position:relative">
      <div class="reply-card-top">
        <span class="reply-avatar">${lucide(def.icon,ICON_SIZE)}</span>
        <span class="reply-from">${escapeHtml(from)}</span>
        ${matched ? `<span style="color:var(--text-secondary);font-weight:600;font-size:12px">已匹配</span>` : ''}
        <span class="reply-tag ${def.cls}">
          ${lucide(def.icon,10)} ${def.text}
        </span>
        ${label ? `<span class="reply-account">${lucide('at-sign',10)} ${escapeHtml(label)}</span>` : ''}
        <span class="reply-meta">${lucide('clock',10)} ${date} · ${replies.length} 封</span>
      </div>
      <div class="reply-subject">${lucide('message-square',ICON_SIZE)} ${subject}</div>
      ${r0.snippet ? `<div class="reply-snippet">${escapeHtml(r0.snippet)}</div>` : ''}
    </div>`;
  }).join('');

  // 绑定右键菜单
  list.querySelectorAll('.reply-card').forEach(card => {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _ctxTarget = card;
      _ctxMenu.style.display = 'block';
      _ctxMenu.style.left = e.clientX + 'px';
      _ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
    });
  });
}

window.__pageHandlers['replies'] = initReplyPage;
