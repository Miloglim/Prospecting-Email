import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle, type drizzle as DrizzleType } from "drizzle-orm/sql-js";
import * as schema from "./schema";
import { DB_PATH } from "../config";
import { Log } from "../logger";
import { migrateTagsValue } from "./tags-migrate";
import * as path from "path";
import * as fs from "fs";

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>> & { $client: SqlJsDatabase };

let dbInstance: DrizzleDB | null = null;
let sqlJsDb: SqlJsDatabase | null = null;

/** 初始化数据库 — 必须在 app ready 后调用一次（异步 WASM 加载） */
export async function initDatabase(): Promise<DrizzleDB> {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  Log.info("db.init", `数据库路径: ${DB_PATH}`);

  // 加载 SQL.js WASM
  const SQL = await initSqlJs();

  // 如果已有数据库文件，加载；否则创建空库
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    sqlJsDb = new SQL.Database(buffer);
    Log.info("db.init", `已加载现有数据库 (${(buffer.length / 1024).toFixed(1)} KB)`);
  } else {
    sqlJsDb = new SQL.Database();
    Log.info("db.init", "创建新数据库");
  }

  // 启用 WAL 模式和 foreign keys
  sqlJsDb.run("PRAGMA journal_mode=WAL");
  sqlJsDb.run("PRAGMA foreign_keys=ON");

  dbInstance = drizzle(sqlJsDb, { schema }) as DrizzleDB;
  return dbInstance;
}

/** 获取数据库实例（需先 initDatabase） */
export function getDb(): DrizzleDB {
  if (!dbInstance) throw new Error("数据库未初始化，先调用 initDatabase()");
  return dbInstance;
}

/** 获取底层 sql.js 数据库实例（drizzle 不暴露 $client，供直接 SQL 查询用） */
export function getSqlJsDb(): SqlJsDatabase {
  if (!sqlJsDb) throw new Error("数据库未初始化，先调用 initDatabase()");
  return sqlJsDb;
}

/** 持久化数据库到磁盘。
 *  ponytail: sql.js 默认在内存中，定时调用此函数写入磁盘。
 *  后续可选：每次变更后自动保存。 */
export function saveDatabase(): void {
  if (!sqlJsDb) return;
  const data = sqlJsDb.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, buffer);
}

/** 应用启动时自动执行迁移。
 *  ponytail: sql.js 不支持 drizzle-kit migrate()，且迁移文件不打包进 dist，
 *  改为内嵌建表 SQL（幂等 CREATE TABLE IF NOT EXISTS） */
export function runMigrations(): void {
  if (!sqlJsDb) throw new Error("数据库未初始化");

  const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer,
  imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, domain text, industry text, country text, size text,
  backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  company_id integer, first_name text, last_name text,
  title text, phone text, linkedin text,
  country text, client_type text, language text,
  stage text DEFAULT 'cold',
  status text DEFAULT '',
  tags text,
  extra text DEFAULT '{}',
  assignee text DEFAULT '',
  source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_relations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id_a integer NOT NULL REFERENCES contacts(id),
  contact_id_b integer NOT NULL REFERENCES contacts(id),
  relation_type text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_stages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL UNIQUE REFERENCES contacts(id),
  stage text NOT NULL, notes text,
  reminder_at text, reminder_note text,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL REFERENCES email_accounts(id),
  message_id text, from_email text NOT NULL, from_name text,
  subject text, body_preview text, classification text,
  cc text, my_role text,
  matched_contact_id integer,
  is_read integer DEFAULT 0 NOT NULL,
  received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL REFERENCES contacts(id),
  type text NOT NULL, direction text NOT NULL,
  channel text DEFAULT 'email' NOT NULL,
  subject text, body_preview text, message_id text,
  account_id integer REFERENCES email_accounts(id),
  metadata text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, language text NOT NULL,
  subject text NOT NULL, body text NOT NULL,
  category text, stage text, version integer DEFAULT 1 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS send_queue (
  id text PRIMARY KEY NOT NULL,
  batch_id text NOT NULL,
  company_name text, company_id integer,
  recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  status text DEFAULT 'pending' NOT NULL,
  error text, sent_at text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON interactions(created_at);
`.trim();

  const statements = SCHEMA_SQL.split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    sqlJsDb.run(stmt + ";");
  }

  // ponytail: 旧库列迁移 — contacts 表删除冗余字段（DROP COLUMN 需 SQLite 3.35+，sql.js 支持）
  try {
    const cols = (sqlJsDb.exec("PRAGMA table_info(contacts)")[0]?.values || []).map(r => String(r[1]));
    for (const col of ["is_bounced", "bounce_reason", "last_sent_at", "last_sent_acct", "followup_note"]) {
      if (cols.includes(col)) sqlJsDb.run(`ALTER TABLE contacts DROP COLUMN ${col};`);
    }
  } catch { /* 表不存在或无此列 → 忽略 */ }

  // v4.1: templates 表补 stage 列
  try {
    const tcols = (sqlJsDb.exec("PRAGMA table_info(templates)")[0]?.values || []).map(r => String(r[1]));
    if (!tcols.includes("stage")) {
      sqlJsDb.run("ALTER TABLE templates ADD COLUMN stage text;");
      Log.info("db.migrate", "templates 表已添加 stage 列");
    }
  } catch { /* 表不存在 → 忽略 */ }

  // v4.2: send_queue 表补 tpl_body + contact_vars 列（body 延迟组装，不再持久化渲染后正文）
  try {
    const qcols = (sqlJsDb.exec("PRAGMA table_info(send_queue)")[0]?.values || []).map(r => String(r[1]));
    if (!qcols.includes("tpl_body")) sqlJsDb.run("ALTER TABLE send_queue ADD COLUMN tpl_body text;");
    if (!qcols.includes("contact_vars")) sqlJsDb.run("ALTER TABLE send_queue ADD COLUMN contact_vars text;");
    Log.info("db.migrate", "send_queue 表已添加 tpl_body/contact_vars 列");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.3: inbox_messages 补 cc + my_role 列（识别抄送，仅抄送不判已回复）
  try {
    const icols = (sqlJsDb.exec("PRAGMA table_info(inbox_messages)")[0]?.values || []).map(r => String(r[1]));
    if (!icols.includes("cc")) sqlJsDb.run("ALTER TABLE inbox_messages ADD COLUMN cc text;");
    if (!icols.includes("my_role")) sqlJsDb.run("ALTER TABLE inbox_messages ADD COLUMN my_role text;");
    Log.info("db.migrate", "inbox_messages 表已添加 cc/my_role 列");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.0: contacts 表补 language 列（国家+语言分离）
  try {
    const ccols = (sqlJsDb.exec("PRAGMA table_info(contacts)")[0]?.values || []).map(r => String(r[1]));
    if (!ccols.includes("language")) {
      sqlJsDb.run("ALTER TABLE contacts ADD COLUMN language text;");
      Log.info("db.migrate", "contacts 表已添加 language 列");
    }
  } catch { /* 忽略 */ }

  // v4.0: tags 收敛为固定 6 值分类（CRM 阶段）单选 — 丢弃自定义标签，只保留首个阶段 key
  try {
    const rows = sqlJsDb.exec("SELECT id, tags, status FROM contacts")[0]?.values || [];
    for (const r of rows) {
      const id = r[0] as number;
      const oldTags = String(r[1] || "");
      const status = String(r[2] || "");
      const newTags = migrateTagsValue(oldTags, status);
      if (newTags !== (oldTags || null)) {
        if (newTags === null) sqlJsDb.run("UPDATE contacts SET tags = NULL WHERE id = ?", [id]);
        else sqlJsDb.run("UPDATE contacts SET tags = ? WHERE id = ?", [newTags, id]);
      }
    }
  } catch { /* 表不存在 → 忽略 */ }

  // v4.1: 回填 inbox 关联 — 历史邮件 matched_contact_id 补全 + interactions 补记（幂等，lower 大小写不敏感）
  try {
    sqlJsDb.run(`
      UPDATE inbox_messages
      SET matched_contact_id = (
        SELECT c.id FROM contacts c
        WHERE lower(c.email) = lower(inbox_messages.from_email)
        LIMIT 1
      )
      WHERE matched_contact_id IS NULL
    `);
    const bfMatched = sqlJsDb.getRowsModified();
    sqlJsDb.run(`
      INSERT INTO interactions (contact_id, type, direction, channel, subject, body_preview, message_id, account_id, created_at)
      SELECT i.matched_contact_id,
             CASE i.classification WHEN 'bounce' THEN 'bounced' WHEN 'replied' THEN 'replied' WHEN 'autoreply' THEN 'autoreply' END,
             'inbound', 'email', i.subject, i.body_preview, i.message_id, i.account_id, i.received_at
      FROM inbox_messages i
      WHERE i.matched_contact_id IS NOT NULL
        AND i.classification IN ('bounce','replied','autoreply')
        AND NOT EXISTS (
          SELECT 1 FROM interactions it
          WHERE it.contact_id = i.matched_contact_id
            AND it.message_id = i.message_id
            AND it.type IN ('bounced','replied','autoreply')
        )
    `);
    const bfInteractions = sqlJsDb.getRowsModified();
    if (bfMatched > 0 || bfInteractions > 0) {
      Log.info("db.backfill", `inbox 关联回填: matched=${bfMatched} interactions=${bfInteractions}`);
    }
  } catch (e) {
    Log.warn("db.backfill", `回填失败: ${(e as Error).message}`);
  }

  Log.info("db.migrations", `${statements.length} 条建表语句已执行`);
}
