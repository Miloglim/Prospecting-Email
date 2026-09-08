import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { eq } from "drizzle-orm";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { contacts } from "../../src/main/db/schema/contacts";
import { inboxMessages, inboxBounceMatches } from "../../src/main/db/schema/inbox";
import { interactions } from "../../src/main/db/schema/interactions";

// ═══════════════════════════════════════════════════════════════════
// 先收信、后建档 → 往来必须当场可见（用户实测：重启程序才同步，不专业）。
// linkInboxForContact = 启动迁移 v4.1 的即时版，钉四件事：
//   认领只吃空行不抢别人的、跟进事件补齐且幂等、退信进关联表、大小写不敏感。
// ═══════════════════════════════════════════════════════════════════

const TMP = path.join(os.tmpdir(), "prospector-inbox-link-test");
type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { linkInboxForContact } = await import("../../src/main/services/inbox-link");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

function freshDb(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  for (const s of [
    `ALTER TABLE inbox_messages ADD COLUMN intent text;`,
    `ALTER TABLE contacts ADD COLUMN language text;`,
  ]) { try { raw.run(s); } catch { /* 列已存在 */ } }
  const db = drizzle(raw, { schema });
  h.db = db;
  return db;
}

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

beforeEach(() => {
  const db = freshDb();
  db.insert(contacts).values([
    { email: "old@acme.com", firstName: "Old" },
    { email: "juan@acme.com", firstName: "Juan", lastName: "Garcia", status: "reached" },
  ]).run();
  // 1=Juan 询价信（未链，建档前到的）、2=已归别人、3=Juan 的退信、4=Juan 的普通闲聊（other）
  db.insert(inboxMessages).values([
    { accountId: 1, fromEmail: "Juan@ACME.com", subject: "Quote request", classification: "replied",
      messageId: "m1", receivedAt: "2026-09-01T10:00:00Z" },
    { accountId: 1, fromEmail: "someone@x.com", subject: "taken", classification: "replied",
      matchedContactId: 1, messageId: "m2", receivedAt: "2026-09-01T11:00:00Z" },
    { accountId: 1, fromEmail: "juan@acme.com", subject: "NDR", classification: "bounce",
      messageId: "m3", receivedAt: "2026-09-02T09:00:00Z" },
    { accountId: 1, fromEmail: "juan@acme.com", subject: "hi", classification: "other",
      messageId: "m4", receivedAt: "2026-09-03T09:00:00Z" },
  ]).run();
});

describe("linkInboxForContact（先收信后建档的即时挂链）", () => {
  it("认领空行且不抢别人已关联的；大小写不敏感；other 类也进往来（不产事件）", () => {
    const linked = linkInboxForContact(2, "juan@acme.com");
    expect(linked).toBe(3);                                 // m1/m3/m4；m2 已有主不动
    const db = h.db;
    const mine = db.select({ id: inboxMessages.id }).from(inboxMessages)
      .where(eq(inboxMessages.matchedContactId, 2)).all().map(r => r.id).sort();
    expect(mine).toEqual([1, 3, 4]);
    expect(db.select({ id: inboxMessages.id }).from(inboxMessages)
      .where(eq(inboxMessages.matchedContactId, 1)).all()).toHaveLength(1);
  });

  it("replied→replied、bounce→bounced 跟进事件各一条，autoreply 之外不补；时间线立即有东西", () => {
    linkInboxForContact(2, "juan@acme.com");
    const evs = h.db.select({ type: interactions.type, messageId: interactions.messageId })
      .from(interactions).where(eq(interactions.contactId, 2)).all();
    expect(evs).toEqual(
      expect.arrayContaining([{ type: "replied", messageId: "m1" }, { type: "bounced", messageId: "m3" }]),
    );
    expect(evs).toHaveLength(2);                            // m4=other 不产事件（只在时间线里出现）
  });

  it("幂等：重复调用不双写（事件、关联表都防重）", () => {
    expect(linkInboxForContact(2, "juan@acme.com")).toBe(3);
    expect(linkInboxForContact(2, "juan@acme.com")).toBe(0);
    expect(h.db.select().from(interactions).where(eq(interactions.contactId, 2)).all()).toHaveLength(2);
    expect(h.db.select().from(inboxBounceMatches).where(eq(inboxBounceMatches.contactId, 2)).all()).toHaveLength(1);
  });

  it("退信行进 inbox_bounce_matches 关联表（计数口径与事件一致）", () => {
    linkInboxForContact(2, "juan@acme.com");
    const rows = h.db.select({ messageId: inboxBounceMatches.messageId }).from(inboxBounceMatches)
      .where(eq(inboxBounceMatches.contactId, 2)).all();
    expect(rows.map(r => r.messageId)).toEqual([3]);        // message_id 存 inbox_messages.id（m3 那封）
  });

  it("无效入参直接 0（不炸库）", () => {
    expect(linkInboxForContact(0, "x@y.com")).toBe(0);
    expect(linkInboxForContact(2, "")).toBe(0);
  });
});
