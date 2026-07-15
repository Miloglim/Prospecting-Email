// ── Milogin's Outreacher — Electron 主进程 v2.0 ────────────────────────────
// electron-reloader 仅旧版 `electron .` 模式使用；electron-vite dev 自带 HMR
if (!process.env.VITE_DEV_SERVER_URL) {
  try {
    require("electron-reloader")(module, {
      watchRenderer: true,
      ignore: ["data/**", "send/**", "logs/**", "reports/**"],
    });
  } catch {
    /* electron-reloader 仅开发环境可用，生产环境忽略 */
  }
}
require("./logger");
const { Log } = require("./modules/core/logger");
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const {
  APP_ROOT,
  RESOURCES_ROOT,
  ensureRuntimeDirs,
} = require("./modules/config");
ensureRuntimeDirs();

// SQLite 迁移：首次启动从 contacts.json + send-log.json 导入
try {
  const { Log: _Log } = require("./modules/core/logger");
  const contactsDb = require("./modules/services/contacts-db");
  const r = contactsDb.migrateFromJson(
    path.join(APP_ROOT, "data", "contacts.json"),
    path.join(APP_ROOT, "send", "send-log.json"),
  );
  if (r.migrated) _Log.info("启动", `SQLite 联系人迁移: ${r.migrated} 人`);
  else if (r.message) _Log.info("启动", "SQLite: " + r.message);
} catch (e) { require("./modules/core/logger").Log.error("启动", "SQLite 联系人迁移失败", e); }

// send-log 迁移
try {
  const sendLogDb = require("./modules/services/send-log-db");
  const r2 = sendLogDb.migrateFromJson(path.join(APP_ROOT, "send", "send-log.json"));
  if (r2.migrated) _Log.info("启动", `send-log 迁移: ${r2.migrated} 条`);
} catch (e) { /* 静默 */ }

// inbox 迁移
try {
  const inboxMigrate = require("./modules/services/inbox-service")._migrateInboxFromJson;
  const r3 = inboxMigrate();
  if (r3) _Log.info("启动", `inbox 迁移: ${r3} 封`);
} catch (e) { /* 静默 */ }

app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-gpu-sandbox");

const deps = {
  mainWindow: null,
  tray: null,
  isQuitting: false,
  templateLib: null,
  sendQueue: [],
  isPaused: false,
  currentSendAbort: false,
  currentTransporter: null,
};
const { parseTemplateLibrary } = require("./template-engine");

let _sendCleanup = null;
function setupIPC() {
  require("./modules/contacts-ipc").register(ipcMain, deps);
  require("./modules/backcheck-ipc").register(ipcMain, deps);
  require("./modules/template-ipc").register(ipcMain, deps);
  require("./modules/ipc/history-ipc").register(ipcMain, deps);
  require("./modules/ipc/system-ipc").register(ipcMain, deps);
  require("./modules/ipc/account-ipc").register(ipcMain);
  require("./modules/ipc/inbox-ipc").register(ipcMain, deps);
  require("./modules/send-ipc").register(ipcMain, deps);
  // try { require("./modules/acquisition-ipc").register(ipcMain, deps); } catch (e) { Log.error("main", "客户开发模块加载失败", e); }
  _sendCleanup = require("./modules/send-ipc").cleanup;
  // try { require("./modules/auto-send/ipc").register(ipcMain, deps); } catch (e) { Log.error("main", "自动发送模块加载失败", e); }
  require("./modules/ipc/table-import-ipc").register(ipcMain);

  // 无边框窗口控制
  ipcMain.on("window:minimize", () => deps.mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (deps.mainWindow?.isMaximized()) deps.mainWindow.unmaximize();
    else deps.mainWindow?.maximize();
  });
  ipcMain.on("window:close", () => deps.mainWindow?.close());

  // 开机自启
  ipcMain.handle("general:setAutoLaunch", async (_e, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle("general:getAutoLaunch", async () => {
    return { enabled: app.getLoginItemSettings().openAtLogin };
  });
}

function createWindow() {
  // electron-vite dev 模式通过 VITE_DEV_SERVER_URL 注入渲染进程地址
  // 打包后 preload 在 ../preload/index.js，开发时在 ./preload.js
  const preloadPath = __dirname.includes("dist")
    ? path.join(__dirname, "../preload/index.js")
    : path.join(__dirname, "preload.js");
  const appIcon = nativeImage.createFromPath(
    path.join(RESOURCES_ROOT, "assets", "icon.png"),
  );
  deps.mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: "Milogin's Outreacher.",
    icon: appIcon,
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    deps.mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    deps.mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
  // 开发快捷键：F12 / Ctrl+Shift+I 打开 DevTools
  deps.mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      deps.mainWindow.webContents.toggleDevTools();
    }
  });
  deps.mainWindow.on("close", (e) => {
    if (deps.isQuitting) return;
    // 读取关闭行为配置
    let closeAction = "tray";
    try {
      const cfgPath = path.join(APP_ROOT, "send", "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        closeAction = cfg?.general?.closeAction || "tray";
      }
    } catch {
      /* 配置文件读取失败 → 使用默认 closeAction='tray' */
    }
    if (closeAction === "tray" && deps.tray) {
      e.preventDefault();
      deps.mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(RESOURCES_ROOT, "assets", "tray-icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (trayIcon.isEmpty()) {
    Log.warn("系统", "托盘图标加载失败: " + iconPath);
    trayIcon = nativeImage.createEmpty();
  }
  deps.tray = new Tray(trayIcon);
  deps.tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: () => deps.mainWindow?.show() },
      {
        label: "退出",
        click: () => {
          deps.isQuitting = true;
          try {
            require("./linkedin-client").stop();
          } catch {
            /* LinkedIn 未启动则跳过 */
          }
          app.quit();
        },
      },
    ]),
  );
  deps.tray.setToolTip("Milogin's Outreacher.");
  deps.tray.on("double-click", () => deps.mainWindow?.show());
}

app.setAppUserModelId("com.milogin.outreacher");

// 单实例锁：防止重复启动
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (deps.mainWindow) {
      if (deps.mainWindow.isMinimized()) deps.mainWindow.restore();
      deps.mainWindow.show();
      deps.mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      try {
        deps.templateLib = parseTemplateLibrary();
        Log.info(
          "系统",
          "模板库加载: " +
            Object.keys(deps.templateLib?.subjects || {}).length +
            "套主题行",
        );
      } catch (e) {
        Log.error("启动", "模板加载失败", e);
        deps.templateLib = {
          hooks: [],
          painPoints: {},
          proofs: {},
          ctas: [],
          followUps: {},
          subjects: {},
          spamWords: { es: [], en: [] },
        };
      }
      setupIPC();
      createWindow();
      createTray();
      require("./modules/updater").init(deps.mainWindow);
      Log.info("系统", "应用启动完成");

      // ponytail: 退信/回复检测已由收件箱统一接管，不再独立轮询
      // const { scheduleAutoBounceCheck } = require('./modules/services/send-engine');
      // const { scheduleAutoReplyCheck } = require('./modules/services/reply-checker');
      // scheduleAutoBounceCheck(deps.mainWindow, deps.tray);
      // scheduleAutoReplyCheck(deps.mainWindow, deps.tray);

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else deps.mainWindow?.show();
      });
    })
    .catch((err) => {
      Log.error("启动", "启动失败", err);
      app.quit();
    });
} // else (gotLock)

app.on("before-quit", () => {
  deps.isQuitting = true;
  try {
    require("./linkedin-client").stop();
  } catch {
    /* 子进程已退出 */
  }
  try {
    _sendCleanup?.();
  } catch {
    /* 发送引擎未启动 */
  }
  try {
    require("./modules/services/reply-checker").cleanup();
  } catch {
    /* 回复检测未启动 */
  }
  try {
    require("./modules/services/db").closeDb();
  } catch {
    /* 数据库未初始化 */
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
