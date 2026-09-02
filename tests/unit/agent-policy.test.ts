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

  it("record_followup：id 宽松归一，备注仍必填", () => {
    // 0 / "abc" 不再判非法：校验失败发生在 execute 之前，模型看不到我们的引导语，
    // 只会原样重试到撞满 max turns（实测）——所以归一为「未填」，由工具本体给提示
    const zero = recordFollowupSchema.safeParse({ contactId: 0, note: "n" });
    expect(zero.success).toBe(true);
    expect((zero.data as { contactId?: number }).contactId).toBeUndefined();
    expect(recordFollowupSchema.safeParse({ contactId: "1", note: "n" }).success).toBe(true);
    expect(recordFollowupSchema.safeParse({ contactId: 1, note: "" }).success).toBe(false); // 备注仍是硬要求
    expect(recordFollowupSchema.safeParse({ contactId: 1, note: "已电话沟通" }).success).toBe(true);
  });
});

describe("会话级写操作豁免（本会话内不再询问）", () => {
  it("只有低风险写工具可豁免，外发类永不豁免", () => {
    expect(canAutoApprove("record_followup")).toBe(true);
    expect(canAutoApprove("send_queue_add")).toBe(false);   // 红线：外发每次都要人工确认
  });

  it("读工具与未注册工具不在豁免范围", () => {
    expect(canAutoApprove("search_contacts")).toBe(false);
    expect(canAutoApprove("update_plan")).toBe(false);
    expect(canAutoApprove("send_campaign")).toBe(false);
  });

  it("update_plan 是免审批读工具（只维护界面清单）", () => {
    expect(classifyTool("update_plan")).toMatchObject({ sideEffect: "read", requiresApproval: false });
  });
});

describe("任务清单归一 normalizePlan", () => {
  it("超过 8 条钳制、空文本条目丢弃", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ text: `第 ${i} 步`, state: "pending" }));
    items.push({ text: "   ", state: "done" });
    const out = normalizePlan(items);
    expect(out).toHaveLength(8);
    expect(out.every(i => i.text.length > 0)).toBe(true);
  });

  it("状态词按同义词归一，认不出的按 pending", () => {
    const out = normalizePlan([
      { text: "a", state: "completed" },
      { text: "b", state: "in_progress" },
      { text: "c", state: "已完成" },
      { text: "d", state: "进行中" },
      { text: "e", state: "whatever" },
      { text: "f" },
    ]);
    expect(out.map(i => i.state)).toEqual(["done", "doing", "done", "doing", "pending", "pending"]);
  });

  it("脏输入（非数组 / 元素不是对象）不抛错，只返回可渲染的部分", () => {
    expect(normalizePlan(undefined)).toEqual([]);
    expect(normalizePlan("oops")).toEqual([]);
    expect(normalizePlan([null, 1, { state: "done" }])).toEqual([]);
    expect(normalizePlan([{ text: "查运价", state: null }])).toEqual([{ text: "查运价", state: "pending" }]);
  });
});
