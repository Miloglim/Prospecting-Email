/** 应用级事件常量 — 主进程→渲染进程推送用 */
export const EVENTS = {
  /** 发送进度更新 */
  SEND_PROGRESS: "send:progress",
  /** 退信检测到新退信 */
  BOUNCE_DETECTED: "inbox:bounceDetected",
  /** 新邮件到达 */
  NEW_MAIL: "inbox:newMail",
  /** 更新可用 */
  UPDATE_AVAILABLE: "system:updateAvailable",
  /** 熔断器状态变化 */
  CIRCUIT_CHANGED: "accounts:circuitChanged",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
