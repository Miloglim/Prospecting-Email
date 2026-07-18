import { initIcons, initNavigation, loadDashboard } from './modules/shared.js';
import { init as initDashboardEditor, syncCards } from './modules/dashboard-editor.js';
import './modules/templates.js';
import './modules/workshop.js';
import './modules/contacts.js';
import './modules/backcheck.js';
import './modules/send-compose.js';
import './modules/send-queue.js';
import './modules/send-history.js';
// import './modules/discover.js';
import './modules/settings.js';
import './modules/inbox.js';
import './modules/crm-pipeline.js';
// import { initAutoSend, teardownAutoSend } from './modules/auto-send.js';
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
  } catch { /* 渲染层降级：操作失败不影响 UI */ }

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
// 预加载联系人数据到内存，避免切页时等待
(async () => {
  try {
    const r = await window.electronAPI.getContacts();
    const data = Array.isArray(r) ? r : (r?.data || []);
    if (data.length) window.S.contactsData = data;
  } catch { /* 预加载失败不影响启动 */ }
})();
setTimeout(() => initDashboardEditor(), 200);  // 等 DOM 稳定后初始化布局编辑器

// ── 全局更新检测 + 右下角通知卡片 ──────────────────────────────
(function initUpdateToast() {
  const toast = document.getElementById('update-toast');
  const title = document.getElementById('update-toast-title');
  const body = document.getElementById('update-toast-body');
  const dlBtn = document.getElementById('update-toast-dl');
  const laterBtn = document.getElementById('update-toast-later');
  const dismiss = document.getElementById('update-toast-dismiss');
  const prog = document.getElementById('update-toast-progress');
  const progFill = document.getElementById('update-toast-progress-fill');
  if (!toast || !dlBtn) return;

  let pendingVersion = '';

  // 监听新版本
  window.electronAPI.onUpdateAvailable((data) => {
    pendingVersion = data.version || '';
    title.textContent = '发现新版本';
    body.textContent = `v${pendingVersion} 已发布，是否立即更新？`;
    dlBtn.textContent = '下载更新';
    dlBtn.style.display = '';
    laterBtn.style.display = '';
    dlBtn.disabled = false;
    prog.style.display = 'none';
    toast.style.display = 'block';
  });

  // 下载进度
  window.electronAPI.onUpdateProgress((data) => {
    prog.style.display = '';
    progFill.style.width = Math.min(100, data.percent || 0) + '%';
    body.textContent = `下载中 ${data.percent || 0}% · ${data.speedMB || '—'} MB/s`;
    dlBtn.textContent = '下载中...';
    dlBtn.disabled = true;
  });

  // 下载完成
  window.electronAPI.onUpdateDownloaded((data) => {
    title.textContent = '更新就绪';
    body.textContent = `v${data.version || pendingVersion} 已下载，重启后生效`;
    dlBtn.textContent = '重启安装';
    dlBtn.style.display = '';
    dlBtn.disabled = false;
    laterBtn.style.display = 'none';
    prog.style.display = 'none';
    dlBtn.onclick = () => window.electronAPI.installUpdate();
  });

  // 下载
  dlBtn.addEventListener('click', () => {
    window.electronAPI.downloadUpdate().catch(() => {
      body.textContent = '下载失败，请稍后重试';
      dlBtn.textContent = '重试';
      dlBtn.disabled = false;
    });
  });

  // 稍后/关闭
  function hideToast() { toast.style.display = 'none'; }
  laterBtn.addEventListener('click', hideToast);
  dismiss.addEventListener('click', hideToast);
})();

// ── 新手向导 ──────────────────────────────────────────────
let _onboardingStep = 1;
let _obTransitioning = false;
let _shiftHeld = false;
let _obTemplateChoice = 'adaptive';  // 默认自适应
document.addEventListener('keydown', e => { if (e.key === 'Shift') _shiftHeld = true; });
document.addEventListener('keyup', e => { if (e.key === 'Shift') _shiftHeld = false; });

async function checkOnboarding() {
  try {
    const cfg = await window.electronAPI.loadConfig();
    // 有账号就不弹（不论是否停用）
    if (cfg?.smtpAccounts?.length > 0) return;
    // 旧格式兼容
    if (cfg?.smtp?.host && cfg?.smtp?.user && cfg?.smtp?.pass) return;
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
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
  const steps = [1, 2, 3, 4].map(i => document.getElementById('ob-step-' + i));
  const done = document.getElementById('ob-step-done');
  const dots = document.querySelectorAll('.ob-dot');

  if (instant) {
    steps.forEach(s => { if (s) { s.style.display = 'none'; s.classList.remove('entering','leaving'); } });
    if (done) { done.style.display = 'none'; done.classList.remove('entering','leaving'); }
  }

  // 目标步骤
  const targetId = _onboardingStep >= 5 ? 'ob-step-done' : 'ob-step-' + _onboardingStep;
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
  const activeIdx = _onboardingStep >= 5 ? 4 : _onboardingStep;
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
    // 默认高亮自适应卡片
    setTimeout(() => {
      const card = document.getElementById('ob-tpl-adaptive');
      if (card) card.style.borderColor = 'var(--accent)';
    }, 50);
    return;
  }
  if (_onboardingStep === 4) {
    // 保存模板选择
    const cfg = (await window.electronAPI.loadConfig()) || {};
    if (!cfg.template) cfg.template = {};
    cfg.template.mode = _obTemplateChoice;
    try { await window.electronAPI.saveConfig(cfg); } catch { /* 渲染层降级：操作失败不影响 UI */ }
    _onboardingStep = 5; updateObStep();
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
// 模板选择卡片点击高亮
['ob-tpl-adaptive','ob-tpl-user'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', function() {
    _obTemplateChoice = id === 'ob-tpl-adaptive' ? 'adaptive' : 'general';
    document.querySelectorAll('.ob-choice-card').forEach(c => c.style.borderColor = 'var(--border)');
    this.style.borderColor = 'var(--accent)';
  });
});

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
  } catch { /* 渲染层降级：操作失败不影响 UI */ }
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
    // 弹出新手教程（可拖动）
    const overlay = document.getElementById('tutorial-overlay');
    const card = document.getElementById('tutorial-card');
    if (overlay && card) {
      overlay.style.display = 'flex';
      document.getElementById('tutorial-dismiss')?.addEventListener('click', () => {
        overlay.style.display = 'none';
      });
      // 拖拽
      const handle = document.getElementById('tut-handle');
      if (handle) {
        let dragging = false, startX, startY, origX, origY;
        handle.addEventListener('mousedown', (e) => {
          dragging = true; startX = e.clientX; startY = e.clientY;
          const r = card.getBoundingClientRect();
          origX = r.left; origY = r.top;
          card.style.transition = 'none';
          e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
          if (!dragging) return;
          card.style.position = 'fixed';
          card.style.left = (origX + e.clientX - startX) + 'px';
          card.style.top = (origY + e.clientY - startY) + 'px';
          card.style.transform = 'none';
        });
        window.addEventListener('mouseup', () => {
          if (dragging) { dragging = false; card.style.transition = ''; }
        });
      }
    }
  }, 2500);
};

async function saveOnboardingConfig() {
  const cfg = (await window.electronAPI.loadConfig()) || {};
  // ponytail: 先 saveConfig 再 addAccount，避免 saveConfig 用旧 cfg 覆盖 addAccount 刚写入的 smtpAccounts
  // 两者操作同一个文件 send/config.json
  const smtpHost = document.getElementById('ob-smtp-host')?.value.trim();
  const smtpUser = document.getElementById('ob-smtp-user')?.value.trim();

  // 发信人（先存，不依赖 smtpAccounts）
  const senderName = document.getElementById('ob-sender-name')?.value.trim();
  const senderBody = document.getElementById('ob-sender-body')?.value.trim();
  if (senderName) { if (!cfg.sender) cfg.sender = {}; cfg.sender.name = senderName; }
  if (senderBody) { if (!cfg.sender) cfg.sender = {}; cfg.sender.bodyName = senderBody; }
  if (!cfg.sender?.email && smtpUser) { cfg.sender.email = smtpUser; }

  try { await window.electronAPI.saveConfig(cfg); } catch { /* 渲染层降级：操作失败不影响 UI */ }

  // SMTP：在 saveConfig 之后保存账号，避免被覆盖
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
  try { await window.electronAPI.saveConfig(cfg); } catch { /* 渲染层降级：操作失败不影响 UI */ }
}
