// ── 回复检测页面 ──────────────────────────────────────────────────────────
import { lucide, showToast, escapeHtml, formatDate } from './shared.js';

const ICON_SIZE = 13;

export async function initReplyPage() {
  const runBtn = document.getElementById('reply-run-btn');
  const status = document.getElementById('reply-status');
  const list = document.getElementById('reply-list');
  const empty = document.getElementById('reply-empty');

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
        renderReplyListFromData(r.replies);
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
    if (r.ok && r.data?.length) renderReplyListFromData(r.data);
  } catch {}
}

function renderReplyListFromData(items) {
  const list = document.getElementById('reply-list');
  const empty = document.getElementById('reply-empty');
  if (!list) return;
  if (!items.length) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';

  const grouped = {};
  for (const r of items) {
    const key = r.from || '未知';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  list.innerHTML = Object.entries(grouped).map(([from, replies]) => {
    const r0 = replies[0];
    const subject = escapeHtml(r0.subject || '无主题');
    const date = formatDate(r0.date);
    const label = r0._accountLabel || '';
    const isAuto = isAutoReply(r0.subject);

    return `<div class="reply-card">
      <div class="reply-card-top">
        <span class="reply-avatar">${lucide(isAuto ? 'bot' : 'user',ICON_SIZE)}</span>
        <span class="reply-from">${escapeHtml(from)}</span>
        <span class="reply-tag ${isAuto ? 'reply-tag-auto' : 'reply-tag-client'}">
          ${lucide(isAuto ? 'refresh-cw' : 'corner-up-left',10)} ${isAuto ? '自动回复' : '客户回复'}
        </span>
        ${label ? `<span class="reply-account">${lucide('at-sign',10)} ${escapeHtml(label)}</span>` : ''}
        <span class="reply-meta">${lucide('clock',10)} ${date} · ${replies.length} 封</span>
      </div>
      <div class="reply-subject">${lucide('message-square',ICON_SIZE)} ${subject}</div>
      ${r0.snippet ? `<div class="reply-snippet">${escapeHtml(r0.snippet)}</div>` : ''}
    </div>`;
  }).join('');
}

function isAutoReply(subject) {
  const s = (subject || '').toLowerCase();
  return ['auto','automatic','自动','ausente','fuera','vacation','out of office'].some(k => s.includes(k));
}

window.__pageHandlers['replies'] = initReplyPage;
