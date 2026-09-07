import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database as RawDb } from "better-sqlite3";
import * as schema from "./schema";
import { DB_PATH } from "../config";
import { Log } from "../logger";
import { migrateTagsValue } from "./tags-migrate";
import { BASE_SCHEMA_SQL } from "./schema-sql";
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

/** 应用启动时自动执行迁移。建表 SQL 单一事实源在 schema-sql.ts（评测沙箱共用） */
export function runMigrations(): void {
  if (!rawDb) throw new Error("数据库未初始化");
  const raw = rawDb;

  const SCHEMA_SQL = BASE_SCHEMA_SQL;

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

  // v4.3: inbox_messages 补 cc + my_role + related_contact_ids 列；v5.0.2 补 to（收件人，详情栏常驻显示）
  try {
    const icols = tableCols("inbox_messages");
    if (!icols.includes("cc")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN cc text;");
    if (!icols.includes("my_role")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN my_role text;");
    if (!icols.includes("related_contact_ids")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN related_contact_ids text;");
    if (!icols.includes("to")) raw.exec(`ALTER TABLE inbox_messages ADD COLUMN "to" text;`);
    Log.info("db.migrate", "inbox_messages 表已补列（cc/my_role/related_contact_ids/to）");
  } catch { /* 表不存在 → 忽略 */ }

  // v4.0: contacts 表补 language 列
  try {
    if (!tableCols("contacts").includes("language")) {
      raw.exec("ALTER TABLE contacts ADD COLUMN language text;");
      Log.info("db.migrate", "contacts 表已添加 language 列");
    }
  } catch { /* 忽略 */ }

  // v5.0.3: agent_conversations 补 archived_at（侧栏删除=移入归档；彻底删除只在设置页归档区）
  try {
    if (!tableCols("agent_conversations").includes("archived_at")) {
      raw.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at text;");
      Log.info("db.migrate", "agent_conversations 表已添加 archived_at 列");
    }
  } catch { /* 忽略 */ }

  // v5.0.3: inbox_messages 补 intent（收信意图识别 + AI 兜底一级分类，见 docs/inbox-intent-spec.md）
  try {
    if (!tableCols("inbox_messages").includes("intent")) {
      raw.exec("ALTER TABLE inbox_messages ADD COLUMN intent text;");
      Log.info("db.migrate", "inbox_messages 表已添加 intent 列");
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

  // v5.1 退信↔被退联系人关联表种子（幂等，规范 docs/bounce-multi-match-spec.md）：
  // 存量单列已匹配的退信各补一行；放在上面单列回填之后，让刚补出来的值也一并进表。
  // ON CONFLICT 靠表上的 UNIQUE(message_id, contact_id)。
  try {
    const seeded = raw.prepare(`
      INSERT INTO inbox_bounce_matches (message_id, contact_id)
      SELECT i.id, i.matched_contact_id FROM inbox_messages i
      WHERE i.classification = 'bounce' AND i.matched_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = i.matched_contact_id)
      ON CONFLICT(message_id, contact_id) DO NOTHING
    `).run().changes;
    if (seeded > 0) Log.info("db.migrate", `被退联系人关联表种子 ${seeded} 条`);
  } catch (e) { Log.warn("db.migrate", `被退联系人关联表种子失败: ${(e as Error).message}`); }

  Log.info("db.migrations", `${statements.length} 条建表语句已执行`);
}
