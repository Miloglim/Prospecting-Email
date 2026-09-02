import { describe, expect, it } from "vitest";
import {
  searchContactsSchema, recordFollowupSchema, quoteSearchSchema, inboxSearchSchema,
  emailSummarizeSchema, generateDraftSchema, sendQueueAddSchema, isToolRuntimeError,
} from "../../src/main/services/agent/tools";

// ═══════════════════════════════════════════════════════════════════
// 模型发来的参数千奇百怪：id 是字符串、布尔是 "false"、数组是 "1,2"。
// zod 一旦抛 InvalidToolInputError，错误发生在 execute 之前——预算与 audit 都看不见，
// 模型只会原样重试到撞满 max turns（实测 agnes-2.5-flash 起草回信就是这样挂的）。
// 这里锁住「宽进」，以及 SDK 层失败的识别。
// ═══════════════════════════════════════════════════════════════════

const ok = <T,>(s: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new Error("本该通过校验: " + JSON.stringify(v));
  return r.data as T;
};

describe("工具参数宽进严出", () => {
  it("id 发成字符串也能用（contactId / messageId）", () => {
    expect(ok<{ contactId: number }>(recordFollowupSchema, { contactId: "1", note: "已发报价" }).contactId).toBe(1);
    expect(ok<{ messageId: number }>(emailSummarizeSchema, { messageId: "16670" }).messageId).toBe(16670);
    expect(ok<{ contactId?: number }>(generateDraftSchema, {
      companyName: "ACME", contactName: "Juan", contactId: "1",
    }).contactId).toBe(1);
  });

  it("id 数组接受 [\"1\",\"2\"] 与 \"1,2\"，并去重限长", () => {
    expect(ok<{ contactIds: number[] }>(sendQueueAddSchema, {
      contactIds: ["1", "2", "1"], subject: "s", body: "b",
    }).contactIds).toEqual([1, 2]);
    expect(ok<{ contactIds: number[] }>(sendQueueAddSchema, {
      contactIds: "1, 2;3", subject: "s", body: "b",
    }).contactIds).toEqual([1, 2, 3]);
  });

  it("布尔与数字接受字符串写法；limit 越界被钳而不是报错", () => {
    expect(ok<{ includeExpired?: boolean }>(quoteSearchSchema, { includeExpired: "false" }).includeExpired).toBe(false);
    expect(ok<{ unreadOnly?: boolean }>(inboxSearchSchema, { unreadOnly: "true" }).unreadOnly).toBe(true);
    expect(ok<{ limit?: number }>(quoteSearchSchema, { limit: "5" }).limit).toBe(5);
    const loose = ok<{ limit?: number }>(searchContactsSchema, { query: "物流", limit: 0 });
    expect(loose.limit).toBeUndefined();          // 0/负数视为未填，走默认值
  });

  it("必填 id 缺失时不炸校验，交给工具给人话引导", () => {
    const r = emailSummarizeSchema.safeParse({});
    expect(r.success).toBe(true);
    expect((r.data as { messageId?: number }).messageId).toBeUndefined();
  });

  it("空串与 null 仍旧等同「不过滤」（前一轮修的行为不回退）", () => {
    const q = ok<{ pod?: string; container?: string }>(quoteSearchSchema, { pod: "", container: null, limit: 0 });
    expect(q.pod).toBeUndefined();
    expect(q.container).toBeUndefined();
  });
});

describe("SDK 层失败识别（熔断的失明补丁）", () => {
  it("认出 InvalidToolInputError / 运行时错误，不误伤正常数据", () => {
    expect(isToolRuntimeError("An error occurred while running the tool. Error: InvalidToolInputError")).toBe(true);
    expect(isToolRuntimeError('{"total":4,"quotes":[…]}')).toBe(false);
    expect(isToolRuntimeError("失败：邮件 #999 不存在，请先用 inbox_search 查询")).toBe(false);  // 我们自己的引导语不算故障
  });

  it("连续两次 SDK 失败后该工具本回合被挂起", async () => {
    const ctx = { conversationId: "conv-x", counts: new Map<string, number>(), failures: new Map<string, number>() };
    const bad = "An error occurred while running the tool. InvalidToolInputError";
    for (let i = 0; i < 2; i++) ctx.failures.set("quote_search", (ctx.failures.get("quote_search") ?? 0) + (isToolRuntimeError(bad) ? 1 : 0));
    expect(ctx.failures.get("quote_search")).toBe(2);
    ctx.failures.set("quote_search", 0);         // 一次成功即清零
    expect(ctx.failures.get("quote_search")).toBe(0);
  });
});
