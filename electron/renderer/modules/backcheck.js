const S = window.S;
import CS from './company-state.js';
import { lucide,showAlert,showConfirm,showToast,escapeHtml,formatDate,daysSince,ratingStars,renderMarkdown,pollBackcheckStatus,checkNetworkStatus,initIcons,findById,truncate,clientTypeTag,groupByCompany,countryToLang } from './shared.js';

// ===== 背调详情 ======================================================


export async function loadBackcheck() {
  const container = document.getElementById('backcheck-companies');
  if (!container) return;

  // 只在首次进入（无选中公司）时重置，内部刷新不动工具栏
  if (!S.currentBackcheckCompany) {
    const toolbar = document.getElementById('backcheck-toolbar');
    if (toolbar) { toolbar.innerHTML = ''; toolbar.style.display = 'none'; }
    S.currentBackcheckDetail = null;
  }

  // 网络状态检查
  checkNetworkStatus();

  // 从联系人列表加载
  await CS.refreshContacts();
  const status = await window.electronAPI.getBackcheckStatus();

  if (!S.contactsData.length) {
    container.innerHTML = '<p style="color:var(--text-secondary);padding:12px">暂无联系人 — 请先在「联系人」中导入客户</p>';
    return;
  }

  // 读取背调筛选设置
  let filterEnabled = true;
  try {
    const cfg = await window.electronAPI.loadConfig();
    filterEnabled = cfg?.backcheck?.filterEnabled !== false; // 默认开启
  } catch { /* 渲染层降级：操作失败不影响 UI */ }

  // 按公司分组 → 根据设置决定是否仅保留 ≥5 人
  let groups = groupByCompany(S.contactsData);
  if (filterEnabled) {
    groups = groups.filter(([, members]) => members.length >= 5);
  }

  // 排序：星级降序 → 人数降序
  groups.sort((a, b) => {
    const ra = status[a[0]]?.rating || 0;
    const rb = status[b[0]]?.rating || 0;
    if (ra !== rb) return rb - ra;
    return b[1].length - a[1].length;
  });

  if (!groups.length) {
    const msg = filterEnabled
      ? '暂无符合条件的可定制客户（需同一公司 ≥5 位联系人）<br><span style="font-size:11px;color:var(--text-secondary)">可在设置中关闭背调筛选查看所有公司</span>'
      : '暂无联系人 — 请先在「联系人」中导入客户';
    container.innerHTML = `<p style="color:var(--text-secondary);padding:12px">${msg}</p>`;
    return;
  }

  container.innerHTML = '<div id="bc-batch-bar" style="display:flex;align-items:center;gap:6px;padding:3px 6px 3px 0;margin-bottom:4px;border-bottom:1px solid var(--border);font-size:11px">'
    + '<button id="bc-research-all" style="font-size:10px;padding:1px 8px;cursor:pointer;white-space:nowrap">全部调查</button>'
    + '<span id="bc-selected-count" style="color:var(--text-secondary);font-size:10px;flex:1"></span>'
    + '<button id="bc-toggle-all" style="font-size:10px;padding:1px 6px;cursor:pointer;white-space:nowrap">选择</button>'
    + '</div>'
    + groups.map(([company, members]) => {
    const st = status[company];
    const ctype = members[0]?.clientType || 'unlabeled';
    const tagHtml = clientTypeTag(ctype);
    const ctry = escapeHtml(members[0]?.country || '');
    const vipClass = members.length >= 5 ? ' ci-vip' : '';
    let badge = lucide('square',14);
    if (st?.status === 'researching' || st?.status === 'pending') badge = lucide('refresh-cw',14,'spin');
    else if (st?.status === 'timeout') badge = lucide('clock',14);
    else if (st?.status === 'done') badge = st.rating ? '' : lucide('check-circle',14);
    const ratingText = (st?.status === 'done' && st.rating) ? ratingStars(st.rating) : '';
    const subParts = [tagHtml, ctry].filter(Boolean);
    return `<div class="backcheck-company" data-company="${escapeHtml(company)}">
      <div class="bc-main"><input type="checkbox" class="bc-checkbox" data-company="${escapeHtml(company)}" style="width:16px;height:16px;flex-shrink:0;margin:0;cursor:pointer" onclick="event.stopPropagation()"><span class="bc-name${vipClass}">${escapeHtml(company)}</span><span class="bc-badge">${badge}</span><span class="bc-count">${members.length}人</span></div>
      ${ratingText ? `<div class="bc-sub">${ratingText}</div>` : ''}
      <div class="bc-sub">${subParts.join(' · ')}</div>
    </div>`;
  }).join('');

  // 批量操作按钮
  let bcSelectMode = false;
  document.getElementById('bc-toggle-all')?.addEventListener('click', function() {
    bcSelectMode = !bcSelectMode;
    this.textContent = bcSelectMode ? '取消选择' : '选择';
    this.style.background = bcSelectMode ? 'var(--primary)' : '';
    this.style.color = bcSelectMode ? '#fff' : '';
    container.querySelectorAll('.bc-checkbox').forEach(cb => { cb.checked = bcSelectMode; });
    updateBcSelectedCount();
  });
  document.getElementById('bc-research-all')?.addEventListener('click', async () => {
    const cbs = container.querySelectorAll('.bc-checkbox:checked');
    const list = cbs.length ? [...cbs] : container.querySelectorAll('.bc-checkbox');
    if (!list.length) return;
    // ponytail: 跳过已完成/进行中的公司
    const toResearch = [];
    for (const cb of list) {
      const cname = cb.dataset.company;
      const st = S.backcheckStatus[cname];
      if (st?.status === 'done' || st?.status === 'researching') continue;
      toResearch.push(cb);
    }
    if (!toResearch.length) { showToast('所选公司均已完成或正在背调', 'info'); return; }
    if (!await showConfirm(`即将对 ${toResearch.length} 家公司启动背调（已跳过 ${list.length - toResearch.length} 家已完成/进行中），确认？`)) return;
    for (const cb of toResearch) {
      const cname = cb.dataset.company;
      const contact = S.contactsData.find(c => (c.company || '').trim() === cname);
      if (!contact) continue;
      await window.electronAPI.startResearch(contact, S.lastBackcheckProvider);
      const badgeEl = cb.closest('.backcheck-company')?.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = lucide('refresh-cw',14,'spin');
    }
    showToast(`已启动 ${list.length} 家公司背调`, 'ok');
  });
  function updateBcSelectedCount() {
    const cnt = container.querySelectorAll('.bc-checkbox:checked').length;
    const total = container.querySelectorAll('.bc-checkbox').length;
    const el = document.getElementById('bc-selected-count');
    if (el) el.textContent = cnt ? `已选 ${cnt}/${total} 家` : `共 ${total} 家`;
  }
  container.addEventListener('change', (e) => {
    if (e.target.classList.contains('bc-checkbox')) updateBcSelectedCount();
  });
  updateBcSelectedCount();

  let selectedCompany = null;

  container.querySelectorAll('.backcheck-company').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('bc-checkbox')) return;
      container.querySelectorAll('.backcheck-company').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectedCompany = el.dataset.company;

      const [detail, freshStatus] = await Promise.all([
        window.electronAPI.getBackcheckDetail(selectedCompany),
        window.electronAPI.getBackcheckStatus(),
      ]);

      const currentSt = freshStatus[selectedCompany];
      if (detail?.rating > 0 && (!currentSt?.rating || currentSt.rating !== detail.rating)) {
        await window.electronAPI.markBackcheckDone(selectedCompany, detail.rating);
        freshStatus[selectedCompany] = { ...currentSt, rating: detail.rating, status: 'done' };
      }

      renderBackcheckCard(detail, selectedCompany, freshStatus[selectedCompany]);

      const updatedSt = freshStatus[selectedCompany];
      let badge = lucide('square',14);
      if (updatedSt?.status === 'researching' || updatedSt?.status === 'pending') badge = lucide('refresh-cw',14,'spin');
      else if (updatedSt?.status === 'done') badge = updatedSt.rating ? '' : lucide('check-circle',14);
      const badgeEl = el.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = badge;
    });
  });

  // 从客户开发页面预选跳转 → 自动点击对应公司
  if (S.discoverPreselectCompany) {
    const target = container.querySelector(`.backcheck-company[data-company="${escapeHtml(discoverPreselectCompany)}"]`);
    if (target) target.click();
    CS.setDiscoverPreselect($1);
  }

  // 工具栏事件委托（一次性绑定）
  if (!window._backcheckToolbarBound) {
    window._backcheckToolbarBound = true;
    // 网络状态关闭 + 重新检查
    document.getElementById('network-close-btn')?.addEventListener('click', () => {
      const el = document.getElementById('network-status');
      if (el) el.style.display = 'none';
      S.networkStatusDismissed = true;
    });
    document.getElementById('network-check-btn')?.addEventListener('click', checkNetworkStatus);
    const tb = document.getElementById('backcheck-toolbar');
    if (tb) {
      tb.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn || !S.currentBackcheckCompany) return;
        const cname = S.currentBackcheckCompany;
        if (btn.id === 'btn-research' || btn.id === 'btn-recheck') doResearch(cname);
        if (btn.id === 'btn-cancel-research') { if (await showConfirm('确定取消？')) { await window.electronAPI.cancelBackcheck(cname); loadBackcheck(); } }
        if (btn.id === 'btn-open-folder') window.electronAPI.openReportsFolder?.();
        if (btn.id === 'btn-reactivate-bc') { if (await showConfirm(`确定重新激活 ${cname}？`)) { await window.electronAPI.reactivateCompany(cname); await CS.refreshContactsSendHistory(); loadBackcheck(); } }
        if (btn.id === 'btn-fix-country') fixCountryFromToolbar();
        if (btn.id === 'btn-add-to-queue') addReportToQueue();
      });
      tb.addEventListener('change', (e) => {
        if (e.target.id === 'bc-provider') S.lastBackcheckProvider = e.target.value;
      });
    }
  }
}

// ── 工具栏独立事件处理 ─────────────────────────────────────────────

// 背调核心（独立函数，工具按钮可复用）
export async function doResearch(companyName) {
  const contact = S.contactsData.find(c => (c.company || '').trim() === (companyName || '').trim());
  if (!contact) { await showAlert('未找到联系人: ' + companyName); return; }

  const provider = document.getElementById('bc-provider')?.value || 'deep-research';

  const reportWrap = document.getElementById('backcheck-report-wrap');
  const btn = document.getElementById('btn-research') || document.getElementById('btn-recheck');
  if (btn) btn.innerHTML = lucide('refresh-cw',14,'spin') + ' 搜索中...';
  if (reportWrap) {
    reportWrap.innerHTML = '<p style="color:var(--primary);padding:20px;text-align:center;font-size:14px">' + lucide('refresh-cw',16,'spin') + ' 正在搜索 ' + escapeHtml(companyName) + ' ...</p>'
      + '<p style="color:var(--text-secondary);text-align:center;font-size:12px" id="research-progress">启动中...</p>';
  }

  let unsub = null;
  if (window.electronAPI.onBackcheckProgress) {
    unsub = window.electronAPI.onBackcheckProgress(async (data) => {
      if (data.company !== companyName) return;
      const progEl = document.getElementById('research-progress');
      if (progEl && data.type === 'research-progress') progEl.textContent = data.progress || '';
      if (data.type === 'research-done') {
        if (unsub) unsub();
        const [detail, status] = await Promise.all([
          window.electronAPI.getBackcheckDetail(companyName),
          window.electronAPI.getBackcheckStatus(),
        ]);
        renderBackcheckCard(detail, companyName, status[companyName]);
        const item = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
        if (item) {
          const st = status[companyName];
          const badge = st?.status === 'done' ? (st.rating ? ratingStars(st.rating) : lucide('check-circle',14)) : lucide('square',14);
          const badgeEl = item.querySelector('.bc-badge');
          if (badgeEl) badgeEl.innerHTML = badge;
        }
      }
    });
  }

  const result = await window.electronAPI.startResearch(contact, provider);
  if (!result.ok) {
    if (unsub) unsub();
    await showAlert(result.message || '启动失败');
    return;
  }
  S.lastBackcheckProvider = provider;
  // 立即更新左侧图标为动态
  const bcItem = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
  if (bcItem) {
    const badgeEl = bcItem.querySelector('.bc-badge');
    if (badgeEl) badgeEl.innerHTML = lucide('refresh-cw',14,'spin');
  }
  // 兜底检查
  const [detail, status] = await Promise.all([
    window.electronAPI.getBackcheckDetail(companyName),
    window.electronAPI.getBackcheckStatus(),
  ]);
  const st = status[companyName];
  if (st?.status === 'done') {
    if (unsub) unsub();
    renderBackcheckCard(detail, companyName, st);
    const item = document.querySelector('.backcheck-company[data-company="' + escapeHtml(companyName) + '"]');
    if (item) {
      const badge = st.rating ? ratingStars(st.rating) : lucide('check-circle',14);
      const badgeEl = item.querySelector('.bc-badge');
      if (badgeEl) badgeEl.innerHTML = badge;
    }
  }
}

// 获取开发信正文（优先独立文件，兜底报告内提取）
export function extractEmailFromDetail(detail) {
  if (detail?.emailBody) return detail.emailBody;
  if (detail?.raw) {
    const m = detail.raw.match(/## 开发信[\s\S]+/);
    return m ? m[0] : '';
  }
  return '';
}

export async function addReportToQueue() {
  if (!S.currentBackcheckDetail?.raw || !S.currentBackcheckCompany) return;
  const emailBody = extractEmailFromDetail(S.currentBackcheckDetail);
  if (!emailBody) { showToast('未找到开发信内容', 'err'); return; }

  // 获取公司联系人
  const members = (S.contactsData || []).filter(c => (c.company || '').trim() === S.currentBackcheckCompany.trim());
  const ctype = members[0]?.clientType || 'unlabeled';
  const country = members[0]?.country || '';
  const validMembers = members.filter(m => m.email && m.email.includes('@'));
  if (!validMembers.length) { showToast('该公司无有效邮箱', 'err'); return; }

  // 生成主题
  const config = await window.electronAPI.loadConfig().catch(() => ({}));
  const sendMode = config.schedule?.mode || 'multi';
  const GROUP_SIZE = sendMode === 'batch' ? (config.schedule?.batch_size || 10) : (config.schedule?.group_size || 20);
  const groups = [];
  for (let i = 0; i < validMembers.length; i += GROUP_SIZE) {
    groups.push(validMembers.slice(i, i + GROUP_SIZE));
  }

  let added = 0;
  for (const group of groups) {
    const toEmails = group.map(m => m.email);
    // 从开发信中提取 Subject 行
    const subjMatch = emailBody.match(/\*\*Subject:\*\*\s*(.+)/i);
    const baseSubject = subjMatch ? subjMatch[1].trim() : ('Logistics Partner / ' + (country || 'LatAm'));
    S.queue.push({
      id: ++S.queueIdCounter, company: S.currentBackcheckCompany, to: toEmails.join(', '), recipients: toEmails,
      subject: baseSubject, body: emailBody, status: 'pending', addedAt: new Date().toISOString(),
      _stage: 'cold', _type: ctype, _lang: countryToLang(country), _country: country,
      _fromReport: true,
    });
    added++;
  }

  showToast(`✅ 已加入 ${added} 组共 ${validMembers.length} 位联系人到队列`, 'ok');
  saveQueue();
  document.getElementById('stat-queue').textContent = S.queue.filter(e => e.status === 'pending').length;
  // 跳转到发送队列
  document.querySelector('[data-page="queue"]')?.click();
}

export async function fixCountryFromToolbar() {
  if (!S.currentBackcheckDetail) { showToast('无报告数据', 'err'); return; }
  // 优先用缓存的检测结果，否则实时计算
  let detectedCountry = S.currentBackcheckDetail._detectedCountry;
  let contact = S.currentBackcheckDetail._contact;
  if (!detectedCountry && S.currentBackcheckDetail.country) {
    const countryMap = { '巴西':'Brazil','brasil':'Brazil','brazil':'Brazil','墨西哥':'Mexico','méxico':'Mexico','mexico':'Mexico','智利':'Chile','chile':'Chile','秘鲁':'Peru','perú':'Peru','peru':'Peru','哥伦比亚':'Colombia','colombia':'Colombia','阿根廷':'Argentina','argentina':'Argentina' };
    const raw = S.currentBackcheckDetail.country.split(/[\n(（⚠]/)[0].trim();
    for (const [k, v] of Object.entries(countryMap)) {
      if (raw.toLowerCase().includes(k.toLowerCase())) { detectedCountry = v; break; }
    }
    contact = S.contactsData?.find(c => (c.company || '').trim() === (S.currentBackcheckCompany || '').trim());
  }
  if (!detectedCountry) { showToast('未检测到国家信息', 'err'); return; }
  const old = contact?.country || '(空)';
  if (!await showConfirm(`确认将「${S.currentBackcheckCompany}」所有联系人的国家标签从「${old}」修改为「${detectedCountry}」？`)) return;
  showToast('正在更新...', 'ok');
  let result;
  try {
    result = await window.electronAPI.updateCompanyCountry(S.currentBackcheckCompany, detectedCountry);
  } catch(e) {
    showToast('更新失败（需重启应用生效 main.js 改动）: ' + e.message, 'err');
    return;
  }
  if (result.ok && result.updated > 0) {
    showToast(`✅ 已修正 ${result.updated}/${result.total} 位联系人：${old} → ${detectedCountry}`, 'ok');
    await CS.refreshContacts();
    loadBackcheck();
  } else { showToast(`修正失败: ${result.error || '无匹配联系人'}`, 'err'); }
}
export function renderBackcheckCard(info, companyName, st) {
  const reportWrap = document.getElementById('backcheck-report-wrap');
  if (!reportWrap) return;

  S.currentBackcheckCompany = companyName;
  S.currentBackcheckDetail = info;

  const hasData = info?.raw && info.raw.length > 50;
  const isDone = st?.status === 'done';
  const isResearching = st?.status === 'researching';
  const isPending = st?.status === 'pending';
  const isTimeout = st?.status === 'timeout';
  const isError = st?.status === 'error' || st?.status === 'no_results' || st?.status === 'no_key';

  const rating = info?.rating || 0;

  // 检测国家标签不匹配
  const countryMap = {
    '巴西': 'Brazil', 'brasil': 'Brazil', 'brazil': 'Brazil',
    '墨西哥': 'Mexico', 'méxico': 'Mexico', 'mexico': 'Mexico',
    '智利': 'Chile', 'chile': 'Chile',
    '秘鲁': 'Peru', 'perú': 'Peru', 'peru': 'Peru',
    '哥伦比亚': 'Colombia', 'colombia': 'Colombia',
    '阿根廷': 'Argentina', 'argentina': 'Argentina',
  };
  let detectedCountry = null, countryMismatch = false, contact = null;
  if (info?.country) {
    const rawCountry = info.country.split(/[\n(（⚠]/)[0].trim(); // 提取纯国家名
    for (const [key, std] of Object.entries(countryMap)) {
      if (rawCountry.toLowerCase().includes(key.toLowerCase())) { detectedCountry = std; break; }
    }
    // 对比联系人当前国家标签
    contact = S.contactsData?.find(c => (c.company || '').trim() === (companyName || '').trim());
    if (detectedCountry && contact && contact.country !== detectedCountry) {
      countryMismatch = true;
    }
  }

  let bodyHtml = '';
  if (hasData || isDone) {
    const mdText = (info.raw || '').replace(/^[^#]*(?=# )/s, '').replace(/^> \*\*国家.*开发价值.*$/gm, '').replace(/\n\n\n+/g, '\n\n');
    const ratingHtml = rating > 0 ? `<div style="margin:8px 0 16px;font-size:13px;color:var(--text-secondary)">开发价值：${ratingStars(rating)} <span style="font-size:11px">(${rating}/5)</span></div>` : '';
    bodyHtml = `<div class="backcheck-report">${ratingHtml}${renderMarkdown(mdText)}</div>`;
  } else if (isError) {
    const msg = st?.progress || st?.message || '背调失败';
    bodyHtml = `<p style="color:var(--danger);padding:20px;text-align:center">${lucide('x-circle',16)} ${msg}</p>
      <p style="color:var(--text-secondary);font-size:12px;text-align:center;margin-top:4px">请确认公司官网地址是否正确，或稍后重试</p>`;
  } else if (isResearching || isPending) {
    bodyHtml = `<p style="color:var(--warning);padding:20px;text-align:center">${lucide('refresh-cw',16,'spin')} ${st?.progress || '处理中...'}</p>`;
  } else if (isTimeout) {
    bodyHtml = `<p style="color:var(--danger);padding:20px;text-align:center">${lucide('clock',16)} 请求超时，请检查请求文件</p>`;
  } else {
    bodyHtml = '<p style="color:var(--text-secondary);padding:20px;text-align:center">点击下方按钮开始背调</p>';
  }
  const showProgress = isResearching || isPending || isTimeout;
  const showStartBtn = !isDone && !isResearching && !isPending;
  const showCancelBtn = isResearching || isPending;

  info._detectedCountry = detectedCountry;
  info._contact = contact;

  // ── 渲染工具栏（固定区）───────────────────────────────────────
  const toolbar = document.getElementById('backcheck-toolbar');
  let toolbarHtml = '';
  if (countryMismatch) {
    toolbarHtml += '<div style="width:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;margin-bottom:6px;background:#fff3e0;border:1px solid #ff9800;border-radius:6px;font-size:12px"><span>⚠️ 真实国家：<b>' + detectedCountry + '</b>，当前：<b>' + escapeHtml(contact?.country || '(空)') + '</b></span><button id="btn-fix-country" style="margin-left:auto;font-size:11px;padding:3px 10px;white-space:nowrap">修正</button></div>';
  }
  toolbarHtml += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
  if (!isResearching && !isPending) {
    toolbarHtml += '<select id="bc-provider" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg)"><option value="deep-research"' + (S.lastBackcheckProvider==='deep-research'?' selected':'') + '>Exa 搜索</option><option value="serper-deepseek"' + (S.lastBackcheckProvider==='serper-deepseek'?' selected':'') + '>Google 搜索</option><option value="tavily-deepseek"' + (S.lastBackcheckProvider==='tavily-deepseek'?' selected':'') + '>Tavily 搜索</option></select>';
  }
  if (showStartBtn) toolbarHtml += '<button id="btn-research">' + lucide('search',14) + ' 开始背调</button>';
  if (isDone) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重新调查</button>';
  if (isError) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重试</button>';
  if (isTimeout) toolbarHtml += '<button id="btn-recheck" style="font-size:12px;padding:5px 14px">' + lucide('refresh-cw',12) + ' 重新调查</button>';
  if (showCancelBtn) toolbarHtml += '<button id="btn-cancel-research" class="danger" style="font-size:12px;padding:5px 14px">' + lucide('x',12) + ' 取消</button>';
  toolbarHtml += '<button id="btn-open-folder" style="font-size:12px;padding:5px 14px">' + lucide('folder-open',12) + ' 打开文件夹</button>';
  if (S.contactsSendHistory[companyName]?.stage === 'archived') toolbarHtml += '<button id="btn-reactivate-bc" style="font-size:12px;padding:5px 14px;color:var(--success)">' + lucide('rotate-ccw',12) + ' 重新激活</button>';
  if (isDone && info?.raw) toolbarHtml += '<button id="btn-add-to-queue" style="font-size:12px;padding:5px 14px;background:var(--success);color:#fff">' + lucide('send',12) + ' 加入队列</button>';
  toolbarHtml += '</div>';
  if (toolbar) { toolbar.innerHTML = toolbarHtml; toolbar.style.display = 'flex'; }

  // ── 渲染报告（可滚动区）───────────────────────────────────────
  const progressHtml = showProgress ? '<div style="background:#fff8e1;border:1px solid #ffe0b2;border-radius:6px;padding:12px;margin-top:12px"><div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">' + lucide('radio-tower',14) + ' 状态</div><div style="font-size:13px;color:var(--primary)">' + (st?.progress || '等待处理...') + '</div>' + (isPending ? '<div style="font-size:11px;color:var(--warning);margin-top:6px">' + lucide('file-text',12) + ' 请求文件已生成，对 Claude 说「处理背调请求」即可自动完成</div>' : '') + (isTimeout ? '<div style="font-size:11px;color:var(--danger);margin-top:6px">报告未在 10 分钟内生成，请手动检查</div>' : '') + '</div>' : '';

  if (reportWrap) {
    reportWrap.dataset.translated = '0';
    reportWrap.innerHTML = bodyHtml + progressHtml;
  }
  const statusEl = document.getElementById('translate-status');
  if (statusEl) statusEl.style.display = 'none';
  const dsPanel = document.getElementById('deep-search-results');
  if (dsPanel) dsPanel.style.display = 'none';

  // ── Agnes 开发信验证（后台，境外断网时跳过）─────────────────────
  if (isDone && info?.emailBody && S.foreignNetworkOk) {
    const vBar = document.createElement('div');
    vBar.id = 'email-verify-bar';
    vBar.style.cssText = 'margin-top:12px;padding:8px 12px;border-radius:6px;font-size:11px;display:flex;align-items:center;gap:8px;background:#f5f6fa;border:1px solid var(--border)';
    vBar.innerHTML = lucide('refresh-cw',12,'spin') + ' 正在检查开发信...';
    reportWrap.appendChild(vBar);

    window.electronAPI.verifyEmail(info.emailBody).then(result => {
      if (result?.ok) {
        const pct = Math.round(result.passed / result.total * 100);
        const ok = result.passed === result.total;
        vBar.style.background = ok ? '#e8f5e9' : '#fff3e0';
        vBar.style.border = ok ? '1px solid #a5d6a7' : '1px solid #ffcc02';
        vBar.innerHTML = (ok ? lucide('check-circle',12) : lucide('alert-circle',12))
          + ` 自查通过 ${result.passed}/${result.total} 项` + (ok ? '' : ' — 点击查看详情');
        vBar.style.cursor = ok ? 'default' : 'pointer';
        vBar.title = result.details || '';
        if (!ok) {
          vBar.addEventListener('click', () => {
            showAlert('开发信自查结果：\n\n' + (result.details || '无详情'));
          });
        }
      } else {
        vBar.innerHTML = lucide('x-circle',12) + ' 验证失败: ' + (result?.error || '未知');
        vBar.style.background = '#ffebee';
      }
    }).catch(e => {
      vBar.innerHTML = lucide('x-circle',12) + ' 验证异常';
      vBar.style.background = '#ffebee';
    });
  }
}

// ── 决策人结果渲染 ──────────────────────────────────────────────
export function renderDeepSearchResults(panel, result) {
  const { people, stats, company_info } = result;
  const logisticsPeople = people.filter(p => p.department === 'logistics');
  const managementPeople = people.filter(p => p.department === 'management');
  const otherPeople = people.filter(p => p.department === 'other');

  let html = '';

  // 来源统计
  html += `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;display:flex;gap:16px;flex-wrap:wrap">`;
  html += `<span>${lucide('globe',12)} 官网: ${stats.from_website}人</span>`;
  html += `<span>${lucide('linkedin',12)} LinkedIn: ${stats.from_linkedin}人</span>`;
  html += `<span>${lucide('target',12)} 物流/采购: ${stats.logistics}人</span>`;
  html += `</div>`;

  // 物流/采购决策人 — 重点展示
  if (logisticsPeople.length) {
    html += `<div style="margin-bottom:12px">`;
    html += `<div style="font-size:13px;font-weight:600;color:var(--success);margin-bottom:8px">${lucide('target',13)} 物流/采购决策人 (${logisticsPeople.length}人)</div>`;
    logisticsPeople.forEach(p => {
      html += renderPersonCard(p, true);
    });
    html += `</div>`;
  }

  // 高管
  if (managementPeople.length) {
    html += `<div style="margin-bottom:12px">`;
    html += `<div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">${lucide('briefcase',13)} 管理层 (${managementPeople.length}人)</div>`;
    managementPeople.forEach(p => {
      html += renderPersonCard(p, false);
    });
    html += `</div>`;
  }

  // 其他
  if (otherPeople.length) {
    html += `<details style="margin-bottom:8px"><summary style="font-size:12px;color:var(--text-secondary);cursor:pointer">${lucide('user',12)} 其他人员 (${otherPeople.length}人)</summary><div style="margin-top:8px">`;
    otherPeople.slice(0, 5).forEach(p => {
      html += renderPersonCard(p, false);
    });
    html += `</div></details>`;
  }

  if (!people.length) {
    html += `<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">`;
    html += `未找到决策人信息。<br><span style="font-size:11px">公司官网可能没有团队页面，LinkedIn 可能未登录。</span>`;
    html += `</div>`;
  }

  panel.innerHTML = html;
}

export function renderPersonCard(p, highlight) {
  const confidenceDots = p.confidence > 0.5 ? '🟢' : p.confidence > 0.3 ? '🟡' : '⚪';

  return `
    <div class="deep-person-card" style="background:${highlight ? '#f0faf0' : '#f8f9fb'};border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="flex:1;min-width:180px">
        <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(p.name)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHtml(p.title)}</div>
        ${p.location ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:1px">📍 ${escapeHtml(p.location)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${p.email ? `<span style="font-size:11px;color:var(--text-secondary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.email)}">${confidenceDots} ${escapeHtml(p.email)}</span>` : ''}
        <button class="btn-add-contact secondary" data-cname="${escapeHtml(p.name)}" data-ctitle="${escapeHtml(p.title)}" data-cemail="${escapeHtml(p.email || '')}" style="font-size:11px;padding:3px 8px;cursor:pointer;white-space:nowrap">+ 联系人</button>
      </div>
    </div>`;
}

// 事件代理：点击「添加到联系人」
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-add-contact');
  if (!btn) return;
  const name = btn.dataset.cname;
  if (!name) return;

  const client = {
    company: name.split(' ').slice(-1)[0],
    contactName: name,
    position: btn.dataset.ctitle,
    email: btn.dataset.cemail,
  };

  try {
    const result = await window.electronAPI.importContacts([client]);
    if (result?.added > 0) {
      btn.textContent = '✓ 已添加';
      btn.style.color = 'var(--success)';
      btn.disabled = true;
    } else if (result?.skipped > 0) {
      btn.textContent = '已存在';
      btn.style.color = 'var(--text-secondary)';
      btn.disabled = true;
    }
  } catch {
    btn.textContent = '失败';
    btn.style.color = 'var(--danger)';
  }
});

window.__pageHandlers['backcheck'] = () => { S.currentBackcheckCompany = null; loadBackcheck(); };
