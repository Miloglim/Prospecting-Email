import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, dialog } from "electron";
import * as path from "path";
import { initDatabase, runMigrations, saveDatabase, closeDatabase } from "./db";
import { migrateBodiesOut } from "./services/inbox.service";
import { migrateAccountPasswords } from "./services/account.service";
import { Log } from "./logger";
import { registerContactIPC } from "./transport/contact.ipc";
import { registerCompanyIPC } from "./transport/company.ipc";
import { registerSendIPC } from "./transport/send.ipc";
import { registerInboxIPC } from "./transport/inbox.ipc";
import { registerCrmIPC } from "./transport/crm.ipc";
import { registerTemplateIPC } from "./transport/template.ipc";
import { registerAccountIPC } from "./transport/account.ipc";
import { registerExportIPC } from "./transport/export.ipc";
import { registerDashboardIPC } from "./transport/dashboard.ipc";
import { registerHistoryIPC } from "./transport/history.ipc";
import { registerBounceIPC } from "./transport/bounce.ipc";
import { registerAiIPC } from "./transport/ai.ipc";
import { registerAgentIPC } from "./transport/agent.ipc";
import { registerRatesIPC } from "./transport/rates.ipc";
import { registerKbIPC } from "./transport/kb.ipc";
import { registerSystemIPC } from "./transport/system.ipc";
import { initUpdater, cleanupUpdater } from "./updater";
import { getResourcesRoot, loadConfig } from "./config";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ── P0-5 崩溃兜底：主进程不再静默消失 ──────────────────────────
// 错误一律落日志；对话框节流 60s 防异常风暴刷屏；进程保持存活（群发批次不受牵连）
let lastCrashDialogAt = 0;
function reportCrash(kind: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  Log.error("crash", `${kind}: ${msg}`);
  const now = Date.now();
  if (now - lastCrashDialogAt > 60_000) {
    lastCrashDialogAt = now;
    try {
      dialog.showErrorBox(
        "程序遇到意外错误",
        `${kind}\n${msg.slice(0, 600)}\n\n错误已记录到日志，程序将继续运行；若反复出现请重启应用。`,
      );
    } catch { /* 对话框本身失败则只留日志 */ }
  }
}
process.on("uncaughtException", (err) => reportCrash("未捕获异常", err));
process.on("unhandledRejection", (reason) => reportCrash("未处理的 Promise 拒绝", reason));

function getIconPath(name: string): string {
  return path.join(getResourcesRoot(), name);
}

function createWindow() {
  // ponytail: 开发模式设独立 name，避免单实例锁跟打包客户端冲突
  if (!app.isPackaged) app.setName("prospecting-email-dev");

  const appIcon = nativeImage.createFromPath(getIconPath("icon.png"));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1040,
    minHeight: 660,   // 低于此值对话区与能力面板会被挤压；1366×768 屏仍有充分余量
    title: "Milogin's Prospector.",
    icon: appIcon,
    backgroundColor: "#09090b",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 关闭行为：读配置决定隐藏到托盘还是直接退出
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    try {
      const cfg = loadConfig();
      const closeAction = cfg.general?.closeAction || "tray";
      if (closeAction === "tray" && tray) {
        e.preventDefault();
        mainWindow?.hide();
      }
    } catch {
      // 配置文件损坏 → 默认托盘
      if (tray) { e.preventDefault(); mainWindow?.hide(); }
    }
  });

  // 开发快捷键：F12 / Ctrl+Shift+I 打开 DevTools
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // P0-5: 渲染进程崩溃 → 落日志并自动重载（替代 Electron 默认白屏）
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    Log.error("crash", `渲染进程退出: ${details.reason} (exitCode=${details.exitCode})`);
    mainWindow?.webContents.reload();
  });

  if (process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function createTray() {
  const iconPath = getIconPath("tray-icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (trayIcon.isEmpty()) {
    trayIcon = nativeImage.createFromPath(getIconPath("icon.png"));
  }
  if (trayIcon.isEmpty()) return; // 没有图标则跳过
  tray = new Tray(trayIcon);
  tray.setToolTip("Milogin's Prospector.");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

function registerAllIPC() {
  registerContactIPC();
  registerCompanyIPC();
  registerSendIPC();
  registerInboxIPC();
  registerCrmIPC();
  registerTemplateIPC();
  registerAccountIPC();
  registerExportIPC();
  registerDashboardIPC();
  registerHistoryIPC();
  registerBounceIPC();
  registerAiIPC();
  registerAgentIPC();
  registerRatesIPC();
  registerKbIPC();
  registerSystemIPC();

  // 窗口控制
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());

  Log.info("ipc", "所有 IPC 通道注册完成");
}

// 单实例锁 — 防止重复启动多个进程
app.setAppUserModelId("com.miloglim.prospecting-email");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await initDatabase();
  runMigrations();
  await migrateBodiesOut(); // 存量正文出库迁移（幂等，首次启动把库从正文撑大的状态缩回几 MB）
  migrateAccountPasswords(); // P0-1: 旧密钥密文一次性重封装为 safeStorage 主密钥（幂等）
  registerAllIPC();
  createWindow();
  createTray();
  initUpdater(mainWindow!);

  // P1-1: better-sqlite3 逐事务落盘，无需定时全量保存（旧 sql.js 30s 定时器已移除）

  Log.info("app", `启动完成，版本 ${app.getVersion()}`);
});

app.on("before-quit", () => {
  isQuitting = true;
  saveDatabase();   // WAL checkpoint 收尾
  closeDatabase();
  cleanupUpdater();
  Log.info("app", "正在退出...");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
