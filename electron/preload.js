// ── Milogin's Prospector — Preload（安全 IPC 桥接）────────────────────────
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
  startResearch: (company, provider) => ipcRenderer.invoke('backcheck:research', company, provider),
  markBackcheckDone: (company, rating) => ipcRenderer.invoke('backcheck:markDone', company, rating),
  cancelBackcheck: (company) => ipcRenderer.invoke('backcheck:cancel', company),
  onBackcheckProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('backcheck:progress', handler);
    return () => ipcRenderer.removeListener('backcheck:progress', handler);
  },

  // 联系人
  getContacts: () => ipcRenderer.invoke('contacts:list'),
  importContacts: (clients) => ipcRenderer.invoke('contacts:import', clients),
  deleteContact: (id) => ipcRenderer.invoke('contacts:delete', id),
  updateBounce: (email, data) => ipcRenderer.invoke('contacts:updateBounce', email, data),
  clearBounce: (email) => ipcRenderer.invoke('contacts:clearBounce', email),
  deleteAllContacts: () => ipcRenderer.invoke('contacts:deleteAll'),
  deleteCompany: (company) => ipcRenderer.invoke('contacts:deleteCompany', company),
  searchContacts: (query) => ipcRenderer.invoke('contacts:search', query),
  deepSearchContacts: (website, company) => ipcRenderer.invoke('contacts:deepSearch', website, company),

  // 模板
  getTemplateLibrary: () => ipcRenderer.invoke('template:getLibrary'),
  getSubjects: (type) => ipcRenderer.invoke('template:getSubjects', type),
  saveTemplateOverrides: (overrides) => ipcRenderer.invoke('template:saveOverrides', overrides),
  getTemplateOverrides: () => ipcRenderer.invoke('template:getOverrides'),
  reloadTemplate: () => ipcRenderer.invoke('template:reload'),
  applyStageOverrides: (stages, overridesStages) => ipcRenderer.invoke('template:applyStageOverrides', stages, overridesStages),

  // 发送
  startSend: (emails) => ipcRenderer.invoke('send:start', emails),
  pauseSend: () => ipcRenderer.invoke('send:pause'),
  cancelSend: () => ipcRenderer.invoke('send:cancel'),
  getSendStatus: () => ipcRenderer.invoke('send:status'),
  onSendProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('send:progress', handler);
    return () => ipcRenderer.removeListener('send:progress', handler);
  },

  // 翻译
  translateReport: (companyName) => ipcRenderer.invoke('translate:report', companyName),
  loadTranslatedReport: (companyName) => ipcRenderer.invoke('translate:loadZh', companyName),

  // 签名
  loadSignature: () => ipcRenderer.invoke('signature:load'),
  saveSignature: (html) => ipcRenderer.invoke('signature:save', html),

  // 队列持久化
  saveQueue: (data) => ipcRenderer.invoke('queue:save', data),
  loadQueue: () => ipcRenderer.invoke('queue:load'),
  saveSendState: (data) => ipcRenderer.invoke('send:saveState', data),
  loadSendState: () => ipcRenderer.invoke('send:loadState'),

  // 退信检查
  checkBounces: () => ipcRenderer.invoke('bounce:check'),
  testImap: (cfg) => ipcRenderer.invoke('imap:test', cfg),
  loadBounceLog: () => ipcRenderer.invoke('bounce:loadLog'),
  saveBounceLog: (data) => ipcRenderer.invoke('bounce:saveLog', data),
  onBounceAutoDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bounce:autoDetected', handler);
    return () => ipcRenderer.removeListener('bounce:autoDetected', handler);
  },

  // 发送历史
  getSendHistory: () => ipcRenderer.invoke('history:get'),
  getSendLog: (params) => ipcRenderer.invoke('history:getLog', params),
  getSendBody: (bodyId) => ipcRenderer.invoke('history:getBody', bodyId),
  deleteHistory: (indices) => ipcRenderer.invoke('history:delete', indices),
  advanceStage: (companies) => ipcRenderer.invoke('history:advance', companies),
  recordSentences: (company, sentenceIds) => ipcRenderer.invoke('history:recordSentences', company, sentenceIds),
  reactivateCompany: (company) => ipcRenderer.invoke('history:reactivate', company),

  // 系统
  minimizeToTray: () => ipcRenderer.invoke('app:minimizeToTray'),
  openReportsFolder: () => ipcRenderer.invoke('app:openReports'),
  openSendFolder: () => ipcRenderer.invoke('app:openSendFolder'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 网络
  checkNetwork: () => ipcRenderer.invoke('network:check'),

  // 设置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
});
