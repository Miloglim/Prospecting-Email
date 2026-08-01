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
  SYSTEM:    "system",
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
  },
  COMPANIES: {
    LIST:      chan(PREFIX.COMPANIES, "list"),
    GET_BY_ID: chan(PREFIX.COMPANIES, "getById"),
    UPSERT:    chan(PREFIX.COMPANIES, "upsert"),
    DELETE:    chan(PREFIX.COMPANIES, "delete"),
  },
  SEND: {
    START:        chan(PREFIX.SEND, "start"),
    PAUSE:        chan(PREFIX.SEND, "pause"),
    RESUME:       chan(PREFIX.SEND, "resume"),
    STATUS:       chan(PREFIX.SEND, "status"),
    RETRY_FAILED: chan(PREFIX.SEND, "retryFailed"),
    TEST:         chan(PREFIX.SEND, "test"),
  },
  INBOX: {
    FETCH:    chan(PREFIX.INBOX, "fetch"),
    CLASSIFY: chan(PREFIX.INBOX, "classify"),
  },
  CRM: {
    LIST_PIPELINE: chan(PREFIX.CRM, "listPipeline"),
    SET_STAGE:     chan(PREFIX.CRM, "setStage"),
    ADD_REMINDER:  chan(PREFIX.CRM, "addReminder"),
    LIST_RELATIONS: chan(PREFIX.CRM, "listRelations"),
    ADD_RELATION:   chan(PREFIX.CRM, "addRelation"),
    GET_DETAIL:     chan(PREFIX.CRM, "getDetail"),
    CHECK_REMINDERS:chan(PREFIX.CRM, "checkReminders"),
  },
  TEMPLATES: {
    LIST:   chan(PREFIX.TEMPLATES, "list"),
    UPSERT: chan(PREFIX.TEMPLATES, "upsert"),
    DELETE: chan(PREFIX.TEMPLATES, "delete"),
  },
  ACCOUNTS: {
    LIST:           chan(PREFIX.ACCOUNTS, "list"),
    VALIDATE:       chan(PREFIX.ACCOUNTS, "validate"),
    CIRCUIT_STATUS: chan(PREFIX.ACCOUNTS, "circuitStatus"),
    UPSERT:         chan(PREFIX.ACCOUNTS, "upsert"),
    DELETE:         chan(PREFIX.ACCOUNTS, "delete"),
  },
  EXPORT: {
    CONTACTS_TO_EXCEL: chan(PREFIX.EXPORT, "contactsToExcel"),
  },
  DASHBOARD: {
    STATS: chan(PREFIX.DASHBOARD, "stats"),
  },
  SYSTEM: {
    GET_CONFIG:    chan(PREFIX.SYSTEM, "getConfig"),
    UPDATE_CONFIG: chan(PREFIX.SYSTEM, "updateConfig"),
    GET_LOGS:      chan(PREFIX.SYSTEM, "getLogs"),
    APP_VERSION:   chan(PREFIX.SYSTEM, "appVersion"),
  },
} as const;

/** 所有通道名的联合类型 */
export type IPCChannel = {
  [D in keyof typeof IPC]: {
    [A in keyof (typeof IPC)[D]]: (typeof IPC)[D][A];
  }[keyof (typeof IPC)[D]];
}[keyof typeof IPC];
