// ── 工具函数（纯函数，被所有模块共用）─────────────────────────────────────
const path = require('path');

function extractField(content, label) {
  const tableRe = new RegExp(`\\|\\s*\\*{0,2}${label}\\*{0,2}\\s*\\|\\s*(.+?)\\s*\\|`, 'i');
  const tableM = content.match(tableRe);
  if (tableM) return tableM[1].replace(/\*\*/g, '').trim();
  const regex = new RegExp(`${label}[：:]\\s*(.+?)(?:\\n|$)`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

function extractFirst(text, regex) {
  const m = text.match(regex);
  return m ? m[1] || m[0] : '';
}

function sanitizeFilename(name) {
  return (name || '').trim().replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
}

function beijingToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function beijingDateFromISO(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { extractField, extractFirst, sanitizeFilename, beijingToday, beijingDateFromISO, sleep };
