/** 应用级事件常量 — 主进程→渲染进程推送用（preload 白名单由本常量推导） */
export const EVENTS = {
  /** 发送进度更新 */
  SEND_PROGRESS: "send:progress",
  /** 退信检测到新退信 */
  BOUNCE_DETECTED: "inbox:bounceDetected",
  /** 新邮件到达 */
  NEW_MAIL: "inbox:newMail",
  /** 收件箱抓取进度 */
  INBOX_FETCH_PROGRESS: "inbox:fetchProgress",
  /** 账号收信健康度变化（每轮抓取后推送 [{accountId,email,ok,error}]） */
  INBOX_HEALTH: "inbox:health",
  /** 熔断器状态变化 */
  CIRCUIT_CHANGED: "accounts:circuitChanged",
  /** 更新可用 */
  UPDATE_AVAILABLE: "update:available",
  /** 更新下载进度 */
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  /** 更新包下载完成 */
  UPDATE_DOWNLOADED: "update:downloaded",
  /** 更新流程出错 */
  UPDATE_ERROR: "update:error",
  /** Agent 流式文字增量 */
  AGENT_CHUNK: "agent:chunk",
  /** Agent 一轮生成完成 */
  AGENT_DONE: "agent:done",
  /** Agent 生成失败 */
  AGENT_ERROR: "agent:error",
  /** Agent 工具调用状态（calling/done） */
  AGENT_TOOL_CALL: "agent:toolCall",
  /** Agent 多步任务清单快照（update_plan 全量推送，渲染端原地刷新） */
  AGENT_PLAN: "agent:plan",
  /** Agent 写操作请求人工审批 */
  AGENT_APPROVAL: "agent:approval",
  /** Agent 后台长任务进度快照（start_batch_task 每步全量推送，任务卡原地刷新） */
  AGENT_TASK: "agent:task",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
