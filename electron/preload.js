// ── Prospecting Email — Preload（安全 IPC 桥接）────────────────────────
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件路径获取（修复 Electron 安全限制）
  getFilePath: (file) => webUtils.getPathForFile(file),

  // 仪表盘
  getDashboardStats: () => ipcRenderer.invoke('dashboard:getStats'),
  checkSmtpStatus: () => ipcRenderer.invoke('smtp:checkStatus'),

  // 客户表
  importFile: (filePath) => ipcRenderer.invoke('table:importFile', filePath),
  importFeishu: (baseToken, tableId) => ipcRenderer.invoke('table:importFeishu', baseToken, tableId),

  // 背调
  getBackcheckReports: () => ipcRenderer.invoke('backcheck:getReports'),
  getBackcheckStatus: () => ipcRenderer.invoke('backcheck:getStatus'),
  getBackcheckDetail: (company) => ipcRenderer.invoke('backcheck:getDetail', company),
  startResearch: (company) => ipcRenderer.invoke('backcheck:research', company),
  markBackcheckDone: (company, rating) => ipcRenderer.invoke('backcheck:markDone', company, rating),
  cancelBackcheck: (company) => ipcRenderer.invoke('backcheck:cancel', company),

  // 联系人
  getContacts: () => ipcRenderer.invoke('contacts:list'),
  importContacts: (clients) => ipcRenderer.invoke('contacts:import', clients),
  deleteContact: (id) => ipcRenderer.invoke('contacts:delete', id),
  deleteAllContacts: () => ipcRenderer.invoke('contacts:deleteAll'),
  searchContacts: (query) => ipcRenderer.invoke('contacts:search', query),

  // 模板
  getTemplateLibrary: () => ipcRenderer.invoke('template:getLibrary'),
  getSubjects: (type) => ipcRenderer.invoke('template:getSubjects', type),

  // 发送
  startSend: (emails) => ipcRenderer.invoke('send:start', emails),
  pauseSend: () => ipcRenderer.invoke('send:pause'),
  getSendStatus: () => ipcRenderer.invoke('send:status'),
  onSendProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('send:progress', handler);
    return () => ipcRenderer.removeListener('send:progress', handler);
  },

  // 系统
  minimizeToTray: () => ipcRenderer.invoke('app:minimizeToTray'),
  openReportsFolder: () => ipcRenderer.invoke('app:openReports'),
});
