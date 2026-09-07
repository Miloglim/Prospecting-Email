import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { eq } from "drizzle-orm";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";
import { contacts } from "../../src/main/db/schema/contacts";
import { companies } from "../../src/main/db/schema/companies";
import { inboxMessages, inboxBounceMatches } from "../../src/main/db/schema/inbox";
import { interactions } from "../../src/main/db/schema/interactions";

// ═══════════════════════════════════════════════════════════════════
// 退信 ↔ 被退联系人一对多（规范 docs/bounce-multi-match-spec.md）
// 钉住用户实测翻车的那条链：一封群发退信报多个失败收件人 →
// 提取全收、关联表全员、计数=真删数、删除前归档、邮件保留只解关联。
// ═══════════════════════════════════════════════════════════════════

const TMP = path.join(os.tmpdir(), "prospector-bounce-test");
type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", () => ({
  APP_ROOT: TMP, DB_PATH: path.join(TMP, "prospector.db"),
}));

const S = await import("../../src/main/services/inbox.service");
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  fs.mkdirSync(TMP, { recursive: true });
  const junk = path.join(TMP, "bounce-delete-archive.jsonl");
  if (fs.existsSync(junk)) fs.rmSync(junk);      // 归档追加写，清掉上一轮残留
});

function freshDb() {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  // BASE_SCHEMA_SQL 是最小建表面貌，增量列由生产 runMigrations ALTER 补——测试库对齐同样终态，
  // 否则 drizzle 全列 INSERT 会撞 "no column named intent/language/..."
  for (const s of [
    `ALTER TABLE inbox_messages ADD COLUMN intent text;`,
    `ALTER TABLE email_accounts ADD COLUMN last_fetch_error text;`,
    `ALTER TABLE email_accounts ADD COLUMN last_fetch_at text;`,
    `ALTER TABLE email_accounts ADD COLUMN fetch_fail_count integer DEFAULT 0 NOT NULL;`,
    `ALTER TABLE contacts ADD COLUMN language text;`,
  ]) { try { raw.run(s); } catch { /* 列已存在 */ } }
  h.db = drizzle(raw, { schema });
  h.db.insert(emailAccounts).values({ email: "zayne_jin@yqn.com", encryptedPass: "x" }).run();
}
beforeEach(freshDb);

function addContact(email: string): number {
  h.db.insert(contacts).values({ email, firstName: email.split("@")[0] } as never).run();
  return h.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).get()!.id;
}
function addBounceMessage(): number {
  h.db.insert(inboxMessages).values({
    accountId: 1, messageId: `bounce-${Math.random().toString(36).slice(2, 8)}`,
    fromEmail: "mailer-daemon@mail.acme.com",
    subject: "Undelivered Mail Returned to Sender", classification: "bounce", receivedAt: "2026-09-04T09:00:00Z",
  } as never).run();
  return h.db.select({ id: inboxMessages.id }).from(inboxMessages).all().at(-1)!.id;
}

describe("extractBouncedContacts：全员被退一次收齐", () => {
  it("DSN 多条 Final-Recipient → 全部命中，不再只取第一条", () => {
    const a = addContact("alice@acme.com"); const b = addContact("bob@acme.com");
    const src = [
      "This is the mail system at host mx.acme.com.",
      "Final-Recipient: rfc822; alice@acme.com", "Action: failed", "Status: 5.1.1",
      "Final-Recipient: rfc822; bob@acme.com", "Action: failed", "Status: 5.1.1",
    ].join("\r\n");
    expect(S.extractBouncedContacts(src).sort()).toEqual([a, b].sort());
  });

  it("X-Failed-Recipients 一行逗号多址拆开；系统地址与我方域名不算被退", () => {
    const c = addContact("carol@acme.com"); const d = addContact("dave@acme.com");
    const got = S.extractBouncedContacts("X-Failed-Recipients: carol@acme.com, dave@acme.com, mailer-daemon@acme.com, zayne_jin@yqn.com");
    expect(got.sort()).toEqual([c, d].sort());
  });

  it("无 DSN 段时正文自然语言模式全收；老单值 API = 第一个", () => {
    const e = addContact("eve@acme.com"); const f = addContact("finn@acme.com");
    const all = S.extractBouncedContacts("Delivery to the following recipients failed: eve@acme.com, finn@acme.com");
    expect(all.sort()).toEqual([e, f].sort());
    expect(S.extractBouncedContact("Delivery to the following recipients failed: eve@acme.com, finn@acme.com")).toBe(all[0]);
  });

  it("库里查无此人的地址不进结果（匹配的是联系人，不是地址）", () => {
    const g = addContact("ghost@acme.com");
    expect(S.extractBouncedContacts("Final-Recipient: rfc822; nobody@x.com\r\nFinal-Recipient: rfc822; ghost@acme.com"))
      .toEqual([g]);
  });
});

describe("recordBounceMatches：一次调用干齐副作用", () => {
  it("全员进关联表 + 单列补第一个 + 每人标记退信并补 bounced 事件；重复调用幂等", () => {
    const mid = addBounceMessage();
    const a = addContact("alice@acme.com"); const b = addContact("bob@acme.com");
    expect(S.recordBounceMatches(mid, [a, b])).toHaveLength(2);
    expect(h.db.select().from(inboxBounceMatches).all()).toHaveLength(2);
    expect(h.db.select({ m: inboxMessages.matchedContactId }).from(inboxMessages).where(eq(inboxMessages.id, mid)).get()!.m).toBe(a);
    expect(h.db.select({ s: contacts.status }).from(contacts).where(eq(contacts.id, a)).get()!.s).toBe("bounced");
    expect(h.db.select({ s: contacts.status }).from(contacts).where(eq(contacts.id, b)).get()!.s).toBe("bounced");
    expect(h.db.select().from(interactions).where(eq(interactions.contactId, a)).all()).toHaveLength(1);
    expect(h.db.select().from(interactions).where(eq(interactions.contactId, b)).all()).toHaveLength(1);
    expect(S.recordBounceMatches(mid, [a, b])).toHaveLength(0);   // 幂等：第二次没有新增
    expect(h.db.select().from(inboxBounceMatches).all()).toHaveLength(2);
    expect(h.db.select().from(interactions).all()).toHaveLength(2);
  });
});

describe("计数与一键删除：同源，所见即所删", () => {
  it("两封退信覆盖 3 人（1 人重叠）→ 计数 3；挂到已消失旧 ID 的不计", () => {
    const a = addContact("a@acme.com"); const b = addContact("b@acme.com"); const c = addContact("c@acme.com");
    S.recordBounceMatches(addBounceMessage(), [a, b]);
    S.recordBounceMatches(addBounceMessage(), [b, c, 99999]);    // 99999 = 已消失旧 ID
    const st = S.bounceMatchStats();
    expect(st.success && st.data.count).toBe(3);
    if (st.success) expect(st.data.emails.sort()).toEqual(["a@acme.com", "b@acme.com", "c@acme.com"]);
  });

  it("非退信邮件的单列关联不计入被退计数", () => {
    const a = addContact("a@acme.com");
    h.db.insert(inboxMessages).values({
      accountId: 1, messageId: "reply-1", fromEmail: "a@acme.com",
      subject: "Re: rates", classification: "replied", receivedAt: "2026-09-04T09:00:00Z", matchedContactId: a,
    } as never).run();
    expect(S.bounceMatchStats().success && S.bounceMatchStats().data.count).toBe(0);
  });

  it("删除：人没了、往来清了、邮件保留且解关联、空壳公司随手清、归档先落盘", () => {
    const co = h.db.insert(companies).values({ name: "Acme Trading" } as never).run();
    void co;
    const coId = h.db.select({ id: companies.id }).from(companies).where(eq(companies.name, "Acme Trading")).get()!.id;
    h.db.insert(contacts).values({ email: "a@acme.com", firstName: "A", companyId: coId } as never).run();
    const a = h.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, "a@acme.com")).get()!.id;
    const mid = addBounceMessage();
    S.recordBounceMatches(mid, [a]);
    h.db.insert(interactions).values({ contactId: a, type: "note", direction: "inbound", subject: "x" } as never).run();

    const r = S.deleteAllBounce();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.deleted).toBe(1);
    expect(h.db.select().from(contacts).all()).toHaveLength(0);
    expect(h.db.select().from(interactions).all()).toHaveLength(0);
    expect(h.db.select().from(inboxBounceMatches).all()).toHaveLength(0);
    expect(h.db.select().from(companies).all()).toHaveLength(0);                       // 名下没人的公司随手清
    expect(h.db.select().from(inboxMessages).all()[0].matchedContactId).toBeNull();   // 邮件保留、只解关联
    const junk = path.join(TMP, "bounce-delete-archive.jsonl");
    expect(fs.existsSync(junk)).toBe(true);
    const lines = fs.readFileSync(junk, "utf-8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!) as { contact: { email: string }; interactions: unknown[] };
    expect(rec.contact.email).toBe("a@acme.com");
    expect(rec.interactions).toHaveLength(2);                                          // 归档带全往来：匹配链记的 bounced + 手插的 note
  });
});
