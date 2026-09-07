// ── 审批闸门结构锁 ────────────────────────────────────────────────
// 锁的是"真实行为"，不是元数据：注册表说 write，交给 SDK 的工具对象就必须带
// needsApproval: true。曾经的脱节：export_artifact 把注册表改成 write/需审批，
// 工具定义却没接 needsApproval → SDK 不中断 → 静默落盘，而只断言元数据的测试照样全绿。
// 现在 needsApproval 统一在 buildHarnessTools 返回处按注册表派生（见 tools.ts 末尾闸门）。
import { describe, it, expect, beforeAll } from "vitest";
import { TOOL_MANIFEST } from "../../src/main/services/agent/manifest";

type ToolLike = { name?: string; needsApproval?: unknown };

const writeNames = TOOL_MANIFEST.filter(m => m.spec.sideEffect === "write").map(m => m.name);
const readNames = TOOL_MANIFEST.filter(m => m.spec.sideEffect === "read").map(m => m.name);

describe("审批闸门（工具真实 needsApproval 由注册表派生）", () => {
  let tools: ToolLike[] = [];
  let byName: Record<string, ToolLike> = {};

  beforeAll(async () => {
    const { buildHarnessTools } = await import("../../src/main/services/agent/tools");
    const ctx = {
      conversationId: "gate-conv", counts: new Map<string, number>(), failures: new Map<string, number>(),
    } as never;
    tools = buildHarnessTools(ctx) as unknown as ToolLike[];
    byName = Object.fromEntries(tools.map(t => [t.name ?? "", t]));
  });

  it("工具集合与注册表名单一致（漏登记 = 漏审批，闸门射程外不放行）", () => {
    expect(tools.map(t => t.name).sort()).toEqual(TOOL_MANIFEST.map(m => m.name).sort());
  });

  it("每个 write 工具的 needsApproval 为 true", () => {
    expect(writeNames.length).toBeGreaterThan(0);
    for (const name of writeNames) expect(byName[name]?.needsApproval, name).toBe(true);
  });

  it("读工具不进审批流（免确认是设计，但不得反过来放宽写工具）", () => {
    for (const name of readNames) expect(byName[name]?.needsApproval, name).not.toBe(true);
  });

  it("点名回归：导出文件与批量任务都必须先问", () => {
    expect(byName["export_artifact"]?.needsApproval).toBe(true);
    expect(byName["start_batch_task"]?.needsApproval).toBe(true);
  });
});
