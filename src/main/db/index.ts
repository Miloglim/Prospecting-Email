import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle, type drizzle as DrizzleType } from "drizzle-orm/sql-js";
import * as schema from "./schema";
import { DB_PATH } from "../config";
import { Log } from "../logger";
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
  first_name text, last_name text, title text, phone text, linkedin_url text,
  company_id integer, country text, client_type text,
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
  matched_contact_id integer,
  is_read integer DEFAULT 0 NOT NULL,
  received_at text NOT NULL, raw_source text,
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
  category text, version integer DEFAULT 1 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
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

  Log.info("db.migrations", `${statements.length} 条建表语句已执行`);
}
