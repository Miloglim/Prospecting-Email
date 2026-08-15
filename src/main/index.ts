import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage } from "electron";
import * as path from "path";
import { initDatabase, runMigrations, saveDatabase } from "./db";
import { migrateBodiesOut } from "./services/inbox.service";
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
import { registerMigrateIPC } from "./transport/migrate.ipc";
import { registerSystemIPC } from "./transport/system.ipc";
import { initUpdater, cleanupUpdater } from "./updater";
import { getResourcesRoot, loadConfig } from "./config";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// 定时持久化数据库（sql.js 在内存中）
let saveInterval: ReturnType<typeof setInterval> | null = null;

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
    minWidth: 960,
    minHeight: 600,
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
  registerMigrateIPC();
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
app.setAppUserModelId("com.milogin.prospecting-email");
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
  registerAllIPC();
  createWindow();
  createTray();
  initUpdater(mainWindow!);

  // 每 30 秒自动持久化
  saveInterval = setInterval(() => {
    saveDatabase();
  }, 30_000);

  Log.info("app", `启动完成，版本 ${app.getVersion()}`);
});

app.on("before-quit", () => {
  isQuitting = true;
  if (saveInterval) clearInterval(saveInterval);
  cleanupUpdater();
  saveDatabase();
  Log.info("app", "正在退出...");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
