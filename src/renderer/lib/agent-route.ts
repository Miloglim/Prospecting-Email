/**
 * 助手会话的路由胶水：活动会话由 hash 参数驱动（#/assistant?c=<id>，与全项目 hash 深链惯例一致）。
 * 单独成模块是为了让「会话流水 store」（hooks/useAgentTranscript.ts）也能改路由，
 * 而不必反向 import 导航栏组件（Sidebar 里保留同名 re-export，调用方无需改动）。
 */

/** 会话数据变更后广播，导航栏监听刷新（标题 / 排序 / 运行中角标） */
export const CONVS_CHANGED = "agent:convs-changed";

export function gotoConversation(id: string | undefined): void {
  window.location.hash = id ? `#/assistant?c=${id}` : "#/assistant";
}
