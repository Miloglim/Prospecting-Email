// Agent 工具层共享类型（单独成文件，避免 tools ↔ idempotency 互相引用成环）
export interface ToolCtx {
  conversationId: string;
  /** 本回合各工具已调用次数（预算守卫） */
  counts: Map<string, number>;
  /** 各工具连续失败次数（熔断守卫）：成功清零，达到阈值后本回合暂停该工具 */
  failures: Map<string, number>;
}
