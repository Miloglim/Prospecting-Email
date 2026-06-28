// ── 自动更新模块 ────────────────────────────────────────────────────────────
// 使用 electron-updater + GitHub Releases（私有仓库），启动后静默检查更新
//
// main.js 启动时调用 init(mainWindow) 即可
//
// 私有仓库认证：electron-updater 自动读取 GH_TOKEN 环境变量
//   开发/构建：export GH_TOKEN=ghp_xxx（需 repo 权限）
//   生产分发：将 GH_TOKEN 写入系统环境变量，或用 fine-grained PAT 嵌入
//   Fine-grained PAT：仅勾选 "Read access to contents"，仅限于本仓库

const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

let _win = null;
let _checkTimer = null;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时

function init(mainWindow) {
  _win = mainWindow;

  // 用户确认后再下载
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── autoUpdater 事件 → 渲染进程 ──
  autoUpdater.on('update-available', (info) => {
    _win?.webContents.send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('download-progress', (p) => {
    _win?.webContents.send('update:download-progress', {
      percent: Math.round(p.percent),
      speedMB: p.bytesPerSecond ? (p.bytesPerSecond / 1024 / 1024).toFixed(1) : '0.0',
      total: p.total ? (p.total / 1024 / 1024).toFixed(0) : '0',
      transferred: p.transferred ? (p.transferred / 1024 / 1024).toFixed(0) : '0',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    _win?.webContents.send('update:downloaded', {
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[更新] 检查失败:', err.message);
  });

  // ── IPC：渲染进程可手动触发 ──
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo?.version) {
        // 有新版本，触发下载（autoDownload=true 时自动开始）
        return { ok: true, data: { version: result.updateInfo.version, downloading: true } };
      }
      return { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('update:install', async () => {
    try {
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 启动后 5 秒检查（避开启动高峰）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);

  // 定期检查
  _checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

function cleanup() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _win = null;
}

module.exports = { init, cleanup };
