// ── 签名存取 — 纯函数，不依赖 Electron/IPC ─────────────────────────────────────
// 全局签名：send/signature.html
// 账号专属：send/signature-{accountId}.html
// accountId 为 null/undefined/空 时操作全局签名

const path = require('path');
const fs = require('fs');

// 由调用方注入 APP_ROOT，避免循环依赖
let _appRoot = '';

function init(appRoot) { _appRoot = appRoot; }

const DEFAULT_HTML = '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>';

function _sigPath(accountId) {
  if (accountId) return path.join(_appRoot, 'send', `signature-${accountId}.html`);
  return path.join(_appRoot, 'send', 'signature.html');
}

/**
 * 读取签名 HTML。
 * @param {string} [accountId] - 账号 ID，不传则读全局。
 * @returns {string} HTML 内容，文件不存在时返回默认 HTML。
 */
function readSignature(accountId) {
  const fp = _sigPath(accountId);
  try {
    if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf-8');
  } catch { /* 读失败降级 */ }
  // 专属签名不存在 → 回退全局（防止无限递归：全局也不存在则返回默认）
  if (accountId) return readSignature(null);
  return DEFAULT_HTML;
}

/**
 * 全局签名原始路径（供外部直接读文件用，保留兼容）。
 * @returns {string}
 */
function globalSigPath() {
  return _sigPath(null);
}

/**
 * 写入签名 HTML。写完后立即读回比对。
 * @param {string} html - HTML 内容
 * @param {string} [accountId] - 账号 ID，不传则写全局
 * @returns {{ ok: boolean, error?: string }}
 */
function writeSignature(html, accountId) {
  const fp = _sigPath(accountId);
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, html, 'utf-8');
    // 保存校验：读回比对
    const verify = fs.readFileSync(fp, 'utf-8');
    if (verify !== html) {
      return { ok: false, error: '保存校验失败：写入内容与读回不一致' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || '写入失败' };
  }
}

/**
 * 删除账号专属签名文件（账号删除联动）。
 * @param {string} accountId
 */
function deleteSignature(accountId) {
  if (!accountId) return;
  const fp = _sigPath(accountId);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* 静默 */ }
}

module.exports = { init, readSignature, writeSignature, deleteSignature, globalSigPath };
