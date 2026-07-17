const S = window.S;
import { lucide,showAlert,showToast,escapeHtml,initIcons,showConfirm,deepMerge } from './shared.js';

// ===== 设置 ==========================================================
const CFG_KEYS = [
  { id: 'cfg-sender-name', path: 'sender.name' },
  { id: 'cfg-sender-body-name', path: 'sender.bodyName' },
  { id: 'cfg-schedule-start', path: 'schedule.start_hour_beijing', isTime: true },
  { id: 'cfg-schedule-end', path: 'schedule.end_hour_beijing', isTime: true },
  { id: 'cfg-schedule-time-toggle', path: 'schedule.time_window_enabled', isBool: true },
  { id: 'cfg-schedule-min-delay', path: 'schedule.min_delay_seconds' },
  { id: 'cfg-schedule-max-delay', path: 'schedule.max_delay_seconds' },
  { id: 'cfg-schedule-group-size', path: 'schedule.group_size' },
  { id: 'cfg-schedule-company-delay-min', path: 'schedule.company_delay_min_seconds' },
  { id: 'cfg-schedule-company-delay-max', path: 'schedule.company_delay_max_seconds' },
  { id: 'cfg-schedule-single-min', path: 'schedule.single_recip_delay_min_seconds' },
  { id: 'cfg-schedule-single-max', path: 'schedule.single_recip_delay_max_seconds' },
  { id: 'cfg-schedule-template-rotate', path: 'schedule.template_rotate_groups' },
  { id: 'cfg-template-mode', path: 'template.mode' },
  { id: 'cfg-schedule-batch-size', path: 'schedule.batch_size' },
  { id: 'cfg-schedule-batch-pause-min', path: 'schedule.batch_pause_min_seconds' },
  { id: 'cfg-schedule-batch-pause-max', path: 'schedule.batch_pause_max_seconds' },
  { id: 'cfg-schedule-batch-item-delay-min', path: 'schedule.batch_item_delay_min' },
  { id: 'cfg-schedule-batch-item-delay-max', path: 'schedule.batch_item_delay_max' },

  { id: 'cfg-search-exa-key', path: 'search.exaKey' },
  { id: 'cfg-search-tavily-key', path: 'search.apiKey' },
  { id: 'cfg-search-serper-key', path: 'search.serperKey' },
  { id: 'cfg-agnes-key', path: 'verify.agnesKey' },
  { id: 'cfg-deepseek-key', path: 'translate.deepseek.apiKey' },
  { id: 'cfg-proxy-host', path: 'proxy.host' },
  { id: 'cfg-test-email', path: 'test.email' },
  { id: 'cfg-test-company', path: 'test.company' },
  { id: 'cfg-test-enabled', path: 'test.enabled', isBool: true },
  { id: 'cfg-dry-run', path: 'test.dryRun', isBool: true },
  { id: 'cfg-backcheck-filter', path: 'backcheck.filterEnabled', isBool: true },
  { id: 'cfg-general-auto-launch', path: 'general.autoLaunch', isBool: true },
  { id: 'cfg-general-close-action', path: 'general.closeAction' },
  { id: 'cfg-general-loader-anim', path: 'general.loaderAnimDisabled', isBool: true },
];

export function loadSettingsIntoForm(config) {
  if (!config) return;
  // 关键字段默认值（防止空值被错误保存）
  const DEFAULTS = {
    'cfg-schedule-start': '09:00', 'cfg-schedule-end': '08:00',
    'cfg-schedule-min-delay': '8', 'cfg-schedule-max-delay': '16',
    'cfg-schedule-company-delay-min': '900', 'cfg-schedule-company-delay-max': '1200',
    'cfg-schedule-single-min': '5', 'cfg-schedule-single-max': '10',
    'cfg-schedule-group-size': '25',
    'cfg-schedule-template-rotate': '3',
    'cfg-schedule-batch-size': '12', 'cfg-schedule-batch-pause-min': '94',
    'cfg-schedule-batch-pause-max': '167',
    'cfg-schedule-batch-item-delay-min': '8', 'cfg-schedule-batch-item-delay-max': '16',
    'cfg-general-close-action': 'tray',
    'cfg-template-mode': 'adaptive',
  };
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val = key.path.split('.').reduce((o, k) => o?.[k], config);
    if (key.isTime && val != null) {
      const h = String(Math.floor(val)).padStart(2, '0');
      val = h + ':00';
    }
    if (val == null && DEFAULTS[key.id]) {
      val = DEFAULTS[key.id];
    }
    if (key.isBool) el.checked = !!val;
    else el.value = val ?? '';
  }
}

export function collectSettingsFromForm() {
  const config = {};
  for (const key of CFG_KEYS) {
    const el = document.getElementById(key.id);
    if (!el) continue;
    let val;
    if (key.isBool) val = el.checked;
    else if (key.isTime) { const p = parseInt(el.value); val = isNaN(p) ? undefined : p; }
    else if (el.type === 'number') { const n = Number(el.value); val = (el.value === '' || isNaN(n)) ? undefined : n; }
    else val = el.value;
    if (val !== undefined) getOrSet(config, key.path, val);
  }
  // 模式选择
  const modeEl = document.getElementById('cfg-schedule-mode');
  if (modeEl && modeEl.value) { if (!config.schedule) config.schedule = {}; config.schedule.mode = modeEl.value; }
  return config;

  function getOrSet(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!o[keys[i]]) o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = val;
  }
}

export async function initSettings() {
  // 强制关闭可能残留的编辑弹窗，防止透明模态层卡死按钮
  const modal = document.getElementById('account-modal');
  if (modal) modal.style.display = 'none';
  // ponytail: 事件委托替代逐元素绑定，避免每次切到设置页累加 focus 监听器
  const page = document.getElementById('page-settings');
  if (page && !page._focusBound) {
    page._focusBound = true;
    page.addEventListener('focusin', (e) => {
      const el = e.target;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select();
    });
  }

  const config = await window.electronAPI.loadConfig();
  if (config) loadSettingsIntoForm(config);
  toggleTimeWindow();
  checkCrossDay();
  updateBatchPauseMinutes();
  // 模式下拉：加载 + 切换
  const modeEl = document.getElementById('cfg-schedule-mode');
  if (modeEl) {
    modeEl.value = config?.schedule?.mode || 'batch';
    modeEl.addEventListener('change', toggleScheduleMode);
    toggleScheduleMode();
  }
  validateRequired();
  updateScheduleEstimate();
}

export function toggleScheduleMode() {
  const mode = document.getElementById('cfg-schedule-mode')?.value || 'batch';
  const multiFields = document.getElementById('cfg-multi-fields');
  const batchFields = document.getElementById('cfg-batch-fields');
  if (multiFields) multiFields.style.display = mode === 'multi' ? '' : 'none';
  if (batchFields) batchFields.style.display = mode === 'batch' ? '' : 'none';
  updateScheduleEstimate();
  // 自动保存模式，防止重启丢失
  saveModeOnly(mode).catch(() => {});
}

async function saveModeOnly(mode) {
  const config = await window.electronAPI.loadConfig() || {};
  if (!config.schedule) config.schedule = {};
  config.schedule.mode = mode;
  await window.electronAPI.saveConfig(config);
}



// 自动保存设置
async function autoSaveSettings(el) {
  validateRequired();
  const card = el.closest('.setting-card');
  const status = card?.querySelector('.setting-status');
  if (status) { status.textContent = '...'; status.style.color = 'var(--warning)'; }
  try {
    const existing = await window.electronAPI.loadConfig() || {};
    const formData = collectSettingsFromForm();
    const merged = deepMerge(existing, formData);
    const result = await window.electronAPI.saveConfig(merged);
    if (status) {
      status.textContent = result.ok ? '✓' : '✗';
      status.style.color = result.ok ? 'var(--success)' : 'var(--danger)';
      if (card && result.ok) {
        card.classList.add('saved');
        setTimeout(() => card.classList.remove('saved'), 1500);
      }
      setTimeout(() => { status.textContent = ''; }, 2000);
    }
  } catch {
    if (status) { status.textContent = '✗'; status.style.color = 'var(--danger)'; }
  }
}

// 自动保存：监听所有设置输入变化
document.querySelectorAll('#page-settings input, #page-settings select, #page-settings textarea').forEach(el => {
  el.addEventListener('change', () => autoSaveSettings(el));
  if (el.type === 'text' || el.type === 'password' || el.type === 'number') {
    el.addEventListener('input', () => {
      clearTimeout(S.settingSaveTimer);
      S.settingSaveTimer = setTimeout(() => autoSaveSettings(el), 800);
    });
  }
});

// 发送时间跨天检测
function checkCrossDay() {
  const start = document.getElementById('cfg-schedule-start')?.value;
  const end = document.getElementById('cfg-schedule-end')?.value;
  const nd = document.getElementById('cfg-schedule-nextday');
  if (nd && start && end) {
    nd.style.display = (start >= end) ? 'inline' : 'none';
  }
}
document.getElementById('cfg-schedule-start')?.addEventListener('input', checkCrossDay);
document.getElementById('cfg-schedule-end')?.addEventListener('input', checkCrossDay);

// 组间暂停秒→分钟换算
function updateBatchPauseMinutes() {
  const el = document.getElementById('cfg-batch-pause-minutes');
  if (!el) return;
  const min = parseFloat(document.getElementById('cfg-schedule-batch-pause-min')?.value) || 0;
  const max = parseFloat(document.getElementById('cfg-schedule-batch-pause-max')?.value) || 0;
  if (min && max && min > 0 && max > 0) {
    el.textContent = `（${(min/60).toFixed(1)} ~ ${(max/60).toFixed(1)} 分钟）`;
  } else {
    el.textContent = '';
  }
}
document.getElementById('cfg-schedule-batch-pause-min')?.addEventListener('input', updateBatchPauseMinutes);
document.getElementById('cfg-schedule-batch-pause-max')?.addEventListener('input', updateBatchPauseMinutes);

// 发送时间窗口开关
function toggleTimeWindow() {
  const toggle = document.getElementById('cfg-schedule-time-toggle');
  const on = toggle?.checked !== false; // 默认开启
  const start = document.getElementById('cfg-schedule-start');
  const end = document.getElementById('cfg-schedule-end');
  if (start) { start.disabled = !on; start.style.opacity = on ? '' : '0.4'; }
  if (end) { end.disabled = !on; end.style.opacity = on ? '' : '0.4'; }
}
document.getElementById('cfg-schedule-time-toggle')?.addEventListener('change', () => {
  toggleTimeWindow();
  // checkbox 值需要映射为 true/false
  const el = document.getElementById('cfg-schedule-time-toggle');
  autoSaveSettings({ id: el.id, type: 'checkbox', checked: el.checked });
});

// 必填字段检测
export function validateRequired() {
  document.querySelectorAll('.setting-required input[data-required]').forEach(el => {
    el.style.borderColor = el.value.trim() ? '' : 'var(--danger)';
    el.style.background = el.value.trim() ? '' : '#fff5f5';
  });
}
document.querySelectorAll('.setting-required input[data-required]').forEach(el => {
  el.addEventListener('input', validateRequired);
});

// 预计发送时长（设置页灰字，双模式）
export async function updateScheduleEstimate() {
  const el = document.getElementById('cfg-schedule-estimate');
  if (!el) return;
  // getNumOr: 区分「用户填0」和「留空」— 留空用默认值，0 就是 0
  const getNumOr = (id, fallback) => {
    const input = document.getElementById(id);
    if (!input || input.value.trim() === '') return fallback;
    const v = Number(input.value);
    return isNaN(v) ? fallback : v;
  };
  // 从仪表盘取实际剩余额度
  let max = 500;
  try { const stats = await window.electronAPI.getDashboardStats(); max = stats.remaining || 0; } catch { /* 渲染层降级：操作失败不影响 UI */ }
  if (max <= 0) { el.innerHTML = ''; return; }
  const mode = document.getElementById('cfg-schedule-mode')?.value || 'batch';

  let totalSec;
  if (mode === 'batch') {
    const batchSize = getNumOr('cfg-schedule-batch-size', 10);
    const pauseMin = getNumOr('cfg-schedule-batch-pause-min', 150);
    const pauseMax = getNumOr('cfg-schedule-batch-pause-max', 210);
    const avgPause = (pauseMin + pauseMax) / 2;
    const batches = Math.ceil(max / batchSize);
    totalSec = Math.round((batches - 1) * avgPause);
  } else {
    const avgItemDelay = (getNumOr('cfg-schedule-min-delay', 10) + getNumOr('cfg-schedule-max-delay', 15)) / 2;
    const singleMin = getNumOr('cfg-schedule-single-min', 60);
    const singleMax = getNumOr('cfg-schedule-single-max', 180);
    const avgSingleDelay = (singleMin + singleMax) / 2;
    const companies = Math.ceil(max / 2);
    totalSec = Math.round(max * avgItemDelay + (companies - 1) * avgSingleDelay);
  }

  if (totalSec <= 0) { el.innerHTML = ''; return; }
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60);
  const timeStr = h > 0 ? `${h} 时 ${m} 分` : `${m} 分`;
  const perMin = totalSec > 0 ? Math.round(max / (totalSec / 60)) : 0;
  const perHour = totalSec > 0 ? Math.round(max / (totalSec / 3600)) : 0;
  el.innerHTML = `剩余 ${max} 封 ≈ <strong>${timeStr}</strong> · 约 <strong>${perMin} 封/分</strong> - <strong>${perHour} 封/时</strong>`;
}
['cfg-schedule-mode','cfg-schedule-min-delay','cfg-schedule-max-delay','cfg-schedule-company-delay-min','cfg-schedule-company-delay-max','cfg-schedule-group-size','cfg-schedule-single-min','cfg-schedule-single-max','cfg-schedule-batch-size','cfg-schedule-batch-pause-min','cfg-schedule-batch-pause-max'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === 'cfg-schedule-mode' ? 'change' : 'input', updateScheduleEstimate);
});

// 开机自启：额外调用系统级设置
document.getElementById('cfg-general-auto-launch')?.addEventListener('change', async (e) => {
  try { await window.electronAPI.setAutoLaunch(e.target.checked); } catch { /* 渲染层降级：操作失败不影响 UI */ }
});

// 初始化时回读系统自启状态
(async () => {
  try {
    const r = await window.electronAPI.getAutoLaunch();
    const el = document.getElementById('cfg-general-auto-launch');
    if (el && r?.enabled) el.checked = true;
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
})();

window.__pageHandlers['settings'] = async () => { await initSettings(); initUpdateCheck(); initExportBtn(); initClearContactsBtn(); };

// ── 数据导出 ──────────────────────────────────────────────────────────────
function initExportBtn() {
  const btn = document.getElementById('btn-export-data');
  const result = document.getElementById('export-result');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    result.textContent = '导出中...';
    try {
      const r = await window.electronAPI.exportData();
      if (r.ok) {
        result.innerHTML = `${lucide('check-circle',12)} 已保存到桌面`;
        result.style.color = 'var(--success)';
      } else {
        result.textContent = r.error || '导出失败';
        result.style.color = 'var(--danger)';
      }
    } catch (e) {
      result.textContent = '导出失败';
      result.style.color = 'var(--danger)';
    }
    btn.disabled = false;
  });
}

// ── 一键清除联系人 ──────────────────────────────────────────────────────────
function initClearContactsBtn() {
  const btn = document.getElementById('btn-clear-contacts');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', async () => {
    const contacts = await window.electronAPI.getContacts();
    if (!contacts.length) { showToast('联系人列表已为空', 'info'); return; }
    if (!await showConfirm(`确定清除全部 ${contacts.length} 个联系人？此操作不可撤销。`)) return;
    await window.electronAPI.deleteAllContacts();
    showToast(`已清除 ${contacts.length} 个联系人`, 'ok');
  });
}

// ── 检查更新 ──────────────────────────────────────────────────────────────
function initUpdateCheck() {
  const btn = document.getElementById('btn-check-update');
  const dlBtn = document.getElementById('btn-download-update');
  const restartBtn = document.getElementById('btn-restart-update');
  const result = document.getElementById('update-result');
  const prog = document.getElementById('update-progress');
  const progFill = document.getElementById('update-progress-fill');
  const speed = document.getElementById('update-speed');
  if (!btn || !result || btn._bound) return;
  btn._bound = true;

  let pendingVersion = '';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    result.innerHTML = `${lucide('loader-2',12,'spin')} 检查中...`;
    result.style.color = 'var(--text-secondary)';
    dlBtn.style.display = 'none';
    prog.style.display = 'none';
    try {
      const r = await window.electronAPI.checkUpdate();
      if (r.ok && r.data?.version) {
        pendingVersion = r.data.version;
        result.innerHTML = `${lucide('bell',12)} 发现新版本 <strong>v${r.data.version}</strong>`;
        result.style.color = 'var(--accent)';
        dlBtn.style.display = '';
      } else {
        result.innerHTML = `${lucide('check-circle',12)} 已是最新版本${r.currentVersion ? ' (v' + escapeHtml(r.currentVersion) + ')' : ''}`;
        result.style.color = 'var(--success)';
      }
    } catch (e) {
      result.innerHTML = `${lucide('x-circle',12)} ${escapeHtml(e.message || '检查失败')}`;
      result.style.color = 'var(--danger)';
    }
    btn.disabled = false;
  });

  dlBtn.addEventListener('click', async () => {
    dlBtn.disabled = true;
    dlBtn.textContent = '下载中...';
    prog.style.display = '';
    progFill.style.width = '0%';
    result.innerHTML = `${lucide('loader-2',12,'spin')} 准备下载...`;
    try {
      await window.electronAPI.downloadUpdate();
    } catch (e) {
      result.innerHTML = `${lucide('x-circle',12)} ${escapeHtml(e.message || '下载失败')}`;
      result.style.color = 'var(--danger)';
      dlBtn.style.display = 'none';
      prog.style.display = 'none';
    }
  });

  // 监听更新事件
  window.electronAPI.onUpdateAvailable((data) => {
    pendingVersion = data.version;
    result.innerHTML = `${lucide('bell',12)} 发现新版本 <strong>v${data.version}</strong>`;
    result.style.color = 'var(--accent)';
    dlBtn.style.display = '';
    prog.style.display = 'none';
    speed.textContent = '';
  });

  // 监听下载进度（含速率）
  window.electronAPI.onUpdateProgress((data) => {
    progFill.style.width = data.percent + '%';
    const sizeInfo = data.total ? `${data.transferred}/${data.total} MB` : `${data.transferred} MB`;
    speed.textContent = `${data.percent}% · ${data.speedMB} MB/s · ${sizeInfo}`;
    result.innerHTML = `${lucide('download',12)} 下载中...`;
    result.style.color = 'var(--accent)';
  });

  restartBtn.addEventListener('click', async () => {
    restartBtn.disabled = true;
    restartBtn.textContent = '重启中...';
    await window.electronAPI.installUpdate();
  });

  window.electronAPI.onUpdateDownloaded((data) => {
    result.innerHTML = `${lucide('check-circle',12)} v${data.version} 已下载`;
    result.style.color = 'var(--success)';
    dlBtn.style.display = 'none';
    restartBtn.style.display = '';
    prog.style.display = 'none';
    speed.textContent = '';
  });
}

// ── 右侧大纲导航 ──────────────────────────────────────────────
const SETTINGS_NAV = [
  { id: 'sec-general', label: '通用' },
  { id: 'sec-mail', label: '邮件发送' },
  { id: 'sec-api', label: 'API 与服务' },
  { id: 'sec-advanced', label: '高级' },
];

function buildSettingsNav() {
  const nav = document.getElementById('settings-nav');
  if (!nav) return;
  nav.innerHTML = SETTINGS_NAV.map(s =>
      `<div class="settings-nav-item" data-target="${s.id}">
        <span class="settings-nav-label">${s.label}</span>
        <span class="settings-nav-dot"></span>
      </div>`
    ).join('');
  nav.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const target = document.getElementById(item.dataset.target);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // 闪烁高亮效果
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1200);
    });
  });
}

let _settingsScrollTimer = 0;
function onSettingsScroll() {
  clearTimeout(_settingsScrollTimer);
  _settingsScrollTimer = setTimeout(() => {
    const markers = document.querySelectorAll('.settings-nav-item');
    const sections = SETTINGS_NAV.map(s => document.getElementById(s.id)).filter(Boolean);
    if (!sections.length) return;
    let active = sections[0].id;
    for (const sec of sections) {
      const top = sec.getBoundingClientRect().top;
      if (top < window.innerHeight * 0.35) active = sec.id;
    }
    markers.forEach(m => m.classList.toggle('active', m.dataset.target === active));
  }, 60);
}

document.addEventListener('scroll', onSettingsScroll, { passive: true });

buildSettingsNav();
initAccountManager();

// ── 发信账号管理 ──────────────────────────────────────────────────────────
function initAccountManager() {
  const listEl = document.getElementById('account-list');
  const modal = document.getElementById('account-modal');
  if (!listEl || !modal) return;

  // 渲染账号列表
  async function render() {
    const result = await window.electronAPI.listAccounts();
    const accounts = result.data || [];
    if (!accounts.length) {
      listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px">暂无账号，点击下方按钮添加</div>';
    } else {
      listEl.innerHTML = accounts.map(a => {
        // 圆点：熔断=橙，失败=红，通过=绿，未测试=灰，停用=暗灰
        let dotClass = 'inactive';
        if (a.active) {
          if (a.fused) dotClass = 'fused';
          else if (!a._lastTest) dotClass = 'untested';
          else if (a._lastTest.ok) dotClass = 'active';
          else dotClass = 'failed';
        }
        const limitInfo = a.fused ? `⚡ 熔断中 · 冷却 ${a.cooldownMin} 分钟`
          : a.active ? `今日 ${a.todaySent || 0}/${a.dailyLimit || 500}`
          : '已停用';
        return `<div class="account-item" data-id="${a.id}">
          <span class="acct-dot ${dotClass}"></span>
          <div class="acct-info">
            <div class="acct-name">${escapeHtml(a.label)}</div>
            <div class="acct-detail">${escapeHtml(a.smtp?.user)} · ${escapeHtml(a.smtp?.host)}</div>
            <div class="acct-meta">${escapeHtml(limitInfo)}</div>
          </div>
          <button class="acct-action" data-action="edit" data-id="${a.id}" title="编辑">${lucide('pencil',12)}</button>
          <button class="acct-action" data-action="toggle" data-id="${a.id}" title="${a.active?'停用':'启用'}">${a.active ? lucide('pause',12) : lucide('play',12)}</button>
          <button class="acct-action acct-delete" data-action="delete" data-id="${a.id}" title="删除">${lucide('trash-2',12)}</button>
        </div>`;
      }).join('');
    }
    // 事件委托：只绑一次，后续 innerHTML 重建不需要重新绑
    if (!listEl._actionsBound) {
      listEl._actionsBound = true;
      listEl.addEventListener("click", async (e) => {
        const btn = e.target.closest(".acct-action");
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === "edit") openEditor(id);
        else if (action === "toggle") { await window.electronAPI.toggleAccount(id); render(); }
        else if (action === "delete") { if (await showConfirm("确定删除该账号？")) { await window.electronAPI.deleteAccount(id); render(); } }
      });
    }
  }

  // IMAP 自动推导
  function autoDeriveImap(smtpHost) {
    return (smtpHost || '')
      .replace(/^smtp\./i, 'imap.').replace(/^mail\./i, 'imap.');
  }

  // 打开编辑框
  let _openingEditor = false;
  async function openEditor(id) {
    if (_openingEditor) return; // 防重入：上一次还没打开完成
    _openingEditor = true;
    const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v; };
    const setChk = (elId, v) => { const el = document.getElementById(elId); if (el) el.checked = v; };
    try {
    setVal('acct-edit-id', id || '');
    // 清空 IMAP 字段
    ['acct-imap-host','acct-imap-port','acct-imap-user','acct-imap-pass'].forEach(f => setVal(f, ''));
    if (id) {
      const result = await window.electronAPI.listAccounts();
      const acc = (result.data || []).find(a => a.id === id);
      if (acc) {
        setVal('acct-label', acc.label || '');
        setVal('acct-host', acc.smtp?.host || '');
        setVal('acct-port', acc.smtp?.port || 465);
        setVal('acct-secure', acc.smtp?.secure !== false ? 'true' : 'false');
        setVal('acct-user', acc.smtp?.user || '');
        setVal('acct-pass', acc.smtp?.pass || '');
        setVal('acct-limit', acc.dailyLimit || 500);
        setChk('acct-active', acc.active !== false);
        // 已有 IMAP 配置则回填
        if (acc.imap) {
          setVal('acct-imap-host', acc.imap.host || '');
          setVal('acct-imap-port', acc.imap.port || 993);
          setVal('acct-imap-user', acc.imap.user || '');
          setVal('acct-imap-pass', acc.imap.pass || '');
        }
      }
    } else {
      // 新账号：清空表单
      ['acct-label','acct-host','acct-port','acct-user','acct-pass','acct-limit'].forEach(f => {
        setVal(f, f === 'acct-port' ? '465' : f === 'acct-limit' ? '100' : '');
      });
      setVal('acct-secure', 'true');
      setChk('acct-active', true);
    }
    const tr = document.getElementById('acct-test-result');
    if (tr) { tr.className = ''; tr.innerHTML = ''; }
    // 专属签名链接（仅编辑已有账号时显示）
    const sigLink = document.getElementById('acct-sig-link');
    if (sigLink) {
      if (id) {
        sigLink.style.display = '';
        sigLink.onclick = () => {
          closeEditor();
          S._sigTargetAccount = id;
          document.querySelector('.nav-sub[data-page="signature"]')?.click();
        };
      } else {
        sigLink.style.display = 'none';
      }
    }
    // ponytail: missing 仅开发调试用，客户端静默降级
    modal.style.display = 'flex';
    } catch (e) {
      showToast('编辑失败: ' + (e.message || ''), 'error');
    } finally {
      _openingEditor = false;
    }
  }

  function closeEditor() { modal.style.display = 'none'; }

  // 收集表单
  // ponytail: 安全取值 — 客户端 DOM 可能未就绪，所有 getElementById 加兜底
  const $ = (id, fallback) => { const el = document.getElementById(id); return el ? el.value : fallback; };
  const $$ = (id, fallback) => { const el = document.getElementById(id); return el ? el.checked : fallback; };

  function collectAccount() {
    const smtpHost = $('acct-host', '').trim();
    const smtpUser = $('acct-user', '').trim();
    const smtpPass = $('acct-pass', '');
    const imapHost = $('acct-imap-host', '').trim() || autoDeriveImap(smtpHost);
    const imapUser = $('acct-imap-user', '').trim() || smtpUser;
    const imapPass = $('acct-imap-pass', '') || smtpPass;
    const imapPort = parseInt($('acct-imap-port', '993')) || 993;

    const account = {
      label: $('acct-label', '').trim(),
      smtp: {
        host: smtpHost,
        port: parseInt($('acct-port', '465')) || 465,
        secure: $('acct-secure', 'true') === 'true',
        user: smtpUser,
        pass: smtpPass,
      },
      dailyLimit: parseInt($('acct-limit', '100')) || 500,
      active: $$('acct-active', true),
    };

    // 有 IMAP 信息时附加
    if (imapHost) {
      account.imap = { host: imapHost, port: imapPort, user: imapUser, pass: imapPass };
    }
    return account;
  }

  // 事件绑定
  document.getElementById('btn-add-account')?.addEventListener('click', () => openEditor(null));
  document.getElementById('btn-acct-cancel')?.addEventListener('click', closeEditor);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeEditor(); });

  document.getElementById('btn-acct-save')?.addEventListener('click', async () => {
    const account = collectAccount();
    if (!account.smtp.host || !account.smtp.user) {
      showAlert('服务器地址和邮箱地址不能为空'); return;
    }
    const btn = document.getElementById('btn-acct-save');
    btn.disabled = true;
    try {
      const id = $('acct-edit-id', '');
      let savedId = id;
      if (id) {
        await window.electronAPI.updateAccount(id, account);
      } else {
        const r = await window.electronAPI.addAccount(account);
        savedId = r.data?.id || '';
      }
      // 保存后自动测试连通性
      if (savedId) {
        try {
          const tr = await window.electronAPI.testAccount(account);
          await window.electronAPI.updateAccount(savedId, {
            _lastTest: { ok: tr.ok, at: new Date().toISOString(), error: tr.error || '' }
          });
        } catch { /* 渲染层降级：操作失败不影响 UI */ }
      }
      closeEditor();
      render();
    } catch (e) {
      showAlert('保存失败: ' + (e.message || '未知错误'));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-acct-test')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('acct-test-result');
    const btn = document.getElementById('btn-acct-test');
    resultEl.className = 'acct-test-status';
    resultEl.innerHTML = `${lucide('loader-2',12,'spin')} 测试中...`;
    btn.disabled = true;
    const account = collectAccount();
    if (!account.smtp.host || !account.smtp.user) {
      resultEl.className = 'acct-test-status fail';
      resultEl.innerHTML = `${lucide('x-circle',12)} 请先填写服务器地址和邮箱`;
      btn.disabled = false; return;
    }
    try {
      const r = await window.electronAPI.testAccount(account);
      resultEl.className = r.ok ? 'acct-test-status ok' : 'acct-test-status fail';
      resultEl.innerHTML = r.ok
        ? `${lucide('check-circle',12)} 连接成功`
        : `${lucide('x-circle',12)} ${escapeHtml(r.error || '连接失败')}`;
      // 将测试结果写入已有账号（编辑模式）
      const editId = document.getElementById('acct-edit-id').value;
      if (editId) {
        await window.electronAPI.updateAccount(editId, {
          _lastTest: { ok: r.ok, at: new Date().toISOString(), error: r.error || '' }
        });
        render();
      }
    } catch (e) {
      resultEl.className = 'acct-test-status fail';
      resultEl.innerHTML = `${lucide('x-circle',12)} ${escapeHtml(e.message)}`;
    }
    btn.disabled = false;
  });

  // IMAP 连通性测试
  document.getElementById('btn-acct-imap-test')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('acct-imap-result');
    const btn = document.getElementById('btn-acct-imap-test');
    if (!resultEl || !btn) return;
    const host = document.getElementById('acct-imap-host')?.value?.trim();
    const user = document.getElementById('acct-imap-user')?.value?.trim();
    const pass = document.getElementById('acct-imap-pass')?.value;
    if (!host || !user) {
      resultEl.className = 'acct-test-status fail';
      resultEl.innerHTML = `${lucide('x-circle',12)} 请先填写 IMAP 服务器和邮箱`;
      return;
    }
    resultEl.className = 'acct-test-status';
    resultEl.innerHTML = `${lucide('loader-2',12,'spin')} 测试中...`;
    btn.disabled = true;
    try {
      const port = parseInt(document.getElementById('acct-imap-port')?.value) || 993;
      const r = await window.electronAPI.testImap({ host, port, user, pass });
      resultEl.className = r.ok ? 'acct-test-status ok' : 'acct-test-status fail';
      resultEl.innerHTML = r.ok
        ? `${lucide('check-circle',12)} IMAP 连接成功`
        : `${lucide('x-circle',12)} ${escapeHtml(r.error || '连接失败')}`;
    } catch (e) {
      resultEl.className = 'acct-test-status fail';
      resultEl.innerHTML = `${lucide('x-circle',12)} ${escapeHtml(e.message)}`;
    }
    btn.disabled = false;
  });

// ── 原有 SMTP 测试的结束标记（以下无更多按钮绑定）

  // SMTP 服务器变动时自动推导 IMAP 服务器
  document.getElementById('acct-host')?.addEventListener('input', function() {
    const imapEl = document.getElementById('acct-imap-host');
    if (imapEl && !imapEl.dataset.manual) {
      imapEl.value = autoDeriveImap(this.value.trim());
      imapEl.placeholder = autoDeriveImap(this.value.trim());
    }
  });
  document.getElementById('acct-imap-host')?.addEventListener('input', function() {
    this.dataset.manual = '1'; // 用户手动修改后不再自动推导
  });

  // 账号编辑框输入框也覆盖式
  document.querySelectorAll('#account-modal input').forEach(el => {
    el.addEventListener('focus', () => el.select());
  });

  // 注册页面 handler：切换到设置页时刷新列表 + 确保按钮事件绑定
  const origHandler = window.__pageHandlers['settings'];
  window.__pageHandlers['settings'] = async () => {
    if (origHandler) await origHandler();
    // ponytail: 每次切到设置页重新绑定添加按钮，防止模块加载时序导致漏绑
    const addBtn = document.getElementById('btn-add-account');
    if (addBtn && !addBtn._bound) { addBtn._bound = true; addBtn.addEventListener('click', () => openEditor(null)); }
    render();
  };
}
