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

export const TOOL_SPECS: Record<string, ToolSpec> = {
  search_contacts:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 5 },
  quote_search:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 5 },
  inbox_search:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 6 },
  email_summarize:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 6 },
  company_backcheck:{ sideEffect: "read",  requiresApproval: false, budgetPerTurn: 1 },
  generate_draft:   { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  queue_status:     { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  reminders_due:    { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 3 },
  accounts_status:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  // 元工具：只维护界面可见的任务清单，不读不写业务数据，故免审批；上限放宽防多步任务频繁刷新
  update_plan:      { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 8 },
  // P2 元能力：产物落盘（只写 outputs/agent，不碰业务数据）与后台批量任务（只读搜索+生成）
  export_artifact:  { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  start_batch_task: { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 1 },
  // 元能力：能力缺口登记（开发期需求探针，只写 agent_gaps 台账）
  report_gap:       { sideEffect: "read",  requiresApproval: false, budgetPerTurn: 2 },
  record_followup:  { sideEffect: "write", requiresApproval: true,  budgetPerTurn: 2, autoApprovable: true },
  // 批量导入联系人：写库，须人工确认，不可会话豁免；一轮一次防重复提交
  import_contacts:  { sideEffect: "write", requiresApproval: true,  budgetPerTurn: 1, autoApprovable: false },
  // 入队 ≠ 发出：startDynamicSend 以 autoStart=false 仅建队列，真正发送仍需用户在发送中心点启动
  // 永不 autoApprovable：外发动作每一次都要人工确认
  send_queue_add:   { sideEffect: "write", requiresApproval: true,  budgetPerTurn: 1, autoApprovable: false },
} as const;

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
