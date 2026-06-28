const S = window.S;
import { lucide,showAlert,showToast,escapeHtml,initIcons,showConfirm,deepMerge } from './shared.js';

// ===== 设置 ==========================================================
const CFG_KEYS = [
  { id: 'cfg-smtp-host', path: 'smtp.host' },
  { id: 'cfg-smtp-port', path: 'smtp.port' },
  { id: 'cfg-smtp-secure', path: 'smtp.secure', isBool: true },
  { id: 'cfg-smtp-user', path: 'smtp.user' },
  { id: 'cfg-smtp-pass', path: 'smtp.pass' },
  { id: 'cfg-sender-name', path: 'sender.name' },
  { id: 'cfg-sender-body-name', path: 'sender.bodyName' },
  { id: 'cfg-sender-email', path: 'sender.email' },
  { id: 'cfg-schedule-max', path: 'schedule.max_per_day' },
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
  { id: 'cfg-proxy-host', path: 'proxy.host' },
  { id: 'cfg-test-email', path: 'test.email' },
  { id: 'cfg-test-company', path: 'test.company' },
  { id: 'cfg-test-enabled', path: 'test.enabled', isBool: true },
  { id: 'cfg-feishu-url', path: 'feishu.url' },
  { id: 'cfg-imap-host', path: 'imap.host' },
  { id: 'cfg-imap-port', path: 'imap.port' },
  { id: 'cfg-imap-user', path: 'imap.user' },
  { id: 'cfg-imap-pass', path: 'imap.pass' },
  { id: 'cfg-backcheck-filter', path: 'backcheck.filterEnabled', isBool: true },
  { id: 'cfg-general-auto-launch', path: 'general.autoLaunch', isBool: true },
  { id: 'cfg-general-close-action', path: 'general.closeAction' },
  { id: 'cfg-general-theme', path: 'general.theme' },
];

export function loadSettingsIntoForm(config) {
  if (!config) return;
  // 关键字段默认值（防止空值被错误保存）
  const DEFAULTS = {
    'cfg-schedule-start': '09:00', 'cfg-schedule-end': '08:00',
    'cfg-schedule-max': '720', 'cfg-schedule-min-delay': '8', 'cfg-schedule-max-delay': '16',
    'cfg-schedule-company-delay-min': '900', 'cfg-schedule-company-delay-max': '1200',
    'cfg-schedule-single-min': '5', 'cfg-schedule-single-max': '10',
    'cfg-schedule-group-size': '25', 'cfg-smtp-port': '465',
    'cfg-schedule-template-rotate': '3',
    'cfg-schedule-batch-size': '12', 'cfg-schedule-batch-pause-min': '94',
    'cfg-schedule-batch-pause-max': '167',
    'cfg-schedule-batch-item-delay-min': '8', 'cfg-schedule-batch-item-delay-max': '16',
    'cfg-general-close-action': 'tray', 'cfg-general-theme': 'light',
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
  // 飞书 URL 加载时自动提取显示
  const url = config?.feishu?.url || '';
  if (url) {
    document.getElementById('cfg-feishu-base-extracted').value = url.match(/\/base\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    document.getElementById('cfg-feishu-table-extracted').value = url.match(/table[=\/]([a-zA-Z0-9_-]+)/)?.[1] || '';
  }
  // 退信自定义关键词
  const kw = config?.bounce?.keywords || [];
  const kwEl = document.getElementById('cfg-bounce-keywords');
  if (kwEl) kwEl.value = kw.join('\n');
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
  // 退信自定义关键词
  const kwEl = document.getElementById('cfg-bounce-keywords');
  if (kwEl) {
    const kw = kwEl.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!config.bounce) config.bounce = {};
    config.bounce.keywords = kw;
  }
  // IMAP 自动同步 SMTP：如果退信检查未配置，使用 SMTP 邮箱密码
  if (config.smtp?.user && !config.imap?.user) {
    if (!config.imap) config.imap = {};
    config.imap.user = config.smtp.user;
    config.imap.pass = config.smtp.pass || config.imap.pass;
    if (!config.imap.host) {
      config.imap.host = (config.smtp.host || '')
        .replace(/^smtp\./i, 'imap.').replace(/^mail\./i, 'imap.');
    }
    if (!config.imap.port) config.imap.port = 993;
    // 回填 UI
    const imapUserEl = document.getElementById('cfg-imap-user');
    const imapPassEl = document.getElementById('cfg-imap-pass');
    const imapHostEl = document.getElementById('cfg-imap-host');
    const imapPortEl = document.getElementById('cfg-imap-port');
    if (imapUserEl && !imapUserEl.value) imapUserEl.value = config.imap.user;
    if (imapPassEl && !imapPassEl.value) imapPassEl.value = config.imap.pass || '';
    if (imapHostEl && !imapHostEl.value) imapHostEl.value = config.imap.host;
    if (imapPortEl && !imapPortEl.value) imapPortEl.value = config.imap.port;
  }

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


// 飞书 URL 自动提取
document.getElementById('cfg-feishu-url')?.addEventListener('input', (e) => {
  const url = e.target.value;
  const base = url.match(/\/base\/([a-zA-Z0-9_-]+)/)?.[1] || '';
  const table = url.match(/table[=\/]([a-zA-Z0-9_-]+)/)?.[1] || '';
  document.getElementById('cfg-feishu-base-extracted').value = base;
  document.getElementById('cfg-feishu-table-extracted').value = table;
});

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
export function updateScheduleEstimate() {
  const el = document.getElementById('cfg-schedule-estimate');
  if (!el) return;
  // getNumOr: 区分「用户填0」和「留空」— 留空用默认值，0 就是 0
  const getNumOr = (id, fallback) => {
    const input = document.getElementById(id);
    if (!input || input.value.trim() === '') return fallback;
    const v = Number(input.value);
    return isNaN(v) ? fallback : v;
  };
  const max = getNumOr('cfg-schedule-max', 500);
  if (max <= 0) { el.innerHTML = ''; return; }
  const mode = document.getElementById('cfg-schedule-mode')?.value || 'batch';

  let totalSec, detail;
  if (mode === 'batch') {
    const batchSize = getNumOr('cfg-schedule-batch-size', 10);
    const pauseMin = getNumOr('cfg-schedule-batch-pause-min', 150);
    const pauseMax = getNumOr('cfg-schedule-batch-pause-max', 210);
    const avgPause = (pauseMin + pauseMax) / 2;
    const batches = Math.ceil(max / batchSize);
    totalSec = Math.round((batches - 1) * avgPause);
    detail = `${batches} 批 × ${batchSize} 封，批间暂停 ${pauseMin}~${pauseMax}s`;
  } else {
    const avgItemDelay = (getNumOr('cfg-schedule-min-delay', 10) + getNumOr('cfg-schedule-max-delay', 15)) / 2;
    const singleMin = getNumOr('cfg-schedule-single-min', 60);
    const singleMax = getNumOr('cfg-schedule-single-max', 180);
    const avgSingleDelay = (singleMin + singleMax) / 2;
    const companies = Math.ceil(max / 2);
    totalSec = Math.round(max * avgItemDelay + (companies - 1) * avgSingleDelay);
    detail = `${companies} 家公司（按每公司 2 人），切换间 ${singleMin}s~${singleMax}s`;
  }

  if (totalSec <= 0) { el.innerHTML = ''; return; }
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60);
  const timeStr = h > 0 ? `${h} 时 ${m} 分` : `${m} 分`;
  const perHour = totalSec > 0 ? Math.round(max / (totalSec / 3600)) : 0;
  el.innerHTML = `满额 ${max} 封 ≈ <strong>${timeStr}</strong> · 约 <strong>${perHour} 封/时</strong> <span style="color:#999">（${detail}）</span>`;
}
['cfg-schedule-mode','cfg-schedule-max','cfg-schedule-min-delay','cfg-schedule-max-delay','cfg-schedule-company-delay-min','cfg-schedule-company-delay-max','cfg-schedule-group-size','cfg-schedule-single-min','cfg-schedule-single-max','cfg-schedule-batch-size','cfg-schedule-batch-pause-min','cfg-schedule-batch-pause-max'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === 'cfg-schedule-mode' ? 'change' : 'input', updateScheduleEstimate);
});

// 开机自启：额外调用系统级设置
document.getElementById('cfg-general-auto-launch')?.addEventListener('change', async (e) => {
  try { await window.electronAPI.setAutoLaunch(e.target.checked); } catch {}
});

// 主题切换：即时生效 + 持久化
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'light');
  try { localStorage.setItem('app-theme', JSON.stringify(theme || 'light')); } catch {}
}
document.getElementById('cfg-general-theme')?.addEventListener('change', (e) => {
  applyTheme(e.target.value);
});

// 初始化时回读系统自启状态 + 主题
(async () => {
  try {
    const r = await window.electronAPI.getAutoLaunch();
    const el = document.getElementById('cfg-general-auto-launch');
    if (el && r?.enabled) el.checked = true;
  } catch {}
  // 主题从 config 加载后应用，如果没有配置则默认浅色
  try {
    const cfg = await window.electronAPI.loadConfig();
    const theme = cfg?.general?.theme || 'light';
    applyTheme(theme);
    const themeEl = document.getElementById('cfg-general-theme');
    if (themeEl) themeEl.value = theme;
  } catch {}
})();

// IMAP 连接测试
document.getElementById('cfg-imap-test')?.addEventListener('click', async () => {
  const btn = document.getElementById('cfg-imap-test');
  const result = document.getElementById('cfg-imap-result');
  btn.disabled = true; btn.textContent = '连接中...';
  result.textContent = ''; result.style.color = '';
  const cfg = {
    host: document.getElementById('cfg-imap-host')?.value || '',
    port: Number(document.getElementById('cfg-imap-port')?.value) || 993,
    user: document.getElementById('cfg-imap-user')?.value || '',
    pass: document.getElementById('cfg-imap-pass')?.value || '',
  };
  try {
    const r = await window.electronAPI.testImap(cfg);
    result.textContent = r.ok ? '✅ ' + r.message : '❌ ' + (r.error || '连接失败');
    result.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
  } catch (e) {
    result.textContent = '❌ ' + e.message;
    result.style.color = 'var(--danger)';
  }
  btn.disabled = false; btn.textContent = '测试连接';
});

window.__pageHandlers['settings'] = initSettings;

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
