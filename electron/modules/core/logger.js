// ── 分级结构日志 API（纯 JS，不依赖 Electron API）────────────────────
// 所有日志操作通过 Log 对象调用，不直接使用 console。
// 由 electron/logger.js 在启动时调用 configure() 注入日志目录。

'use strict';

const fs = require('fs');
const path = require('path');

// ── 保存原始 console 引用（在 electron/logger.js 拦截 console 之前捕获）──
const _rawLog   = console.log.bind(console);
const _rawWarn  = console.warn.bind(console);
const _rawError = console.error.bind(console);

// ── 内部状态 ──────────────────────────────────────────────────────────────
let _logDir = null;
let _isDev  = process.env.NODE_ENV === 'development';

// ── 时间戳工具 ────────────────────────────────────────────────────────────

/** 返回当前上海时区的完整时间戳（含毫秒） */
function ts() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
  const [dp, tp] = s.split(', ');
  const [m, d, y] = dp.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${tp}.${String(new Date().getMilliseconds()).padStart(3, '0')}`;
}

/** 返回当前上海时区的日期字符串，用于日志文件名 */
function _dateStr() {
  const [d] = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false }).split(', ');
  const [m, day, y] = d.split('/');
  return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ── 格式化 ────────────────────────────────────────────────────────────────

/**
 * 将 ctx、msg、data 格式化为一行日志。
 * @param {string} level - 日志级别（DEBUG/INFO/WARN/ERROR）
 * @param {string} ctx  - 上下文标签，如 "发送引擎"
 * @param {string} msg  - 日志消息
 * @param {*}      data - 附加数据（Error、对象、字符串等）
 * @returns {string} 格式化后的日志行
 */
function _formatLine(level, ctx, msg, data) {
  let body = msg;
  if (data !== undefined) {
    if (data instanceof Error) {
      body += '\n' + (data.stack || data.message);
    } else if (typeof data === 'object') {
      try { body += ' ' + JSON.stringify(data); } catch { body += ' [Object]'; }
    } else {
      body += ' ' + String(data);
    }
  }
  return `[${ts()}] [${level}] [${ctx}] ${body}`;
}

/** 写入日志文件（静默失败，不抛异常） */
function _writeFile(line) {
  if (!_logDir) return;
  try {
    fs.appendFileSync(path.join(_logDir, `app-${_dateStr()}.log`), line + '\n', 'utf-8');
  } catch { /* 降级：磁盘满或权限不足时静默丢弃 */ }
}

// ── 对外 API ──────────────────────────────────────────────────────────────

/**
 * 配置日志系统。
 * 由 electron/logger.js 在启动时调用。
 * @param {{ logDir?: string, isDev?: boolean }} opts
 */
function configure({ logDir, isDev } = {}) {
  if (logDir) {
    _logDir = logDir;
    try {
      if (!fs.existsSync(_logDir)) fs.mkdirSync(_logDir, { recursive: true });
    } catch { /* 降级 */ }
  }
  if (isDev !== undefined) _isDev = isDev;
}

/**
 * 获取当前日志目录。
 * @returns {string|null}
 */
function getLogDir() {
  return _logDir;
}

/**
 * 分级日志 API。
 *
 * 用法：
 *   Log.info('发送引擎', '发信完成', { count: 5 });
 *   Log.error('启动', '模板加载失败', err);
 */
const Log = {
  /**
   * 调试日志 — 仅开发模式下 console 输出，不写文件。
   * @param {string} ctx  - 上下文标签
   * @param {string} msg  - 消息
   * @param {*}      [data] - 附加数据
   */
  debug: (ctx, msg, data) => {
    const line = _formatLine('DEBUG', ctx, msg, data);
    _writeFile(line);
    if (_isDev) _rawLog(line);
  },

  /**
   * 操作记录 — 写文件 + console.log。
   * @param {string} ctx  - 上下文标签
   * @param {string} msg  - 消息
   * @param {*}      [data] - 附加数据
   */
  info: (ctx, msg, data) => {
    const line = _formatLine('INFO', ctx, msg, data);
    _writeFile(line);
    _rawLog(line);
  },

  /**
   * 非致命问题 — 写文件 + console.warn。
   * @param {string} ctx  - 上下文标签
   * @param {string} msg  - 消息
   * @param {*}      [data] - 附加数据
   */
  warn: (ctx, msg, data) => {
    const line = _formatLine('WARN', ctx, msg, data);
    _writeFile(line);
    _rawWarn(line);
  },

  /**
   * 致命错误 — 写文件 + console.error（含完整 stack）。
   * @param {string} ctx - 上下文标签
   * @param {string} msg - 消息
   * @param {Error}  [err] - 错误对象
   */
  error: (ctx, msg, err) => {
    const line = _formatLine('ERROR', ctx, msg, err);
    _writeFile(line);
    _rawError(line);
  },
};

module.exports = { Log, configure, getLogDir };
