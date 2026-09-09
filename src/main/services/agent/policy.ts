// ── Agent Harness 策略层 ──────────────────────────────────────────
// 工具注册表元数据：副作用分级 / 审批要求 / 每轮调用预算。
// 设计红线：write 类工具必须 requiresApproval；发信类动作永不进入注册表。
// 会话级「不再询问」豁免已于 2026-09-07 连根删除——写/生成每次都问，不留旋钮。
// 纯逻辑、无副作用，便于单测。

export type SideEffect = "read" | "write";

export interface ToolSpec {
  sideEffect: SideEffect;
  /** write 工具必须为 true：执行前走人工确认中断流 */
  requiresApproval: boolean;
  /** 单轮对话内该工具的最大调用次数，防失控循环 */
  budgetPerTurn?: number;
}

/**
 * 工具策略元数据从注册表（manifest.ts）派生 —— 副作用分级/审批/预算的唯一事实源
 * 在 manifest 里登记；这里不维护第二份清单。红线见 manifest 头部：
 * write 类工具必须 requiresApproval，且每次都问（无任何豁免通道）。
 */
import { TOOL_MANIFEST } from "./manifest";

export const TOOL_SPECS: Record<string, ToolSpec> =
  Object.fromEntries(TOOL_MANIFEST.map(m => [m.name, m.spec]));

export function classifyTool(name: string): ToolSpec | undefined {
  return TOOL_SPECS[name];
}

/**
 * 审批闸门的唯一口径：注册表登记为 write ⇒ 必须人工确认。
 * 刻意只看 sideEffect——万一 requiresApproval 被误写成 false，闸门仍然拦得住，
 * 判据只可加严不可放宽。工具层用它给 needsApproval 赋值，禁止各自判断。
 */
export function requiresApprovalOf(name: string): boolean {
  return TOOL_SPECS[name]?.sideEffect === "write";
}

export class ToolBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolBudgetError";
  }
}

/**
 * 每工具单轮次数预算已解除（2026-09-09 用户定）：正常任务不该感知"次数限制"，
 * 阈值只该防失控、不该防产能（实测：delete_contacts 撞预算后模型谎报"已删除 13 人"，
 * 用户看到的就是既卡住又是假结果）。counts 继续累计，只用于观测与成本回执。
 */
export const TURN_CALL_CEILING = Math.max(50, Number(process.env.AGENT_TURN_CALL_CEILING || 240) || 240);

/** 不可逆的批量销毁类工具：单轮只许走一次，靠这一条防失控（不防产能） */
export const ONE_PER_TURN_TOOLS = new Set(["delete_contacts"]);

/** 预算守卫：只拦真失控（本轮总量兜底 + 销毁类单轮一次）；否则计数 +1 */
export function checkBudget(counts: Map<string, number>, toolName: string): void {
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  if (total >= TURN_CALL_CEILING) {
    throw new ToolBudgetError(
      `本轮工具调用总量已到兜底阈值（${TURN_CALL_CEILING} 次），疑似死循环——请立刻停止调用，基于已有数据给出结论并向用户说明卡在哪。`);
  }
  const used = counts.get(toolName) ?? 0;
  if (ONE_PER_TURN_TOOLS.has(toolName) && used >= 1) {
    throw new ToolBudgetError(
      `「${toolName}」本轮已执行过一次：不可逆的批量删除不在一句话里连环执行。`
      + "请把已删/未删的确切数字如实告诉用户，需要继续删除由用户再发起一次。");
  }
  counts.set(toolName, used + 1);
}
