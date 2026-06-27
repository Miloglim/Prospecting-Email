// ── Scrapling 抓取服务管理（启停 + API 调用）───────────────────────────────
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { APP_ROOT } = require('./config');

const SCRAPLING_PORT = 8765;
let scraplingProcess = null;

function callScraplingAPI(endpoint) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${SCRAPLING_PORT}${endpoint}`;
    http.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'parse_error' }); }
      });
    }).on('error', (e) => resolve({ ok: false, error: e.message }))
      .on('timeout', function () { this.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function trySpawn(pythonCmd, scriptPath, serviceDir, resolve) {
  scraplingProcess = spawn(pythonCmd, [scriptPath], {
    cwd: serviceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(SCRAPLING_PORT) },
  });
  scraplingProcess.stdout?.on('data', d => console.log('[scrapling]', d.toString().trim()));
  scraplingProcess.stderr?.on('data', d => {
    const msg = d.toString().trim();
    // 隐藏 ModuleNotFoundError / 编码错误等非关键噪音
    if (msg && !msg.includes('ModuleNotFoundError') && !msg.includes('Traceback') && !msg.includes('UnicodeEncodeError')) {
      console.error('[scrapling]', msg);
    }
  });
  scraplingProcess.on('exit', code => {
    if (code !== 0) console.log('[scrapling] Python 环境不完整，抓取服务跳过（不影响其他功能）');
  });

  let attempts = 0;
  const check = setInterval(() => {
    attempts++;
    http.get(`http://127.0.0.1:${SCRAPLING_PORT}/health`, { timeout: 2000 }, () => {
      clearInterval(check);
      console.log('[scrapling] 服务就绪 (' + pythonCmd + ')');
      resolve(true);
    }).on('error', () => {
      if (attempts >= 20) {
        clearInterval(check);
        console.log('[scrapling] 服务启动超时');
        resolve(false);
      }
    });
  }, 500);
}

function startScraplingService() {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${SCRAPLING_PORT}/health`, { timeout: 2000 }, () => {
      console.log('[scrapling] 服务已在运行');
      resolve(true);
    }).on('error', () => {
      const serviceDir = path.join(APP_ROOT, 'scrapling-service');
      const scriptPath = path.join(serviceDir, 'scrape_service.py');
      if (!fs.existsSync(scriptPath)) {
        console.log('[scrapling] 服务脚本未找到，跳过');
        resolve(false);
        return;
      }

      // 依次尝试 python3 → python → py（Windows Python Launcher）
      const candidates = ['python3', 'python', 'py'];
      let idx = 0;

      function tryNext() {
        if (idx >= candidates.length) {
          console.log('[scrapling] Python 未安装或不在 PATH 中，Scrapling 抓取已跳过（不影响其他功能）');
          resolve(false);
          return;
        }
        const cmd = candidates[idx++];
        const cp = spawn(cmd, ['--version'], { stdio: 'ignore' });
        cp.on('error', () => tryNext());
        cp.on('close', (code) => {
          if (code === 0) trySpawn(cmd, scriptPath, serviceDir, resolve);
          else tryNext();
        });
      }

      tryNext();
    });
  });
}

function stopScraplingService() {
  if (scraplingProcess) {
    scraplingProcess.kill();
    scraplingProcess = null;
  }
}

module.exports = { callScraplingAPI, startScraplingService, stopScraplingService, SCRAPLING_PORT };
