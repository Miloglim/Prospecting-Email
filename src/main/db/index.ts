import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database as RawDb } from "better-sqlite3";
import * as schema from "./schema";
import { DB_PATH } from "../config";
import { Log } from "../logger";
import { migrateTagsValue } from "./tags-migrate";
import * as path from "path";
import * as fs from "fs";

// ── P1-1：sql.js（内存全量导出）→ better-sqlite3（原生绑定，逐事务落盘 + 真 WAL）──
// 懒加载 require：原生绑定只在 initDatabase() 运行时加载（Electron ABI 编译产物），
// vitest 等 Node 环境 import 本模块不会触发原生加载，单测不受 ABI 影响。

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DrizzleDB | null = null;
let rawDb: RawDb | null = null;

/** 初始化数据库 — 必须在 app ready 后调用一次 */
export async function initDatabase(): Promise<DrizzleDB> {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  Log.info("db.init", `数据库路径: ${DB_PATH}`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3Ctor = require("better-sqlite3") as typeof import("better-sqlite3");
  const opened: RawDb = new BetterSqlite3Ctor(DB_PATH); // 文件不存在则创建；存在直接打开（SQLite 标准格式，旧库零转换）
  rawDb = opened;
  opened.pragma("journal_mode = WAL");     // 这次是真 WAL：读写不互斥、崩溃可恢复
  opened.pragma("foreign_keys = ON");
  opened.pragma("busy_timeout = 5000");
  const ver = (opened.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  Log.info("db.init", `better-sqlite3 就绪（SQLite ${ver}，WAL 模式）`);

  dbInstance = drizzle(opened, { schema });
  return dbInstance;
}

/** 获取数据库实例（需先 initDatabase） */
export function getDb(): DrizzleDB {
  if (!dbInstance) throw new Error("数据库未初始化，先调用 initDatabase()");
  return dbInstance;
}

/** 获取底层 better-sqlite3 实例（直接 SQL 查询用，替代旧 getSqlJsDb） */
export function getRawDb(): RawDb {
  if (!rawDb) throw new Error("数据库未初始化，先调用 initDatabase()");
  return rawDb;
}

/** 持久化。P1-1 后每次写操作已逐事务落盘，此函数转为 WAL checkpoint —— 调用点无需改动 */
export function saveDatabase(): void {
  try {
    rawDb?.pragma("wal_checkpoint(PASSIVE)");
  } catch { /* checkpoint 失败不影响业务，WAL 会自动管理 */ }
}

/** 关闭数据库（退出时调用，确保 WAL 收尾） */
export function closeDatabase(): void {
  try { rawDb?.close(); } catch { /* 已关闭 */ }
  rawDb = null;
  dbInstance = null;
}

/** 应用启动时自动执行迁移。内嵌建表 SQL（幂等 CREATE TABLE IF NOT EXISTS） */
export function runMigrations(): void {
  if (!rawDb) throw new Error("数据库未初始化");
  const raw = rawDb;

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
  last_fetch_error text, last_fetch_at text,
  fetch_fail_count integer DEFAULT 0 NOT NULL,
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
  matched_contact_id integer, related_contact_ids text,
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
CREATE TABLE IF NOT EXISTS agent_conversations (
  id text PRIMARY KEY NOT NULL,
  title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL REFERENCES agent_conversations(id),
  role text NOT NULL, content text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  tool_name text NOT NULL, side_effect text NOT NULL,
  args_json text, result_json text,
  approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id);
CREATE TABLE IF NOT EXISTS rate_quotes (
  record_id text PRIMARY KEY NOT NULL,
  pol text, pod_raw text NOT NULL,
  lane text, carrier text,
  container text, container_raw text,
  ocean_usd integer,
  validity_raw text, valid_from text, valid_to text,
  free_days text, shortfall_fee text, note text,
  source_group text, sender text, msg_time text, image_name text,
  synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_quotes_lane ON rate_quotes(lane);
CREATE INDEX IF NOT EXISTS idx_rate_quotes_valid_to ON rate_quotes(valid_to);
`.trim();

  const statements = SCHEMA_SQL.split(";").map(s => s.trim()).filter(s => s.length > 0);
  raw.exec(SCHEMA_SQL); // better-sqlite3 exec 支持多语句，一次执行

  const tableCols = (t: string): string[] =>
    (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name);

  // 旧库列迁移 — contacts 表删除冗余字段
  try {
    const cols = tableCols("contacts");
    for (const col of ["is_bounced", "bounce_reason", "last_sent_at", "last_sent_acct", "followup_note"]) {
      if (cols.includes(col)) raw.exec(`ALTER TABLE contacts DROP COLUMN ${col};`);
    }
  } catch { /* 表不存在或无此列 → 忽略 */ }

  // v4.1: templates 表补 stage 列
  try {
    if (!tableCols("templates").includes("stage")) {
      raw.exec("ALTER TABLE templates ADD COLUMN stage text;");
      Log.info("db.migrate", "templates 表已添加 stage 列");
    }
  } catch { /* 表不存在 → 忽略 */ }

  // 收信健康度：email_accounts 补 last_fetch_error / last_fetch_at / fetch_fail_count 列
  try {
    const acols = tableCols("email_accounts");
    let added = false;
    if (!acols.includes("last_fetch_error")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN last_fetch_error text;"); added = true; }
    if (!acols.includes("last_fetch_at")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN last_fetch_at text;"); added = true; }
    if (!acols.includes("fetch_fail_count")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN fetch_fail_count integer DEFAULT 0 NOT NULL;"); added = true; }
    if (added) Log.info("db.migrate", "email_accounts 表已添加收信健康度列");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.2/v4.4: send_queue 补列
  try {
    const qcols = tableCols("send_queue");
    if (!qcols.includes("tpl_body")) raw.exec("ALTER TABLE send_queue ADD COLUMN tpl_body text;");
    if (!qcols.includes("contact_vars")) raw.exec("ALTER TABLE send_queue ADD COLUMN contact_vars text;");
    if (!qcols.includes("cc")) raw.exec("ALTER TABLE send_queue ADD COLUMN cc text;");
    if (!qcols.includes("tpl_name")) raw.exec("ALTER TABLE send_queue ADD COLUMN tpl_name text;");
    if (!qcols.includes("country")) raw.exec("ALTER TABLE send_queue ADD COLUMN country text;");
    if (!qcols.includes("language")) raw.exec("ALTER TABLE send_queue ADD COLUMN language text;");
    Log.info("db.migrate", "send_queue 表已添加 tpl_body/contact_vars/cc/tpl_name/country/language 列");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.3: inbox_messages 补 cc + my_role + related_contact_ids 列
  try {
    const icols = tableCols("inbox_messages");
    if (!icols.includes("cc")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN cc text;");
    if (!icols.includes("my_role")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN my_role text;");
    if (!icols.includes("related_contact_ids")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN related_contact_ids text;");
    Log.info("db.migrate", "inbox_messages 表已添加 cc/my_role/related_contact_ids 列");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.0: contacts 表补 language 列
  try {
    if (!tableCols("contacts").includes("language")) {
      raw.exec("ALTER TABLE contacts ADD COLUMN language text;");
      Log.info("db.migrate", "contacts 表已添加 language 列");
    }
  } catch { /* 忽略 */ }

  // v4.x: stage 大小写归一化
  try {
    let n = 0;
    for (const [from, to] of [["F1", "f1"], ["F2", "f2"], ["F3", "f3"], ["F4", "f4"]]) {
      n += raw.prepare(`UPDATE contacts SET stage = ? WHERE stage = ?`).run(to, from).changes;
    }
    if (n > 0) Log.info("db.migrate", `stage 大小写归一化 ${n} 条`);
  } catch { /* 忽略 */ }

  // v4.x: country 缩写归一化
  try {
    let n = 0;
    for (const [from, to] of [
      ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["CL", "Chile"],
      ["PE", "Peru"], ["CO", "Colombia"], ["EC", "Ecuador"], ["UY", "Uruguay"],
      ["PY", "Paraguay"], ["VE", "Venezuela"], ["PA", "Panama"], ["CR", "Costa Rica"],
      ["US", "United States"], ["CA", "Canada"], ["CN", "China"], ["HK", "Hong Kong"],
      ["TW", "Taiwan"], ["JP", "Japan"], ["KR", "South Korea"], ["SG", "Singapore"],
      ["TH", "Thailand"], ["VN", "Vietnam"], ["ID", "Indonesia"], ["IN", "India"],
      ["AE", "United Arab Emirates"], ["UAE", "United Arab Emirates"],
      ["GB", "United Kingdom"], ["England", "United Kingdom"],
      ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"],
      ["PT", "Portugal"], ["NL", "Netherlands"], ["BE", "Belgium"],
      ["PL", "Poland"], ["RU", "Russia"], ["AU", "Australia"], ["NZ", "New Zealand"],
      ["ZA", "South Africa"], ["EG", "Egypt"],
    ]) {
      n += raw.prepare(`UPDATE contacts SET country = ? WHERE country = ?`).run(to, from).changes;
    }
    if (n > 0) Log.info("db.migrate", `country 缩写归一化 ${n} 条`);
  } catch { /* 忽略 */ }

  // v4.0: tags 收敛为固定 6 值分类单选
  try {
    const rows = raw.prepare("SELECT id, tags, status FROM contacts").all() as
      Array<{ id: number; tags: string | null; status: string | null }>;
    for (const r of rows) {
      const oldTags = r.tags || "";
      const status = r.status || "";
      const newTags = migrateTagsValue(oldTags, status);
      if (newTags !== (oldTags || null)) {
        if (newTags === null) raw.prepare("UPDATE contacts SET tags = NULL WHERE id = ?").run(r.id);
        else raw.prepare("UPDATE contacts SET tags = ? WHERE id = ?").run(newTags, r.id);
      }
    }
  } catch { /* 表不存在 → 忽略 */ }

  // v4.1: 回填 inbox 关联（幂等）
  try {
    const bfMatched = raw.prepare(`
      UPDATE inbox_messages
      SET matched_contact_id = (
        SELECT c.id FROM contacts c
        WHERE lower(c.email) = lower(inbox_messages.from_email)
        LIMIT 1
      )
      WHERE matched_contact_id IS NULL
    `).run().changes;
    const bfInteractions = raw.prepare(`
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
    `).run().changes;
    if (bfMatched > 0 || bfInteractions > 0) {
      Log.info("db.backfill", `inbox 关联回填: matched=${bfMatched} interactions=${bfInteractions}`);
    }
  } catch (e) {
    Log.warn("db.backfill", `回填失败: ${(e as Error).message}`);
  }

  Log.info("db.migrations", `${statements.length} 条建表语句已执行`);
}
