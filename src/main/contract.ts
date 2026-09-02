const PREFIX = {
  CONTACTS:  "contacts",
  COMPANIES: "companies",
  SEND:      "send",
  INBOX:     "inbox",
  CRM:       "crm",
  TEMPLATES: "templates",
  ACCOUNTS:  "accounts",
  EXPORT:    "export",
  DASHBOARD: "dashboard",
  HISTORY:   "history",
  BOUNCE:    "bounce",
  AI:        "ai",
  AGENT:     "agent",
  RATES:     "rates",
  KB:        "kb",
  SYSTEM:    "system",
  UPDATE:    "update",
} as const;

function chan(domain: string, action: string): string {
  return `${domain}:${action}`;
}

export const IPC = {
  CONTACTS: {
    LIST:      chan(PREFIX.CONTACTS, "list"),
    GET_BY_ID: chan(PREFIX.CONTACTS, "getById"),
    UPSERT:    chan(PREFIX.CONTACTS, "upsert"),
    DELETE:    chan(PREFIX.CONTACTS, "delete"),
    IMPORT:    chan(PREFIX.CONTACTS, "import"),
    EXPORT:    chan(PREFIX.CONTACTS, "export"),
    COUNT:     chan(PREFIX.CONTACTS, "count"),
    LIST_IDS:  chan(PREFIX.CONTACTS, "listIds"),
    DELETE_BATCH: chan(PREFIX.CONTACTS, "deleteBatch"),
    INTERACTIONS: chan(PREFIX.CONTACTS, "interactions"),
    LIST_FOR_MATCH: chan(PREFIX.CONTACTS, "listForMatch"),
  },
  COMPANIES: {
    LIST:      chan(PREFIX.COMPANIES, "list"),
    GET_BY_ID: chan(PREFIX.COMPANIES, "getById"),
    GET_DETAIL: chan(PREFIX.COMPANIES, "getDetail"),
    UPSERT:    chan(PREFIX.COMPANIES, "upsert"),
    DELETE:    chan(PREFIX.COMPANIES, "delete"),
  },
  SEND: {
    START:            chan(PREFIX.SEND, "start"),
    PAUSE:            chan(PREFIX.SEND, "pause"),
    RESUME:           chan(PREFIX.SEND, "resume"),
    CANCEL:           chan(PREFIX.SEND, "cancel"),
    STATUS:           chan(PREFIX.SEND, "status"),
    GET_QUEUE:        chan(PREFIX.SEND, "getQueue"),
    RESUME_QUEUE:     chan(PREFIX.SEND, "resumeQueue"),
    TEST:             chan(PREFIX.SEND, "test"),
    GET_TIME_BUCKETS: chan(PREFIX.SEND, "getTimeBuckets"),
    GET_STAGE_BUCKETS: chan(PREFIX.SEND, "getStageBuckets"),
    GET_SEND_TIME_BUCKETS: chan(PREFIX.SEND, "getSendTimeBuckets"),
    PREVIEW:          chan(PREFIX.SEND, "preview"),
    GET_QUOTA:        chan(PREFIX.SEND, "getQuota"),
    DYNAMIC:          chan(PREFIX.SEND, "dynamic"),
  },
  INBOX: {
    LIST:          chan(PREFIX.INBOX, "list"),
    FETCH:         chan(PREFIX.INBOX, "fetch"),
    CLASSIFY:      chan(PREFIX.INBOX, "classify"),
    MARK_READ:     chan(PREFIX.INBOX, "markRead"),
    DELETE:        chan(PREFIX.INBOX, "delete"),
    DELETE_BOUNCE: chan(PREFIX.INBOX, "deleteBounce"),
    GET_BODY:      chan(PREFIX.INBOX, "getBody"),
  },
  CRM: {
    LIST_PIPELINE: chan(PREFIX.CRM, "listPipeline"),
    SET_STAGE:     chan(PREFIX.CRM, "setStage"),
    ADD_REMINDER:  chan(PREFIX.CRM, "addReminder"),
    CLEAR_REMINDER: chan(PREFIX.CRM, "clearReminder"),
    ADD_NOTE:      chan(PREFIX.CRM, "addNote"),
    GET_DETAIL:    chan(PREFIX.CRM, "getDetail"),
    UPDATE_NOTE:   chan(PREFIX.CRM, "updateNote"),
    DELETE_NOTE:   chan(PREFIX.CRM, "deleteNote"),
    CHECK_REMINDERS: chan(PREFIX.CRM, "checkReminders"),
  },
  TEMPLATES: {
    LIST:    chan(PREFIX.TEMPLATES, "list"),
    UPSERT:  chan(PREFIX.TEMPLATES, "upsert"),
    DELETE:  chan(PREFIX.TEMPLATES, "delete"),
    PRESETS: chan(PREFIX.TEMPLATES, "presets"),
  },
  ACCOUNTS: {
    LIST:     chan(PREFIX.ACCOUNTS, "list"),
    VALIDATE: chan(PREFIX.ACCOUNTS, "validate"),
    UPSERT:   chan(PREFIX.ACCOUNTS, "upsert"),
    DELETE:   chan(PREFIX.ACCOUNTS, "delete"),
  },
  EXPORT: {
    CONTACTS_TO_EXCEL: chan(PREFIX.EXPORT, "contactsToExcel"),
    NOTES_TO_CSV:      chan(PREFIX.EXPORT, "notesToCsv"),
  },
  DASHBOARD: {
    STATS: chan(PREFIX.DASHBOARD, "stats"),
  },
  HISTORY: {
    LIST:      chan(PREFIX.HISTORY, "list"),
    GET_DATES: chan(PREFIX.HISTORY, "getDates"),
    CLEAR:     chan(PREFIX.HISTORY, "clear"),
  },
  BOUNCE: {
    LIST: chan(PREFIX.BOUNCE, "list"),
  },
  AI: {
    STATUS:         chan(PREFIX.AI, "status"),
    GET_KEYS:       chan(PREFIX.AI, "getKeys"),
    SET_KEY:        chan(PREFIX.AI, "setKey"),
    BACKCHECK:      chan(PREFIX.AI, "backcheck"),
    GENERATE_DRAFT: chan(PREFIX.AI, "generateDraft"),
    SUMMARIZE_EMAIL: chan(PREFIX.AI, "summarizeEmail"),
    /** 模型端点：生效状态 / 列表 / 增删改 / 密钥 / 激活 / 思考 / 连通性测试 */
    ENDPOINT_STATUS: chan(PREFIX.AI, "endpointStatus"),
    PROFILES:        chan(PREFIX.AI, "profiles"),
    PROFILE_UPSERT:  chan(PREFIX.AI, "profileUpsert"),
    PROFILE_DELETE:  chan(PREFIX.AI, "profileDelete"),
    PROFILE_KEY:     chan(PREFIX.AI, "profileKey"),
    PROFILE_ACTIVATE: chan(PREFIX.AI, "profileActivate"),
    PROFILE_THINKING: chan(PREFIX.AI, "profileThinking"),
    PROFILE_TEST:    chan(PREFIX.AI, "profileTest"),
    /** 出网代理自动检测结果（只读；无需用户配置） */
    PROXY_INFO:      chan(PREFIX.AI, "proxyInfo"),
    /** AI 追问建议：基于一轮问答产出 2-3 条下一步可问的短问题 */
    FOLLOW_UPS:      chan(PREFIX.AI, "followUps"),
  },
  AGENT: {
    /** 发起一轮对话（立即返回 conversationId/messageId，内容走 agent:chunk 事件流） */
    CHAT:   chan(PREFIX.AGENT, "chat"),
    /** 中断当前生成 */
    STOP:   chan(PREFIX.AGENT, "stop"),
    /** provider 配置状态（mock/live），供 UI 显示模式横幅 */
    STATUS: chan(PREFIX.AGENT, "status"),
    /** 会话列表（按更新时间倒序） */
    LIST_CONVERSATIONS:  chan(PREFIX.AGENT, "listConversations"),
    /** 单会话的全部消息 */
    GET_CONVERSATION:    chan(PREFIX.AGENT, "getConversation"),
    RENAME_CONVERSATION: chan(PREFIX.AGENT, "renameConversation"),
    DELETE_CONVERSATION: chan(PREFIX.AGENT, "deleteConversation"),
    /** 写操作审批结论回填（approved → 恢复执行；rejected → 模型收到拒绝消息） */
    RESOLVE_APPROVAL: chan(PREFIX.AGENT, "resolveApproval"),
    /** AI 活动审计：最近 N 条工具调用记录（设置页展示） */
    TOOL_CALLS: chan(PREFIX.AGENT, "toolCalls"),
    /** 执行结果卡上的「写入类」动作（动作闭包留在主进程注册表，渲染端只传 id） */
    RUN_ACTION: chan(PREFIX.AGENT, "runAction"),
    /** 产物卡「打开位置」：在资源管理器里高亮该文件（仅允许 outputs/agent 目录内） */
    OPEN_PATH: chan(PREFIX.AGENT, "openPath"),
    /** 后台任务快照（任务卡挂载时取一次，此后靠 agent:task 事件增量刷新） */
    GET_TASK: chan(PREFIX.AGENT, "getTask"),
    /** 取消后台任务（当前项做完即停） */
    CANCEL_TASK: chan(PREFIX.AGENT, "cancelTask"),
    /** 导出诊断包（日志尾部+配置掩码快照+库行数+最近异常 → outputs/agent 的 md） */
    EXPORT_DIAGNOSTICS: chan(PREFIX.AGENT, "exportDiagnostics"),
    /** 能力缺口台账清单（按被抱怨次数降序；/缺口 命令查看） */
    LIST_GAPS: chan(PREFIX.AGENT, "listGaps"),
  },
  RATES: {
    /** 从快照文件全量刷新本地运价镜像 */
    SYNC:   chan(PREFIX.RATES, "sync"),
    /** 条件查价（航线/船司/目的港/柜型） */
    LIST:   chan(PREFIX.RATES, "list"),
    /** 镜像统计（总数/有效数/最近同步/快照新鲜度） */
    STATUS: chan(PREFIX.RATES, "status"),
  },
  KB: {
    /** 读取 KB 中转配置（baseUrl/令牌是否已配/生效端点，不含明文令牌） */
    CONFIG_GET: chan(PREFIX.KB, "getConfig"),
    /** 写入/清除 KB 中转配置（落到 .env） */
    CONFIG_SET: chan(PREFIX.KB, "setConfig"),
    /** 离线预览：返回将发出的真实请求（令牌脱敏），验证两层鉴权不串位 */
    PREVIEW:    chan(PREFIX.KB, "preview"),
    /** 连通性 + 鉴权探针：无需真实业务接口即可判断 KB 是否可达、令牌是否有效 */
    TEST_CONNECTION: chan(PREFIX.KB, "testConnection"),
    /** 实际发起一次 http-dispatch 中转调用 */
    DISPATCH:   chan(PREFIX.KB, "dispatch"),
  },
  SYSTEM: {
    GET_CONFIG:       chan(PREFIX.SYSTEM, "getConfig"),
    UPDATE_CONFIG:    chan(PREFIX.SYSTEM, "updateConfig"),
    GET_LOGS:         chan(PREFIX.SYSTEM, "getLogs"),
    APP_VERSION:      chan(PREFIX.SYSTEM, "appVersion"),
    SELECT_DIRECTORY: chan(PREFIX.SYSTEM, "selectDirectory"),
    OPEN_PATH:        chan(PREFIX.SYSTEM, "openPath"),
    /** 开机自启开关（新手向导用，Windows 登录项） */
    SET_AUTO_LAUNCH:  chan(PREFIX.SYSTEM, "setAutoLaunch"),
  },
  UPDATE: {
    CHECK:        chan(PREFIX.UPDATE, "check"),
    DOWNLOAD:     chan(PREFIX.UPDATE, "download"),
    INSTALL:      chan(PREFIX.UPDATE, "install"),
    LIST_VERSIONS: chan(PREFIX.UPDATE, "listVersions"),
    SET_CHANNEL:  chan(PREFIX.UPDATE, "setChannel"),
    GET_CHANNEL:  chan(PREFIX.UPDATE, "getChannel"),
  },
} as const;

/** 所有通道名的联合类型 */
export type IPCChannel = {
  [D in keyof typeof IPC]: {
    [A in keyof (typeof IPC)[D]]: (typeof IPC)[D][A];
  }[keyof (typeof IPC)[D]];
}[keyof typeof IPC];
