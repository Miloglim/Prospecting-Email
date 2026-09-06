import { describe, expect, it } from "vitest";
import { classifyIntentRules } from "../../src/main/services/intent.service";

// ═══════════════════════════════════════════════════════════════════
// 收信意图规则分类（docs/inbox-intent-spec.md §2）：命中即定档、全落空交 LLM。
// LLM 兜底不进单测（要真实端点），规则层必须锁死。
// ═══════════════════════════════════════════════════════════════════

describe("classifyIntentRules（意图规则分类）", () => {
  it("询价：英文/中文关键词都能命中", () => {
    expect(classifyIntentRules("RE: Price for Shanghai to Santos", null)).toBe("price_inquiry");
    expect(classifyIntentRules(null, "请报一下 40HQ 上海到桑托斯的价格")).toBe("price_inquiry");
    expect(classifyIntentRules("Quotation request", "need best rate")).toBe("price_inquiry");
  });

  it("船期：eta/etd/船期/舱位", () => {
    expect(classifyIntentRules("ETA for the booking?", null)).toBe("schedule_request");
    expect(classifyIntentRules(null, "下周一有船期吗，要直航的")).toBe("schedule_request");
  });

  it("合作：partnership/代理/合作", () => {
    expect(classifyIntentRules("Partnership proposal", null)).toBe("cooperation");
    expect(classifyIntentRules(null, "我们想找一家长期合作代理")).toBe("cooperation");
  });

  it("跟进：确认/收到/thanks", () => {
    expect(classifyIntentRules("Re: docs", "well received, thanks")).toBe("follow_up");
  });

  it("无命中返回 null（交 LLM 兜底），不硬猜", () => {
    expect(classifyIntentRules("Meeting next Tuesday", "Let's discuss the plan")).toBeNull();
    expect(classifyIntentRules(null, null)).toBeNull();
  });

  it("优先级：价格规则排最前（询价邮件同时提到船期时按询价算）", () => {
    expect(classifyIntentRules("Price and ETA question", "rate please, and the vessel schedule")).toBe("price_inquiry");
  });
});
