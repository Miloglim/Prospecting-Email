// ── 写操作幂等（Q5 幂等控制）─────────────────────────────────
// 症状：同一句「给 X 记一条跟进」被模型重复提交、或用户连点两次动作卡 → 库里出现两条
// 一模一样的记录 / 队列里重复入队。
// 做法：会话 + 工具 + 参数哈希做键，5 分钟内重复提交直接复用上一次的返回，不再执行。
// 只用于写操作：读工具每次重查才是对的（数据可能刚变）。
import * as crypto from "crypto";
import type { ToolCtx } from "./types";

const TTL_MS = 5 * 60_000;
const MAX_KEEP = 100;

const store = new Map<string, { at: number; result: string }>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
  while (store.size > MAX_KEEP) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function keyOf(ctx: ToolCtx, toolName: string, args: unknown): string {
  const hash = crypto.createHash("sha1").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 12);
  return `${ctx.conversationId}|${toolName}|${hash}`;
}

/** 命中返回上次的结果文本，未命中返回 null */
export function lookupIdempotent(ctx: ToolCtx, toolName: string, args: unknown): string | null {
  prune();
  const hit = store.get(keyOf(ctx, toolName, args));
  if (!hit) return null;
  return `${hit.result}\n（重复提交已按幂等处理：${TTL_MS / 60_000} 分钟内相同内容不再执行第二次）`;
}

/** 仅成功结果才缓存，失败要允许重试 */
export function rememberResult(ctx: ToolCtx, toolName: string, args: unknown, result: string): void {
  prune();
  store.set(keyOf(ctx, toolName, args), { at: Date.now(), result });
}

/** 回合失败/停止时不该记住，写失败时显式清除该键 */
export function forget(ctx: ToolCtx, toolName: string, args: unknown): void {
  store.delete(keyOf(ctx, toolName, args));
}
