import { initIcons, initNavigation, loadDashboard } from './modules/shared.js';
import './modules/templates.js';
import './modules/workshop.js';
import './modules/contacts.js';
import './modules/backcheck.js';
import './modules/send-compose.js';
import './modules/send-queue.js';
import './modules/send-history.js';
import './modules/discover.js';
import './modules/settings.js';
import './modules/bounces.js';
import './modules/replies.js';
import { initQueue } from './modules/send-queue.js';

document.getElementById('tb-minimize')?.addEventListener('click', () => window.electronAPI.windowMinimize());
document.getElementById('tb-maximize')?.addEventListener('click', () => window.electronAPI.windowMaximize());
document.getElementById('tb-close')?.addEventListener('click', () => window.electronAPI.windowClose());

initIcons();
initNavigation();

// 启动：仪表盘数据就绪后加载层淡出 + 主界面滑入
// 默认最少显示 1000ms，可在设置 → 通用 → 关闭加载动画 中跳过
(async () => {
  const loadStart = Date.now();
  await window.__pageHandlers['dashboard']?.();

  // 读取配置：用户可选择关闭加载动画
  let skipLoader = false;
  try {
    const cfg = await window.electronAPI.loadConfig();
    if (cfg?.general?.loaderAnimDisabled) skipLoader = true;
  } catch {}

  const elapsed = Date.now() - loadStart;
  const MIN_LOADER_MS = skipLoader ? 0 : 1000;
  const delay = Math.max(0, MIN_LOADER_MS - elapsed);

  const hideLoader = () => {
    const loader = document.getElementById('app-loader');
    if (loader) {
      loader.classList.add('hidden');
      document.body.classList.add('app-ready');
      setTimeout(() => loader.remove(), 550);
    }
    // 新手向导：SMTP 未配置时自动弹出
    setTimeout(() => checkOnboarding(), 100);
  };

  if (delay > 0) {
    setTimeout(hideLoader, delay);
  } else {
    hideLoader();
  }
})();
initQueue();  // 队列后台并行恢复

// ── 新手向导 ──────────────────────────────────────────────
let _onboardingStep = 1;
let _obTransitioning = false;
let _shiftHeld = false;
document.addEventListener('keydown', e => { if (e.key === 'Shift') _shiftHeld = true; });
document.addEventListener('keyup', e => { if (e.key === 'Shift') _shiftHeld = false; });

async function checkOnboarding() {
  try {
    const cfg = await window.electronAPI.loadConfig();
    // 有账号就不弹（不论是否停用）
    if (cfg?.smtpAccounts?.length > 0) return;
    // 旧格式兼容
    if (cfg?.smtp?.host && cfg?.smtp?.user && cfg?.smtp?.pass) return;
  } catch {}
  showOnboarding();
}

function showOnboarding() {
  const ob = document.getElementById('onboarding');
  if (!ob) return;
  _onboardingStep = 1; updateObStep(true);
  ob.style.display = 'flex';
  requestAnimationFrame(() => { requestAnimationFrame(() => ob.classList.add('show')); });
}

// Shift+点击版本号 → 强制打开新手向导（调试用，正式版也可触发）
document.getElementById('nav-version')?.addEventListener('click', function(e) {
  if (e.shiftKey) showOnboarding();
});

function hideOnboarding() {
  const ob = document.getElementById('onboarding');
  if (!ob) return;
  ob.classList.add('hide');
  ob.classList.remove('show');
  setTimeout(() => { ob.style.display = 'none'; ob.classList.remove('hide'); }, 600);
}

function updateObStep(instant) {
  const steps = [1, 2, 3].map(i => document.getElementById('ob-step-' + i));
  const done = document.getElementById('ob-step-done');
  const dots = document.querySelectorAll('.ob-dot');

  if (instant) {
    steps.forEach(s => { if (s) { s.style.display = 'none'; s.classList.remove('entering','leaving'); } });
    if (done) { done.style.display = 'none'; done.classList.remove('entering','leaving'); }
  }

  // 目标步骤
  const targetId = _onboardingStep >= 4 ? 'ob-step-done' : 'ob-step-' + _onboardingStep;
  const target = document.getElementById(targetId);

  // 隐藏所有，显示目标
  steps.forEach(s => { if (s && s !== target) { s.style.display = 'none'; s.classList.remove('entering','leaving'); } });
  if (done && done !== target) { done.style.display = 'none'; done.classList.remove('entering','leaving'); }

  if (target && target.style.display === 'none') {
    // 入场动画
    target.classList.add('entering');
    target.style.display = '';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        target.classList.remove('entering');
        target.classList.add('entering-done');
        setTimeout(() => target.classList.remove('entering-done'), 300);
      });
    });
  }

  // 进度条
  const activeIdx = _onboardingStep >= 4 ? 3 : _onboardingStep;
  dots.forEach(d => d.classList.toggle('active', parseInt(d.dataset.step) <= activeIdx));
}

window.onboardingBack = function() {
  if (_obTransitioning) return;
  if (_onboardingStep <= 1) return;
  _onboardingStep--;
  updateObStep();
};

window.onboardingNext = async function() {
  if (_obTransitioning) return;
  // 验证必填（Shift+点击跳过）
  if (_onboardingStep === 1 && !_shiftHeld) {
    const required = [
      { id: 'ob-smtp-host', label: 'SMTP 服务器' },
      { id: 'ob-smtp-user', label: '邮箱地址' },
      { id: 'ob-smtp-pass', label: '密码' },
    ];
    let ok = true;
    required.forEach(r => {
      const el = document.getElementById(r.id);
      if (!el || !el.value.trim()) {
        el.style.borderColor = 'var(--danger)';
        el.style.background = 'rgba(198,40,40,0.04)';
        el.placeholder = '请填写' + r.label;
        ok = false;
      } else {
        el.style.borderColor = '';
        el.style.background = '';
      }
    });
    if (!ok) return;
  }
  if (_onboardingStep === 2) {
    await saveOnboardingConfig();
    _onboardingStep = 3; updateObStep();
    return;
  }
  if (_onboardingStep === 3) {
    await saveGeneralConfig();
    _onboardingStep = 4; updateObStep();
    // 触发 Logo + 标题动画
    setTimeout(() => {
      const logo = document.getElementById('ob-logo');
      if (logo) { logo.classList.remove('animate'); void logo.offsetWidth; logo.classList.add('animate'); }
      const h2 = document.querySelector('#ob-step-done h2');
      if (h2) { h2.classList.remove('done'); void h2.offsetWidth; h2.classList.add('done'); }
    }, 50);
    return;
  }
  _onboardingStep++; updateObStep();
};

// 输入时清除错误状态
['ob-smtp-host','ob-smtp-user','ob-smtp-pass'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', function() {
    this.style.borderColor = '';
    this.style.background = '';
    this.placeholder = this.dataset.origPlaceholder || this.placeholder;
  });
});

window.onboardingSkip = function() { hideOnboarding(); };
window.onboardingFinish = async function() {
  const ob = document.getElementById('onboarding');
  if (!ob) return;

  // 对所有账号进行 SMTP 连通性测试，结果写入账号
  try {
    const accounts = await window.electronAPI.listAccounts();
    for (const acc of (accounts.data || [])) {
      if (!acc.active) continue;
      const r = await window.electronAPI.testAccount(acc);
      await window.electronAPI.updateAccount(acc.id, {
        _lastTest: { ok: r.ok, at: new Date().toISOString(), error: r.error || '' }
      }).catch(() => {});
    }
  } catch {}
  // 立即刷新仪表盘
  loadDashboard();

  // 阶段1: 0.1s 后卡片淡出 + 毛玻璃呈现 (0.6s)
  setTimeout(() => ob.classList.add('finishing'), 100);
  // 阶段2: 毛玻璃完成后整体淡出 (1.5s)
  setTimeout(() => ob.classList.add('fadeout'), 800);
  // 静默移除
  setTimeout(() => {
    ob.style.display = 'none';
    ob.classList.remove('finishing', 'fadeout', 'show');
  }, 2500);
};

async function saveOnboardingConfig() {
  const cfg = (await window.electronAPI.loadConfig()) || {};
  // SMTP：通过账号管理 API 保存
  const smtpHost = document.getElementById('ob-smtp-host')?.value.trim();
  const smtpUser = document.getElementById('ob-smtp-user')?.value.trim();
  if (smtpHost && smtpUser) {
    const account = {
      label: '默认账号',
      smtp: {
        host: smtpHost,
        port: parseInt(document.getElementById('ob-smtp-port')?.value) || 465,
        secure: document.getElementById('ob-smtp-secure')?.value !== 'false',
        user: smtpUser,
        pass: document.getElementById('ob-smtp-pass')?.value || '',
      },
      dailyLimit: cfg.schedule?.max_per_day || 500,
    };
    // 检查是否已存在相同邮箱的账号
    const existing = await window.electronAPI.listAccounts();
    const exists = (existing.data || []).some(a => a.smtp?.user === smtpUser);
    if (!exists) {
      await window.electronAPI.addAccount(account);
    }
  }
  // 发信人
  const senderName = document.getElementById('ob-sender-name')?.value.trim();
  const senderBody = document.getElementById('ob-sender-body')?.value.trim();
  if (senderName) { if (!cfg.sender) cfg.sender = {}; cfg.sender.name = senderName; }
  if (senderBody) { if (!cfg.sender) cfg.sender = {}; cfg.sender.bodyName = senderBody; }
  if (!cfg.sender?.email && smtpUser) { cfg.sender.email = smtpUser; }

  try { await window.electronAPI.saveConfig(cfg); } catch {}
}

async function saveGeneralConfig() {
  const cfg = (await window.electronAPI.loadConfig()) || {};
  const closeAction = document.getElementById('ob-close-action')?.value || 'tray';
  const autoLaunch = document.getElementById('ob-auto-launch')?.checked || false;
  if (!cfg.general) cfg.general = {};
  cfg.general.closeAction = closeAction;
  cfg.general.autoLaunch = autoLaunch;
  cfg.schedule = cfg.schedule || {};
  cfg.schedule.mode = 'batch';
  cfg.template = cfg.template || {};
  cfg.template.mode = 'adaptive';
  try { await window.electronAPI.saveConfig(cfg); } catch {}
}
