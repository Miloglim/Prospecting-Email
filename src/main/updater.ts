// ── 自动更新模块 ────────────────────────────────────────────────────────────
// 使用 electron-updater + GitHub Releases
// main/index.ts 启动时调用 init(mainWindow) 即可

import { autoUpdater } from "electron-updater";
import { ipcMain, app } from "electron";
import type { BrowserWindow } from "electron";
import * as https from "https";
import { IPC } from "./contract";
import { Log } from "./logger";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const GITHUB_API = "https://api.github.com/repos/Miloglim/Prospecting-Email/releases";

let _win: BrowserWindow | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _channel: "stable" | "prerelease" = "stable";

// ── GitHub API 请求（轻量，不引入第三方库）─────────────────────────
function ghGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path);
    const opts: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent": "prospecting-email",
        "Accept": "application/vnd.github+json",
      },
      timeout: 15000,
    };
    // 私有仓库认证
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token && opts.headers) (opts.headers as any)["Authorization"] = `Bearer ${token}`;

    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); } catch { reject(new Error("JSON parse error")); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

// ── autoUpdater 事件 → 渲染进程 ──
function bindAutoUpdaterEvents() {
  autoUpdater.on("update-available", (info) => {
    const currentVersion = app.getVersion();
    const remoteVersion = (info.version || "").replace(/^v/i, "");
    if (remoteVersion === currentVersion) return;
    _win?.webContents.send("update:available", {
      version: info.version,
      releaseDate: info.releaseDate,
      prerelease: info.version?.includes("-"),
    });
  });

  autoUpdater.on("download-progress", (p) => {
    _win?.webContents.send("update:download-progress", {
      percent: Math.round(p.percent || 0),
      speedMB: p.bytesPerSecond ? (p.bytesPerSecond / 1024 / 1024).toFixed(1) : "—",
      total: p.total ? (p.total / 1024 / 1024).toFixed(1) : null,
      transferred: p.transferred ? (p.transferred / 1024 / 1024).toFixed(1) : "0.0",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    _win?.webContents.send("update:downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    Log.warn("updater", `检查失败: ${err.message}`);
    _win?.webContents.send("update:error", { message: err.message });
  });
}

// ── 注册 IPC 通道 ──
function registerIPC() {
  // 获取版本列表（前10个，区分正式版/预览版）
  ipcMain.handle(IPC.UPDATE.LIST_VERSIONS, async () => {
    try {
      const releases = await ghGet(GITHUB_API + "?per_page=10");
      const currentVersion = app.getVersion();
      const list = (releases || []).map((r: any) => ({
        version: (r.tag_name || "").replace(/^v/i, ""),
        name: r.name || "",
        publishedAt: r.published_at || "",
        prerelease: !!r.prerelease,
        htmlUrl: r.html_url || "",
        body: (r.body || "").slice(0, 500),
        isCurrent: (r.tag_name || "").replace(/^v/i, "") === currentVersion,
      }));
      return { success: true as const, data: { currentVersion, channel: _channel, releases: list } };
    } catch (e) {
      Log.warn("updater", `获取版本列表失败: ${(e as Error).message}`);
      return { success: false as const, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.UPDATE.CHECK, async () => {
    try {
      // 设置 electron-updater 通道
      autoUpdater.allowPrerelease = _channel === "prerelease";
      autoUpdater.allowDowngrade = false;
      const currentVersion = app.getVersion();
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo?.version) {
        const remoteVersion = result.updateInfo.version.replace(/^v/i, "");
        if (remoteVersion === currentVersion) {
          return { success: true as const, data: null };
        }
        return { success: true as const, data: { version: result.updateInfo.version, available: true } };
      }
      return { success: true as const, data: null };
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("404") || msg.includes("Not Found")) {
        return { success: false as const, error: "仓库未找到，请检查 GH_TOKEN 是否有 repo 权限" };
      }
      return { success: false as const, error: msg || "检查失败" };
    }
  });

  ipcMain.handle(IPC.UPDATE.DOWNLOAD, async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true as const };
    } catch (e) {
      return { success: false as const, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.UPDATE.INSTALL, () => {
    try {
      autoUpdater.quitAndInstall(true, true);
      return { success: true as const };
    } catch (e) {
      return { success: false as const, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.UPDATE.SET_CHANNEL, (_e, ch: string) => {
    if (ch === "stable" || ch === "prerelease") {
      _channel = ch;
      autoUpdater.allowPrerelease = ch === "prerelease";
      Log.info("updater", `通道切换: ${ch}`);
      return { success: true as const };
    }
    return { success: false as const, error: "无效通道，只能是 stable 或 prerelease" };
  });

  ipcMain.handle(IPC.UPDATE.GET_CHANNEL, () => {
    return { success: true as const, data: _channel };
  });
}

// ── 启动 ──
export function initUpdater(mainWindow: BrowserWindow) {
  _win = mainWindow;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  bindAutoUpdaterEvents();
  registerIPC();

  // 启动后 10 秒自动检查（比旧 PE 稍晚，避开启动 IO 高峰）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 10_000);

  // 定期检查
  _checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

export function cleanupUpdater() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _win = null;
}
