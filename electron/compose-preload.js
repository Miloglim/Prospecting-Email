// ── Milogin's Prospector — Compose 窗口 Preload ───────────────────────────
// 只暴露 compose 子窗口需要的最小 API 集，减少安全面
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("composeAPI", {
  /** 获取窗口初始化数据（预填收件人/主题等） */
  getInitData: () => ipcRenderer.invoke("compose:getInitData"),

  /** 获取可用发信账号列表 */
  getAccounts: () => ipcRenderer.invoke("compose:getAccounts"),

  /** 发送邮件 */
  send: (params) => ipcRenderer.invoke("compose:send", params),

  /** 获取联系人发送历史 */
  getThread: (email) => ipcRenderer.invoke("compose:getThread", email),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke("compose:close"),

  /** 最大化/还原 */
  toggleMaximize: () => ipcRenderer.invoke("compose:toggleMaximize"),

  /** 监听窗口状态变化 */
  onWindowState: (cb) => {
    ipcRenderer.on("compose:windowState", (_e, data) => cb(data));
  },

  /** 保存/覆盖草稿（按联系人邮箱去重） */
  saveDraft: (contactEmail, data) => ipcRenderer.invoke("compose:saveDraft", contactEmail, data),

  /** 加载某个联系人的草稿 */
  loadDraft: (contactEmail) => ipcRenderer.invoke("compose:loadDraft", contactEmail),
});
