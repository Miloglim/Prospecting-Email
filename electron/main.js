// ── Milogin's Prospector — Electron 主进程 v2.0 ────────────────────────────
// electron-reloader 仅旧版 `electron .` 模式使用；electron-vite dev 自带 HMR
if (!process.env.VITE_DEV_SERVER_URL) {
  try {
    require('electron-reloader')(module, {
      watchRenderer: true,
      ignore: ['data/**', 'send/**', 'logs/**', 'reports/**'],
    });
  } catch {}
}
require('./logger');
const { Log } = require('./modules/core/logger');
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { APP_ROOT, ensureRuntimeDirs } = require('./modules/config');
ensureRuntimeDirs();
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const deps = { mainWindow: null, tray: null, isQuitting: false, templateLib: null, sendQueue: [], isPaused: false, currentSendAbort: false, currentTransporter: null };
const { parseTemplateLibrary } = require('./template-engine');

let _sendCleanup = null;
function setupIPC() {
  require('./modules/contacts-ipc').register(ipcMain, deps);
  require('./modules/backcheck-ipc').register(ipcMain, deps);
  require('./modules/template-ipc').register(ipcMain, deps);
  require('./modules/services/history-store').register(ipcMain);
  require('./modules/ipc/system-ipc').register(ipcMain, deps);
  require('./modules/send-ipc').register(ipcMain, deps);
  _sendCleanup = require('./modules/send-ipc').cleanup;
  registerTableImportHandlers();

  // 无边框窗口控制
  ipcMain.on('window:minimize', () => deps.mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (deps.mainWindow?.isMaximized()) deps.mainWindow.unmaximize();
    else deps.mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => deps.mainWindow?.close());

  // 开机自启
  ipcMain.handle('general:setAutoLaunch', async (_e, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('general:getAutoLaunch', async () => {
    return { enabled: app.getLoginItemSettings().openAtLogin };
  });
}

function registerTableImportHandlers() {
  const { classifyClient, markSuspicious } = require('./modules/classify-client');
  const XLSX = require('xlsx');
  const { execSync } = require('child_process');

  ipcMain.handle('table:importFile', async (_e, filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!['.csv', '.xlsx', '.xls'].includes(ext)) return { error: '不支持的文件格式' };
      let wb;
      if (ext === '.csv') { let text = fs.readFileSync(filePath, 'utf-8'); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); wb = XLSX.read(text, { type: 'string', codepage: 65001 }); }
      else wb = XLSX.readFile(filePath, { type: 'file', codepage: 65001 });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const getStr = (obj, ...keys) => { for (const k of keys) { const v = obj[k]; if (v !== undefined && v !== null && String(v).trim()) return String(v).trim(); } return ''; };
      const clients = rows.map(r => ({
        company: getStr(r, '公司名称','公司名','公司','Company','company','empresa','客户名称','客户'),
        country: getStr(r, '国家','Country','country'),
        category: getStr(r, '公司类型','品类','Category','category','rubro','行业'),
        email: getStr(r, '联系方式','邮箱','邮箱地址','Email','email','收件人','to','邮件'),
        website: getStr(r, '网站','Website','website','官网','网址'),
        linkedin: getStr(r, 'LinkedIn'),
        contactName: getStr(r, '姓名 | 职位','姓名','联系人','Contact','contact'),
        position: getStr(r, '职位','Position','position','title'),
        phone: getStr(r, 'Phone','phone','电话','Tel','tel'),
        clientType: classifyClient(getStr(r, '公司名称','公司名','公司','Company','company','empresa','客户名称','客户'), getStr(r, '公司类型','品类','Category','category','rubro','行业')),
      })).filter(c => c.company);
      return { clients, total: clients.length };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('table:importFeishu', async (_e, baseToken, tableId) => {
    try {
      const fieldOut = execSync(`lark-cli base +field-list --base-token "${baseToken}" --table-id "${tableId}" --limit 200`, { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      const fd = JSON.parse(fieldOut); const fields = fd.data?.fields || fd.fields || []; const allFieldNames = fields.map(f => f.name);
      const TARGETS = [
        { keys: ['公司名称','公司名','公司','Company','company','empresa','客户名称'], field: 'company' },
        { keys: ['国家','Country','country'], field: 'country' },
        { keys: ['公司类型','品类','行业','Category','category','rubro'], field: 'category' },
        { keys: ['邮箱','联系方式','邮箱地址','Email','email','收件人'], field: 'email' },
        { keys: ['网站','Website','website','官网','LinkedIn'], field: 'website' },
        { keys: ['姓名','联系人','Contact','contact'], field: 'contactName' },
        { keys: ['职位','Position','position'], field: 'position' },
        { keys: ['电话','Phone','phone','Tel','tel'], field: 'phone' },
      ];
      const selectedNames = []; for (const t of TARGETS) { const name = allFieldNames.find(n => t.keys.some(k => n === k || (n && n.includes(k)))); selectedNames.push(name || ''); }
      if (!selectedNames.some(Boolean)) { selectedNames.splice(0, selectedNames.length, ...allFieldNames.slice(0, 3)); while (selectedNames.length < TARGETS.length) selectedNames.push(''); }
      const validNames = selectedNames.filter(Boolean); const allRecords = []; const seenRecordIds = new Set(); const pageSize = 200; let offset = 0;
      const idArgs = validNames.map(n => ` --field-id "${n}"`).join('');
      while (true) {
        const output = execSync(`lark-cli base +record-list --base-token "${baseToken}" --table-id "${tableId}" --offset ${offset} --limit ${pageSize} --format json${idArgs}`, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10*1024*1024 });
        const resp = JSON.parse(output); const rows = resp.data?.data || resp.data || []; if (!rows.length) break;
        const ids = resp.data?.record_id_list || [];
        for (let i = 0; i < rows.length; i++) {
          const rid = ids[i] || String(i+offset); if (seenRecordIds.has(rid)) continue; seenRecordIds.add(rid);
          const row = rows[i]; const colMap = {}; (resp.data?.fields || []).forEach((name, ci) => { colMap[name] = ci; });
          const obj = {};
          for (let ti = 0; ti < TARGETS.length; ti++) {
            const an = selectedNames[ti]; if (!an) continue;
            const ci = colMap[an]; const val = ci !== undefined && ci < row.length ? row[ci] : '';
            let clean = '';
            if (Array.isArray(val)) clean = String(val[0]?.link || val[0]?.text || val[0]?.url || val[0] || '');
            else if (val && typeof val === 'object') clean = val.link || val.text || val.url || '';
            else clean = String(val ?? '');
            clean = clean.trim();
            const md = clean.match(/^\[(.+?)\]\((.+?)\)$/);
            if (md) { const u = md[2]; clean = u.startsWith('mailto:') ? u.slice(7) : u.startsWith('tel:') ? u.slice(4) : u.includes('@') ? u.replace(/^https?:\/\//,'') : u; }
            if (clean.startsWith('mailto:')) clean = clean.slice(7);
            else if (clean.startsWith('tel:')) clean = clean.slice(4);
            obj[TARGETS[ti].field] = clean.trim();
          }
          allRecords.push(obj);
        }
        if (!resp.data?.has_more || rows.length < pageSize) break;
        offset += pageSize;
      }
      if (!allRecords.length) return { error: '未读取到任何记录' };
      let suspiciousCount = 0;
      for (const r of allRecords) {
        const m = markSuspicious(r.company); r.company = m.company; r._suspicious = m._suspicious;
        if (m._suspicious) suspiciousCount++;
        r.clientType = classifyClient(r.company, r.category);
      }
      return { clients: allRecords, total: allRecords.length, suspiciousCount };
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('not found')) return { error: 'lark-cli 未安装' };
      if (msg.includes('auth')) return { error: '飞书未授权' };
      if (msg.includes('ETIMEDOUT')) return { error: '飞书请求超时' };
      return { error: '飞书读取失败: ' + msg };
    }
  });
}

function createWindow() {
  // electron-vite dev 模式通过 VITE_DEV_SERVER_URL 注入渲染进程地址
  // 打包后 preload 在 ../preload/index.js，开发时在 ./preload.js
  const preloadPath = __dirname.includes('dist')
    ? path.join(__dirname, '../preload/index.js')
    : path.join(__dirname, 'preload.js');
  const appIcon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'icon.png'));
  deps.mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 680, title: "Milogin's Prospector.",
    icon: appIcon,
    frame: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    deps.mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    deps.mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
  // 开发快捷键：F12 / Ctrl+Shift+I 打开 DevTools
  deps.mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      deps.mainWindow.webContents.toggleDevTools();
    }
  });
  deps.mainWindow.on('close', (e) => {
    if (deps.isQuitting) return;
    // 读取关闭行为配置
    let closeAction = 'tray';
    try {
      const cfgPath = path.join(APP_ROOT, 'send', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        closeAction = cfg?.general?.closeAction || 'tray';
      }
    } catch {}
    if (closeAction === 'tray' && deps.tray) {
      e.preventDefault();
      deps.mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(APP_ROOT, 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) trayIcon = path.resolve(iconPath);
  else trayIcon = require('electron').nativeImage.createEmpty();
  deps.tray = new Tray(trayIcon);
  deps.tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => deps.mainWindow?.show() },
    { label: '退出', click: () => { deps.isQuitting = true; try { require('./linkedin-client').stop(); } catch {} app.quit(); } },
  ]));
  deps.tray.setToolTip("Milogin's Prospector.");
  deps.tray.on('double-click', () => deps.mainWindow?.show());
}

app.setAppUserModelId('com.milogin.prospecting-email');
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try { deps.templateLib = parseTemplateLibrary(); }
  catch (e) { Log.error('启动', '模板加载失败', e); deps.templateLib = { hooks:[],painPoints:{},proofs:{},ctas:[],followUps:{},subjects:{},spamWords:{es:[],en:[]} }; }
  setupIPC(); createWindow(); createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else deps.mainWindow?.show(); });
}).catch((err) => { Log.error('启动', '启动失败', err); app.quit(); });

app.on('before-quit', () => { deps.isQuitting = true; try { require('./linkedin-client').stop(); } catch {} try { _sendCleanup?.(); } catch {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
