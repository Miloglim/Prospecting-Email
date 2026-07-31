"use strict";
const electron = require("electron");
const path = require("path");
const initSqlJs = require("sql.js");
const sqlJs = require("drizzle-orm/sql-js");
const sqliteCore = require("drizzle-orm/sqlite-core");
const drizzleOrm = require("drizzle-orm");
const fs = require("fs");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const contacts = sqliteCore.sqliteTable("contacts", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  email: sqliteCore.text("email").notNull().unique(),
  firstName: sqliteCore.text("first_name"),
  lastName: sqliteCore.text("last_name"),
  title: sqliteCore.text("title"),
  phone: sqliteCore.text("phone"),
  linkedinUrl: sqliteCore.text("linkedin_url"),
  companyId: sqliteCore.integer("company_id"),
  // 自定义字段
  customStr1: sqliteCore.text("custom_str1"),
  customStr2: sqliteCore.text("custom_str2"),
  customStr3: sqliteCore.text("custom_str3"),
  customStr4: sqliteCore.text("custom_str4"),
  customStr5: sqliteCore.text("custom_str5"),
  customNum1: sqliteCore.integer("custom_num1"),
  customNum2: sqliteCore.integer("custom_num2"),
  customNum3: sqliteCore.integer("custom_num3"),
  customNum4: sqliteCore.integer("custom_num4"),
  customNum5: sqliteCore.integer("custom_num5"),
  customDate1: sqliteCore.text("custom_date1"),
  customDate2: sqliteCore.text("custom_date2"),
  customDate3: sqliteCore.text("custom_date3"),
  customDate4: sqliteCore.text("custom_date4"),
  customDate5: sqliteCore.text("custom_date5"),
  source: sqliteCore.text("source").default("manual"),
  sourceDetail: sqliteCore.text("source_detail"),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`),
  updatedAt: sqliteCore.text("updated_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const companies = sqliteCore.sqliteTable("companies", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  name: sqliteCore.text("name").notNull(),
  domain: sqliteCore.text("domain"),
  industry: sqliteCore.text("industry"),
  country: sqliteCore.text("country"),
  size: sqliteCore.text("size"),
  backcheckData: sqliteCore.text("backcheck_data"),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`),
  updatedAt: sqliteCore.text("updated_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const emailAccounts = sqliteCore.sqliteTable("email_accounts", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  email: sqliteCore.text("email").notNull().unique(),
  provider: sqliteCore.text("provider").notNull().default("smtp"),
  smtpHost: sqliteCore.text("smtp_host"),
  smtpPort: sqliteCore.integer("smtp_port"),
  imapHost: sqliteCore.text("imap_host"),
  imapPort: sqliteCore.integer("imap_port"),
  encryptedPass: sqliteCore.text("encrypted_pass").notNull(),
  displayName: sqliteCore.text("display_name"),
  signature: sqliteCore.text("signature"),
  consecutiveFails: sqliteCore.integer("consecutive_fails").notNull().default(0),
  circuitOpenAt: sqliteCore.text("circuit_open_at"),
  circuitResetAfter: sqliteCore.text("circuit_reset_after"),
  isActive: sqliteCore.integer("is_active").notNull().default(1),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const interactions = sqliteCore.sqliteTable("interactions", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  contactId: sqliteCore.integer("contact_id").references(() => contacts.id).notNull(),
  type: sqliteCore.text("type").notNull(),
  direction: sqliteCore.text("direction").notNull(),
  channel: sqliteCore.text("channel").notNull().default("email"),
  subject: sqliteCore.text("subject"),
  bodyPreview: sqliteCore.text("body_preview"),
  messageId: sqliteCore.text("message_id"),
  accountId: sqliteCore.integer("account_id").references(() => emailAccounts.id),
  metadata: sqliteCore.text("metadata"),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const crmStages = sqliteCore.sqliteTable("crm_stages", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  contactId: sqliteCore.integer("contact_id").references(() => contacts.id).notNull().unique(),
  stage: sqliteCore.text("stage").notNull(),
  notes: sqliteCore.text("notes"),
  reminderAt: sqliteCore.text("reminder_at"),
  reminderNote: sqliteCore.text("reminder_note"),
  updatedAt: sqliteCore.text("updated_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const crmRelations = sqliteCore.sqliteTable("crm_relations", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  contactIdA: sqliteCore.integer("contact_id_a").references(() => contacts.id).notNull(),
  contactIdB: sqliteCore.integer("contact_id_b").references(() => contacts.id).notNull(),
  relationType: sqliteCore.text("relation_type").notNull(),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const inboxMessages = sqliteCore.sqliteTable("inbox_messages", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  accountId: sqliteCore.integer("account_id").references(() => emailAccounts.id).notNull(),
  messageId: sqliteCore.text("message_id"),
  fromEmail: sqliteCore.text("from_email").notNull(),
  fromName: sqliteCore.text("from_name"),
  subject: sqliteCore.text("subject"),
  bodyPreview: sqliteCore.text("body_preview"),
  classification: sqliteCore.text("classification"),
  matchedContactId: sqliteCore.integer("matched_contact_id"),
  isRead: sqliteCore.integer("is_read").notNull().default(0),
  receivedAt: sqliteCore.text("received_at").notNull(),
  rawSource: sqliteCore.text("raw_source"),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const templates = sqliteCore.sqliteTable("templates", {
  id: sqliteCore.integer("id").primaryKey({ autoIncrement: true }),
  name: sqliteCore.text("name").notNull(),
  language: sqliteCore.text("language").notNull(),
  subject: sqliteCore.text("subject").notNull(),
  body: sqliteCore.text("body").notNull(),
  category: sqliteCore.text("category"),
  version: sqliteCore.integer("version").notNull().default(1),
  isActive: sqliteCore.integer("is_active").notNull().default(1),
  createdAt: sqliteCore.text("created_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`),
  updatedAt: sqliteCore.text("updated_at").notNull().default(drizzleOrm.sql`CURRENT_TIMESTAMP`)
});
const schema = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  companies,
  contacts,
  crmRelations,
  crmStages,
  emailAccounts,
  inboxMessages,
  interactions,
  templates
}, Symbol.toStringTag, { value: "Module" }));
function getAppRoot() {
  try {
    const { app } = require("electron");
    return app.isPackaged ? app.getPath("userData") : path__namespace.resolve(__dirname, "..", "..");
  } catch {
    return path__namespace.resolve(__dirname, "..", "..");
  }
}
const APP_ROOT = getAppRoot();
const DB_PATH = path__namespace.join(APP_ROOT, "data", "prospector.db");
const CONFIG_PATH = path__namespace.join(APP_ROOT, "send", "config.json");
const DEFAULT_CONFIG = {
  smtpAccounts: [],
  schedule: {
    minDelaySeconds: 30,
    maxPerBatch: 50
  }
};
function loadConfig() {
  if (!fs__namespace.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  return JSON.parse(fs__namespace.readFileSync(CONFIG_PATH, "utf-8"));
}
function saveConfig(config) {
  const dir = path__namespace.dirname(CONFIG_PATH);
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  fs__namespace.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
const LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function createLogger(opts = {}) {
  const minLevel = LEVEL_ORDER[opts.level || "debug"] || 0;
  function formatTime() {
    const now = /* @__PURE__ */ new Date();
    const shanghai = new Date(now.getTime() + 8 * 36e5);
    return shanghai.toISOString().replace("T", " ").slice(0, 19);
  }
  function write(level, ctx, msg, extra) {
    if (LEVEL_ORDER[level] < minLevel) return;
    const line = `[${formatTime()}] [${level.toUpperCase()}] [${ctx}] ${msg}${extra ? "\n" + extra : ""}`;
    if (opts.writeFn) {
      opts.writeFn(line);
    } else {
      switch (level) {
        case "error":
          console.error(line);
          break;
        case "warn":
          console.warn(line);
          break;
        default:
          console.log(line);
      }
    }
  }
  return {
    debug(ctx, msg) {
      write("debug", ctx, msg);
    },
    info(ctx, msg) {
      write("info", ctx, msg);
    },
    warn(ctx, msg) {
      write("warn", ctx, msg);
    },
    error(ctx, msg, stack) {
      write("error", ctx, msg, stack);
    }
  };
}
const Log = createLogger();
let dbInstance = null;
let sqlJsDb = null;
async function initDatabase() {
  const dir = path__namespace.dirname(DB_PATH);
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  Log.info("db.init", `数据库路径: ${DB_PATH}`);
  const SQL = await initSqlJs();
  if (fs__namespace.existsSync(DB_PATH)) {
    const buffer = fs__namespace.readFileSync(DB_PATH);
    sqlJsDb = new SQL.Database(buffer);
    Log.info("db.init", `已加载现有数据库 (${(buffer.length / 1024).toFixed(1)} KB)`);
  } else {
    sqlJsDb = new SQL.Database();
    Log.info("db.init", "创建新数据库");
  }
  sqlJsDb.run("PRAGMA journal_mode=WAL");
  sqlJsDb.run("PRAGMA foreign_keys=ON");
  dbInstance = sqlJs.drizzle(sqlJsDb, { schema });
  return dbInstance;
}
function getDb() {
  if (!dbInstance) throw new Error("数据库未初始化，先调用 initDatabase()");
  return dbInstance;
}
function saveDatabase() {
  if (!sqlJsDb) return;
  const data = sqlJsDb.export();
  const buffer = Buffer.from(data);
  const dir = path__namespace.dirname(DB_PATH);
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  fs__namespace.writeFileSync(DB_PATH, buffer);
}
function runMigrations() {
  if (!sqlJsDb) throw new Error("数据库未初始化");
  const migrationsDir = path__namespace.resolve(__dirname, "..", "db", "migrations");
  if (!fs__namespace.existsSync(migrationsDir)) {
    Log.info("db.migrations", "无迁移目录，跳过");
    return;
  }
  const files = fs__namespace.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    Log.info("db.migrations", "无迁移文件");
    return;
  }
  for (const file of files) {
    const sql = fs__namespace.readFileSync(path__namespace.join(migrationsDir, file), "utf-8");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try {
        sqlJsDb.run(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          Log.error("db.migrations", `${file} 执行失败: ${stmt.slice(0, 60)}`, msg);
          throw err;
        }
      }
    }
  }
  Log.info("db.migrations", `${files.length} 个迁移已执行`);
}
const PREFIX = {
  CONTACTS: "contacts",
  COMPANIES: "companies",
  SEND: "send",
  INBOX: "inbox",
  CRM: "crm",
  TEMPLATES: "templates",
  ACCOUNTS: "accounts",
  EXPORT: "export",
  DASHBOARD: "dashboard",
  SYSTEM: "system"
};
function chan(domain, action) {
  return `${domain}:${action}`;
}
const IPC = {
  CONTACTS: {
    LIST: chan(PREFIX.CONTACTS, "list"),
    GET_BY_ID: chan(PREFIX.CONTACTS, "getById"),
    UPSERT: chan(PREFIX.CONTACTS, "upsert"),
    DELETE: chan(PREFIX.CONTACTS, "delete"),
    COUNT: chan(PREFIX.CONTACTS, "count")
  },
  COMPANIES: {
    LIST: chan(PREFIX.COMPANIES, "list"),
    GET_BY_ID: chan(PREFIX.COMPANIES, "getById"),
    UPSERT: chan(PREFIX.COMPANIES, "upsert"),
    DELETE: chan(PREFIX.COMPANIES, "delete")
  },
  SEND: {
    START: chan(PREFIX.SEND, "start"),
    PAUSE: chan(PREFIX.SEND, "pause"),
    RESUME: chan(PREFIX.SEND, "resume"),
    STATUS: chan(PREFIX.SEND, "status"),
    RETRY_FAILED: chan(PREFIX.SEND, "retryFailed"),
    TEST: chan(PREFIX.SEND, "test")
  },
  INBOX: {
    FETCH: chan(PREFIX.INBOX, "fetch"),
    CLASSIFY: chan(PREFIX.INBOX, "classify")
  },
  CRM: {
    LIST_PIPELINE: chan(PREFIX.CRM, "listPipeline"),
    SET_STAGE: chan(PREFIX.CRM, "setStage"),
    ADD_REMINDER: chan(PREFIX.CRM, "addReminder"),
    LIST_RELATIONS: chan(PREFIX.CRM, "listRelations")
  },
  TEMPLATES: {
    LIST: chan(PREFIX.TEMPLATES, "list"),
    UPSERT: chan(PREFIX.TEMPLATES, "upsert"),
    DELETE: chan(PREFIX.TEMPLATES, "delete")
  },
  ACCOUNTS: {
    LIST: chan(PREFIX.ACCOUNTS, "list"),
    VALIDATE: chan(PREFIX.ACCOUNTS, "validate"),
    CIRCUIT_STATUS: chan(PREFIX.ACCOUNTS, "circuitStatus"),
    UPSERT: chan(PREFIX.ACCOUNTS, "upsert"),
    DELETE: chan(PREFIX.ACCOUNTS, "delete")
  },
  EXPORT: {
    CONTACTS_TO_EXCEL: chan(PREFIX.EXPORT, "contactsToExcel")
  },
  DASHBOARD: {
    STATS: chan(PREFIX.DASHBOARD, "stats")
  },
  SYSTEM: {
    GET_CONFIG: chan(PREFIX.SYSTEM, "getConfig"),
    UPDATE_CONFIG: chan(PREFIX.SYSTEM, "updateConfig"),
    APP_VERSION: chan(PREFIX.SYSTEM, "appVersion")
  }
};
function okResult(data) {
  return { success: true, data };
}
function failResult(error, cause) {
  return { success: false, error, cause };
}
async function getContactById(id) {
  Log.debug("contact.getById", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }
  const row = getDb().select().from(contacts).where(drizzleOrm.eq(contacts.id, id)).get();
  if (!row) {
    return failResult(`联系人不存在: id=${id}`);
  }
  return okResult(row);
}
async function listContacts(params) {
  Log.debug("contact.list", JSON.stringify(params));
  const page = params?.page || 1;
  const pageSize = params?.pageSize || 50;
  const search = params?.search?.trim();
  let query = getDb().select().from(contacts);
  if (search) {
    const pattern = `%${search}%`;
    query = query.where(
      drizzleOrm.or(
        drizzleOrm.like(contacts.email, pattern),
        drizzleOrm.like(contacts.firstName, pattern),
        drizzleOrm.like(contacts.lastName, pattern),
        drizzleOrm.like(contacts.title, pattern)
      )
    );
  }
  const all = query.all();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return okResult({ items, total });
}
async function upsertContact(input) {
  Log.debug("contact.upsert", `email=${input.email}`);
  if (!input.email) {
    return failResult("email 必填");
  }
  const existing = getDb().select().from(contacts).where(drizzleOrm.eq(contacts.email, input.email)).get();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (existing) {
    getDb().update(contacts).set({
      ...input,
      updatedAt: now
    }).where(drizzleOrm.eq(contacts.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(contacts).where(drizzleOrm.eq(contacts.id, existing.id)).get();
    return okResult(updated);
  }
  getDb().insert(contacts).values({
    ...input,
    createdAt: now,
    updatedAt: now
  }).run();
  saveDatabase();
  const created = getDb().select().from(contacts).where(drizzleOrm.eq(contacts.email, input.email)).get();
  return okResult(created);
}
async function deleteContact(id) {
  Log.debug("contact.delete", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }
  const existing = getDb().select().from(contacts).where(drizzleOrm.eq(contacts.id, id)).get();
  if (!existing) {
    return failResult(`联系人不存在: id=${id}`);
  }
  getDb().delete(contacts).where(drizzleOrm.eq(contacts.id, id)).run();
  saveDatabase();
  return okResult(void 0);
}
function registerContactIPC() {
  electron.ipcMain.handle(IPC.CONTACTS.GET_BY_ID, async (_e, id) => {
    Log.debug("ipc.contact.getById", `id=${id}`);
    if (id == null || typeof id !== "number") return failResult("参数错误: id 必须是数字");
    return getContactById(id);
  });
  electron.ipcMain.handle(IPC.CONTACTS.LIST, async (_e, params) => {
    Log.debug("ipc.contact.list", JSON.stringify(params));
    return listContacts(params || {});
  });
  electron.ipcMain.handle(IPC.CONTACTS.UPSERT, async (_e, input) => {
    Log.debug("ipc.contact.upsert", `email=${input?.email}`);
    if (!input?.email) return failResult("参数错误: email 必填");
    return upsertContact(input);
  });
  electron.ipcMain.handle(IPC.CONTACTS.DELETE, async (_e, id) => {
    Log.debug("ipc.contact.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return deleteContact(id);
  });
  electron.ipcMain.handle(IPC.CONTACTS.COUNT, async (_e, _params) => {
    Log.debug("ipc.contact.count", "");
    const result = await listContacts({ page: 1, pageSize: 1 });
    if (!result.success) return result;
    return { success: true, data: result.data.total };
  });
}
async function getCompanyById(id) {
  Log.debug("company.getById", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }
  const row = getDb().select().from(companies).where(drizzleOrm.eq(companies.id, id)).get();
  if (!row) {
    return failResult(`公司不存在: id=${id}`);
  }
  return okResult(row);
}
async function listCompanies(search) {
  Log.debug("company.list", `search=${search}`);
  let query = getDb().select().from(companies);
  if (search?.trim()) {
    const pattern = `%${search.trim()}%`;
    query = query.where(
      drizzleOrm.or(drizzleOrm.like(companies.name, pattern), drizzleOrm.like(companies.domain, pattern))
    );
  }
  return okResult(query.all());
}
async function upsertCompany(input) {
  Log.debug("company.upsert", `name=${input.name}`);
  if (!input.name) {
    return failResult("公司名称必填");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let existing;
  if (input.domain) {
    existing = getDb().select().from(companies).where(drizzleOrm.eq(companies.domain, input.domain)).get();
  }
  if (!existing) {
    existing = getDb().select().from(companies).where(drizzleOrm.eq(companies.name, input.name)).get();
  }
  if (existing) {
    getDb().update(companies).set({ ...input, updatedAt: now }).where(drizzleOrm.eq(companies.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(companies).where(drizzleOrm.eq(companies.id, existing.id)).get();
    return okResult(updated);
  }
  getDb().insert(companies).values({ ...input, createdAt: now, updatedAt: now }).run();
  saveDatabase();
  const created = getDb().select().from(companies).where(drizzleOrm.eq(companies.name, input.name)).get();
  return okResult(created);
}
async function deleteCompany(id) {
  Log.debug("company.delete", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }
  const existing = getDb().select().from(companies).where(drizzleOrm.eq(companies.id, id)).get();
  if (!existing) {
    return failResult(`公司不存在: id=${id}`);
  }
  getDb().delete(companies).where(drizzleOrm.eq(companies.id, id)).run();
  saveDatabase();
  return okResult(void 0);
}
function registerCompanyIPC() {
  electron.ipcMain.handle(IPC.COMPANIES.GET_BY_ID, async (_e, id) => {
    Log.debug("ipc.company.getById", `id=${id}`);
    if (id == null || typeof id !== "number") return failResult("参数错误: id 必须是数字");
    return getCompanyById(id);
  });
  electron.ipcMain.handle(IPC.COMPANIES.LIST, async (_e, search) => {
    Log.debug("ipc.company.list", `search=${search}`);
    return listCompanies(search);
  });
  electron.ipcMain.handle(IPC.COMPANIES.UPSERT, async (_e, input) => {
    Log.debug("ipc.company.upsert", `name=${input?.name}`);
    if (!input?.name) return failResult("参数错误: name 必填");
    return upsertCompany(input);
  });
  electron.ipcMain.handle(IPC.COMPANIES.DELETE, async (_e, id) => {
    Log.debug("ipc.company.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return deleteCompany(id);
  });
}
function registerSendIPC() {
  electron.ipcMain.handle(IPC.SEND.STATUS, () => {
    Log.debug("ipc.send.status", "");
    return okResult({ queueLength: 0, sentToday: 0, isPaused: false, currentBatch: null });
  });
  electron.ipcMain.handle(IPC.SEND.START, (_e, _config) => {
    return failResult("发送引擎尚未集成");
  });
  electron.ipcMain.handle(IPC.SEND.PAUSE, () => okResult(void 0));
  electron.ipcMain.handle(IPC.SEND.RESUME, () => okResult(void 0));
  electron.ipcMain.handle(IPC.SEND.RETRY_FAILED, (_e, _batchId) => failResult("尚未集成"));
  electron.ipcMain.handle(IPC.SEND.TEST, (_e, _input) => failResult("尚未集成"));
}
function registerInboxIPC() {
  electron.ipcMain.handle(IPC.INBOX.FETCH, (_e, _accountId) => {
    Log.debug("ipc.inbox.fetch", "");
    return okResult([]);
  });
  electron.ipcMain.handle(IPC.INBOX.CLASSIFY, (_e, _id) => {
    return failResult("收件箱分类尚未集成");
  });
}
const STAGES = ["new", "contacted", "replied", "interested", "negotiating", "won", "lost"];
async function listPipeline() {
  Log.debug("crm.listPipeline", "");
  const db = getDb();
  const rows = db.select({
    stageId: crmStages.id,
    contactId: contacts.id,
    email: contacts.email,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    companyName: companies.name,
    stage: crmStages.stage,
    notes: crmStages.notes,
    reminderAt: crmStages.reminderAt
  }).from(crmStages).innerJoin(contacts, drizzleOrm.eq(crmStages.contactId, contacts.id)).leftJoin(companies, drizzleOrm.eq(contacts.companyId, companies.id)).all();
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const stage = row.stage || "new";
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage).push(row);
  }
  const result = STAGES.map((stage) => ({
    stage,
    contacts: (grouped.get(stage) || []).map((r) => ({
      id: r.contactId,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      companyName: r.companyName,
      notes: r.notes,
      reminderAt: r.reminderAt
    }))
  }));
  return okResult(result);
}
async function setStage(contactId, stage) {
  Log.debug("crm.setStage", `contactId=${contactId} stage=${stage}`);
  if (!STAGES.includes(stage)) {
    return failResult(`无效的阶段: ${stage}，有效值: ${STAGES.join(", ")}`);
  }
  const existing = getDb().select().from(crmStages).where(drizzleOrm.eq(crmStages.contactId, contactId)).get();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (existing) {
    getDb().update(crmStages).set({ stage, updatedAt: now }).where(drizzleOrm.eq(crmStages.id, existing.id)).run();
  } else {
    getDb().insert(crmStages).values({ contactId, stage, updatedAt: now }).run();
  }
  saveDatabase();
  return okResult(void 0);
}
async function addReminder(contactId, reminderAt, note) {
  Log.debug("crm.addReminder", `contactId=${contactId} at=${reminderAt}`);
  const existing = getDb().select().from(crmStages).where(drizzleOrm.eq(crmStages.contactId, contactId)).get();
  if (!existing) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    getDb().insert(crmStages).values({
      contactId,
      stage: "contacted",
      reminderAt,
      reminderNote: note,
      updatedAt: now
    }).run();
  } else {
    getDb().update(crmStages).set({ reminderAt, reminderNote: note }).where(drizzleOrm.eq(crmStages.id, existing.id)).run();
  }
  saveDatabase();
  return okResult(void 0);
}
async function listRelations(contactId) {
  Log.debug("crm.listRelations", `contactId=${contactId}`);
  const db = getDb();
  const relations = db.select().from(crmRelations).where(drizzleOrm.eq(crmRelations.contactIdA, contactId)).all();
  const reverse = db.select().from(crmRelations).where(drizzleOrm.eq(crmRelations.contactIdB, contactId)).all();
  return okResult([...relations, ...reverse]);
}
function registerCrmIPC() {
  electron.ipcMain.handle(IPC.CRM.LIST_PIPELINE, async () => {
    Log.debug("ipc.crm.listPipeline", "");
    return listPipeline();
  });
  electron.ipcMain.handle(IPC.CRM.SET_STAGE, async (_e, params) => {
    Log.debug("ipc.crm.setStage", `id=${params?.contactId} stage=${params?.stage}`);
    if (!params?.contactId || !params?.stage) return failResult("参数错误: contactId 和 stage 必填");
    return setStage(params.contactId, params.stage);
  });
  electron.ipcMain.handle(IPC.CRM.ADD_REMINDER, async (_e, params) => {
    Log.debug("ipc.crm.addReminder", `id=${params?.contactId}`);
    return addReminder(params?.contactId, params?.reminderAt, params?.reminderNote);
  });
  electron.ipcMain.handle(IPC.CRM.LIST_RELATIONS, async (_e, contactId) => {
    Log.debug("ipc.crm.listRelations", `id=${contactId}`);
    return listRelations(contactId);
  });
}
async function listTemplates(language) {
  Log.debug("template.list", `language=${language}`);
  let query = getDb().select().from(templates);
  if (language) {
    query = query.where(drizzleOrm.eq(templates.language, language));
  }
  return okResult(query.all().filter((t) => t.isActive === 1));
}
async function upsertTemplate(input) {
  Log.debug("template.upsert", `name=${input.name}`);
  if (!input.name || !input.subject || !input.body) {
    return failResult("name、subject、body 必填");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existing = getDb().select().from(templates).where(drizzleOrm.and(drizzleOrm.eq(templates.name, input.name), drizzleOrm.eq(templates.language, input.language || "EN"))).get();
  if (existing) {
    getDb().update(templates).set({
      ...input,
      version: (existing.version || 1) + 1,
      updatedAt: now
    }).where(drizzleOrm.eq(templates.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(templates).where(drizzleOrm.eq(templates.id, existing.id)).get();
    return okResult(updated);
  }
  getDb().insert(templates).values({
    ...input,
    version: 1,
    createdAt: now,
    updatedAt: now
  }).run();
  saveDatabase();
  const created = getDb().select().from(templates).where(drizzleOrm.and(drizzleOrm.eq(templates.name, input.name), drizzleOrm.eq(templates.language, input.language || "EN"))).get();
  return okResult(created);
}
async function deleteTemplate(id) {
  Log.debug("template.delete", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }
  getDb().update(templates).set({ isActive: 0, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }).where(drizzleOrm.eq(templates.id, id)).run();
  saveDatabase();
  return okResult(void 0);
}
function registerTemplateIPC() {
  electron.ipcMain.handle(IPC.TEMPLATES.LIST, async (_e, language) => {
    Log.debug("ipc.template.list", `language=${language}`);
    return listTemplates(language);
  });
  electron.ipcMain.handle(IPC.TEMPLATES.UPSERT, async (_e, input) => {
    Log.debug("ipc.template.upsert", `name=${input?.name}`);
    if (!input?.name || !input?.subject || !input?.body) {
      return failResult("参数错误: name、subject、body 必填");
    }
    return upsertTemplate(input);
  });
  electron.ipcMain.handle(IPC.TEMPLATES.DELETE, async (_e, id) => {
    Log.debug("ipc.template.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return deleteTemplate(id);
  });
}
function registerAccountIPC() {
  electron.ipcMain.handle(IPC.ACCOUNTS.LIST, () => {
    Log.debug("ipc.accounts.list", "");
    return okResult([]);
  });
  electron.ipcMain.handle(IPC.ACCOUNTS.VALIDATE, (_e, _id) => {
    return failResult("账号验证尚未集成");
  });
  electron.ipcMain.handle(IPC.ACCOUNTS.CIRCUIT_STATUS, (_e, _id) => {
    return okResult({ consecutiveFails: 0, isOpen: false });
  });
  electron.ipcMain.handle(IPC.ACCOUNTS.UPSERT, (_e, _input) => {
    return failResult("账号管理尚未集成");
  });
  electron.ipcMain.handle(IPC.ACCOUNTS.DELETE, (_e, _id) => {
    return failResult("账号管理尚未集成");
  });
}
async function exportContactsToExcel(filter) {
  Log.debug("export.contactsToExcel", "");
  const result = await listContacts({ page: 1, pageSize: 99999, search: filter?.search });
  if (!result.success) {
    return failResult("导出失败: " + result.error);
  }
  const items = result.data.items;
  if (items.length === 0) {
    return failResult("没有可导出的联系人");
  }
  const headers = ["邮箱", "名", "姓", "职位", "电话", "LinkedIn", "公司ID", "来源", "创建时间"];
  const rows = items.map((c) => [
    c.email,
    c.firstName || "",
    c.lastName || "",
    c.title || "",
    c.phone || "",
    c.linkedinUrl || "",
    String(c.companyId || ""),
    c.source || "",
    c.createdAt || ""
  ]);
  const csvContent = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const bom = "\uFEFF";
  const content = bom + csvContent;
  return okResult(content);
}
function registerExportIPC() {
  electron.ipcMain.handle(IPC.EXPORT.CONTACTS_TO_EXCEL, async (_e, filter) => {
    Log.debug("ipc.export.contactsToExcel", "");
    return exportContactsToExcel(filter);
  });
}
function getStats() {
  Log.debug("dashboard.stats", "");
  const db = getDb();
  const totalContacts = db.select({ count: drizzleOrm.sql`count(*)` }).from(contacts).get()?.count || 0;
  const totalSent = db.select({ count: drizzleOrm.sql`count(*)` }).from(interactions).where(drizzleOrm.sql`type = 'sent'`).get()?.count || 0;
  const totalReplied = db.select({ count: drizzleOrm.sql`count(*)` }).from(interactions).where(drizzleOrm.sql`type = 'replied'`).get()?.count || 0;
  const bounceCount = db.select({ count: drizzleOrm.sql`count(*)` }).from(interactions).where(drizzleOrm.sql`type = 'bounced'`).get()?.count || 0;
  const stages = db.select({ stage: crmStages.stage, count: drizzleOrm.sql`count(*)` }).from(crmStages).groupBy(crmStages.stage).all();
  const pipelineSummary = {};
  for (const s of stages) {
    pipelineSummary[s.stage] = s.count;
  }
  const recentRows = db.select({
    type: interactions.type,
    contactEmail: contacts.email,
    subject: interactions.subject,
    createdAt: interactions.createdAt
  }).from(interactions).leftJoin(contacts, drizzleOrm.sql`${interactions.contactId} = ${contacts.id}`).orderBy(drizzleOrm.sql`${interactions.createdAt} DESC`).limit(10).all();
  const recentActivity = recentRows.map((r) => ({
    type: r.type,
    contactEmail: r.contactEmail || "未知",
    subject: r.subject,
    createdAt: r.createdAt
  }));
  const openRate = totalSent > 0 ? (bounceCount + totalReplied) / totalSent : 0;
  const replyRate = totalSent > 0 ? totalReplied / totalSent : 0;
  return okResult({
    totalContacts,
    totalSent,
    totalReplied,
    bounceCount,
    openRate: Math.round(openRate * 100) / 100,
    replyRate: Math.round(replyRate * 100) / 100,
    pipelineSummary,
    recentActivity
  });
}
function registerDashboardIPC() {
  electron.ipcMain.handle(IPC.DASHBOARD.STATS, () => {
    Log.debug("ipc.dashboard.stats", "");
    return getStats();
  });
}
function registerSystemIPC() {
  electron.ipcMain.handle(IPC.SYSTEM.GET_CONFIG, () => {
    try {
      return okResult(loadConfig());
    } catch (err) {
      return okResult({
        smtpAccounts: [],
        schedule: { minDelaySeconds: 30, maxPerBatch: 50 }
      });
    }
  });
  electron.ipcMain.handle(IPC.SYSTEM.UPDATE_CONFIG, (_e, partial) => {
    const current = loadConfig();
    const merged = { ...current, ...partial };
    saveConfig(merged);
    return okResult(void 0);
  });
  electron.ipcMain.handle(IPC.SYSTEM.APP_VERSION, () => {
    return okResult(electron.app.getVersion());
  });
}
let mainWindow = null;
let saveInterval = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Milogin's Prospector",
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path__namespace.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://localhost:5173");
  } else {
    mainWindow.loadFile(path__namespace.join(__dirname, "../renderer/index.html"));
  }
}
function registerAllIPC() {
  registerContactIPC();
  registerCompanyIPC();
  registerSendIPC();
  registerInboxIPC();
  registerCrmIPC();
  registerTemplateIPC();
  registerAccountIPC();
  registerExportIPC();
  registerDashboardIPC();
  registerSystemIPC();
  Log.info("ipc", "所有 IPC 通道注册完成");
}
electron.app.whenReady().then(async () => {
  await initDatabase();
  runMigrations();
  registerAllIPC();
  createWindow();
  saveInterval = setInterval(() => {
    saveDatabase();
  }, 3e4);
  Log.info("app", `启动完成，版本 ${electron.app.getVersion()}`);
});
electron.app.on("before-quit", () => {
  if (saveInterval) clearInterval(saveInterval);
  saveDatabase();
  Log.info("app", "正在退出...");
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("activate", () => {
  if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
});
