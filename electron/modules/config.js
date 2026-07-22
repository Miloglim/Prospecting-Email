// ── 配置读取 + 代理支持 + 路径常量 ─────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { app } = require('electron');

// 打包后路径判定（使用 Electron 标准 API，比 __dirname.includes('.asar') 更可靠）
const _IS_PACKAGED = app.isPackaged;
// 用户数据路径（跨版本持久）：C:\Users\<name>\AppData\Roaming\prospecting-email-send
const APP_ROOT = _IS_PACKAGED
  ? app.getPath('userData')
  : path.join(__dirname, '..', '..');
// 应用资源路径（打包后的静态文件，如图标/模板）：不随更新清除
const RESOURCES_ROOT = _IS_PACKAGED
  ? process.resourcesPath
  : path.join(__dirname, '..', '..');

// 首次切换时迁移旧数据（resources/ → userData）
function _migrateIfNeeded() {
  if (!_IS_PACKAGED) return;
  const oldRoot = process.resourcesPath;
  if (oldRoot === APP_ROOT) return; // 新旧相同，无需迁移
  const dirs = ['logs', 'data', 'send', 'reports'];
  for (const d of dirs) {
    const oldDir = path.join(oldRoot, d);
    const newDir = path.join(APP_ROOT, d);
    if (!fs.existsSync(oldDir)) continue;
    try { fs.mkdirSync(newDir, { recursive: true }); } catch { /* 非关键文件操作失败不影响主流程 */ }
    try {
      const files = fs.readdirSync(oldDir);
      for (const f of files) {
        const oldPath = path.join(oldDir, f);
        const newPath = path.join(newDir, f);
        if (fs.existsSync(newPath)) continue; // 已存在不覆盖
        try { fs.copyFileSync(oldPath, newPath); } catch { /* 非关键文件操作失败不影响主流程 */ }
      }
    } catch { /* 非关键文件操作失败不影响主流程 */ }
  }
}

// ── 品牌更名数据迁移：prospecting-email-send → outreacher ──────────
function _migrateFromOldName() {
  if (!_IS_PACKAGED) return;
  const oldRoot = path.join(path.dirname(APP_ROOT), 'prospecting-email-send');
  if (!fs.existsSync(oldRoot) || oldRoot === APP_ROOT) return;
  const marker = path.join(APP_ROOT, '.migrated_from_old_name');
  if (fs.existsSync(marker)) return; // 已迁移过
  try {
    const dirs = ['logs', 'data', 'send', 'reports'];
    for (const d of dirs) {
      const oldDir = path.join(oldRoot, d);
      const newDir = path.join(APP_ROOT, d);
      if (!fs.existsSync(oldDir)) continue;
      try { fs.mkdirSync(newDir, { recursive: true }); } catch { /* 降级 */ }
      const files = fs.readdirSync(oldDir);
      for (const f of files) {
        const oldPath = path.join(oldDir, f);
        const newPath = path.join(newDir, f);
        if (fs.existsSync(newPath)) continue;
        try { fs.copyFileSync(oldPath, newPath); } catch { /* 降级 */ }
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
  } catch { /* 迁移失败不阻塞启动 */ }
}

function ensureRuntimeDirs() {
  _migrateIfNeeded();
  _migrateFromOldName();
  const dirs = ['logs', 'data', 'send', 'reports'];
  for (const d of dirs) {
    const p = path.join(APP_ROOT, d);
    try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch { /* 非关键文件操作失败不影响主流程 */ }
  }
}

function loadSearchConfig() {
  const configPath = path.join(APP_ROOT, 'send', 'config.json');
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* 非关键文件操作失败不影响主流程 */ }
  }
  return {};
}

function getProxyConfig() {
  const cfg = loadSearchConfig();
  const host = cfg?.proxy?.host;
  if (!host) return null;
  const [hostname, portStr] = host.split(':');
  return { hostname: hostname.trim(), port: parseInt(portStr) || 7890 };
}

function proxyTlsConnect(targetHost, targetPort, callback) {
  const proxy = getProxyConfig();
  if (!proxy) {
    const sock = require('tls').connect(
      { host: targetHost, port: targetPort, servername: targetHost },
      () => callback(null, sock)
    );
    sock.on('error', callback);
    return;
  }
  const req = http.request({
    hostname: proxy.hostname, port: proxy.port,
    method: 'CONNECT', path: `${targetHost}:${targetPort}`,
    timeout: 10000,
  });
  req.on('connect', (_res, socket) => {
    const tls = require('tls');
    const tlsSock = tls.connect(
      { socket, host: targetHost, servername: targetHost },
      () => callback(null, tlsSock)
    );
    tlsSock.on('error', callback);
  });
  req.on('error', callback);
  req.on('timeout', () => { req.destroy(); callback(new Error('代理连接超时')); });
  req.end();
}

function createRequest(options) {
  const hostname = options.hostname || options.host;
  const port = options.port || 443;
  options.createConnection = (_opts, cb) => proxyTlsConnect(hostname, port, cb);
  return https.request(options);
}

module.exports = {
  APP_ROOT, RESOURCES_ROOT, _IS_PACKAGED,
  ensureRuntimeDirs, loadSearchConfig,
  getProxyConfig, proxyTlsConnect, createRequest,
};
