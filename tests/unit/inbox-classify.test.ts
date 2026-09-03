import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { emailAccounts } from "../../src/main/db/schema/accounts";

// ═══════════════════════════════════════════════════════════════════
// 收件箱分类：退信误判回归
// 真实事故：同事 Mandy 的「回复：达飞南美东 9.8-9.14 FAK」被判 bounce，
// 助手据此建议用户「对方邮箱可能失效，改电话联系」——用错误分类推出自信的错误建议。
// 根因是旧规则 `/\b5\d{2}\b/`：运价里的 545/580/5天免箱期 全命中。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { classify } = await import("../../src/main/services/inbox.service");
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

function seed(accounts: string[]) {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(`CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL, smtp_host text, smtp_port integer,
  imap_host text, imap_port integer, encrypted_pass text NOT NULL,
  display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL, circuit_open_at text, circuit_reset_after text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);`);
  const db = drizzle(raw, { schema });
  h.db = db;
  if (accounts.length) db.insert(emailAccounts).values(accounts.map(e => ({ email: e, encryptedPass: "x" }))).run();
}

function reseed(accounts: string[]) { seed(accounts); }

describe("退信判定要硬证据", () => {
  beforeEach(() => { vi.useRealTimers(); reseed(["zayne_jin@yqn.com"]); });

  it("同事发的运价回复（正文含 545 / 580 / 5天）不再判退信", () => {
    const out = classify(
      "回复: 达飞南美东 9.8-9.14 FAK", "mandy_li@yqn.com",
      "本期南美东价格 40HQ USD 545，20GP 580，免箱期 5天，ETD 9月8日", true,
    );
    expect(out).toBe("replied");
  });

  it("外部来信含运价数字也不因数字判退信", () => {
    expect(classify("Rates for SH - Jeb A", "buyer@acme.com", "we see 545 per 40HQ and 5 days free time")).not.toBe("bounce");
  });

  it("真退信仍然抓得到：mailer-daemon + SMTP 码", () => {
    expect(classify("Undelivered Mail Returned to Sender", "mailer-daemon@mail.acme.com",
      "This is the mail system at host mx. Final-Recipient: rfc822; no@where.com\nsmtp; 550 5.1.1 user unknown")).toBe("bounce");
    expect(classify("来自no-reply@mailsupport.aliyun.com的退信", "no-reply@mailsupport.aliyun.com",
      "以下收件人地址不存在，投递失败 status: 5.1.1")).toBe("bounce");
  });

  it("只有退信词、没有 NDR 结构时不轻判（正常商务邮件也会说「无法送达某港」）", () => {
    expect(classify("weekly rates", "ops@carrier.com", "some lanes 无法送达 due to congestion, others 545 USD")).not.toBe("bounce");
  });

  it("非我方域名的普通往来按 replied/other 处理", () => {
    expect(classify("Re: Proposta logística", "raphael@exalog.com.br", "obrigado", true)).toBe("replied");
    expect(classify("YML WCSA - FAK Tariff", "katy_huang@other.com", "rate from 2026 SEP 8", false)).toBe("other");
  });
});
