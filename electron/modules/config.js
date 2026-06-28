// ── 配置读取 + 代理支持 + 路径常量 ─────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// 打包后路径判定
const _IS_PACKAGED = typeof __dirname === 'string' && __dirname.includes('.asar');
const APP_ROOT = _IS_PACKAGED
  ? process.resourcesPath
  : path.join(__dirname, '..', '..');

function ensureRuntimeDirs() {
  const dirs = ['logs', 'data', 'send', 'reports'];
  for (const d of dirs) {
    const p = path.join(APP_ROOT, d);
    try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch {}
  }
}

function loadSearchConfig() {
  const configPath = path.join(APP_ROOT, 'send', 'config.json');
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
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
  APP_ROOT, _IS_PACKAGED,
  ensureRuntimeDirs, loadSearchConfig,
  getProxyConfig, proxyTlsConnect, createRequest,
};
