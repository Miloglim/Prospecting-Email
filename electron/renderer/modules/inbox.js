// ===== 收件箱 ==========================================================
const S = window.S;
import { lucide, escapeHtml, showToast, formatDate } from './shared.js';

let _mails = [];
let _selectedIdx = -1;
let _filter = 'all';
let _loading = false;

const TYPE_LABELS = { bounce: '退信', reply: '回复', 'auto-reply': '自动回复', other: '其他' };
const TYPE_DOT = { bounce: '#e5484d', reply: '#22a644', 'auto-reply': '#e6a817', other: '#8b8b8b' };

export async function initInbox() {
  _mails = [];
  _selectedIdx = -1;
  const list = await window.electronAPI.listInbox();
  if (list.ok) _mails = list.data || [];
  renderInbox();
}

export async function doFetchInbox() {
  if (_loading) return;
  _loading = true;
  renderInbox();

  const result = await window.electronAPI.fetchInbox();
  _loading = false;
  if (result.ok) {
    _mails = result.data || [];
    showToast(`收件箱已刷新 · ${_mails.length} 封`, 'ok');
  } else {
    showToast(`拉取失败: ${result.error}`, 'err');
  }
  renderInbox();
}

function renderInbox() {
  const listEl = document.getElementById('inbox-list');
  const detailEl = document.getElementById('inbox-detail');
  const countEl = document.getElementById('inbox-count');
  if (!listEl) return;

  // 筛选
  const filtered = _filter === 'all' ? _mails : _mails.filter(m => m.type === _filter);
  // 排序：回复 > 自动回复 > 退信 > 其他，同类内最新在前
  const TYPE_ORDER = { reply: 0, 'auto-reply': 1, bounce: 2, other: 3 };
  filtered.sort((a, b) => (TYPE_ORDER[a.type] ?? 3) - (TYPE_ORDER[b.type] ?? 3) || (b.date || '').localeCompare(a.date || ''));

  // 统计
  const counts = { bounce: 0, reply: 0, 'auto-reply': 0, other: 0 };
  _mails.forEach(m => { if (counts[m.type] !== undefined) counts[m.type]++; });
  if (countEl) {
    countEl.textContent = `共 ${_mails.length} 封 · 退信 ${counts.bounce} · 回复 ${counts.reply} · 自动回复 ${counts['auto-reply']} · 其他 ${counts.other}`;
  }

  // 左侧列表
  listEl.innerHTML = filtered.map((m, i) => {
    const realIdx = _mails.indexOf(m);
    const cls = realIdx === _selectedIdx ? 'inbox-item active' : 'inbox-item';
    const time = _shortTime(m.date);
    return `<div class="${cls}" data-idx="${realIdx}">
      <span class="inbox-type"><span style="color:${TYPE_DOT[m.type] || '#8b8b8b'};font-weight:600">●</span></span>
      <div class="inbox-meta">
        <span class="inbox-subject">${escapeHtml(m.subject || '(无主题)')}</span>
        <span class="inbox-from">${escapeHtml(m.fromName || m.from)}${m.contactCompany ? ` · ${escapeHtml(m.contactCompany)}` : ''}</span>
      </div>
      <span class="inbox-time">${time}</span>
    </div>`;
  }).join('');

  // 点击事件
  listEl.querySelectorAll('.inbox-item').forEach(el => {
    el.addEventListener('click', () => {
      _selectedIdx = parseInt(el.dataset.idx);
      renderDetail();
      renderInbox();
    });
  });

  // 右侧详情
  renderDetail();

  // 加载中
  if (_loading) {
    listEl.innerHTML = `<div class="inbox-loading">${lucide('refresh-cw', 20, 'spin')} 正在拉取邮件...</div>`;
  } else if (!filtered.length) {
    listEl.innerHTML = '<div class="inbox-loading">暂无邮件，点击刷新拉取</div>';
  }
}

async function renderDetail() {
  const el = document.getElementById('inbox-detail');
  if (!el) return;
  if (_selectedIdx < 0 || _selectedIdx >= _mails.length) {
    el.innerHTML = '<div class="inbox-detail-empty">选择左侧邮件查看正文</div>';
    return;
  }

  const m = _mails[_selectedIdx];
  // 懒加载正文
  let body = m.body || '';
  if (!body && m.uid) {
    try {
      const r = await window.electronAPI.getInboxBody(_selectedIdx);
      if (r.ok) { body = r.data || ''; m.body = body; }
    } catch { body = ''; }
  }

  const typeLabel = TYPE_LABELS[m.type] || '其他';
  const time = m.date ? new Date(m.date).toLocaleString('zh-CN') : '—';

  el.innerHTML = `
    <div class="inbox-detail-header">
      <div class="inbox-detail-field wide"><span>发件人</span><span>${escapeHtml(m.fromName || '')} &lt;${escapeHtml(m.from)}&gt;</span></div>
      <div class="inbox-detail-field wide"><span>主题</span><span>${escapeHtml(m.subject || '(无主题)')}</span></div>
      <div class="inbox-detail-field"><span>时间</span><span>${time}</span></div>
      <div class="inbox-detail-field"><span>账号</span><span>${escapeHtml(m.accountLabel || m.accountId)}</span></div>
      <div class="inbox-detail-field"><span>分类</span><span><span style="color:${TYPE_DOT[m.type] || '#8b8b8b'};font-weight:600">●</span> ${typeLabel}</span></div>
      <div class="inbox-detail-field"><span>关联</span><span class="${m.contactCompany ? '' : 'muted'}">${m.contactCompany ? `${escapeHtml(m.contactCompany)}` : '未关联'}</span></div>
    </div>
    <iframe class="inbox-detail-body" sandbox="allow-same-origin"></iframe>
    <div class="inbox-detail-actions">
      <button id="inbox-btn-processed">${lucide('check', 12)} ${m.processed ? '已处理' : '标记已处理'}</button>
      <button id="inbox-btn-delete">${lucide('trash', 12)} 删除</button>
    </div>
  `;

  // 正文用 iframe srcdoc 渲染（沙箱隔离，自动处理 HTML/CSS/中文）
  const iframe = el.querySelector('.inbox-detail-body');
  if (iframe) {
    const doc = body || '<p style="color:#999">(无正文)</p>';
    iframe.srcdoc = `<html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.7;color:var(--text, #333);padding:0;margin:0;word-break:break-word}img{max-width:100%}a{color:var(--primary, #2563eb)}</style></head><body>${doc}</body></html>`;
  }

  document.getElementById('inbox-btn-processed')?.addEventListener('click', async () => {
    await window.electronAPI.markInboxProcessed(_selectedIdx);
    m.processed = true;
    showToast('已标记', 'ok');
    renderInbox();
  });
  document.getElementById('inbox-btn-delete')?.addEventListener('click', async () => {
    await window.electronAPI.deleteInboxMail(_selectedIdx);
    _mails.splice(_selectedIdx, 1);
    _selectedIdx = -1;
    renderInbox();
  });
}

function _shortTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (diff < 172800000) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 筛选 ────────────────────────────────────────────────────────────────
document.getElementById('inbox-filter')?.addEventListener('change', (e) => {
  _filter = e.target.value;
  _selectedIdx = -1;
  renderInbox();
});

document.getElementById('inbox-refresh')?.addEventListener('click', doFetchInbox);

window.__pageHandlers['inbox'] = initInbox;
