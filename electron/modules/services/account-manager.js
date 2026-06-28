// ── 账号管理服务 ────────────────────────────────────────────────────────────
// 纯业务逻辑，不碰 fs / Electron / IPC
// deps: nodemailer（由调用方传入或 lazy require）

const crypto = require('crypto');

// ── ID 生成 ──────────────────────────────────────────────────────────────────
function generateAccountId() {
  return 'acc_' + crypto.randomBytes(4).toString('hex');
}

// ── 验证 ─────────────────────────────────────────────────────────────────────
function validateAccount(account) {
  if (!account?.smtp?.host) return { ok: false, error: 'SMTP 服务器地址不能为空' };
  if (!account?.smtp?.user) return { ok: false, error: '邮箱地址不能为空' };
  return { ok: true };
}

// ── 旧配置静默迁移（幂等）────────────────────────────────────────────────────
// 入参：config object（已 parse）
// 返回：{ migrated: bool, config } — 调用方负责写回磁盘
function migrateFromLegacy(config) {
  if (!config) return { migrated: false, config };

  // 已迁移，跳过
  if (Array.isArray(config.smtpAccounts) && config.smtpAccounts.length > 0) {
    return { migrated: false, config };
  }

  // 无旧 smtp 配置，跳过
  if (!config.smtp?.host && !config.smtp?.user) {
    return { migrated: false, config };
  }

  // 迁移
  const account = {
    id: generateAccountId(),
    label: '默认账号',
    active: true,
    dailyLimit: config.schedule?.max_per_day || 500,
    smtp: {
      host: config.smtp.host || '',
      port: config.smtp.port || 465,
      secure: config.smtp.secure !== false,
      user: config.smtp.user || '',
      pass: config.smtp.pass || '',
    },
    imap: config.imap ? { ...config.imap } : undefined,
  };

  config.smtpAccounts = [account];
  delete config.smtp;
  if (config.imap) delete config.imap;

  return { migrated: true, config };
}

// ── 熔断常量 ─────────────────────────────────────────────────────────────────
const FUSE_THRESHOLD = 3;          // 连续失败 3 次 → 熔断
const FUSE_COOLDOWN_BASE = 15 * 60 * 1000;  // 基础冷却 15 分钟
const FUSE_COOLDOWN_MAX = 60 * 60 * 1000;   // 最大冷却 1 小时

// ── 账号运行时状态（存储在 send-log.json 的 _accountStates 字段）────────────
// 格式：{ [accountId]: { failures, fused, fusedAt, cooldownMs } }

function _ensureState(states, id) {
  if (!states[id]) states[id] = { failures: 0, fused: false, fusedAt: 0, cooldownMs: 0 };
  return states[id];
}

// 检查是否正在熔断中（冷却未结束）
function isFused(accountId, states) {
  const s = states?.[accountId];
  if (!s?.fused) return false;
  if (Date.now() - s.fusedAt >= s.cooldownMs) {
    // 冷却结束 → 进入半开状态（允许试一次），清除熔断标记
    s.fused = false;
    return false;
  }
  return true;
}

// 发送成功 → 清零
function recordSuccess(accountId, states) {
  if (!states) return;
  const s = _ensureState(states, accountId);
  s.failures = 0;
  s.fused = false;
  s.fusedAt = 0;
  s.cooldownMs = 0;
}

// 发送失败 → 累加，达阈值熔断
function recordFailure(accountId, states, isRateLimit) {
  if (!states) return;
  const s = _ensureState(states, accountId);
  if (isRateLimit) {
    // 速率限制立即熔断
    s.failures = FUSE_THRESHOLD;
  } else {
    s.failures++;
  }
  if (s.failures >= FUSE_THRESHOLD) {
    s.fused = true;
    s.fusedAt = Date.now();
    // 冷却时间翻倍，首次用基础值
    s.cooldownMs = Math.min(
      (s.cooldownMs || FUSE_COOLDOWN_BASE) * 2,
      FUSE_COOLDOWN_MAX
    );
    if (!s.cooldownMs || s.cooldownMs < FUSE_COOLDOWN_BASE) {
      s.cooldownMs = FUSE_COOLDOWN_BASE;
    }
  }
}

// ── 轮询选号 ─────────────────────────────────────────────────────────────────
// 跳过 inactive、跳过超限、跳过熔断中。全不可用返回 { account: null, reason }
function pickNextAccount(accounts, lastIdx, dailyCounts, states) {
  if (!accounts || !accounts.length) return { account: null, idx: -1, reason: '无可用账号' };

  const startIdx = lastIdx < 0 ? 0 : lastIdx;
  let skippedFused = 0;
  let skippedLimit = 0;
  let skippedInactive = 0;

  for (let offset = 0; offset < accounts.length; offset++) {
    const idx = (startIdx + 1 + offset) % accounts.length;
    const acc = accounts[idx];

    if (!acc.active) { skippedInactive++; continue; }

    if (isFused(acc.id, states)) { skippedFused++; continue; }

    const limit = acc.dailyLimit || 500;
    const count = (dailyCounts && dailyCounts[acc.id]) || 0;
    if (count >= limit) { skippedLimit++; continue; }

    return { account: acc, idx };
  }

  const parts = [];
  if (skippedInactive) parts.push(`${skippedInactive} 个已停用`);
  if (skippedFused) parts.push(`${skippedFused} 个熔断中`);
  if (skippedLimit) parts.push(`${skippedLimit} 个已达上限`);
  return { account: null, idx: -1, reason: parts.join('，') };
}

// ── 创建 transporter（统一重复代码）──────────────────────────────────────────
function createTransporter(account) {
  const nodemailer = require('nodemailer');
  const s = account.smtp;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port || 465,
    secure: s.secure !== false,
    auth: { user: s.user, pass: s.pass || '' },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

module.exports = {
  generateAccountId,
  validateAccount,
  migrateFromLegacy,
  pickNextAccount,
  createTransporter,
  isFused,
  recordSuccess,
  recordFailure,
  FUSE_THRESHOLD,
  FUSE_COOLDOWN_BASE,
  FUSE_COOLDOWN_MAX,
};
