// Agent 工具层共享类型（单独成文件，避免 tools ↔ idempotency 互相引用成环）

/** 主进程 → 渲染进程事件推送器（形状同 harness.PushFn；就地声明避免循环引用） */
export type CtxPushFn = (channel: string, data: unknown) => void;

export interface ToolCtx {
  conversationId: string;
  /** 事件推送器：后台任务等需要在工具执行层直接推进度的场景用 */
  push: CtxPushFn;
  /** 本回合各工具已调用次数（预算守卫） */
  counts: Map<string, number>;
  /** 各工具连续失败次数（熔断守卫）：成功清零，达到阈值后本回合暂停该工具 */
  failures: Map<string, number>;
}
