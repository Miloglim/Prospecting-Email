// ── Milogin's Prospector — Preload（安全 IPC 桥接）────────────────────────
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件路径获取（修复 Electron 安全限制）
  getFilePath: (file) => webUtils.getPathForFile(file),

  // 仪表盘
  getDashboardStats: () => ipcRenderer.invoke('dashboard:getStats'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
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
  verifyEmail: (emailBody) => ipcRenderer.invoke('backcheck:verifyEmail', emailBody),
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
  setContactTag: (id, tag) => ipcRenderer.invoke('contacts:setTag', id, tag),
  setContactTags: (id, tags) => ipcRenderer.invoke('contacts:setTags', id, tags),
  classifyContactsAI: () => ipcRenderer.invoke('contacts:classifyAI'),
  deleteAllContacts: () => ipcRenderer.invoke('contacts:deleteAll'),
  deleteCompany: (company) => ipcRenderer.invoke('contacts:deleteCompany', company),
  updateCompanyCountry: (company, newCountry) => ipcRenderer.invoke('contacts:updateCountry', company, newCountry),
  searchContacts: (query) => ipcRenderer.invoke('contacts:search', query),
  deepSearchContacts: (website, company) => ipcRenderer.invoke('contacts:deepSearch', website, company),
  upsertContact: (contact) => ipcRenderer.invoke('contacts:upsert', contact),

  // 模板
  getTemplateLibrary: () => ipcRenderer.invoke('template:getLibrary'),
  getSubjects: (type) => ipcRenderer.invoke('template:getSubjects', type),
  saveTemplateOverrides: (overrides) => ipcRenderer.invoke('template:saveOverrides', overrides),
  getTemplateOverrides: () => ipcRenderer.invoke('template:getOverrides'),
  reloadTemplate: () => ipcRenderer.invoke('template:reload'),
  applyStageOverrides: (stages, overridesStages) => ipcRenderer.invoke('template:applyStageOverrides', stages, overridesStages),

  // 用户模板
  listUserTemplates: () => ipcRenderer.invoke('template:listUser'),
  saveUserTemplate: (tpl) => ipcRenderer.invoke('template:saveUser', tpl),
  deleteUserTemplate: (id) => ipcRenderer.invoke('template:deleteUser', id),

  // 发送
  startSend: (emails) => ipcRenderer.invoke('send:start', emails),
  resumeSend: () => ipcRenderer.invoke('send:resume'),
  pauseSend: () => ipcRenderer.invoke('send:pause'),
  cancelSend: () => ipcRenderer.invoke('send:cancel'),
  sendTestOne: (params) => ipcRenderer.invoke('send:testOne', params),
  getSendStatus: () => ipcRenderer.invoke('send:status'),
  onSendProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('send:progress', handler);
    return () => ipcRenderer.removeListener('send:progress', handler);
  },


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
  clearBounceCursor: () => ipcRenderer.invoke('bounce:clear'),
  testImap: (cfg) => ipcRenderer.invoke('imap:test', cfg),
  loadBounceLog: () => ipcRenderer.invoke('bounce:loadLog'),
  saveBounceLog: (data) => ipcRenderer.invoke('bounce:saveLog', data),
  onBounceAutoDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bounce:autoDetected', handler);
    return () => ipcRenderer.removeListener('bounce:autoDetected', handler);
  },

  // 回复检测
  checkReplies: () => ipcRenderer.invoke('reply:check'),
  loadReplyLog: () => ipcRenderer.invoke('reply:log'),
  onReplyDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('reply:detected', handler);
    return () => ipcRenderer.removeListener('reply:detected', handler);
  },

  // 自动更新
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update:download-progress', handler);
    return () => ipcRenderer.removeListener('update:download-progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },

  // 发送历史
  getSendHistory: () => ipcRenderer.invoke('history:get'),
  getSendLog: (params) => ipcRenderer.invoke('history:getLog', params),
  getSendBody: (bodyId) => ipcRenderer.invoke('history:getBody', bodyId),
  deleteHistory: (indices) => ipcRenderer.invoke('history:delete', indices),
  advanceStage: (companies) => ipcRenderer.invoke('history:advance', companies),
  catchupStage: () => ipcRenderer.invoke('history:catchup'),
  recordSentences: (company, sentenceIds) => ipcRenderer.invoke('history:recordSentences', company, sentenceIds),
  reactivateCompany: (company) => ipcRenderer.invoke('history:reactivate', company),

  // 系统
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  minimizeToTray: () => ipcRenderer.invoke('app:minimizeToTray'),
  openReportsFolder: () => ipcRenderer.invoke('app:openReports'),
  openSendFolder: () => ipcRenderer.invoke('app:openSendFolder'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openLogFile: () => ipcRenderer.invoke('app:openLogFile'),

  // 网络
  checkNetwork: () => ipcRenderer.invoke('network:check'),

  // 客户开发（通过 IPC 代理，安全）
  discoverSearch: (params) => ipcRenderer.invoke('discover:search', params),
  discoverLookup: (params) => ipcRenderer.invoke('discover:lookup', params),

  // 设置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // 通用设置
  setAutoLaunch: (enabled) => ipcRenderer.invoke('general:setAutoLaunch', enabled),
  getAutoLaunch: () => ipcRenderer.invoke('general:getAutoLaunch'),

  // 发信账号管理
  listAccounts: () => ipcRenderer.invoke('account:list'),
  addAccount: (account) => ipcRenderer.invoke('account:add', account),
  updateAccount: (id, updates) => ipcRenderer.invoke('account:update', id, updates),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  toggleAccount: (id) => ipcRenderer.invoke('account:toggle', id),
  testAccount: (account) => ipcRenderer.invoke('account:test', account),
  getAccountStatus: () => ipcRenderer.invoke('account:status'),

  // 数据导出
  exportData: () => ipcRenderer.invoke('data:export'),
});
