const S = window.S;
import { lucide,showAlert,showConfirm,showToast,escapeHtml,truncate,formatDate,daysSince,initIcons,deepMerge,clientTypeTag,countryToLang } from './shared.js';
import { randomPick, assembleEmail, assembleMonthlyReport, generateMonthlyReports, matchUserTemplates } from './templates.js';
import { saveQueue } from './send-queue.js';
import CS from './company-state.js';

// ===== 邮件发送 ======================================================


export async function initEmailSend() {
  if (!S.templateLib) await CS.refreshTemplateLib();
  // 模板模式选择 — 与设置页同步
  const tplModeSel = document.getElementById('send-tpl-mode');
  const cfgModeSel = document.getElementById('cfg-template-mode');
  if (tplModeSel) {
    const config = await window.electronAPI.loadConfig().catch(() => ({}));
    const mode = config?.template?.mode || 'adaptive';
    tplModeSel.value = mode;
    tplModeSel.addEventListener('change', async () => {
      const cfg = await window.electronAPI.loadConfig().catch(() => ({}));
      if (!cfg.template) cfg.template = {};
      cfg.template.mode = tplModeSel.value;
      await window.electronAPI.saveConfig(cfg);
      // 同步设置页
      if (cfgModeSel) cfgModeSel.value = tplModeSel.value;
    });
    // 设置页变化也同步过来
    if (cfgModeSel) {
      cfgModeSel.addEventListener('change', () => { tplModeSel.value = cfgModeSel.value; });
    }
  }
  document.getElementById('ws-add-queue')?.addEventListener('click', addToQueue);
  document.getElementById('monthly-generate-btn')?.addEventListener('click', generateMonthlyReports);
  // 搜索 & 选择工具
  document.getElementById('send-search')?.addEventListener('input', (e) => {
    renderCompanyList(e.target.value.toLowerCase());
  });
  document.getElementById('send-select-all')?.addEventListener('click', () => {
    CS.clearSelection();
    if (CS.getFilter() === 'archived') {
      document.querySelectorAll('#send-company-list .send-company-item.archived').forEach(el => {
        if (el.dataset.company) CS.select(el.dataset.company);
      });
    } else {
      document.querySelectorAll('.sc-check').forEach(cb => {
        cb.checked = true;
        if (cb.dataset.company) CS.select(cb.dataset.company);
      });
    }
    updateSelectedCount();
  });
  document.getElementById('send-deselect-all')?.addEventListener('click', () => {
    CS.clearSelection();
    document.querySelectorAll('.sc-check').forEach(cb => { cb.checked = false; });
    updateSelectedCount();
  });
  document.getElementById('send-fill-limit')?.addEventListener('click', async () => {
    CS.clearSelection();
    document.querySelectorAll('.sc-check').forEach(cb => { cb.checked = false; });
    const stage = document.getElementById('send-fill-stage')?.value;
    let limit = 500;
    try { const stats = await window.electronAPI.getDashboardStats(); limit = stats.remaining || 500; } catch { /* 渲染层降级：操作失败不影响 UI */ }
    let total = 0;
    const allItems = document.querySelectorAll('#send-company-list .send-company-item:not(.archived)');
    const sorted = [...allItems].sort((a, b) => {
      const ca = (S.sendCompanies[a.dataset.company] || []).length;
      const cb = (S.sendCompanies[b.dataset.company] || []).length;
      return cb - ca;
    });
    for (const el of sorted) {
      const name = el.dataset.company;
      if (!name) continue;
      if (stage && (S.sendHistory[name]?.stage || 'cold') !== stage) continue;
      const count = (S.sendCompanies[name] || []).length;
      if (total + count > limit && total > 0) continue;
      CS.select(name);
      const cb = el.querySelector('.sc-check');
      if (cb) cb.checked = true;
      total += count;
    }
    updateSelectedCount();
    const stageLabel = stage ? ({ cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4' }[stage] || stage) : '全部阶段';
    showToast(`[${stageLabel}] 已填充 ${CS.getSelected().size} 家 · ${total} 人（剩余额度 ${limit}）`, 'ok');
  });
  // 阶段筛选标签
  document.querySelectorAll('.send-stage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.send-stage-tab').forEach(t => {
        t.style.background = 'var(--bg)';
        t.style.color = 'var(--text-secondary)';
        t.classList.remove('active');
      });
      tab.classList.add('active');
      tab.style.background = 'var(--primary)';
      tab.style.color = '#fff';
      CS.setFilterAndClear(tab.dataset.stage);
      const stageSel = document.getElementById('send-fill-stage');
      if (stageSel) stageSel.value = '';
      renderCompanyList(document.getElementById('send-search')?.value || '');
    });
  });
  // 阶段下拉同步筛选列表
  document.getElementById('send-fill-stage')?.addEventListener('change', () => {
    CS.setFilterAndClear(document.getElementById('send-fill-stage')?.value || 'active');
    renderCompanyList(document.getElementById('send-search')?.value || '');
    document.querySelectorAll('.send-stage-tab').forEach(t => {
      t.style.background = 'var(--bg)';
      t.style.color = 'var(--text-secondary)';
      t.classList.remove('active');
    });
  });
  await loadSendContacts();
  // 预加载用户模板供右键菜单使用
  try { S._userTemplates = await window.electronAPI.listUserTemplates(); } catch { S._userTemplates = []; }

  // 右键菜单：公司模板覆盖（右侧已选公司卡片）
  const ctxMenu = document.getElementById('send-ctx-menu');
  document.getElementById('send-company-cards')?.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.sc-card');
    if (!card || !card.dataset.company) return;
    e.preventDefault();
    const name = card.dataset.company;
    showSendContextMenu(name, e.clientX, e.clientY);
  });
  document.addEventListener('click', (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target)) hideSendContextMenu();
  });
}

function showSendContextMenu(companyName, x, y) {
  const ctxMenu = document.getElementById('send-ctx-menu');
  if (!ctxMenu) return;
  const members = S.sendCompanies[companyName] || [];
  const ctype = members[0]?.clientType || 'unlabeled';
  const hist = S.sendHistory[companyName];
  const stage = hist?.stage || 'cold';
  const lang = countryToLang(members[0]?.country || '');
  const card = S.selectedCards[companyName];
  const isUserTpl = card?._templateSource === 'user';
  const curTplName = isUserTpl ? card._userTemplate?.name : '预设模板';
  const curTplId = isUserTpl ? card._userTemplate?.id : '';

  const userTemplates = S._userTemplates || [];
  const matched = matchUserTemplates(userTemplates, ctype, stage, lang);

  let html = `<div class="ctx-current">当前：${escapeHtml(curTplName)}</div>`;
  html += `<div class="ctx-item${!isUserTpl ? ' active' : ''}" data-action="auto-preset">自动匹配（预设模板）</div>`;
  if (matched.length) {
    html += `<div class="ctx-item${isUserTpl && !curTplId ? ' active' : ''}" data-action="auto-user">自动匹配（用户模板）</div>`;
  }
  if (matched.length) {
    html += '<div class="ctx-sep"></div>';
    for (const tpl of matched) {
      const active = isUserTpl && curTplId === tpl.id;
      html += `<div class="ctx-item${active ? ' active' : ''}" data-action="pick" data-tpl-id="${escapeHtml(tpl.id)}">${escapeHtml(tpl.name || tpl.id)}</div>`;
    }
  }

  ctxMenu.innerHTML = html;
  // 确保菜单不超出视口
  const maxX = window.innerWidth - 220;
  const maxY = window.innerHeight - 200;
  ctxMenu.style.left = Math.min(x, maxX) + 'px';
  ctxMenu.style.top = Math.min(y, maxY) + 'px';
  ctxMenu.style.display = 'block';
  ctxMenu._companyName = companyName;
  ctxMenu._ctype = ctype;
  ctxMenu._stage = stage;
  ctxMenu._lang = lang;

  // 菜单项点击
  ctxMenu.querySelectorAll('.ctx-item').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      const tplId = el.dataset.tplId;
      applyTemplateOverride(ctxMenu._companyName, ctxMenu._ctype, ctxMenu._stage, ctxMenu._lang, action, tplId);
      hideSendContextMenu();
    });
  });
}

function hideSendContextMenu() {
  const ctxMenu = document.getElementById('send-ctx-menu');
  if (ctxMenu) ctxMenu.style.display = 'none';
}

function applyTemplateOverride(name, ctype, stage, lang, action, tplId) {
  const members = S.sendCompanies[name] || [];
  const usedSentences = S.sendHistory[name]?.usedSentences || [];
  const userTemplates = S._userTemplates || [];

  if (action === 'auto-preset') {
    CS.setCard(name, {
      type: ctype, stage, lang,
      template: randomPick(ctype, stage, usedSentences),
      _templateSource: 'preset',
    });
  } else if (action === 'auto-user') {
    const matched = matchUserTemplates(userTemplates, ctype, stage, lang);
    if (matched.length) {
      const picked = matched[Math.floor(Math.random() * matched.length)];
      CS.setCard(name, {
        type: ctype, stage, lang,
        template: randomPick(ctype, stage, usedSentences),
        _templateSource: 'user', _userTemplate: picked,
      });
    }
  } else if (action === 'pick' && tplId) {
    const tpl = userTemplates.find(t => t.id === tplId);
    if (tpl) {
      CS.setCard(name, {
        type: ctype, stage, lang,
        template: randomPick(ctype, stage, usedSentences),
        _templateSource: 'user', _userTemplate: tpl,
      });
    }
  }

  // 确保公司被选中
  CS.select(name);
  const cb = document.querySelector(`.sc-check[data-company="${CSS.escape(name)}"]`);
  if (cb) cb.checked = true;

  // 同步队列中该公司已有条目的模板信息
  const card = CS.getCard(name);
  if (card) {
    for (const q of S.queue) {
      if (q.company !== name) continue;
      q._tplInfo = card._templateSource === 'user' ? `user:${card._userTemplate?.id || ''}` : q._tplInfo;
      q._templateSource = card._templateSource;
    }
    saveQueue();
  }

  // 刷新右侧卡片
  updateSelectedCount();
  renderSelectedCards();
}


// ── 模板预览 ──────────────────────────────────────────────────────
export async function initTemplatePreview() {
  if (!S.templateLib) await CS.refreshTemplateLib();
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  // 预加载签名
  let sigHtml = '';
  try { const r = await window.electronAPI.loadSignature(); if (r.ok) sigHtml = r.html; } catch { /* 渲染层降级：操作失败不影响 UI */ }

  let selType = 'agent', selLang = 'es', selStage = 'cold', selSource = 'preset';

  // 将纯文本邮件转为 HTML（100% 复刻 main.js buildContent 输出）
  function textToHtml(bodyText) {
    const lines = bodyText.split('\n');
    const htmlLines = [];
    let isFirstLine = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const content = (isFirstLine && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${escapeHtml(t)}</strong>`
        : escapeHtml(t);
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${content}</p>`);
      isFirstLine = false;
    }
    return htmlLines.join('\n') + '\n<br>\n' + sigHtml;
  }

  const render = async () => {
    const content = document.getElementById('tpl-preview-content');
    if (!content) return;

    if (selSource === 'user') {
      // ponytail: 用户模板预览 — 找匹配的模板
      const templates = await window.electronAPI.listUserTemplates().catch(() => []);
      const matched = matchUserTemplates(templates, selType, selStage, selLang);

      if (!matched.length) {
        content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-secondary)"><p style="font-size:14px">📭 该类型/阶段暂无用户模板</p><p style="font-size:12px">请先在「模板工坊 → 用户模板」中创建</p></div>';
        return;
      }

      // 随机选一个匹配模板展示
      const tpl = matched[Math.floor(Math.random() * matched.length)];
      const displayBody = tpl.body ? tpl.body.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim() : '(空白模板)';
      const html = textToHtml(displayBody);
      content.innerHTML = `<div style="margin-bottom:8px;font-size:10px;color:var(--text-secondary)">${escapeHtml(tpl.name)} · ${USER_TEMPLATE_TYPES[tpl.type] || tpl.type} · ${USER_TEMPLATE_STAGES[tpl.stage] || tpl.stage} · ${USER_TEMPLATE_LANGS[tpl.lang] || tpl.lang}</div>
        <div style="margin-bottom:4px;font-size:11px;color:var(--primary)">${lucide('mail',12)} 主题：${escapeHtml(tpl.subject || '(无)')}</div>
        <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:4px">${html}</div>`;
      return;
    }

    // 预设库：现有逻辑
    if (!S.templateLib) return;
    const picked = randomPick(selType, selStage, [], false);
    const email = assembleEmail(selLang, picked.hook, picked.pain, picked.proof, picked.cta, picked.followup, selStage, selType, config?.sender?.bodyName, undefined);
    const html = textToHtml(email);

    // 在正文旁标注来源 ID
    const srcLabels = [];
    if (picked.hook) srcLabels.push('Hook: ' + picked.hook.id);
    if (picked.pain) srcLabels.push('Pain: ' + picked.pain.id);
    if (picked.proof) srcLabels.push('Proof: ' + picked.proof.id);
    if (picked.cta) srcLabels.push('CTA: ' + picked.cta.id);
    if (picked.followup) srcLabels.push('FollowUp: ' + picked.followup.id);

    content.innerHTML = `<div style="margin-bottom:8px;font-size:10px;color:var(--text-secondary)">${srcLabels.join(' · ')}</div>
      <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:4px">${html}</div>`;
  };

  if (!document.getElementById('tpl-regenerate')?._bound) {
    document.querySelectorAll('.tpl-type').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-type').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selType = b.dataset.val; render();
    }));
    document.querySelectorAll('.tpl-lang').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-lang').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selLang = b.dataset.val; render();
    }));
    document.querySelectorAll('.tpl-stage').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-stage').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selStage = b.dataset.val; render();
    }));
    document.querySelectorAll('.tpl-source').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tpl-source').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); selSource = b.dataset.val; render();
    }));
    document.getElementById('tpl-regenerate')?.addEventListener('click', () => render());
    document.getElementById('tpl-regenerate')._bound = true;
  }
  render();
}

export function updateMonthlyReportSection() {
  const section = document.getElementById('monthly-report-section');
  const countEl = document.getElementById('monthly-archived-count');
  if (!section || !countEl) return;
  const archivedCount = Object.entries(S.sendCompanies)
    .filter(([name]) => S.sendHistory[name]?.stage === 'archived').length;
  if (archivedCount > 0) {
    section.style.display = 'block';
    countEl.textContent = `${archivedCount} 家归档客户`;
  } else {
    section.style.display = 'none';
  }
}


export async function loadSendContacts() {
  await CS.refreshContacts();
  await CS.refreshSendHistory();
  try { S.sendBackcheckStatus = await window.electronAPI.getBackcheckStatus(); } catch { S.sendBackcheckStatus = {}; }
  S.sendCompanies = {};
  S.sendCompaniesById = {};
  for (const c of S.contactsData) {
    const name = c.company || '未命名';
    if (!S.sendCompanies[name]) S.sendCompanies[name] = [];
    S.sendCompanies[name].push(c);
    // Phase 3: build companyId index
    if (c.companyId) {
      if (!S.sendCompaniesById[c.companyId]) S.sendCompaniesById[c.companyId] = [];
      S.sendCompaniesById[c.companyId].push(c);
    }
  }
  renderCompanyList();
  updateMonthlyReportSection();
}

export function renderCompanyList(filter) {
  const container = document.getElementById('send-company-list');
  // 排序：联系人数 + 背调评分加权（评分 × 2 作为额外权重，高分优先）
  let all = Object.entries(S.sendCompanies).sort((a, b) => {
    const ra = S.sendBackcheckStatus[a[0]]?.rating || 0;
    const rb = S.sendBackcheckStatus[b[0]]?.rating || 0;
    const scoreA = a[1].length + (ra * 2);
    const scoreB = b[1].length + (rb * 2);
    return scoreB - scoreA;
  });
  if (filter) all = all.filter(([n]) => n.toLowerCase().includes(filter));

  const activeList = all.filter(([name]) => S.sendHistory[name]?.stage !== 'archived');
  const archivedList = all.filter(([name]) => S.sendHistory[name]?.stage === 'archived');

  let visible;
  if (S.sendStageFilter === 'archived') { visible = archivedList; }
  else if (S.sendStageFilter && S.sendStageFilter !== 'active') {
    visible = activeList.filter(([name]) => (S.sendHistory[name]?.stage || 'cold') === S.sendStageFilter);
  } else { visible = activeList; }

  const archTab = document.querySelector('.send-stage-tab[data-stage="archived"]');
  if (archTab) archTab.textContent = `已归档 (${archivedList.length})`;

  if (!visible.length) {
    const msg = S.sendStageFilter === 'archived' ? '暂无已归档公司 — 发完 F4 后自动归档' : '无匹配公司';
    container.innerHTML = `<p style="font-size:12px;color:var(--text-secondary);padding:8px">${msg}</p>`;
    if (S.sendStageFilter === 'active') updateSelectedCount();
    return;
  }

  const isArchivedView = S.sendStageFilter === 'archived';

    // 按开发阶段分组
  if (isArchivedView) {
    container.innerHTML = visible.map(function(pair) {
      var name = pair[0], members = pair[1];
      var ctype = members[0]?.clientType || 'unlabeled';
      var tagHtml = clientTypeTag(ctype);
      var ctry = escapeHtml(members[0]?.country || '');
      var hist = S.sendHistory[name];
      var vipClass = members.length >= 5 ? ' ci-vip' : '';
      var startedStr = hist?.startedAt ? formatDate(hist.startedAt) : '';
      var daysStr = hist?.startedAt ? '<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">' + daysSince(hist.startedAt) + '</span>' : '';
      var archivedStr = hist?.archivedAt ? formatDate(hist.archivedAt) : '';
      var subParts = [tagHtml, ctry, startedStr, archivedStr].filter(Boolean);
      return '<div class="send-company-item archived" data-company="' + escapeHtml(name) + '" style="opacity:.7">' +
        '<div class="sci-info">' +
          '<span class="ci-name' + vipClass + '">' + lucide('archive',13) + ' ' + escapeHtml(name) + daysStr + '</span>' +
          (subParts.length ? '<span class="sci-sub">' + subParts.join(' · ') + '</span>' : '') +
        '</div>' +
        '<button class="btn-reactivate-send" data-company="' + escapeHtml(name) + '" style="font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--success);background:transparent;color:var(--success);cursor:pointer;white-space:nowrap">' + lucide('refresh-cw',11) + ' 重新激活</button>' +
      '</div>';
    }).join('');
  } else {
    // 活跃视图：按阶段分组
    const stageGroups = {};
    const STAGES = ['cold','f1','f2','f3','f4'];
    visible.forEach(([name, members]) => {
      const stage = S.sendHistory[name]?.stage || 'cold';
      if (!stageGroups[stage]) stageGroups[stage] = [];
      stageGroups[stage].push([name, members]);
    });
    let html = '';
    for (const stage of S.STAGES) {
      const items = stageGroups[stage];
      if (!items || !items.length) continue;
      const totalContacts = items.reduce((s, [,m]) => s + m.length, 0);
      const gid = 'sg-' + stage;
      html += '<div class="send-stage-group">' +
        '<div class="send-stage-head" data-group="' + gid + '" style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f0f2f5;border-bottom:1px solid #e0e0e0;font-size:11px;font-weight:600">' +
          '<span class="sg-arrow" style="display:inline-block;width:10px;font-size:9px;transition:transform .2s">▸</span>' +
          '<span class="stage-badge stage-' + stage + '">' + S.STAGE_LABELS_SEND[stage] + '</span>' +
          '<span>' + items.length + ' 家 · ' + totalContacts + ' 人</span>' +
        '</div>' +
        '<div class="send-stage-cards" data-group="' + gid + '" style="display:none">' +
          items.map(([name, members]) => {
            const ctype = members[0]?.clientType || 'unlabeled';
            const tagHtml = clientTypeTag(ctype);
            const ctry = escapeHtml(members[0]?.country || '');
            const hist = S.sendHistory[name];
            const vipClass = members.length >= 5 ? ' ci-vip' : '';
            const startedStr = hist?.startedAt ? formatDate(hist.startedAt) : '';
            const daysStr = hist?.startedAt ? '<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">' + daysSince(hist.startedAt) + '</span>' : '';
            const subParts = [tagHtml, ctry, startedStr].filter(Boolean);
            const countStyle = members.length >= 20 ? ' style="color:var(--warning);font-weight:600"' : '';
            return '<div class="send-company-item" data-company="' + escapeHtml(name) + '">' +
              '<input type="checkbox" class="sc-check" data-company="' + escapeHtml(name) + '"' + (S.selectedCompanySet.has(name) ? ' checked' : '') + '>' +
              '<div class="sci-info">' +
                '<span class="ci-name' + vipClass + '">' + escapeHtml(name) + daysStr + '</span>' +
                (subParts.length ? '<span class="sci-sub">' + subParts.join(' · ') + '</span>' : '') +
              '</div>' +
              '<span class="ci-count"' + countStyle + '>' + members.length + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;

    // 阶段折叠
    container.querySelectorAll('.send-stage-head').forEach(head => {
      head.addEventListener('click', () => {
        const gid = head.dataset.group;
        const cards = container.querySelector('.send-stage-cards[data-group="' + gid + '"]');
        const arrow = head.querySelector('.sg-arrow');
        if (!cards) return;
        const hidden = cards.style.display === 'none';
        cards.style.display = hidden ? 'block' : 'none';
        if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
      });
    });
    // 默认展开冷开发
    container.querySelector('.send-stage-head[data-group="sg-cold"]')?.click();
  }

  if (isArchivedView) {
    container.querySelectorAll('.btn-reactivate-send').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const company = btn.dataset.company;
        if (!await showConfirm(`确定重新激活 ${company}？\n将重置为冷开发阶段，清空序列记录。`)) return;
        btn.disabled = true; btn.textContent = '⏳';
        await window.electronAPI.reactivateCompany(company);
        await CS.refreshSendHistory();
        CS.setFilter('active');
        document.querySelectorAll('.send-stage-tab').forEach(t => {
          t.style.background = 'var(--bg)'; t.style.color = 'var(--text-secondary)'; t.classList.remove('active');
        });
        const activeTab = document.querySelector('.send-stage-tab[data-stage="active"]');
        if (activeTab) { activeTab.classList.add('active'); activeTab.style.background = 'var(--primary)'; activeTab.style.color = '#fff'; }
        renderCompanyList(document.getElementById('send-search')?.value || '');
        updateMonthlyReportSection();
        showToast(`${company} 已重新激活`, 'ok');
      });
    });
    updateMonthlyReportSection();
  } else {
    updateSelectedCount();
    container.querySelectorAll('.send-company-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        const cb = el.querySelector('.sc-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      const cb = el.querySelector('.sc-check');
      if (cb) {
        cb.addEventListener('change', (e) => {
          const name = e.target.dataset.company;
          if (e.target.checked) CS.select(name);
          else CS.deselect(name);
          updateSelectedCount();
        });
      }
    });
  }

  // 右键菜单：重置全部选中公司
  container.oncontextmenu = (e) => {
    const selected = getSelectedCompanies();
    if (!selected.length) return;
    e.preventDefault();
    document.getElementById('ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:160px;font-size:13px';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = '<div style="padding:6px 14px;cursor:pointer;color:#333;white-space:nowrap;border-radius:4px;margin:0 4px;transition:background .15s" data-action="reset" onmouseenter="this.style.background=\'#f0f0f0\'" onmouseleave="this.style.background=\'transparent\'">重置状态 (' + selected.length + ' 家)</div>';
    menu.querySelector('[data-action="reset"]').onclick = async () => {
      menu.remove();
      if (!await showConfirm(`确定重置全部 ${selected.length} 家选中公司？\n将清空序列记录，恢复为冷开发阶段。`)) return;
      // 前端先行：立即清除选中和缓存，刷新列表
      const names = [...selected];
      for (const company of names) {
        CS.deselect(company);
        CS.removeCard(company);
      }
      renderCompanyList(document.getElementById('send-search')?.value || '');
      updateMonthlyReportSection();
      showToast(`${names.length} 家公司已重置`, 'ok');
      // 后端异步确认
      Promise.all(names.map(c => window.electronAPI.reactivateCompany(c))).then(async () => {
        await CS.refreshSendHistory();
        renderCompanyList(document.getElementById('send-search')?.value || '');
      });
    };
    document.body.appendChild(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  };
}

export function getSelectedCompanies() {
  return [...S.selectedCompanySet].map(id => CS.getName(id));
}

export function updateSelectedCount() {
  const selected = getSelectedCompanies();
  let totalContacts = 0;
  for (const name of selected) {
    totalContacts += (S.sendCompanies[name] || []).length;
  }
  const countEl = document.getElementById('send-selected-count');
  if (countEl) countEl.textContent = '';
  // 归档视图下隐藏加入队列按钮，显示批量重新激活
  const addBtn = document.getElementById('ws-add-queue');
  const listTitle = document.getElementById('send-list-title');
  const cardsContainer = document.getElementById('send-company-cards');
  const emptyEl = document.getElementById('send-cards-empty');
  if (S.sendStageFilter === 'archived') {
    if (addBtn) addBtn.style.display = 'none';
    if (listTitle) listTitle.textContent = selected.length ? `已选归档公司 (${selected.length} 家)` : '已归档公司';
    if (cardsContainer) cardsContainer.innerHTML = selected.length
      ? `<div style="text-align:center;padding:40px"><button id="btn-reactivate-all" style="font-size:14px;padding:10px 24px">' + lucide('refresh-cw',14) + ' 全部重新激活 (${selected.length} 家)</button></div>`
      : '';
    if (emptyEl && !selected.length) { emptyEl.textContent = '← 勾选左侧公司，使用「全选」批量激活'; emptyEl.style.display = 'block'; }
    else if (emptyEl) emptyEl.style.display = 'none';
    // 绑定批量重新激活按钮
    if (selected.length) {
      setTimeout(() => {
        document.getElementById('btn-reactivate-all')?.addEventListener('click', async () => {
          if (!await showConfirm(`确定重新激活全部 ${selected.length} 家归档公司？`)) return;
          const btn = document.getElementById('btn-reactivate-all');
          if (btn) { btn.disabled = true; btn.textContent = '⏳ 激活中...'; }
          for (const name of selected) {
            await window.electronAPI.reactivateCompany(name).catch(() => {});
          }
          await CS.refreshSendHistory();
          CS.setFilterAndClear('active');
          document.querySelectorAll('.send-stage-tab').forEach(t => {
            t.style.background = 'var(--bg)'; t.style.color = 'var(--text-secondary)'; t.classList.remove('active');
          });
          const activeTab = document.querySelector('.send-stage-tab[data-stage="active"]');
          if (activeTab) { activeTab.classList.add('active'); activeTab.style.background = 'var(--primary)'; activeTab.style.color = '#fff'; }
          renderCompanyList(document.getElementById('send-search')?.value || '');
          updateMonthlyReportSection();
          showToast(`已重新激活 ${selected.length} 家公司`, 'ok');
        });
      }, 0);
    }
  } else {
    if (addBtn) addBtn.style.display = '';
    if (listTitle) listTitle.textContent = selected.length ? `已选公司 (${selected.length} 家 · ${totalContacts} 人)` : '已选公司';
    renderSelectedCards();
  }
}

export async function renderSelectedCards() {
  const container = document.getElementById('send-company-cards');
  const empty = document.getElementById('send-cards-empty');
  const title = document.getElementById('send-list-title');
  const selected = getSelectedCompanies();
  if (!selected.length) {
    if (container) container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    if (title) title.textContent = '已选公司';
    return;
  }
  if (empty) empty.style.display = 'none';
  let tc = 0;
  for (const name of selected) { tc += (S.sendCompanies[name] || []).length; }
  if (title) title.textContent = `已选公司 (${selected.length} 家 · ${tc} 人)`;

  // ponytail: 加载用户模板和配置
  let userTemplates = [];
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const tplMode = document.getElementById('send-tpl-mode')?.value || config?.template?.mode || 'adaptive';
  try { userTemplates = await window.electronAPI.listUserTemplates(); } catch { /* 渲染层降级：操作失败不影响 UI */ }

  for (const name of selected) {
    const members = S.sendCompanies[name] || [];
    const ctype = members[0]?.clientType || 'unlabeled';
    const hist = S.sendHistory[name];
    const stage = hist?.stage || 'cold';
    const lang = countryToLang(members[0]?.country || '');
    const usedSentences = hist?.usedSentences || [];
    // ponytail: 每次加入队列时重新读取全局模板模式，不保留旧选择
    if (tplMode === 'general') {
      const matchedTpls = matchUserTemplates(userTemplates, ctype, stage, lang);
      if (matchedTpls.length) {
        const pickedTpl = matchedTpls[Math.floor(Math.random() * matchedTpls.length)];
        CS.setCard(name, { type: ctype, stage, lang, template: randomPick(ctype, stage, usedSentences), _templateSource: 'user', _userTemplate: pickedTpl });
      } else {
        CS.setCard(name, { type: ctype, stage, lang, template: randomPick(ctype, stage, usedSentences), _templateSource: 'preset' });
      }
    } else {
      CS.setCard(name, { type: ctype, stage, lang, template: randomPick(ctype, stage, usedSentences), _templateSource: 'preset' });
    }
  }
  const typeLabelMap = { agent: '代理模板', direct: '直客模板', unlabeled: '通用模板' };
  CS.pruneCards(selected);
  if (container) {
    container.innerHTML = selected.map(name => {
      const card = S.selectedCards[name];
      const members = S.sendCompanies[name] || [];
      const emailCount = members.filter(m => m.email).length;
      const countHtml = `<span>${emailCount}人</span>`;
      const ctry = escapeHtml(members[0]?.country || '');
      const nextLabel = S.STAGE_LABELS_SEND[S.STAGE_NEXT_SEND[card.stage]] || 'F1';
      const typeTag = clientTypeTag(card.type);
      const tplLabel = typeLabelMap[card.type] || '通用模板';
      const tplSourceTag = card._templateSource === 'user'
        ? `<span style="color:var(--primary);font-weight:600">📝 ${escapeHtml(card._userTemplate?.name || '')}</span>`
        : `<span>📋 ${typeLabelMap[card.type] || '自适应'}</span>`;
      const hist2 = S.sendHistory[name];
      const startedStr = hist2?.startedAt ? `<span>${formatDate(hist2.startedAt)}</span>` : '';
      const daysStr2 = hist2?.startedAt ? `<span style="color:var(--accent);font-weight:600">${daysSince(hist2.startedAt)}</span>` : '';
      const tags = [
        typeTag,
        ctry ? `<span>${ctry}</span>` : '',
        `<span>${card.lang.toUpperCase()}</span>`,
        countHtml,
        tplSourceTag,
        daysStr2,
        startedStr,
      ].filter(Boolean).join(' · ');
      return `<div class="sc-card" data-company="${escapeHtml(name)}">
        <div class="sc-card-header">
          <strong>${escapeHtml(name)}</strong>
          <span class="sc-stage">${S.STAGE_LABELS_SEND[card.stage]} → ${nextLabel}</span>
          <button class="sc-card-remove" data-company="${escapeHtml(name)}">${lucide('x',14)}</button>
        </div>
        <div class="sc-card-meta">${tags}</div>
      </div>`;
    }).join('');
    container.querySelectorAll('.sc-card-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CS.deselect(btn.dataset.company);
        // 同步取消左侧勾选
        const cb = document.querySelector(`.sc-check[data-company="${CSS.escape(btn.dataset.company)}"]`);
        if (cb) cb.checked = false;
        updateSelectedCount();
      });
    });
  }
}

// ── 加入队列 ────────────────────────────────────────────────────────
// ponytail: 从 app.js 迁移，适配 S.* 全局状态
async function addToQueue() {
  try {
  const typeLabelMap = { agent: '代理模板', direct: '直客模板', unlabeled: '通用模板' };
  const selected = getSelectedCompanies();
  if (!selected.length) return await showAlert('请先勾选左侧公司');
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  const GROUP_SIZE = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);
  let added = 0, skippedNoEmail = 0, skippedInvalidEmail = 0, skippedDupOrBounced = 0, skippedQueued = 0, reactivatedCount = 0;

  // 拉最新 contacts.json，确保 _sentBy 是最新的（内存快照可能过期）
  const freshContacts = await window.electronAPI.getContacts();
  const sentByEmails = new Set();
  for (const c of freshContacts) {
    if (c._sentBy && c.email) sentByEmails.add(c.email.toLowerCase().trim());
  }

  const needReset = [];
  for (const name of selected) {
    const members = S.sendCompanies[name] || [];
    if (!members.length) continue;
    const sentContacts = new Set((S.sendHistory[name]?.sentContacts || []).map(e => e.toLowerCase().trim()));
    const bouncedMembers = members.filter(m => m.bounced && m.bounceType !== 'temporary');
    const reachedMembers = members.filter(m => (m.tags || []).includes('reached'));
    const bouncedByContact = members.filter(m => (m.tags || []).includes('bounced_by_contact'));
    const repliedMembers = members.filter(m => (m.tags || []).includes('replied'));
    const leftCompany = members.filter(m => (m.tags || []).includes('left_company'));
    const alreadySent = members.filter(m => sentContacts.has((m.email || '').toLowerCase().trim()));
    const taggedSent = members.filter(m => sentByEmails.has((m.email || '').toLowerCase().trim()));
    const activeMembers = members.filter(m => !bouncedMembers.includes(m) && !alreadySent.includes(m) && !taggedSent.includes(m) && !reachedMembers.includes(m) && !bouncedByContact.includes(m) && !repliedMembers.includes(m) && !leftCompany.includes(m));
    if (!activeMembers.length && !bouncedMembers.length) {
      const stage = S.sendHistory[name]?.stage;
      if (!stage || stage === 'cold') needReset.push({ name, count: members.length });
    }
  }

  if (needReset.length) {
    const listStr = needReset.map(r => `· ${r.name} (${r.count}人)`).join('\n');
    const choice = await showConfirm(
      `以下 ${needReset.length} 家公司的联系人已标记为「已发送」，但开发阶段仍为冷开发：\n\n${listStr}\n\n点击「确定」全部重置并重新发送，点击「取消」跳过这些公司。`
    );
    if (choice) {
      for (const r of needReset) {
        await window.electronAPI.reactivateCompany(r.name);
        reactivatedCount += r.count;
      }
      await CS.refreshSendHistory();
    } else {
      for (const r of needReset) skippedDupOrBounced += r.count;
    }
  }

  for (const name of selected) {
    const card = S.selectedCards[name];
    if (!card) continue;
    const members = S.sendCompanies[name] || [];
    const bouncedMembers = members.filter(m => m.bounced && m.bounceType !== 'temporary');
    const reachedMembers = members.filter(m => (m.tags || []).includes('reached'));
    const bouncedByContact = members.filter(m => (m.tags || []).includes('bounced_by_contact'));
    const repliedMembers = members.filter(m => (m.tags || []).includes('replied'));
    const leftCompany = members.filter(m => (m.tags || []).includes('left_company'));
    const sentContacts = new Set((S.sendHistory[name]?.sentContacts || []).map(e => e.toLowerCase().trim()));
    const alreadySent = members.filter(m => sentContacts.has((m.email || '').toLowerCase().trim()));
    const taggedSent = members.filter(m => sentByEmails.has((m.email || '').toLowerCase().trim()));
    const queuedEmails = new Set();
    S.queue.forEach(q => {
      if (q.status === 'pending' || q.status === 'sending') {
        (q.recipients || []).forEach(r => queuedEmails.add(r.toLowerCase().trim()));
      }
    });
    const alreadyQueued = members.filter(m => queuedEmails.has((m.email || '').toLowerCase().trim()));
    let activeMembers = members.filter(m => !bouncedMembers.includes(m) && !alreadySent.includes(m) && !taggedSent.includes(m) && !reachedMembers.includes(m) && !bouncedByContact.includes(m) && !repliedMembers.includes(m) && !leftCompany.includes(m) && !alreadyQueued.includes(m));
    if (alreadyQueued.length) skippedQueued += alreadyQueued.length;
    if (taggedSent.length) skippedDupOrBounced += taggedSent.length;

    if (!activeMembers.length && members.length > 0) {
      if (alreadyQueued.length === members.length) {
        skippedQueued += 0; // already counted above
        continue;
      }
      if (bouncedMembers.length) {
        await showAlert(`${lucide('alert-triangle',12)} ${name} 所有联系人已退信（${bouncedMembers.length}/${members.length} 人），跳过`);
        skippedDupOrBounced += members.length;
        continue;
      }
      if (needReset.some(r => r.name === name)) continue;
      skippedDupOrBounced += members.length;
      continue;
    }
    const emails = [...new Set(activeMembers.map(m => (m.email || '').trim()).filter(e => e))];
    if (!emails.length) { skippedNoEmail++; continue; }
    const valid = emails.filter(e => S.EMAIL_RE.test(e));
    const invalid = emails.filter(e => !S.EMAIL_RE.test(e));
    if (!valid.length) { skippedInvalidEmail++; continue; }
    if (invalid.length) {
      if (!await showConfirm(`' + lucide('alert-triangle',12) + ' ${name} 有 ${invalid.length} 个邮箱格式异常：\n${invalid.join('\n')}\n\n仅发送给 ${valid.length} 个有效邮箱，是否继续？`)) continue;
    }
    const lang = card.lang;
    const hist = S.sendHistory[name];
    const stage = hist?.stage || 'cold';

    const useUserTpl = card._templateSource === 'user' && card._userTemplate;
    let baseSubject, body;
    const companyDisplay = (!name || name.includes('未命名') || name.includes('⚠️')) ? 'Estimado cliente' : name;
    // Phase 3: 取第一个联系人的 firstName 用于模板变量
    const firstNameDisplay = members[0]?.firstName || '';

    if (useUserTpl) {
      const ut = card._userTemplate;
      baseSubject = (ut.subject || '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
      body = (ut.body || '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
    } else {
      const subjects = S.templateLib.subjects?.[card.type] || { es: '', pt: '', en: '' };
      baseSubject = (subjects[lang] || subjects.es || subjects.en || '').replace(/\{\{company\}\}/g, companyDisplay).replace(/\{\{firstName\}\}/g, firstNameDisplay);
    }

    const totalGroups = Math.ceil(valid.length / GROUP_SIZE);
    const rotateGroups = (config.schedule?.template_rotate_groups > 0 ? config.schedule.template_rotate_groups : 3);
    let currentTpl = null;
    let groupsOnTpl = rotateGroups; // 首组即触发随机

    for (let g = 0; g < totalGroups; g++) {
      const groupEmails = valid.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE);
      let groupTpl = null;

      if (useUserTpl) {
        // ponytail: 用户模板不轮换 — 用户写什么就发什么，所有组共用同一正文
        if (!currentTpl) currentTpl = card.template;
        groupTpl = currentTpl;
      } else {
        // 预设模板：每 rotateGroups 组随机换一次
        if (groupsOnTpl >= rotateGroups) {
          currentTpl = randomPick(card.type, stage, []);
          groupsOnTpl = 0;
        }
        groupTpl = currentTpl;
        groupsOnTpl++;
        body = assembleEmail(lang, groupTpl.hook, groupTpl.pain, groupTpl.proof, groupTpl.cta, groupTpl.followup, stage, card.type, config?.sender?.bodyName, firstNameDisplay);
      }

      const batchLabel = totalGroups > 1 ? ` (${g + 1}/${totalGroups})` : '';
      S.queue.push({
        id: ++S.queueIdCounter, company: name, companyId: members[0]?.companyId || '', to: groupEmails.join(", "), recipients: groupEmails,
        subject: baseSubject, body, status: "pending", addedAt: new Date().toISOString(),
        _stage: stage, _type: card.type, _lang: card.lang, _country: members[0]?.country || '',
        _tplInfo: useUserTpl ? `user:${card._userTemplate?.id}` : [groupTpl?.hook?.id, groupTpl?.pain?.id, groupTpl?.proof?.id, groupTpl?.cta?.id, groupTpl?.followup?.id].filter(Boolean).join('·'),
        _templateSource: card._templateSource || 'preset',
        _templateLabel: useUserTpl ? (card._userTemplate?.name || '用户模板') : (typeLabelMap[card.type] || '自适应'),
        _groupOf: totalGroups > 1 ? name : undefined, _groupSeq: totalGroups > 1 ? g : undefined, _groupTotal: totalGroups > 1 ? totalGroups : undefined,
        _batchLabel: batchLabel,
        _recipientStatus: groupEmails.map(e => ({ email: e, status: 'pending' })),
      });
      added++;
    }
  }
  if (!added) {
    const reasons = [];
    if (skippedNoEmail) reasons.push(`${skippedNoEmail} 家无邮箱`);
    if (skippedInvalidEmail) reasons.push(`${skippedInvalidEmail} 家邮箱格式无效`);
    if (skippedQueued) reasons.push(`${skippedQueued} 人已在队列中`);
    if (skippedDupOrBounced) reasons.push(`${skippedDupOrBounced} 家已退信/已发送`);
    return await showAlert(`所选公司无法加入队列：${reasons.join('，')}`);
  }
  if (reactivatedCount > 0) showToast(lucide('refresh-cw',12) + ` ${reactivatedCount} 个联系人已重置，${needReset.length} 家公司可重新发送`, 'ok');
  saveQueue();
  document.getElementById('stat-queue').textContent = S.queue.filter(e => e.status === 'pending').length;
  // 清空选择，防止二次添加
  CS.clearSelection();
  // 跳转到发送队列
  const queueNav = document.querySelector('[data-page="queue"]');
  if (queueNav) queueNav.click();
  } catch (e) {
    showToast(`加入队列失败: ${e.message}`, 'err');
    console.error('addToQueue error:', e);
  }
}

// ── 用户模板匹配 ────────────────────────────────────────────────────
// ponytail: 返回匹配的模板列表。自适应模式：按类型+阶段+语言匹配；通用模式：只用含"general"的

// 热更新：发送历史变更时自动刷新公司列表（自动发送跑完/阶段推进）
window.electronAPI.onHistoryChanged(() => {
  if (document.getElementById('page-email-send')?.classList.contains('active')) {
    CS.refreshSendHistory();
    buildCompanyList();
    updateSelectedCount();
    renderSelectedCards();
  }
});

window.__pageHandlers['email-send'] = initEmailSend;
window.__pageHandlers['template-preview'] = initTemplatePreview;
