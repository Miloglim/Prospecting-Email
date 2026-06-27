// ── 进程日志：拦截 console → 实时写文件 + 终端 ─────────────────────
const fs = require('fs');
const path = require('path');

const _IS_PACKAGED = __dirname.includes('.asar');
const APP_ROOT = _IS_PACKAGED
  ? path.dirname(process.resourcesPath)
  : path.join(__dirname, '..');
const LOG_DIR = path.join(APP_ROOT, 'logs');
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); }
catch (e) { /* 降级 */ }

// 清理 7 天前旧日志
try {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  fs.readdirSync(LOG_DIR).forEach(f => {
    if (f.startsWith('app-') && f.endsWith('.log') && fs.statSync(path.join(LOG_DIR, f)).mtimeMs < cutoff)
      fs.unlinkSync(path.join(LOG_DIR, f));
  });
} catch {}

function _dateStr() {
  const [d] = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false }).split(', ');
  const [m, day, y] = d.split('/');
  return `${y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}`;
}
let _today = _dateStr();

function ts() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
  const [dp, tp] = s.split(', ');
  const [m, d, y] = dp.split('/');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${tp}.${String(new Date().getMilliseconds()).padStart(3,'0')}`;
}

function write(level, args) {
  const td = _dateStr();
  if (td !== _today) _today = td;
  const line = `[${ts()}] [${level}] ${args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return '[Object]'; } }
    return String(a);
  }).join(' ')}`;
  try { fs.appendFileSync(path.join(LOG_DIR, `app-${_today}.log`), line + '\n', 'utf-8'); } catch {}
}

const _log = console.log, _warn = console.warn, _error = console.error;
console.log   = (...a) => { write('INFO', a);  _log(...a); };
console.warn  = (...a) => { write('WARN', a);  _warn(...a); };
console.error = (...a) => { write('ERROR', a); _error(...a); };

process.on('uncaughtException', (err) => {
  write('FATAL', ['uncaughtException: ' + (err.stack || err.message)]);
  _error('FATAL:', err.stack || err.message);
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  write('FATAL', ['unhandledRejection: ' + (reason?.stack || reason)]);
  _error('FATAL(unhandled):', reason?.stack || reason);
});

module.exports = { logDir: LOG_DIR };
