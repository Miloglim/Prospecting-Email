import { beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// 助手身份注入（固定：运去哪（YQN）公司的 agent 助手，不由用户配置）
// 公司身份与角色写死在 identity.ts；唯一变量是 fromName（发件人显示名）。
// ═══════════════════════════════════════════════════════════════════

const cfg = { fromName: "" };
vi.mock("../../src/main/config", () => ({ loadConfig: () => cfg }));

const { readIdentity, identityBlock } = await import("../../src/main/services/agent/identity");

beforeEach(() => { cfg.fromName = ""; });

describe("助手身份注入", () => {
  it("公司身份恒定注入（fromName 未填也含运去哪，永不为空）", () => {
    const block = identityBlock();
    expect(block).toContain("【我方身份档案】");
    expect(block).toContain("运去哪（YQN）");
    expect(block).toContain("agent 助手");
    expect(block).toContain("禁止再留 {{firstName}}");
  });

  it("行事原则齐备：报价纪律 / 诚实优先 / 语言跟随 / 保密", () => {
    const block = identityBlock();
    expect(block).toContain("报价纪律");
    expect(block).toContain("以最终确认为准");
    expect(block).toContain("诚实优先");
    expect(block).toContain("语言跟随客户");
    expect(block).toContain("客户信息保密");
  });

  it("readIdentity：selfName = fromName，公司固定", () => {
    cfg.fromName = "Zayne Jin";
    const id = readIdentity();
    expect(id.fromName).toBe("Zayne Jin");
    expect(id.selfName).toBe("Zayne Jin");
    expect(id.company).toBe("运去哪（YQN）");
  });

  it("fromName 填写后身份行带上发件人名", () => {
    cfg.fromName = "Zayne Jin";
    expect(identityBlock()).toContain("Zayne Jin · 运去哪（YQN）");
  });

  it("readIdentity 去空格", () => {
    cfg.fromName = "  Zayne  ";
    expect(readIdentity().fromName).toBe("Zayne");
  });
});
