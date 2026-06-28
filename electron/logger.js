// ── 进程日志：拦截 console → 委托 core/logger 分级写入 ─────────────────
// 本文件负责：路径推导、7 天日志清理、console 拦截。
// 实际日志格式化与文件写入委托给 electron/modules/core/logger.js。

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 引入分级日志核心（必须在拦截 console 前 require，确保其捕获原始 console）──
const { Log, configure, getLogDir } = require('./modules/core/logger');

// ── 日志目录推导 ──────────────────────────────────────────────────────────
const _IS_PACKAGED = __dirname.includes('.asar');
const APP_ROOT = _IS_PACKAGED
  ? path.dirname(process.resourcesPath)
  : path.join(__dirname, '..');
const LOG_DIR = path.join(APP_ROOT, 'logs');

// ── 配置核心日志 ──────────────────────────────────────────────────────────
configure({
  logDir: LOG_DIR,
  isDev: process.env.NODE_ENV === 'development',
});

// ── 清理 7 天前旧日志 ─────────────────────────────────────────────────────
try {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  fs.readdirSync(LOG_DIR).forEach(f => {
    if (f.startsWith('app-') && f.endsWith('.log')) {
      const filePath = path.join(LOG_DIR, f);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch { /* 单个文件清理失败不影响其他 */ }
    }
  });
} catch { /* 日志目录不存在或不可读 */ }

// ── 拦截 console → 委托 Log ──────────────────────────────────────────────
// 保存原始 console 用于 uncaughtException 等极端场景的直接输出
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

/** 将 console 的多个参数合并为一条消息字符串 */
function _joinArgs(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return '[Object]'; } }
    return String(a);
  }).join(' ');
}

console.log   = (...a) => { Log.info('主进程', _joinArgs(a)); };
console.warn  = (...a) => { Log.warn('主进程', _joinArgs(a)); };
console.error = (...a) => { Log.error('主进程', _joinArgs(a)); };

// ── 全局异常兜底 ──────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  Log.error('进程', 'uncaughtException', err);
  _error('FATAL:', err.stack || err.message);
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  Log.error('进程', 'unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  _error('FATAL(unhandled):', reason?.stack || reason);
});

// ── 导出（兼容旧引用：send-ipc.js 需要 logDir）────────────────────────────
module.exports = { logDir: LOG_DIR, getLogDir };
