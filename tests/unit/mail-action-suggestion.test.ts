import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════
// 客户回复 → 一键行动（规范 docs/mail-action-suggestion-spec.md）
// 钉住识别口径：什么算"客户回给我们"、什么必须排除、点一下会发生什么。
// 现状反直觉之处：收到回复会把 status 改成 replied，而跟进看板只筛 reached ——
// 客户一回信反而从列表消失，本功能的动作就是把他置回已触达。
// ═══════════════════════════════════════════════════════════════════

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mail-action-"));
vi.mock("../../src/main/config", () => ({ APP_ROOT: TMP, DB_PATH: path.join(TMP, "prospector.db") }));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/db", () => ({ getDb: () => null, saveDatabase: () => {}, getRawDb: () => null }));
// 建议流的其他取数在本测试里不用（只测纯决策 + 候选拼装），给空值即可
vi.mock("../../src/main/services/crm.service", () => ({ checkReminders: () => ({ success: false, error: "off" }) }));
vi.mock("../../src/main/services/send.service", () => ({
  getSendStatus: () => ({ success: false, error: "off" }),
  getQueueItems: () => ({ success: false, error: "off" }),
}));

const S = await import("../../src/main/services/suggestion.service");

const row = (fromEmail: string, fromName: string | null = null) => ({ fromEmail, fromName });
const contact = (id: number, email: string, status: string | null, firstName: string | null = null, lastName: string | null = null) =>
  ({ id, email, status, firstName, lastName });
const INTERNAL = ["yqn.com", "trimanshipping.com"];

describe("decideReplyActions：谁算客户回复", () => {
  it("库里没有这个邮箱 → 出「建档并标为已触达」，姓名从 from_name 拆出来", () => {
    const a = S.decideReplyActions(
      [row("quotation@threelogintl.com", "Isabella Mendes | Three Logistics")], [], INTERNAL,
    );
    expect(a).toEqual([{
      kind: "addContact", email: "quotation@threelogintl.com", firstName: "Isabella", lastName: "Mendes",
    }]);
  });

  it("库里已有但状态不是 reached（回复后被改成了 replied）→ 出「放回跟进列表」并带 contactId", () => {
    const a = S.decideReplyActions(
      [row("juan@acme.com", "Juan Garcia")],
      [contact(7, "juan@acme.com", "replied", "Juan", "Garcia")], INTERNAL,
    );
    expect(a).toEqual([{ kind: "markReached", email: "juan@acme.com", contactId: 7, firstName: "Juan", lastName: "Garcia" }]);
  });

  it("已经在跟进列表（status=reached）→ 没有动作可做，不出建议", () => {
    expect(S.decideReplyActions([row("juan@acme.com")], [contact(7, "juan@acme.com", "reached")], INTERNAL)).toEqual([]);
  });

  it("我方内部域名（同事之间的 Re: 转发在分类里也是 replied）→ 排除；子域名也算", () => {
    expect(S.decideReplyActions([row("zayne_jin@yqn.com", "Zayne")], [], INTERNAL)).toEqual([]);
    expect(S.decideReplyActions([row("friday_zhang@trimanshipping.com")], [], INTERNAL)).toEqual([]);
    expect(S.decideReplyActions([row("someone@branch.yqn.com")], [], INTERNAL)).toEqual([]);
    // 同名后缀但不是子域（evilyqn.com）不该被误杀
    expect(S.decideReplyActions([row("bob@evilyqn.com")], [], INTERNAL)).toHaveLength(1);
  });

  it("公共/机器人信箱不算客户意向", () => {
    for (const e of ["noreply@acs.com", "no-reply@acs.com", "postmaster@acs.com", "mailer-daemon@acs.com", "info@acs.com"]) {
      expect(S.decideReplyActions([row(e)], [], INTERNAL)).toEqual([]);
    }
    expect(S.decideReplyActions([row("marketing.manager@acs.com")], [], INTERNAL)).toHaveLength(1);
  });

  it("坏地址（无 @、无点、空）静默跳过，不抛", () => {
    for (const e of ["", "not-an-email", "x@localhost", "  "]) {
      expect(() => S.decideReplyActions([row(e)], [], INTERNAL)).not.toThrow();
      expect(S.decideReplyActions([row(e)], [], INTERNAL)).toEqual([]);
    }
  });

  it("同一邮箱多封只出一条（取最新一封的姓名）；不同邮箱各出一条", () => {
    const a = S.decideReplyActions(
      [row("a@x.com", "Ann Lee"), row("a@x.com", "Ann L."), row("b@y.com", "Ben")], [], INTERNAL,
    );
    expect(a.map(x => x.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(a[0]!.lastName).toBe("Lee");   // 最新一封的写法胜出（rows 已按新→旧传入）
  });

  it("邮箱大小写不一致也认得是同一个人（库里存小写唯一键）", () => {
    const a = S.decideReplyActions([row("Quotation@ThreeLogIntl.com")], [], INTERNAL);
    const b = S.decideReplyActions([row("quotation@threelogintl.com")], a.map(() => contact(1, "quotation@threelogintl.com", "reached")), INTERNAL);
    expect(b).toEqual([]);   // 已建档且已触达 → 不再提
  });
});

describe("名字与信箱判定", () => {
  it("from_name 的签名尾巴砍掉：| （ 之后的都不进姓名", () => {
    expect(S.cleanPersonName("Mandy深圳运去哪(奥南)")).toEqual({ firstName: "Mandy深圳运去哪", lastName: null });
    expect(S.cleanPersonName("Artur Bernardo | Three Log Pricing")).toEqual({ firstName: "Artur", lastName: "Bernardo" });
    expect(S.cleanPersonName(null)).toEqual({ firstName: null, lastName: null });
    expect(S.cleanPersonName("   ")).toEqual({ firstName: null, lastName: null });
  });
  it("isBotMailbox：整个本地名是那个词才算，真人前缀不算", () => {
    expect(S.isBotMailbox("do-not-reply@x.com")).toBe(true);
    expect(S.isBotMailbox("noreply24@x.com")).toBe(true);
    expect(S.isBotMailbox("info@x.com")).toBe(true);
    expect(S.isBotMailbox("imendes@threelogintl.com")).toBe(false);
    expect(S.isBotMailbox("marketing.manager@acs.com")).toBe(false);   // 真人，前缀不能误杀
    expect(S.isBotMailbox("@x.com")).toBe(true);
  });
});

describe("action 候选进入建议流", () => {
  const base = {
    now: Date.now(), reminders: null, send: null,
    mail: { unread: 0, latest: null, unreplied: null, bounce3d: 0 },
    diff: null, related: new Map(), dismissed: new Set<string>(),
  };

  it("新客回复分数最高（黄金窗口压过行情/运价类），文案动词开头并写清做什么", () => {
    const c = S.collectCandidates({
      ...base,
      replyActions: [{ kind: "addContact", email: "i@x.com", firstName: "Isabella", lastName: "Mendes" }],
    });
    const top = [...c].sort((a, b) => b.score - a.score)[0]!;
    expect(top.bucket).toBe("action");
    expect(top.key).toBe("act:new:i@x.com");
    expect(top.text).toBe("把 Isabella Mendes（i@x.com）加入联系人并标为已触达");
    expect(top.action?.kind).toBe("addContact");
  });

  it("老客放回跟进列表：key 用 contactId 稳定，href 直达该客户", () => {
    const c = S.collectCandidates({
      ...base,
      replyActions: [{ kind: "markReached", email: "j@a.com", firstName: "Juan", lastName: "Garcia", contactId: 42 }],
    });
    const it0 = c.find(x => x.bucket === "action")!;
    expect(it0.key).toBe("act:reached:42");
    expect(it0.href).toBe("#/customers?view=table&detail=42");
    expect(it0.contactId).toBe(42);
  });

  it("action 桶受同桶 ≤2 与总 4 条约束，且 FeedItem 带得动 action", () => {
    const acts = ["a@x.com", "b@x.com", "c@x.com"].map(e => ({ kind: "addContact" as const, email: e }));
    const feed = S.buildFeed({ ...base, replyActions: acts });
    const actionable = feed.items.filter(i => i.action);
    expect(actionable.length).toBeLessThanOrEqual(2);
    expect(feed.items.length).toBeLessThanOrEqual(4);
    if (actionable.length) expect(actionable[0]!.action?.kind).toBe("addContact");
  });

  it("dismiss 过的 key 当天不再出现（同邮箱重算也稳定）", () => {
    const act = [{ kind: "addContact" as const, email: "i@x.com" }];
    expect(S.buildFeed({ ...base, replyActions: act, dismissed: new Set(["act:new:i@x.com"]) }).items
      .some(i => i.key === "act:new:i@x.com")).toBe(false);
  });
});
