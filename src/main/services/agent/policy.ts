// ── Agent Harness 策略层 ──────────────────────────────────────────
// 工具注册表元数据：副作用分级 / 审批要求 / 每轮调用预算。
// 设计红线：write 类工具必须 requiresApproval；发信类动作永不进入注册表。
// 纯逻辑、无副作用，便于单测。

export type SideEffect = "read" | "write";

export interface ToolSpec {
  sideEffect: SideEffect;
  /** write 工具必须为 true：执行前走人工确认中断流 */
  requiresApproval: boolean;
  /** 单轮对话内该工具的最大调用次数，防失控循环 */
  budgetPerTurn?: number;
  /** 低风险写工具：允许用户在当前会话内选择「不再询问」。缺省 false —— 发信类永不豁免 */
  autoApprovable?: boolean;
}

/**
 * 工具策略元数据从注册表（manifest.ts）派生 —— 副作用分级/审批/预算的唯一事实源
 * 在 manifest 里登记；这里不维护第二份清单。红线见 manifest 头部：
 * write 类工具必须 requiresApproval；send_queue_add / import_contacts 永不豁免。
 */
import { TOOL_MANIFEST } from "./manifest";

export const TOOL_SPECS: Record<string, ToolSpec> =
  Object.fromEntries(TOOL_MANIFEST.map(m => [m.name, m.spec]));

export function classifyTool(name: string): ToolSpec | undefined {
  return TOOL_SPECS[name];
}

/** 该写工具能否被「本会话内不再询问」豁免（未注册 / 读工具 / 发信类一律 false） */
export function canAutoApprove(name: string): boolean {
  const spec = TOOL_SPECS[name];
  return !!spec && spec.sideEffect === "write" && spec.autoApprovable === true;
}

export class ToolBudgetError extends Error {
  constructor(toolName: string, budget: number) {
    super(`工具 ${toolName} 本轮调用已达上限（${budget} 次），请基于已有数据回答`);
    this.name = "ToolBudgetError";
  }
}

/** 预算守卫：超限抛错（错误会作为 tool error 回给模型，逼其收敛）；否则计数 +1 */
export function checkBudget(counts: Map<string, number>, toolName: string): void {
  const spec = classifyTool(toolName);
  const used = counts.get(toolName) ?? 0;
  if (spec?.budgetPerTurn && used >= spec.budgetPerTurn) {
    throw new ToolBudgetError(toolName, spec.budgetPerTurn);
  }
  counts.set(toolName, used + 1);
}
