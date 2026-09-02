// ── Agent 动作卡（Action Card）服务端侧 ─────────────────────────────
// 工具在返回数据的同时，把「可以顺手做掉的写入」注册成待执行动作，只把摘要
// （按钮文案 + 人话确认句 + 字段 diff）随结果推给渲染端；真正的写入闭包留在主进程。
// 安全语义与审批网关一致：必须用户点击才执行、重启即失效、执行落 agent_tool_calls 审计。
import * as crypto from "crypto";
import { getDb, saveDatabase } from "../../db";
import { agentToolCalls } from "../../db/schema/agent";
import { Log } from "../../logger";
import { okResult, failResult, type Result } from "../../errors";

export interface ActionDiffRow { field: string; label: string; from: string; to: string }

export interface PendingAction {
  id: string;
  conversationId: string;
  toolName: string;
  /** 按钮文案（人话，动词开头） */
  label: string;
  /** 确认弹窗主句 */
  confirm: string;
  /** 弹窗副句：风险/边界说明，例如「入队 ≠ 发送」 */
  detail?: string;
  diff: ActionDiffRow[];
  /** 执行成功后给用户的跳转查看入口 */
  target?: { label: string; href: string };
  /** 执行闭包：返回一句人话结果，作为会话内回执 */
  run: () => Promise<Result<string>>;
}

/** 卡片渲染用的可序列化视图（不含闭包） */
export interface ActionCard {
  kind: "write";
  id: string;
  label: string;
  confirm: string;
  detail?: string;
  diff: ActionDiffRow[];
  target?: { label: string; href: string };
}

const TTL_MS = 30 * 60_000;
const MAX_KEEP = 200;

const store = new Map<string, { action: PendingAction; at: number }>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, v] of store) if (v.at < cutoff) store.delete(id);
  // 仍然超限则按时间丢弃最旧的（Map 保持插入序）
  while (store.size > MAX_KEEP) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 注册一个待执行动作，返回 id（工具把它塞进 actions 数组） */
export function registerAction(a: Omit<PendingAction, "id">): ActionCard {
  prune();
  const id = crypto.randomUUID();
  store.set(id, { action: { ...a, id }, at: Date.now() });
  return {
    kind: "write", id, label: a.label, confirm: a.confirm,
    ...(a.detail ? { detail: a.detail } : {}), diff: a.diff,
    ...(a.target ? { target: a.target } : {}),
  };
}

export function hasAction(id: string): boolean {
  return store.has(id);
}

/** 用户点击写入类动作 → 执行闭包 + 审计留痕（approval 记 user_clicked 以示区别） */
export async function executeAction(id: string): Promise<Result<{ label: string; message: string; target?: { label: string; href: string } }>> {
  const hit = store.get(id);
  if (!hit) return failResult("这个动作已经过期（超过 30 分钟或应用重启），请重新问一次");
  store.delete(id);
  const a = hit.action;
  try {
    const r = await a.run();
    audit(a, r.success ? r.data : undefined, r.success ? undefined : r.error);
    if (!r.success) return failResult(r.error);
    return okResult({ label: a.label, message: r.data, ...(a.target ? { target: a.target } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("agent.action", `动作执行失败 ${a.toolName}/${a.label}`, msg);
    audit(a, undefined, msg);
    return failResult(msg);
  }
}

function audit(a: PendingAction, result: string | undefined, error?: string): void {
  try {
    getDb().insert(agentToolCalls).values({
      conversationId: a.conversationId,
      toolName: a.toolName,
      sideEffect: "write",
      argsJson: JSON.stringify({ via: "action_card", label: a.label, diff: a.diff }),
      resultJson: result ? result.slice(0, 4000) : undefined,
      approval: "user_clicked",
      error,
    }).run();
    saveDatabase();
  } catch (err) {
    Log.warn("agent.action", `动作审计写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 清空某会话的待执行动作（会话删除时调用，避免闭包长期驻留） */
export function dropActionsForConversation(conversationId: string): number {
  let n = 0;
  for (const [id, v] of [...store]) {
    if (v.action.conversationId === conversationId) { store.delete(id); n++; }
  }
  return n;
}
