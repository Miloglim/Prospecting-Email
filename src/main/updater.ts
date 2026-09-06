// ── 自动更新模块 ────────────────────────────────────────────────────────────
// 使用 electron-updater + GitHub Releases
// main/index.ts 启动时调用 init(mainWindow) 即可

import { autoUpdater } from "electron-updater";
import { ipcMain, app } from "electron";
import type { BrowserWindow } from "electron";
import { IPC } from "./contract";
import { Log } from "./logger";
import { netFetch } from "./net-proxy";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const GITHUB_API = "https://api.github.com/repos/Miloglim/Prospecting-Email/releases";

let _win: BrowserWindow | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _channel: "stable" | "prerelease" = "stable";

// ── GitHub API 请求（走 netFetch：代理感知 + 容忍企业证书；裸 https 在办公网会 TLS 失败）──
async function ghGet(url: string): Promise<any> {
  const headers: Record<string, string> = {
    "User-Agent": "prospecting-email",
    "Accept": "application/vnd.github+json",
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await netFetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** 语义化版本比较：a<b 返回 -1，相等 0，a>b 返回 1（只比 major.minor.patch） */
function cmpVer(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 从 releases（GitHub 按发布倒序返回）挑当前通道下最新的一条 */
function pickLatest(releases: any[]): { version: string; publishedAt: string; prerelease: boolean } | null {
  const list = (releases || []).map((r: any) => ({
    version: (r.tag_name || "").replace(/^v/i, ""),
    publishedAt: r.published_at || "",
    prerelease: !!r.prerelease,
  })).filter((r) => r.version);
  const pool = _channel === "prerelease" ? list : list.filter((r) => !r.prerelease);
  return pool[0] ?? null;
}

/** 轮询用：比对最新发布与运行版本，更新则推送 update:available（dev/内网都能检测，不依赖 app-update.yml） */
async function pollForUpdate(): Promise<void> {
  try {
    const releases = await ghGet(GITHUB_API + "?per_page=10");
    const cur = app.getVersion();
    const latest = pickLatest(releases);
    if (latest && cmpVer(latest.version, cur) > 0) {
      _win?.webContents.send("update:available", { version: latest.version, releaseDate: latest.publishedAt, prerelease: latest.prerelease });
      Log.info("updater", `发现新版本 v${latest.version}（当前 v${cur}）`);
    } else {
      Log.debug("updater", `已是最新（当前 v${cur}${latest ? `，最新 v${latest.version}` : ""}）`);
    }
  } catch (e) {
    Log.warn("updater", `检查更新失败: ${(e as Error).message}`);
  }
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
    // 让 electron-updater 先拉一次（打包后下载需要它缓存 updateInfo；dev/无 feed 时失败也无妨）
    autoUpdater.allowPrerelease = _channel === "prerelease";
    autoUpdater.allowDowngrade = false;
    void autoUpdater.checkForUpdates().catch(() => { /* 静默 */ });
    // 可靠检测走 GitHub API（代理感知，dev / 内网都可用）
    try {
      const releases = await ghGet(GITHUB_API + "?per_page=10");
      const cur = app.getVersion();
      const latest = pickLatest(releases);
      if (latest && cmpVer(latest.version, cur) > 0) {
        return { success: true as const, data: { version: latest.version, available: true } };
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

  // 启动后 10 秒自动检查（走 GitHub API，dev/内网都能检测）
  setTimeout(() => { void pollForUpdate(); }, 10_000);

  // 每 4 小时轮询
  _checkTimer = setInterval(() => { void pollForUpdate(); }, CHECK_INTERVAL_MS);
}

export function cleanupUpdater() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _win = null;
}
