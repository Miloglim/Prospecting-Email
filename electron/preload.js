// ── Milogin's Prospector — Preload（安全 IPC 桥接）────────────────────────
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 文件路径获取（修复 Electron 安全限制）
  getFilePath: (file) => webUtils.getPathForFile(file),

  // 仪表盘
  getDashboardStats: () => ipcRenderer.invoke("dashboard:getStats"),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  checkSmtpStatus: () => ipcRenderer.invoke("smtp:checkStatus"),

  // 客户表
  importFile: (filePath) => ipcRenderer.invoke("table:importFile", filePath),

  // 背调
  getBackcheckReports: () => ipcRenderer.invoke("backcheck:getReports"),
  getBackcheckStatus: () => ipcRenderer.invoke("backcheck:getStatus"),
  getBackcheckDetail: (company) =>
    ipcRenderer.invoke("backcheck:getDetail", company),
  startResearch: (company, provider) =>
    ipcRenderer.invoke("backcheck:research", company, provider),
  markBackcheckDone: (company, rating) =>
    ipcRenderer.invoke("backcheck:markDone", company, rating),
  verifyEmail: (emailBody) =>
    ipcRenderer.invoke("backcheck:verifyEmail", emailBody),
  cancelBackcheck: (company) => ipcRenderer.invoke("backcheck:cancel", company),
  onBackcheckProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("backcheck:progress", handler);
    return () => ipcRenderer.removeListener("backcheck:progress", handler);
  },

  // 联系人
  getContacts: () => ipcRenderer.invoke("contacts:list"),
  importContacts: (clients) => ipcRenderer.invoke("contacts:import", clients),
  deleteContact: (id) => ipcRenderer.invoke("contacts:delete", id),
  deleteContactsMany: (ids) => ipcRenderer.invoke("contacts:deleteMany", ids),
  updateBounce: (email, data) =>
    ipcRenderer.invoke("contacts:updateBounce", email, data),
  clearBounce: (email) => ipcRenderer.invoke("contacts:clearBounce", email),
  setContactTag: (id, tag) => ipcRenderer.invoke("contacts:setTag", id, tag),
  setContactTags: (id, tags) =>
    ipcRenderer.invoke("contacts:setTags", id, tags),
  classifyContactsAI: () => ipcRenderer.invoke("contacts:classifyAI"),
  deleteAllContacts: () => ipcRenderer.invoke("contacts:deleteAll"),
  deleteCompany: (company) =>
    ipcRenderer.invoke("contacts:deleteCompany", company),
  updateCompany: (id, data) => ipcRenderer.invoke('companies:update', id, data),
  updateCompanyCountry: (company, newCountry) =>
    ipcRenderer.invoke("contacts:updateCountry", company, newCountry),
  searchContacts: (query) => ipcRenderer.invoke("contacts:search", query),
  deepSearchContacts: (website, company) =>
    ipcRenderer.invoke("contacts:deepSearch", website, company),
  upsertContact: (contact) => ipcRenderer.invoke("contacts:upsert", contact),
  saveFollowup: (contactId, text) =>
    ipcRenderer.invoke("contacts:saveFollowup", contactId, text),
  getFollowups: (contactId) =>
    ipcRenderer.invoke("contacts:getFollowups", contactId),
  listNotes: (contactId) => ipcRenderer.invoke("contacts:listNotes", contactId),
  addNote: (contactId, content) => ipcRenderer.invoke("contacts:addNote", contactId, content),
  updateNote: (noteId, content) => ipcRenderer.invoke("contacts:updateNote", noteId, content),
  deleteNote: (noteId) => ipcRenderer.invoke("contacts:deleteNote", noteId),

  // 模板
  getTemplateLibrary: () => ipcRenderer.invoke("template:getLibrary"),
  getSubjects: (type) => ipcRenderer.invoke("template:getSubjects", type),
  saveTemplateOverrides: (overrides) =>
    ipcRenderer.invoke("template:saveOverrides", overrides),
  getTemplateOverrides: () => ipcRenderer.invoke("template:getOverrides"),
  reloadTemplate: () => ipcRenderer.invoke("template:reload"),
  applyStageOverrides: (stages, overridesStages) =>
    ipcRenderer.invoke("template:applyStageOverrides", stages, overridesStages),

  // 用户模板
  listUserTemplates: () => ipcRenderer.invoke("template:listUser"),
  saveUserTemplate: (tpl) => ipcRenderer.invoke("template:saveUser", tpl),
  deleteUserTemplate: (id) => ipcRenderer.invoke("template:deleteUser", id),

  // 发送
  startSend: (emails) => ipcRenderer.invoke("send:start", emails),
  resumeSend: () => ipcRenderer.invoke("send:resume"),
  pauseSend: () => ipcRenderer.invoke("send:pause"),
  cancelSend: () => ipcRenderer.invoke("send:cancel"),
  sendTestOne: (params) => ipcRenderer.invoke("send:testOne", params),
  getSendStatus: () => ipcRenderer.invoke("send:status"),
  onSendProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("send:progress", handler);
    return () => ipcRenderer.removeListener("send:progress", handler);
  },

  // 签名（accountId 可选：不传=全局，传了=账号专属）
  loadSignature: (accountId) => ipcRenderer.invoke("signature:load", accountId),
  saveSignature: (html, accountId) => ipcRenderer.invoke("signature:save", html, accountId),

  // 队列持久化
  saveQueue: (data) => ipcRenderer.invoke("queue:save", data),
  loadQueue: () => ipcRenderer.invoke("queue:load"),
  saveSendState: (data) => ipcRenderer.invoke("send:saveState", data),
  loadSendState: () => ipcRenderer.invoke("send:loadState"),

  // 退信检查
  // 收件箱
  fetchInbox: () => ipcRenderer.invoke("inbox:fetch"),
  listInbox: () => ipcRenderer.invoke("inbox:list"),
  getInboxBody: (index) => ipcRenderer.invoke("inbox:getBody", index),
  markInboxProcessed: (index) =>
    ipcRenderer.invoke("inbox:markProcessed", index),
  linkInboxContact: (index, contactId, company) =>
    ipcRenderer.invoke("inbox:linkContact", index, contactId, company),
  deleteInboxMail: (index) => ipcRenderer.invoke("inbox:delete", index),
  removeInboxMatchedContact: (index, email) =>
    ipcRenderer.invoke("inbox:removeMatchedContact", index, email),
  removeInboxMatchedContactsBatch: (items) => ipcRenderer.invoke("inbox:removeMatchedContactsBatch", items),
  getBounceCount: () => ipcRenderer.invoke("inbox:getBounceCount"),
  toggleInboxImportant: (index, key) =>
    ipcRenderer.invoke("inbox:toggleImportant", index, key),
  setInboxType: (index, newType) =>
    ipcRenderer.invoke("inbox:setType", index, newType),
  clearInbox: () => ipcRenderer.invoke("inbox:clear"),

  onContactsChanged: (cb) => {
    ipcRenderer.on("contacts:changed", cb);
    return () => ipcRenderer.removeListener("contacts:changed", cb);
  },
  onContactsCleared: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("contacts:cleared", handler);
    return () => ipcRenderer.removeListener("contacts:cleared", handler);
  },
  onInboxChanged: (cb) => {
    ipcRenderer.on("inbox:changed", cb);
    return () => ipcRenderer.removeListener("inbox:changed", cb);
  },
  onHistoryChanged: (cb) => {
    ipcRenderer.on("history:changed", cb);
    return () => ipcRenderer.removeListener("history:changed", cb);
  },

  // CRM 客户跟进
  crmListPipeline: (filters) => ipcRenderer.invoke("crm:listPipeline", filters),
  crmSetStage: (contactId, newStage) => ipcRenderer.invoke("crm:setStage", contactId, newStage),
  crmUpdateExtra: (contactId, patch) => ipcRenderer.invoke("crm:updateExtra", contactId, patch),
  crmGetDetail: (contactId) => ipcRenderer.invoke("crm:getDetail", contactId),
  crmSaveNote: (contactId, content) => ipcRenderer.invoke("crm:saveNote", contactId, content),
  crmCheckReminders: () => ipcRenderer.invoke("crm:checkReminders"),
  onCrmChanged: (cb) => {
    ipcRenderer.on("crm:changed", cb);
    return () => ipcRenderer.removeListener("crm:changed", cb);
  },

  checkBounces: () => ipcRenderer.invoke("bounce:check"),
  clearBounceCursor: () => ipcRenderer.invoke("bounce:clear"),
  testImap: (cfg) => ipcRenderer.invoke("imap:test", cfg),
  loadBounceLog: () => ipcRenderer.invoke("bounce:loadLog"),
  saveBounceLog: (data) => ipcRenderer.invoke("bounce:saveLog", data),
  onBounceAutoDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("bounce:autoDetected", handler);
    return () => ipcRenderer.removeListener("bounce:autoDetected", handler);
  },

  // 回复检测
  checkReplies: () => ipcRenderer.invoke("reply:check"),
  loadReplyLog: () => ipcRenderer.invoke("reply:log"),
  onReplyDetected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("reply:detected", handler);
    return () => ipcRenderer.removeListener("reply:detected", handler);
  },

  // 自动更新
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update:available", handler);
    return () => ipcRenderer.removeListener("update:available", handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update:download-progress", handler);
    return () =>
      ipcRenderer.removeListener("update:download-progress", handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update:downloaded", handler);
    return () => ipcRenderer.removeListener("update:downloaded", handler);
  },

  // 发送历史
  getSendHistory: () => ipcRenderer.invoke("history:get"),
  getSendLog: (params) => ipcRenderer.invoke("history:getLog", params),
  getSendDates: () => ipcRenderer.invoke("history:getDates"),
  getSendBody: (bodyId) => ipcRenderer.invoke("history:getBody", bodyId),
  deleteHistory: (indices) => ipcRenderer.invoke("history:delete", indices),
  advanceStage: (companies) => ipcRenderer.invoke("history:advance", companies),
  catchupStage: () => ipcRenderer.invoke("history:catchup"),
  recordSentences: (company, sentenceIds) =>
    ipcRenderer.invoke("history:recordSentences", company, sentenceIds),
  reactivateCompany: (company) =>
    ipcRenderer.invoke("history:reactivate", company),

  // 系统
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximize: () => ipcRenderer.send("window:maximize"),
  windowClose: () => ipcRenderer.send("window:close"),
  minimizeToTray: () => ipcRenderer.invoke("app:minimizeToTray"),
  openReportsFolder: () => ipcRenderer.invoke("app:openReports"),
  openSendFolder: () => ipcRenderer.invoke("app:openSendFolder"),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  openLogFile: () => ipcRenderer.invoke("app:openLogFile"),

  // 网络
  checkNetwork: () => ipcRenderer.invoke("network:check"),

  // 客户开发（通过 IPC 代理，安全）
  discoverProfiles: () => ipcRenderer.invoke("discover:profiles"),
  discoverGetProfile: (profileId) => ipcRenderer.invoke("discover:getProfile", profileId),
  discoverSaveProfile: (profileId, data) => ipcRenderer.invoke("discover:saveProfile", profileId, data),
  discoverDeleteProfile: (profileId) => ipcRenderer.invoke("discover:deleteProfile", profileId),
  discoverProviders: () => ipcRenderer.invoke("discover:providers"),
  discoverSearch: (profileId) => ipcRenderer.invoke("discover:search", profileId),
  discoverCompanyDetail: (domain) => ipcRenderer.invoke("discover:companyDetail", domain),
  discoverReveal: (profileId, maxCredits, domainFilter) => ipcRenderer.invoke("discover:reveal", profileId, maxCredits, domainFilter),

  // 设置
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),

  // 通用设置
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke("general:setAutoLaunch", enabled),
  getAutoLaunch: () => ipcRenderer.invoke("general:getAutoLaunch"),

  // 发信账号管理
  listAccounts: () => ipcRenderer.invoke("account:list"),
  addAccount: (account) => ipcRenderer.invoke("account:add", account),
  updateAccount: (id, updates) =>
    ipcRenderer.invoke("account:update", id, updates),
  deleteAccount: (id) => ipcRenderer.invoke("account:delete", id),
  toggleAccount: (id) => ipcRenderer.invoke("account:toggle", id),
  testAccount: (account) => ipcRenderer.invoke("account:test", account),
  getAccountStatus: () => ipcRenderer.invoke("account:status"),

  // 自动发送
  autoStart: () => ipcRenderer.invoke("auto:start"),
  autoStop: () => ipcRenderer.invoke("auto:stop"),
  autoStatus: () => ipcRenderer.invoke("auto:status"),
  autoUpdateRules: (rules) => ipcRenderer.invoke("auto:updateRules", rules),
  autoForecast: () => ipcRenderer.invoke("auto:forecast"),
  autoPlan: () => ipcRenderer.invoke("auto:plan"),
  autoDecisionLog: (n) => ipcRenderer.invoke("auto:decisionLog", n),
  onAutoProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("auto:progress", handler);
    return () => ipcRenderer.removeListener("auto:progress", handler);
  },
  onAutoStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("auto:status", handler);
    return () => ipcRenderer.removeListener("auto:status", handler);
  },

  // 数据导出
  exportData: () => ipcRenderer.invoke("data:export"),

  // 渲染进程日志 → 主进程统一写文件
  log: (level, ctx, msg, data) => ipcRenderer.invoke("log:write", { level, ctx, msg, data }),
});
