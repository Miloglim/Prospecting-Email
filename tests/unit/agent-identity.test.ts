import { beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// 助手身份档案注入
// 背景：用户发现 AI 起草的邮件里全是 {{firstName}} {{company}} {{phone}} ——
// 因为 agent 从来拿不到"我方是谁"。这里锁住注入行为与缺失提示。
// ═══════════════════════════════════════════════════════════════════

const cfg = { fromName: "", bodyName: "", signature: "", identity: {} as Record<string, string> };
vi.mock("../../src/main/config", () => ({ loadConfig: () => cfg }));

const { readIdentity, identityBlock, identityGaps } = await import("../../src/main/services/agent/identity");

beforeEach(() => {
  cfg.fromName = ""; cfg.bodyName = ""; cfg.signature = "";
  cfg.identity = { company: "", title: "", business: "", persona: "" };
});

describe("助手身份注入", () => {
  it("什么都没填 → 不注入任何内容，并列出缺项", () => {
    expect(identityBlock()).toBe("");
    expect(identityGaps()).toEqual(["自称/发件人名称", "我方公司名", "邮件署名"]);
  });

  it("填了自称/公司/署名 → 注入身份块并明令禁止占位符", () => {
    cfg.bodyName = "Zayne";
    cfg.identity = { company: "运去哪 YQN", title: "航线经理", business: "", persona: "" };
    cfg.signature = "Zayne Jin\n运去哪 YQN · +86 138xxxx";
    const block = identityBlock();
    expect(block).toContain("【我方身份档案】");
    expect(block).toContain("Zayne · 航线经理 · 运去哪 YQN");
    expect(block).toContain("禁止再留 {{firstName}}");
    expect(identityGaps()).toEqual([]);
  });

  it("角色口径与业务描述都会带上", () => {
    cfg.fromName = "Zayne Jin";
    cfg.identity = { company: "YQN", title: "", business: "拉美整箱海运，CMA/MSC", persona: "未确认的价格不得承诺" };
    const block = identityBlock();
    expect(block).toContain("我方业务：拉美整箱海运，CMA/MSC");
    expect(block).toContain("你的固定角色：未确认的价格不得承诺");
  });

  it("只有署名（缺自称与公司）→ 仍会注入但 gap 不空", () => {
    cfg.signature = "Best regards";
    expect(identityBlock()).toContain("Best regards");
    expect(identityGaps().length).toBeGreaterThan(0);
  });

  it("readIdentity 去空格、空串归零", () => {
    cfg.bodyName = "  Zayne  ";
    cfg.identity = { company: " ", title: "", business: "", persona: "" };
    const i = readIdentity();
    expect(i.selfName).toBe("Zayne");
    expect(i.company).toBe("");
  });
});
