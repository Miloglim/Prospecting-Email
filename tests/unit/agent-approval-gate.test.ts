// ── 审批闸门结构锁 ────────────────────────────────────────────────
// 锁的是"真实行为"，不是元数据：注册表说 write，交给 SDK 的工具对象就必须在运行时
// 真的要求审批。两层脱节都踩过：
//  1) export_artifact 把注册表改成 write/需审批，工具定义却没接 needsApproval → 静默落盘；
//  2) 闸门把 needsApproval 覆盖成布尔 true，而 SDK 运行时是 `await tool.needsApproval(ctx,args,callId)`
//     当函数调 → `true(...)` 崩（TypeError: needsApproval is not a function），只断言 `=== true`
//     的旧测试照样全绿。
// 所以这里必须「调用」needsApproval 并断言其解析值，而不是只看它等不等于 true。
// needsApproval 统一在 buildHarnessTools 返回处按注册表派生（见 tools.ts 末尾闸门）。
import { describe, it, expect, beforeAll } from "vitest";
import { TOOL_MANIFEST } from "../../src/main/services/agent/manifest";

type ToolLike = { name?: string; needsApproval?: unknown };

const writeNames = TOOL_MANIFEST.filter(m => m.spec.sideEffect === "write").map(m => m.name);
const readNames = TOOL_MANIFEST.filter(m => m.spec.sideEffect === "read").map(m => m.name);

/** 按 SDK 运行时的方式解析 needsApproval：是函数就调用它（哑参），否则取其布尔/undefined 原值 */
async function resolvesApproval(t: ToolLike | undefined): Promise<unknown> {
  const na = t?.needsApproval;
  if (typeof na === "function") return await (na as (...a: unknown[]) => unknown)({}, {}, "call");
  return na;
}

describe("审批闸门（工具真实 needsApproval 由注册表派生，且运行时可调用）", () => {
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

  it("每个 write 工具的 needsApproval 运行时解析为 true（且是可调用函数，不是裸布尔）", async () => {
    expect(writeNames.length).toBeGreaterThan(0);
    for (const name of writeNames) {
      expect(typeof byName[name]?.needsApproval, `${name} 的 needsApproval 必须是函数（SDK 会当函数调）`).toBe("function");
      expect(await resolvesApproval(byName[name]), name).toBe(true);
    }
  });

  it("读工具不进审批流（运行时解析不得为 true）", async () => {
    for (const name of readNames) expect(await resolvesApproval(byName[name]), name).not.toBe(true);
  });

  it("点名回归：导出文件与批量任务都必须先问", async () => {
    expect(await resolvesApproval(byName["export_artifact"])).toBe(true);
    expect(await resolvesApproval(byName["start_batch_task"])).toBe(true);
  });
});
