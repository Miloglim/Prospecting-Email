import { app, BrowserWindow } from "electron";
import * as path from "path";
import { initDatabase, runMigrations, saveDatabase } from "./db";
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
import { registerSystemIPC } from "./transport/system.ipc";
import { seedTestData } from "./services/seed.service";

let mainWindow: BrowserWindow | null = null;

// 定时持久化数据库（sql.js 在内存中）
let saveInterval: ReturnType<typeof setInterval> | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Milogin's Prospector",
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
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
  registerSystemIPC();
  Log.info("ipc", "所有 IPC 通道注册完成");
}

app.whenReady().then(async () => {
  await initDatabase();
  runMigrations();
  registerAllIPC();
  createWindow();

  // 测试数据 seed
  try { seedTestData(); } catch (err) { Log.error("seed", "seed 失败", (err as Error).stack); }

  // 每 30 秒自动持久化
  saveInterval = setInterval(() => {
    saveDatabase();
  }, 30_000);

  Log.info("app", `启动完成，版本 ${app.getVersion()}`);
});

app.on("before-quit", () => {
  if (saveInterval) clearInterval(saveInterval);
  saveDatabase();
  Log.info("app", "正在退出...");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
