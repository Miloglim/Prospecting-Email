import { describe, it, expect } from "vitest";
import { TOOL_SPECS, classifyTool, checkBudget, ToolBudgetError } from "../../src/main/services/agent/policy";
import { searchContactsSchema, recordFollowupSchema } from "../../src/main/services/agent/tools";

describe("agent harness policy", () => {
  it("注册表每个工具都有副作用分级与预算", () => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(["read", "write"], `${name} sideEffect`).toContain(spec.sideEffect);
      expect(spec.budgetPerTurn).toBeGreaterThan(0);
    }
  });

  it("write 工具必须人工审批（harness 红线）", () => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      if (spec.sideEffect === "write") expect(spec.requiresApproval, name).toBe(true);
    }
    expect(classifyTool("record_followup")?.requiresApproval).toBe(true);
    expect(classifyTool("search_contacts")?.requiresApproval).toBe(false);
  });

  it("未注册工具返回 undefined（白名单外不可执行）", () => {
    expect(classifyTool("send_campaign")).toBeUndefined();
  });

  it("预算守卫：超限抛 ToolBudgetError，未超限计数递增", () => {
    const counts = new Map<string, number>();
    const budget = TOOL_SPECS.search_contacts.budgetPerTurn!;
    for (let i = 0; i < budget; i++) checkBudget(counts, "search_contacts");
    expect(counts.get("search_contacts")).toBe(budget);
    expect(() => checkBudget(counts, "search_contacts")).toThrow(ToolBudgetError);
  });
});

describe("agent harness tool schemas", () => {
  it("search_contacts 拒绝空关键词；limit 不再硬拒（execute 内钳制，防模型撞 zod 校验循环）", () => {
    expect(searchContactsSchema.safeParse({ query: "" }).success).toBe(false);
    // live 评测实锤：zod 拒绝发生在预算守卫之前，模型会反复重试直至 max turns → 改为 execute 钳制
    expect(searchContactsSchema.safeParse({ query: "x", limit: 21 }).success).toBe(true);
    expect(searchContactsSchema.safeParse({ query: "物流", limit: 5 }).success).toBe(true);
  });

  it("record_followup 拒绝非法 contactId 与空备注", () => {
    expect(recordFollowupSchema.safeParse({ contactId: 0, note: "n" }).success).toBe(false);
    expect(recordFollowupSchema.safeParse({ contactId: 1, note: "" }).success).toBe(false);
    expect(recordFollowupSchema.safeParse({ contactId: 1, note: "已电话沟通" }).success).toBe(true);
  });
});
