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
  },
  AGENT: {
    /** 发起一轮对话（立即返回 conversationId/messageId，内容走 agent:chunk 事件流） */
    CHAT:   chan(PREFIX.AGENT, "chat"),
    /** 中断当前生成 */
    STOP:   chan(PREFIX.AGENT, "stop"),
    /** provider 配置状态（mock/live），供 UI 显示模式横幅 */
    STATUS: chan(PREFIX.AGENT, "status"),
  },
  SYSTEM: {
    GET_CONFIG:       chan(PREFIX.SYSTEM, "getConfig"),
    UPDATE_CONFIG:    chan(PREFIX.SYSTEM, "updateConfig"),
    GET_LOGS:         chan(PREFIX.SYSTEM, "getLogs"),
    APP_VERSION:      chan(PREFIX.SYSTEM, "appVersion"),
    SELECT_DIRECTORY: chan(PREFIX.SYSTEM, "selectDirectory"),
    OPEN_PATH:        chan(PREFIX.SYSTEM, "openPath"),
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
