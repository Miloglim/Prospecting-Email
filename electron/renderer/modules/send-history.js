const S = window.S;
import { lucide,showToast,escapeHtml,formatDate,daysSince,renderPagination,statusLabel,initIcons,showConfirm,showAlert,clientTypeTag } from './shared.js';

// ===== 发送总览 ======================================================

export async function loadHistoryPage() {
  const q = (document.getElementById('history-search')?.value || '').trim();
  const params = {
    limit: S.HISTORY_PAGE_SIZE, offset: S.historyPage * S.HISTORY_PAGE_SIZE,
    search: q || undefined,
    type: S.historyFilters.type || undefined,
    lang: S.historyFilters.lang || undefined,
    country: S.historyFilters.country || undefined,
    stage: S.historyFilters.stage || undefined,
  };
  const result = await window.electronAPI.getSendLog(params);
  S.historyTotal = result.total;
  return result.records;
}

export async function renderHistoryTable() {
  const listEl = document.getElementById('history-list');
  const layout = document.getElementById('history-layout');
  const empty = document.getElementById('history-empty');
  const count = document.getElementById('history-count');
  const pagination = document.getElementById('history-pagination');
  const preview = document.getElementById('history-preview');

  const records = await loadHistoryPage();
  const totalPages = Math.ceil(S.historyTotal / S.HISTORY_PAGE_SIZE);

  if (count) count.textContent = S.historyTotal ? `共 ${S.historyTotal} 封（第 ${S.historyPage + 1}/${totalPages || 1} 页）` : '';
  // 动态生成国家筛选按钮
  const countryContainer = document.getElementById('history-country-btns');
  if (countryContainer && S.historyCountries.length > 0) {
    countryContainer.innerHTML = S.historyCountries.map(c =>
      `<button class="htab${S.historyFilters.country === c ? ' active' : ''}" data-key="country" data-val="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join('');
    countryContainer.querySelectorAll('.htab').forEach(btn => {
      btn.addEventListener('click', () => {
        S.historyFilters[btn.dataset.key] = btn.dataset.val;
        document.querySelectorAll(`#history-filter-group .htab[data-key="country"]`).forEach(b => b.classList.toggle('active', b.dataset.val === btn.dataset.val));
        S.historyPage = 0;
        renderHistoryTable();
      });
    });
  }
  if (!records.length) {
    if (layout) layout.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (pagination) pagination.style.display = 'none';
    if (preview) preview.innerHTML = '<div class="history-preview-empty">← 选择公司查看详情</div>';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (layout) layout.style.display = 'flex';

  // 按公司分组
  const groups = {};
  records.forEach(r => {
    const key = r.company || '未知';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  // 按最新发送时间排序（取组内最新一封的时间比较）
  const entries = Object.entries(groups).sort((a, b) => {
    const ta = Math.max(...a[1].map(r => new Date(r.time || 0).getTime()));
    const tb = Math.max(...b[1].map(r => new Date(r.time || 0).getTime()));
    return tb - ta;
  });

  if (listEl) {
    listEl.innerHTML = entries.map(([company, items]) => {
      const r0 = items[0];
      const tags = [];
      const tt = clientTypeTag(r0._type);
      if (tt) tags.push(tt);
      if (r0._country) tags.push(escapeHtml(r0._country));
      if (r0._lang) tags.push(escapeHtml(r0._lang).toUpperCase());
      const tplMap = { agent:'代理模板', direct:'直客模板', unlabeled:'通用模板' };
      const tplTag = r0._templateSource === 'user'
        ? (r0._templateLabel || '用户模板')
        : (tplMap[r0._type] || '通用模板');
      tags.push(lucide('file-text',11) + ' ' + tplTag);
      if (r0._test) tags.push(lucide('flask-conical',11) + ' 测试');
      // 收集去重收件人
      const allTo = [...new Set(items.map(r => r.to).filter(Boolean))];
      const recipientsStr = allTo.join(', ');
      const timeStr = r0.time ? new Date(new Date(r0.time).getTime() + 8*3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
      const stageLbl = { cold:'冷开发',f1:'F1',f2:'F2',f3:'F3',f4:'F4',archived:'已归档',monthly:'月度' }[r0._stage] || '';
      const allIdx = items.map(r => r.index).join('|');
      // ponytail: 按 bodyId 去重 — 同一队列项的收件人共享正文，合并为一条
      const deduped = new Map();
      items.forEach(r => {
        const key = r.bodyId || r.index;
        if (!deduped.has(key)) {
          deduped.set(key, {
            subject: r.subject || '',
            bodyId: r.bodyId || '',
            time: r.time || '',
            idx: r.index,
            _type: r._type || '',
            _tplInfo: r._tplInfo || '',
            _templateSource: r._templateSource || '',
            _templateLabel: r._templateLabel || '',
            _batchLabel: r._batchLabel || '',
          });
        }
      });
      const groupsData = [...deduped.values()];
      return `<div class="history-item" data-idx="${allIdx}"
            data-groups="${escapeHtml(JSON.stringify(groupsData))}"
            data-to="${escapeHtml(recipientsStr)}" data-company="${escapeHtml(company)}"
            data-subject="${escapeHtml(r0.subject || '')}" data-stage="${escapeHtml(stageLbl)}"
            data-tags="${escapeHtml(tags.join(' · ') || '—')}" data-status="${escapeHtml(r0.status === 'sent' ? '已发送' : '失败')}"
            data-time="${escapeHtml(timeStr)}">
        <input type="checkbox" class="hi-check" data-idx="${allIdx}" onclick="event.stopPropagation()">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(company)}</span>
            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap">${items.length} 封</span>
          </div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tags.join(' · ')}</div>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        listEl.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        showPreview(item.dataset);
      });
    });
  }

  // 分页
  if (pagination && totalPages > 1) {
    pagination.style.display = 'flex';
    let h = `<button ${S.historyPage === 0 ? 'disabled' : ''} data-p="0">««</button>`;
    h += `<button ${S.historyPage === 0 ? 'disabled' : ''} data-p="${S.historyPage - 1}">«</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= S.historyPage + 1 - 2 && i <= S.historyPage + 1 + 2)) {
        h += `<button class="${i - 1 === S.historyPage ? 'active' : ''}" data-p="${i - 1}">${i}</button>`;
      } else if (i === S.historyPage + 1 - 3 || i === S.historyPage + 1 + 3) {
        h += '<span>...</span>';
      }
    }
    h += `<button ${S.historyPage >= totalPages - 1 ? 'disabled' : ''} data-p="${S.historyPage + 1}">»</button>`;
    h += `<button ${S.historyPage >= totalPages - 1 ? 'disabled' : ''} data-p="${totalPages - 1}">»»</button>`;
    pagination.innerHTML = h;
    pagination.querySelectorAll('button[data-p]').forEach(btn => {
      btn.addEventListener('click', () => {
        S.historyPage = parseInt(btn.dataset.p);
        renderHistoryTable();
      });
    });
  } else if (pagination) {
    pagination.style.display = 'none';
  }
}

export async function showPreview(d) {
  const preview = document.getElementById('history-preview');
  if (!preview) return;
  let sigHtml = '';
  try { const r = await window.electronAPI.loadSignature(); if (r.ok) sigHtml = r.html; } catch { /* 渲染层降级：操作失败不影响 UI */ }
  function textToHtml(bodyText) {
    const lines = bodyText.split('\n');
    const h = [];
    let first = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { h.push('<br>'); continue; }
      if (t === '--' || t === '---') { h.push('<br>'); continue; }
      const c = (first && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${escapeHtml(t)}</strong>`
        : escapeHtml(t);
      h.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${c}</p>`);
      first = false;
    }
    return h.join('\n') + '\n<br>\n' + sigHtml;
  }

  // ponytail: 解析多组数据，支持组间切换
  let groups = [];
  try { groups = JSON.parse(d.groups || '[]'); } catch { /* 渲染层降级：操作失败不影响 UI */ }
  const hasGroups = groups.length > 1;
  const recipients = (d.to || '').split(',').map(s => s.trim()).filter(Boolean);

  // 渲染当前组的函数
  async function renderGroupBody(g) {
    const bodyEl = document.getElementById('hp-body-content');
    const subjEl = document.getElementById('hp-subject');
    const metaEl = document.getElementById('hp-meta');
    if (subjEl) subjEl.textContent = g.subject || '无主题';
    if (metaEl) {
      const t = g.time ? new Date(new Date(g.time).getTime() + 8*3600000).toISOString().slice(0,16).replace('T',' ') : '';
      let tplLabel = g._templateLabel || '';
      if (!tplLabel && g._templateSource !== 'user') {
        const tplMap = { agent:'代理模板', direct:'直客模板', unlabeled:'通用模板' };
        tplLabel = tplMap[g._type] || '';
      }
      if (!tplLabel && g._tplInfo) {
        tplLabel = g._tplInfo.startsWith('user:') ? '用户模板' : '';
      }
      metaEl.innerHTML = `<span>🕐 ${escapeHtml(t || '—')}</span>${tplLabel ? '<span>· ' + escapeHtml(tplLabel) + '</span>' : ''}`;
    }
    // 高亮当前组按钮
    preview.querySelectorAll('.hp-group-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.idx === String(g.idx));
    });
    if (bodyEl && g.bodyId) {
      bodyEl.innerHTML = '<span style="color:var(--text-secondary)">加载中...</span>';
      try {
        const body = await window.electronAPI.getSendBody(g.bodyId);
        const isHtmlBody = /<[a-z][\s\S]*>/i.test(body || '');
        bodyEl.innerHTML = body
          ? (isHtmlBody ? body + '\n<br>\n' + sigHtml : textToHtml(body))
          : '<span style="color:var(--text-secondary)">(无正文)</span>';
      } catch { bodyEl.textContent = '(加载失败)'; }
    } else if (bodyEl) {
      bodyEl.innerHTML = '<span style="color:var(--text-secondary)">(无邮件正文)</span>';
    }
  }

  preview.innerHTML =
    `<div class="hp-box">
      <div class="hp-box-head">${lucide('mail',14)} 发送信息 · ${escapeHtml(d.company || '')}</div>
      <div class="hp-box-body">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600;flex:1" id="hp-subject">${escapeHtml(d.subject || '无主题')}</div>
        </div>
        ${hasGroups ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px" id="hp-group-selector">
          ${groups.map((g, i) => `<button class="hp-group-btn${i === 0 ? ' active' : ''}" data-idx="${g.idx}" style="font-size:10px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);cursor:pointer">组${i + 1}${g._batchLabel ? ' ' + escapeHtml(g._batchLabel) : ''}</button>`).join('')}
        </div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:var(--text-secondary);margin-bottom:4px" id="hp-meta">
          <span>🕐 ${escapeHtml(d.time || '—')}</span>
          <span>${d.tags || '—'}</span>
          <span>${d.stage || '—'} · ${d.status || ''}</span>
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:3px">收件人（${recipients.length} 位）</div>
        <div class="hp-recipients">${recipients.map(r => '<div>' + escapeHtml(r) + '</div>').join('')}</div>
      </div>
    </div>
    <div class="hp-box" style="flex:1;display:flex;flex-direction:column">
      <div class="hp-box-head">${lucide('mail',14)} 信件内容${hasGroups ? ' <span style="font-weight:400;font-size:10px;color:var(--text-secondary)">— 点击上方组按钮切换</span>' : ''}</div>
      <div class="hp-box-body" style="flex:1;overflow-y:auto">
        <div class="hp-body" id="hp-body-content">${d.bodyid ? '<span style="color:var(--text-secondary)">加载中...</span>' : '<span style="color:var(--text-secondary)">(无邮件正文)</span>'}</div>
      </div>
    </div>`;

  // 加载第一组内容
  if (groups.length) await renderGroupBody(groups[0]);
  else if (d.bodyid) {
    // 兼容旧数据（无 groups 字段）
    await renderGroupBody({ subject: d.subject, bodyId: d.bodyid, time: d.time, idx: 0 });
  }

  // 绑定组切换事件
  preview.querySelectorAll('.hp-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const g = groups.find(x => x.idx === idx);
      if (g) renderGroupBody(g);
    });
  });
}

export function debounceHistorySearch() {
  clearTimeout(window._historySearchTimer);
  window._historySearchTimer = setTimeout(() => {
    S.historyPage = 0;
    renderHistoryTable();
  }, 300);
}

export async function initHistoryPage() {
  // 预加载所有国家列表（用于筛选按钮）
  try {
    const fullLog = await window.electronAPI.getSendLog({ limit: 99999, offset: 0, search: undefined, type: undefined, lang: undefined, stage: undefined, country: undefined });
    S.historyCountries = [...new Set((fullLog.records || []).map(r => r._country).filter(Boolean))].sort();
  } catch { S.historyCountries = []; }
  S.historyPage = 0;
  renderHistoryTable();

  if (!document.querySelector('#history-filter-group')._bound) {
    document.querySelector('#history-filter-group')._bound = true;

    // 全部清除（只绑定一次）
    document.getElementById('history-clear-all')?.addEventListener('click', async () => {
      if (window.S?.sendInProgress) { await showAlert('发送进行中，请先暂停后再清除记录'); return; }
      if (!await showConfirm('确定清除全部发送记录？此操作不可恢复。')) return;
      try {
        await window.electronAPI.deleteHistory(['__ALL__']);
        S.historyPage = 0;
        renderHistoryTable();
        showToast('已清除', 'ok');
      } catch (e) { await showAlert('清除失败: ' + e.message); }
    });
    document.querySelectorAll('#history-filter-group .htab').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const val = btn.dataset.val;
        S.historyFilters[key] = val;
        document.querySelectorAll(`#history-filter-group .htab[data-key="${key}"]`).forEach(b => b.classList.toggle('active', b.dataset.val === val));
        S.historyPage = 0;
        renderHistoryTable();
      });
    });
    document.getElementById('history-search')?.addEventListener('input', debounceHistorySearch);
  }
}

// API 快捷入口：点击在浏览器打开对应服务
document.getElementById('page-settings')?.addEventListener('click', async (e) => {
  const link = e.target.closest('.quick-link');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.url;
  if (url) await window.electronAPI.openExternal(url);
});

window.__pageHandlers['history'] = initHistoryPage;
