// ── Prospecting Email — IPC 契约（通道名常量 + 响应构建 + 类型定义）────────
// 本文件是 preload.js ↔ main.js 之间的唯一 IPC 真相源。
// 所有通道名、请求/响应格式均定义于此，增删通道时必须同步更新。

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// 通用响应构建函数
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 构建成功响应。
 * @param {*} [data] - 响应载荷（可选）
 * @returns {{ success: true, data?: * }}
 */
function ok(data) {
  if (arguments.length === 0) return { success: true };
  return { success: true, data: data };
}

/**
 * 构建失败响应。
 * @param {string} message - 错误描述
 * @returns {{ success: false, error: string }}
 */
function fail(message) {
  return { success: false, error: String(message) };
}

// ══════════════════════════════════════════════════════════════════════════════
// IPC 通道名常量（按功能域分组）
// ══════════════════════════════════════════════════════════════════════════════

// ── 联系人（contacts）────────────────────────────────────────────────────────
const CONTACTS = {
  /** 获取全部联系人列表 */
  LIST:           'contacts:list',
  /** 批量导入联系人 */
  IMPORT:         'contacts:import',
  /** 删除单个联系人 */
  DELETE:         'contacts:delete',
  /** 更新退信标记 */
  UPDATE_BOUNCE:  'contacts:updateBounce',
  /** 清除退信标记 */
  CLEAR_BOUNCE:   'contacts:clearBounce',
  /** 设置联系人标签（单值，向后兼容） */
  SET_TAG:        'contacts:setTag',
  /** 设置联系人标签（多值） */
  SET_TAGS:       'contacts:setTags',
  /** 删除全部联系人 */
  DELETE_ALL:     'contacts:deleteAll',
  /** 按公司名删除联系人 */
  DELETE_COMPANY: 'contacts:deleteCompany',
  /** 更新公司所属国家 */
  UPDATE_COUNTRY: 'contacts:updateCountry',
  /** 关键词搜索联系人 */
  SEARCH:         'contacts:search',
  /** 深度搜索（按网站/公司名抓取联系人） */
  DEEP_SEARCH:    'contacts:deepSearch',
  /** 按 email 插入或更新联系人（email 为唯一键） */
  UPSERT:         'contacts:upsert',
};

// ── 发送（send）──────────────────────────────────────────────────────────────
const SEND = {
  /** 开始批量发送 */
  START:          'send:start',
  /** 恢复暂停的发送 */
  RESUME:         'send:resume',
  /** 暂停发送 */
  PAUSE:          'send:pause',
  /** 取消发送 */
  CANCEL:         'send:cancel',
  /** 发送单封测试邮件 */
  TEST_ONE:       'send:testOne',
  /** 获取发送状态 */
  STATUS:         'send:status',
  /** 持久化发送状态 */
  SAVE_STATE:     'send:saveState',
  /** 加载持久化的发送状态 */
  LOAD_STATE:     'send:loadState',
  /** 发送进度事件（main → renderer） */
  PROGRESS:       'send:progress',
};

// ── 背调（backcheck）─────────────────────────────────────────────────────────
const BACKCHECK = {
  /** 获取全部背调报告 */
  GET_REPORTS:    'backcheck:getReports',
  /** 获取背调任务状态 */
  GET_STATUS:     'backcheck:getStatus',
  /** 获取单家公司背调详情 */
  GET_DETAIL:     'backcheck:getDetail',
  /** 启动公司调研 */
  RESEARCH:       'backcheck:research',
  /** 标记背调完成并设置评分 */
  MARK_DONE:      'backcheck:markDone',
  /** 验证邮件正文 */
  VERIFY_EMAIL:   'backcheck:verifyEmail',
  /** 取消背调 */
  CANCEL:         'backcheck:cancel',
  /** 背调进度事件（main → renderer） */
  PROGRESS:       'backcheck:progress',
};

// ── 模板（template）──────────────────────────────────────────────────────────
const TEMPLATE = {
  /** 获取模板库 */
  GET_LIBRARY:           'template:getLibrary',
  /** 获取邮件主题列表 */
  GET_SUBJECTS:          'template:getSubjects',
  /** 保存模板覆盖配置 */
  SAVE_OVERRIDES:        'template:saveOverrides',
  /** 获取模板覆盖配置 */
  GET_OVERRIDES:         'template:getOverrides',
  /** 重新加载模板 */
  RELOAD:                'template:reload',
  /** 按阶段应用覆盖 */
  APPLY_STAGE_OVERRIDES: 'template:applyStageOverrides',
  /** 列出用户自定义模板 */
  LIST_USER:             'template:listUser',
  /** 保存用户自定义模板 */
  SAVE_USER:             'template:saveUser',
  /** 删除用户自定义模板 */
  DELETE_USER:           'template:deleteUser',
};

// ── 发送历史（history）───────────────────────────────────────────────────────
const HISTORY = {
  /** 获取全部发送历史 */
  GET:              'history:get',
  /** 获取发送日志 */
  GET_LOG:          'history:getLog',
  /** 获取某封邮件的正文 */
  GET_BODY:         'history:getBody',
  /** 删除历史记录 */
  DELETE:           'history:delete',
  /** 推进公司阶段 */
  ADVANCE:          'history:advance',
  /** 记录已用句库 */
  RECORD_SENTENCES: 'history:recordSentences',
  /** 重新激活公司 */
  REACTIVATE:       'history:reactivate',
  /** 阶段追回：扫描已发记录补推进 */
  CATCHUP:          'history:catchup',
};

// ── 队列持久化（queue）───────────────────────────────────────────────────────
const QUEUE = {
  /** 保存发送队列到磁盘 */
  SAVE: 'queue:save',
  /** 从磁盘加载发送队列 */
  LOAD: 'queue:load',
};

// ── 退信检查（bounce）────────────────────────────────────────────────────────
const BOUNCE = {
  /** 执行退信检查 */
  CHECK:             'bounce:check',
  /** 加载退信日志 */
  LOAD_LOG:          'bounce:loadLog',
  /** 保存退信日志 */
  SAVE_LOG:          'bounce:saveLog',
  /** 测试 IMAP 连接 */
  IMAP_TEST:         'imap:test',
  /** 自动检测到退信事件（main → renderer） */
  AUTO_DETECTED:     'bounce:autoDetected',
  /** 清除退信 UID 游标 */
  CLEAR:             'bounce:clear',
};

// ── 收件箱（inbox）────────────────────────────────────────────────────────────
const INBOX = {
  /** 拉取最新邮件 */
  FETCH:             'inbox:fetch',
  /** 获取缓存的邮件列表 */
  LIST:              'inbox:list',
  /** 获取单封邮件正文 */
  GET_BODY:          'inbox:getBody',
  /** 标记已处理 */
  MARK_PROCESSED:    'inbox:markProcessed',
  /** 关联联系人 */
  LINK_CONTACT:      'inbox:linkContact',
  /** 删除邮件记录 */
  DELETE:            'inbox:delete',
};

// ── 系统（system）────────────────────────────────────────────────────────────
// 聚合 dashboard、smtp、signature、window、app、network、config、general
const SYSTEM = {
  // -- 仪表盘
  /** 获取仪表盘统计数据 */
  DASHBOARD_STATS:    'dashboard:getStats',
  // -- SMTP
  /** 检查 SMTP 连接状态 */
  SMTP_STATUS:        'smtp:checkStatus',
  // -- 签名
  /** 加载邮件签名 */
  SIGNATURE_LOAD:     'signature:load',
  /** 保存邮件签名 */
  SIGNATURE_SAVE:     'signature:save',
  // -- 窗口控制（ipcRenderer.send，无返回值）
  /** 最小化窗口 */
  WINDOW_MINIMIZE:    'window:minimize',
  /** 最大化/还原窗口 */
  WINDOW_MAXIMIZE:    'window:maximize',
  /** 关闭窗口 */
  WINDOW_CLOSE:       'window:close',
  // -- 应用功能
  /** 最小化到系统托盘 */
  APP_TRAY:           'app:minimizeToTray',
  /** 打开背调报告文件夹 */
  APP_REPORTS:        'app:openReports',
  /** 打开发送记录文件夹 */
  APP_SEND_FOLDER:    'app:openSendFolder',
  /** 在默认浏览器打开外部链接 */
  APP_EXTERNAL:       'app:openExternal',
  /** 打开日志文件 */
  APP_LOG:            'app:openLogFile',
  // -- 网络
  /** 检查网络连通性 */
  NETWORK_CHECK:      'network:check',
  // -- 配置
  /** 加载应用配置 */
  CONFIG_LOAD:        'config:load',
  /** 保存应用配置 */
  CONFIG_SAVE:        'config:save',
  // -- 通用设置
  /** 设置开机自启 */
  AUTO_LAUNCH_SET:    'general:setAutoLaunch',
  /** 获取开机自启状态 */
  AUTO_LAUNCH_GET:    'general:getAutoLaunch',
};

// ── 自动更新（updater）────────────────────────────────────────────────────────
const UPDATE = {
  /** 发现新版本（main → renderer） */
  AVAILABLE:            'update:available',
  /** 下载进度（main → renderer） */
  DOWNLOAD_PROGRESS:    'update:download-progress',
  /** 下载完成，可安装（main → renderer） */
  DOWNLOADED:           'update:downloaded',
  /** 渲染进程手动检查更新 */
  CHECK:                'update:check',
  /** 渲染进程触发安装 */
  INSTALL:              'update:install',
};

// ── 发信账号（account）─────────────────────────────────────────────────────────
const ACCOUNT = {
  /** 获取所有账号 */
  LIST:               'account:list',
  /** 添加账号 */
  ADD:                'account:add',
  /** 更新账号 */
  UPDATE:             'account:update',
  /** 删除账号 */
  DELETE:             'account:delete',
  /** 启用/停用账号 */
  TOGGLE:             'account:toggle',
  /** 测试账号 SMTP 连接 */
  TEST:               'account:test',
  /** 获取各账号发送状态统计 */
  STATUS:             'account:status',
};

// ── 回复检测（reply）──────────────────────────────────────────────────────────
const REPLY = {
  /** 手动触发回复检测 */
  CHECK:              'reply:check',
  /** 获取回复日志 */
  LOG:                'reply:log',
  /** 自动检测到回复事件（main → renderer） */
  DETECTED:           'reply:detected',
};

// ── 客户开发（discover）──────────────────────────────────────────────────────
const DISCOVER = {
  /** 搜索潜在客户 */
  SEARCH: 'discover:search',
  /** 查询公司详细信息 */
  LOOKUP: 'discover:lookup',
};

// ── 客户表（table）──────────────────────────────────────────────────────────
const TABLE = {
  /** 从文件导入客户表 */
  IMPORT_FILE:   'table:importFile',
  /** 从飞书多维表格导入客户表 */
  IMPORT_FEISHU: 'table:importFeishu',
};

// ══════════════════════════════════════════════════════════════════════════════
// 聚合导出
// ══════════════════════════════════════════════════════════════════════════════

/**
 * IPC 通道名全集，按功能域分组。
 * @namespace IPC
 */
const IPC = {
  CONTACTS,
  SEND,
  BACKCHECK,
  TEMPLATE,
  HISTORY,
  QUEUE,
  BOUNCE,
  INBOX,
  SYSTEM,
  UPDATE,
  ACCOUNT,
  REPLY,
  DISCOVER,
  TABLE,
};

// ══════════════════════════════════════════════════════════════════════════════
// JSDoc 类型定义（请求/响应类型说明）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ─── 通用 ────────────────────────────────────────────────────────────────────
 *
 * 所有 invoke 通道的响应统一为：
 * @typedef  {{ success: true, data?: * }} IpcOk
 * @typedef  {{ success: false, error: string }} IpcFail
 * @typedef  {IpcOk|IpcFail} IpcResponse
 *
 * 发送事件（main → renderer，通过 onXxx 回调）不在 invoke 响应模型内，
 * 其载荷由各通道自行约定。
 */

/**
 * ─── 联系人（CONTACTS）───────────────────────────────────────────────────────
 *
 * CONTACTS_LIST           ()                                  → IpcResponse<Contact[]>
 * CONTACTS_IMPORT         (clients: object[])                 → IpcResponse<{ imported: number }>
 * CONTACTS_DELETE         (id: string)                        → IpcResponse<void>
 * CONTACTS_UPDATE_BOUNCE  (email: string, data: object)       → IpcResponse<void>
 * CONTACTS_CLEAR_BOUNCE   (email: string)                     → IpcResponse<void>
 * CONTACTS_DELETE_ALL     ()                                  → IpcResponse<void>
 * CONTACTS_DELETE_COMPANY (company: string)                   → IpcResponse<void>
 * CONTACTS_UPDATE_COUNTRY (company: string, newCountry: string) → IpcResponse<void>
 * CONTACTS_SEARCH         (query: string)                     → IpcResponse<Contact[]>
 * CONTACTS_DEEP_SEARCH    (website: string, company: string)  → IpcResponse<Contact[]>
 *
 * @typedef {{ id: string, company: string, country: string, email: string,
 *             name?: string, title?: string, stage?: string, bounce?: object }} Contact
 */

/**
 * ─── 发送（SEND）─────────────────────────────────────────────────────────────
 *
 * SEND_START      (emails: object[])                          → IpcResponse<{ batchId: string }>
 * SEND_RESUME     ()                                          → IpcResponse<void>
 * SEND_PAUSE      ()                                          → IpcResponse<void>
 * SEND_CANCEL     ()                                          → IpcResponse<void>
 * SEND_TEST_ONE   (params: { to, subject, body })             → IpcResponse<{ sent: boolean }>
 * SEND_STATUS     ()                                          → IpcResponse<SendStatus>
 * SEND_SAVE_STATE (data: object)                              → IpcResponse<void>
 * SEND_LOAD_STATE ()                                          → IpcResponse<object|null>
 *
 * 事件 SEND_PROGRESS → 载荷：
 * @typedef {{ current: number, total: number, company?: string,
 *             stage?: string, status: 'sending'|'paused'|'done'|'error' }} SendProgress
 *
 * @typedef {{ running: boolean, paused: boolean, progress: SendProgress }} SendStatus
 */

/**
 * ─── 背调（BACKCHECK）────────────────────────────────────────────────────────
 *
 * BACKCHECK_GET_REPORTS  ()                                  → IpcResponse<BackcheckReport[]>
 * BACKCHECK_GET_STATUS   ()                                  → IpcResponse<BackcheckStatus>
 * BACKCHECK_GET_DETAIL   (company: string)                   → IpcResponse<BackcheckDetail>
 * BACKCHECK_RESEARCH     (company: string, provider?: string)→ IpcResponse<{ taskId: string }>
 * BACKCHECK_MARK_DONE    (company: string, rating: number)   → IpcResponse<void>
 * BACKCHECK_VERIFY_EMAIL (emailBody: string)                 → IpcResponse<{ valid: boolean, issues?: string[] }>
 * BACKCHECK_CANCEL       (company: string)                   → IpcResponse<void>
 *
 * 事件 BACKCHECK_PROGRESS → 载荷：
 * @typedef {{ company: string, stage: string, message?: string }} BackcheckProgress
 *
 * @typedef {{ company: string, country: string, rating?: number, done: boolean,
 *             report?: object }} BackcheckReport
 * @typedef {{ total: number, done: number, pending: number }} BackcheckStatus
 * @typedef {{ company: string, country: string, website?: string, rating?: number,
 *             summary?: string, contacts?: object[], news?: object[] }} BackcheckDetail
 */

/**
 * ─── 模板（TEMPLATE）─────────────────────────────────────────────────────────
 *
 * TEMPLATE_GET_LIBRARY          ()                              → IpcResponse<TemplateLibrary>
 * TEMPLATE_GET_SUBJECTS         (type: string)                  → IpcResponse<string[]>
 * TEMPLATE_SAVE_OVERRIDES       (overrides: object)             → IpcResponse<void>
 * TEMPLATE_GET_OVERRIDES        ()                              → IpcResponse<object>
 * TEMPLATE_RELOAD               ()                              → IpcResponse<void>
 * TEMPLATE_APPLY_STAGE_OVERRIDES(stages: string[], overridesStages: string[]) → IpcResponse<object>
 * TEMPLATE_LIST_USER            ()                              → IpcResponse<UserTemplate[]>
 * TEMPLATE_SAVE_USER            (tpl: UserTemplate)             → IpcResponse<void>
 * TEMPLATE_DELETE_USER          (id: string)                    → IpcResponse<void>
 *
 * @typedef {{ stages: object, subjects: object, sentences: object }} TemplateLibrary
 * @typedef {{ id: string, name: string, body: string, subject?: string }} UserTemplate
 */

/**
 * ─── 发送历史（HISTORY）──────────────────────────────────────────────────────
 *
 * HISTORY_GET              ()                                      → IpcResponse<HistoryEntry[]>
 * HISTORY_GET_LOG          (params: { company?: string, limit?: number })
 *                                                                  → IpcResponse<SendLogEntry[]>
 * HISTORY_GET_BODY         (bodyId: string)                        → IpcResponse<string>
 * HISTORY_DELETE           (indices: number[])                     → IpcResponse<void>
 * HISTORY_ADVANCE          (companies: string[])                   → IpcResponse<void>
 * HISTORY_RECORD_SENTENCES (company: string, sentenceIds: string[])→ IpcResponse<void>
 * HISTORY_REACTIVATE       (company: string)                       → IpcResponse<void>
 *
 * @typedef {{ company: string, stage: string, lastContact?: string, status: string }} HistoryEntry
 * @typedef {{ id: string, company: string, email: string, sentAt: string,
 *             subject?: string, status: string }} SendLogEntry
 */

/**
 * ─── 队列持久化（QUEUE）──────────────────────────────────────────────────────
 *
 * QUEUE_SAVE (data: object)  → IpcResponse<void>
 * QUEUE_LOAD ()              → IpcResponse<object|null>
 */

/**
 * ─── 退信检查（BOUNCE）───────────────────────────────────────────────────────
 *
 * BOUNCE_CHECK         ()                → IpcResponse<BounceResult[]>
 * BOUNCE_LOAD_LOG      ()                → IpcResponse<BounceLogEntry[]>
 * BOUNCE_SAVE_LOG      (data: object[])  → IpcResponse<void>
 * BOUNCE_IMAP_TEST     (cfg: ImapConfig) → IpcResponse<{ ok: boolean, error?: string }>
 *
 * 事件 BOUNCE_AUTO_DETECTED → 载荷：
 * @typedef {{ email: string, reason?: string }} BounceAutoDetected
 *
 * @typedef {{ host: string, port: number, user: string, password: string,
 *             tls?: boolean }} ImapConfig
 * @typedef {{ email: string, bounced: boolean, reason?: string }} BounceResult
 * @typedef {{ email: string, detectedAt: string, reason?: string }} BounceLogEntry
 */

/**
 * ─── 系统（SYSTEM）───────────────────────────────────────────────────────────
 *
 * SYSTEM_DASHBOARD_STATS ()              → IpcResponse<DashboardStats>
 * SYSTEM_SMTP_STATUS     ()              → IpcResponse<{ connected: boolean, config?: object }>
 * SYSTEM_SIGNATURE_LOAD  ()              → IpcResponse<string>
 * SYSTEM_SIGNATURE_SAVE  (html: string)  → IpcResponse<void>
 * SYSTEM_WINDOW_MINIMIZE ()              → void（ipcRenderer.send，无返回值）
 * SYSTEM_WINDOW_MAXIMIZE ()              → void（ipcRenderer.send，无返回值）
 * SYSTEM_WINDOW_CLOSE    ()              → void（ipcRenderer.send，无返回值）
 * SYSTEM_APP_TRAY        ()              → IpcResponse<void>
 * SYSTEM_APP_REPORTS     ()              → IpcResponse<void>
 * SYSTEM_APP_SEND_FOLDER ()              → IpcResponse<void>
 * SYSTEM_APP_EXTERNAL    (url: string)   → IpcResponse<void>
 * SYSTEM_APP_LOG         ()              → IpcResponse<void>
 * SYSTEM_NETWORK_CHECK   ()              → IpcResponse<{ online: boolean }>
 * SYSTEM_CONFIG_LOAD     ()              → IpcResponse<AppConfig>
 * SYSTEM_CONFIG_SAVE     (config: AppConfig) → IpcResponse<void>
 * SYSTEM_AUTO_LAUNCH_SET (enabled: boolean) → IpcResponse<void>
 * SYSTEM_AUTO_LAUNCH_GET ()              → IpcResponse<boolean>
 *
 * @typedef {{ totalContacts: number, totalSent: number, totalBounced: number,
 *             stageDistribution?: object }} DashboardStats
 * @typedef {{ smtp?: object, imap?: object, general?: object, send?: object,
 *             templates?: object, backcheck?: object }} AppConfig
 */

/**
 * ─── 客户开发（DISCOVER）─────────────────────────────────────────────────────
 *
 * DISCOVER_SEARCH (params: DiscoverSearchParams) → IpcResponse<DiscoverResult[]>
 * DISCOVER_LOOKUP (params: DiscoverLookupParams) → IpcResponse<DiscoverDetail>
 *
 * @typedef {{ query: string, country?: string, industry?: string, limit?: number }} DiscoverSearchParams
 * @typedef {{ website?: string, company?: string, country?: string }} DiscoverLookupParams
 * @typedef {{ company: string, website?: string, email?: string, country?: string }} DiscoverResult
 * @typedef {{ company: string, website: string, description?: string, contacts?: object[],
 *             socialLinks?: object }} DiscoverDetail
 */

/**
 * ─── 客户表（TABLE）──────────────────────────────────────────────────────────
 *
 * TABLE_IMPORT_FILE   (filePath: string)                       → IpcResponse<{ rows: number, columns: string[] }>
 * TABLE_IMPORT_FEISHU (baseToken: string, tableId: string)     → IpcResponse<{ rows: number, columns: string[] }>
 */

// ══════════════════════════════════════════════════════════════════════════════
// 外部 API 端点（统一管理，换域名只改这里）
// ══════════════════════════════════════════════════════════════════════════════

const API = {
  DEEPSEEK: { hostname: 'api.deepseek.com', path: '/v1/chat/completions' },
  EXA:      { hostname: 'api.exa.ai',        path: '/search' },
  SERPER:   { hostname: 'google.serper.dev', path: '/search' },
  TAVILY:   { hostname: 'api.tavily.com',    path: '/search' },
  JINA:     { hostname: 'r.jina.ai',         path: '/' },
  AGNES:    { hostname: 'apihub.agnes-ai.com', path: '/v1/chat/completions' },
};

// ══════════════════════════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  ok,
  fail,
  IPC,
  API,
  // 分域导出（方便解构使用）
  CONTACTS,
  SEND,
  BACKCHECK,
  TEMPLATE,
  HISTORY,
  QUEUE,
  BOUNCE,
  INBOX,
  SYSTEM,
  UPDATE,
  ACCOUNT,
  REPLY,
  DISCOVER,
  TABLE,
};
