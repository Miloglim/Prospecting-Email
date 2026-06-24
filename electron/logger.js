// ── 进程日志：拦截 console → 同时写文件 + 终端 ─────────────────────
// ponytail: 全局单例，零配置，按天滚动
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const dateStr = new Date().toISOString().slice(0, 10);
const stream = fs.createWriteStream(path.join(LOG_DIR, `app-${dateStr}.log`), { flags: 'a' });

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 23); // 2026-06-24 14:31:05.123
}

function write(level, args) {
  const line = `[${ts()}] [${level}] ${args.map(a =>
    a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ')}\n`;
  stream.write(line);
}

// 劫持全局 console
const _log = console.log, _warn = console.warn, _error = console.error;
console.log   = (...a) => { write('INFO', a);  _log(...a); };
console.warn  = (...a) => { write('WARN', a);  _warn(...a); };
console.error = (...a) => { write('ERROR', a); _error(...a); };

// 未捕获异常落盘
process.on('uncaughtException', (err) => {
  stream.write(`[${ts()}] [FATAL] uncaughtException: ${err.stack || err.message}\n`);
  _error('FATAL:', err.stack || err.message);
  // 给日志写完的时间再退出
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  stream.write(`[${ts()}] [FATAL] unhandledRejection: ${reason?.stack || reason}\n`);
  _error('FATAL(unhandled):', reason?.stack || reason);
});

module.exports = { logDir: LOG_DIR };
