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
}

export const TOOL_SPECS: Record<string, ToolSpec> = {
  search_contacts:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  quote_search:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  inbox_search:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  email_summarize:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  company_backcheck:{ sideEffect: "read",  requiresApproval: false, budgetPerTurn: 1 },
  generate_draft:   { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  queue_status:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  reminders_due:    { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  accounts_status:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  record_followup:  { sideEffect: "write", requiresApproval: true,  budgetPerTurn: 2 },
  // 入队 ≠ 发出：startDynamicSend 以 autoStart=false 仅建队列，真正发送仍需用户在发送中心点启动
  send_queue_add:   { sideEffect: "write", requiresApproval: true,  budgetPerTurn: 1 },
} as const;

export function classifyTool(name: string): ToolSpec | undefined {
  return TOOL_SPECS[name];
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
