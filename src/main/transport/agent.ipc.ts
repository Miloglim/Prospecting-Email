import { ipcMain, BrowserWindow, shell } from "electron";
import { IPC } from "../contract";
import * as Agent from "../services/agent.service";
import * as BgTask from "../services/bg-task.service";
import * as Diagnostics from "../services/diagnostics.service";
import * as Gaps from "../services/gap.service";
import { isInsideArtifactDir } from "../services/artifact.service";
import { failResult, okResult } from "../errors";
import { Log } from "../logger";

/** 渲染进程事件推送器 — 与 send.ipc/inbox.ipc 同模式，service 层不接触 electron */
function makePush() {
  return (channel: string, data: unknown) => {
    try { BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data); } catch { /* 窗口已销毁 */ }
  };
}

export function registerAgentIPC() {
  const push = makePush();

  // 启动时记录端点就绪状态 — 排查「助手不回话」的第一现场
  const st = Agent.status();
  if (st.success) {
    const d = st.data as { configured: boolean; model: string };
    Log.info("agent.init", d.configured
      ? `端点就绪 model=${d.model}`
      : "未配置模型端点（设置 → 模型与端点 里新增并启用后，无需重启即可对话）");
  }

  // 发起一轮对话（立即返回 ID，正文走 agent:chunk 事件流）
  ipcMain.handle(IPC.AGENT.CHAT, (_e, input: Agent.ChatInput) => Agent.chat(push, input));

  // 中断当前生成
  ipcMain.handle(IPC.AGENT.STOP, (_e, conversationId: string) => {
    if (!conversationId) return failResult("缺少 conversationId");
    return Agent.stop(conversationId);
  });

  // 写操作审批结论回填（harness 中断流的人工确认环节）
  ipcMain.handle(IPC.AGENT.RESOLVE_APPROVAL, (_e, input: Agent.ApprovalInput) =>
    Agent.resolveApprovalRequest(push, input ?? {}));

  // 端点就绪状态（供对话页角标与提示）
  ipcMain.handle(IPC.AGENT.STATUS, () => Agent.status());

  // 会话管理（左侧历史列表）
  ipcMain.handle(IPC.AGENT.LIST_CONVERSATIONS, () => Agent.listConversations());

  ipcMain.handle(IPC.AGENT.GET_CONVERSATION, (_e, conversationId: string) => Agent.getMessages(conversationId));

  ipcMain.handle(IPC.AGENT.RENAME_CONVERSATION,
    (_e, input: { conversationId?: string; title?: string }) =>
      Agent.renameConversation(input?.conversationId ?? "", input?.title ?? ""));

  ipcMain.handle(IPC.AGENT.DELETE_CONVERSATION, (_e, conversationId: string) =>
    Agent.deleteConversation(conversationId));

  // AI 活动审计：最近工具调用记录（设置页）
  ipcMain.handle(IPC.AGENT.TOOL_CALLS, (_e, limit?: number) => Agent.listToolCalls(limit));

  // 结果卡「写入类」动作：用户点击后执行主进程留存的闭包（过期/重启即失效）
  ipcMain.handle(IPC.AGENT.RUN_ACTION, (_e, actionId: string) => Agent.runAction(actionId));

  // P2 产物卡「打开位置」：仅允许 outputs/agent 目录内的路径（防注入 ../ 越权）
  ipcMain.handle(IPC.AGENT.OPEN_PATH, (_e, input: { path?: string }) => {
    const p = input?.path?.trim();
    if (!p) return failResult("缺少文件路径");
    if (!isInsideArtifactDir(p)) {
      Log.warn("agent.openPath", `拒绝打开产物目录之外的路径：${p.slice(0, 120)}`);
      return failResult("只允许打开助手生成的产物文件");
    }
    try {
      shell.showItemInFolder(p);
      return okResult(undefined);
    } catch (err) {
      return failResult(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // P2 后台任务：任务卡挂载时取快照（此后靠 agent:task 事件增量刷新）
  ipcMain.handle(IPC.AGENT.GET_TASK, (_e, input: { taskId?: string }) => BgTask.getTask(input?.taskId ?? ""));

  // P2 后台任务：取消（当前项做完即停）
  ipcMain.handle(IPC.AGENT.CANCEL_TASK, (_e, input: { taskId?: string }) => BgTask.cancelTask(input?.taskId ?? ""));

  // 诊断包导出：日志尾部 + 配置掩码快照 + 库行数 + 最近异常 → outputs/agent 的 md
  ipcMain.handle(IPC.AGENT.EXPORT_DIAGNOSTICS, () => Diagnostics.exportDiagnostics());

  // 能力缺口台账（/缺口 命令查看，按被抱怨次数降序）
  ipcMain.handle(IPC.AGENT.LIST_GAPS, (_e, limit?: number) => Gaps.listGaps(limit ?? 20));
}
