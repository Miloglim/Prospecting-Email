// ── 账号管理 IPC ────────────────────────────────────────────────────────────
// 只做路由：读取/保存配置 + 调用 account-manager 业务逻辑
const { Log } = require('../core/logger');

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');
const acct = require('../services/account-manager');

const CONFIG_PATH = path.join(APP_ROOT, 'send', 'config.json');

function _readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* 文件损坏时降级为空配置 */ }
  return {};
}

function _writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function register(ipcMain) {
  // ── 启动时迁移 ──
  const config = _readConfig();
  const result = acct.migrateFromLegacy(config);
  if (result.migrated) {
    _writeConfig(result.config);
    Log.info('账号', '旧 SMTP 配置已自动迁移到多账号');
  }

  // ── 列表 ──
  ipcMain.handle('account:list', async () => {
    const cfg = _readConfig();
    return { ok: true, data: cfg.smtpAccounts || [] };
  });

  // ── 添加 ──
  ipcMain.handle('account:add', async (_e, account) => {
    const valid = acct.validateAccount(account);
    if (!valid.ok) return { ok: false, error: valid.error };

    const cfg = _readConfig();
    if (!cfg.smtpAccounts) cfg.smtpAccounts = [];

    const newAccount = {
      id: acct.generateAccountId(),
      label: account.label || `账号 ${cfg.smtpAccounts.length + 1}`,
      active: account.active !== false,
      dailyLimit: account.dailyLimit || cfg.schedule?.max_per_day || 500,
      smtp: { ...account.smtp },
      imap: account.imap ? { ...account.imap } : undefined,
    };

    cfg.smtpAccounts.push(newAccount);
    _writeConfig(cfg);
    Log.info('账号', ` 添加: ${newAccount.smtp?.user} @ ${newAccount.smtp?.host} (${newAccount.id})`);
    return { ok: true, data: newAccount };
  });

  // ── 更新 ──
  ipcMain.handle('account:update', async (_e, id, updates) => {
    const cfg = _readConfig();
    const idx = (cfg.smtpAccounts || []).findIndex(a => a.id === id);
    if (idx < 0) return { ok: false, error: '账号不存在' };

    const existing = cfg.smtpAccounts[idx];
    cfg.smtpAccounts[idx] = {
      ...existing,
      ...updates,
      id: existing.id, // 不允许改 id
      smtp: updates.smtp ? { ...existing.smtp, ...updates.smtp } : existing.smtp,
      imap: updates.imap ? { ...existing.imap, ...updates.imap } : existing.imap,
    };
    _writeConfig(cfg);
    return { ok: true, data: cfg.smtpAccounts[idx] };
  });

  // ── 删除 ──
  ipcMain.handle('account:delete', async (_e, id) => {
    const cfg = _readConfig();
    const accounts = cfg.smtpAccounts || [];
    if (accounts.length <= 1) {
      return { ok: false, error: '至少保留一个发信账号' };
    }
    cfg.smtpAccounts = accounts.filter(a => a.id !== id);
    _writeConfig(cfg);
    return { ok: true };
  });

  // ── 启用/停用 ──
  ipcMain.handle('account:toggle', async (_e, id) => {
    const cfg = _readConfig();
    const acc = (cfg.smtpAccounts || []).find(a => a.id === id);
    if (!acc) return { ok: false, error: '账号不存在' };
    acc.active = !acc.active;
    _writeConfig(cfg);
    return { ok: true, data: acc };
  });

  // ── 测试连接 ──
  ipcMain.handle('account:test', async (_e, account) => {
    try {
      const transporter = acct.createTransporter(account);
      await transporter.verify();
      transporter.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 发送状态 ──
  ipcMain.handle('account:status', async () => {
    const logPath = path.join(APP_ROOT, 'send', 'send-log.json');
    let dailyCounts = {}, accountStates = {};
    try {
      if (fs.existsSync(logPath)) {
        const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
          .toISOString().slice(0, 10);
        const logDate = log.last_date_beijing || '';
        dailyCounts = (logDate === today) ? (log.daily_counts || {}) : {};
        accountStates = log._accountStates || {};
      }
    } catch { /* 日志不存在或损坏 */ }

    const acctMgr = require('../services/account-manager');
    const cfg = _readConfig();
    const accounts = (cfg.smtpAccounts || []).map(a => {
      const st = accountStates[a.id] || {};
      const fused = acctMgr.isFused(a.id, accountStates);
      return {
        id: a.id,
        label: a.label,
        active: a.active,
        todaySent: dailyCounts[a.id] || 0,
        dailyLimit: a.dailyLimit || 500,
        fused,
        failures: st.failures || 0,
        cooldownMin: fused ? Math.round((st.cooldownMs || 0) / 60000) : 0,
      };
    });
    return { ok: true, data: accounts };
  });
}

module.exports = { register };
