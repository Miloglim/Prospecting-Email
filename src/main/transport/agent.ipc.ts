import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../contract";
import * as Agent from "../services/agent.service";
import { failResult } from "../errors";

/** 渲染进程事件推送器 — 与 send.ipc/inbox.ipc 同模式，service 层不接触 electron */
function makePush() {
  return (channel: string, data: unknown) => {
    try { BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data); } catch { /* 窗口已销毁 */ }
  };
}

export function registerAgentIPC() {
  const push = makePush();

  // 发起一轮对话（立即返回 ID，正文走 agent:chunk 事件流）
  ipcMain.handle(IPC.AGENT.CHAT, (_e, input: Agent.ChatInput) => Agent.chat(push, input));

  // 中断当前生成
  ipcMain.handle(IPC.AGENT.STOP, (_e, conversationId: string) => {
    if (!conversationId) return failResult("缺少 conversationId");
    return Agent.stop(conversationId);
  });

  // provider 配置状态（mock/live）
  ipcMain.handle(IPC.AGENT.STATUS, () => Agent.status());

  // 会话管理（左侧历史列表）
  ipcMain.handle(IPC.AGENT.LIST_CONVERSATIONS, () => Agent.listConversations());

  ipcMain.handle(IPC.AGENT.GET_CONVERSATION, (_e, conversationId: string) => Agent.getMessages(conversationId));

  ipcMain.handle(IPC.AGENT.RENAME_CONVERSATION,
    (_e, input: { conversationId?: string; title?: string }) =>
      Agent.renameConversation(input?.conversationId ?? "", input?.title ?? ""));

  ipcMain.handle(IPC.AGENT.DELETE_CONVERSATION, (_e, conversationId: string) =>
    Agent.deleteConversation(conversationId));
}
