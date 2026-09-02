// ── 工具结果短时缓存（读类）───────────────────────────────────
// 原则（缓存三原则的落地）：细粒度 Key（会话+工具+参数）、TTL 分级、写后失效。
// 只缓存「事实快照」类读结果：运价、联系人、收件箱、提醒、账号状态——同一回合内
// 模型重复查相同条件的概率高（换措辞重问、多步里重复引用），命中率可观。
// 明确不缓存：email_summarize（LLM 生成，贵但低频）、company_backcheck（外网实时）、
// generate_draft（每次都该新写）、一切写工具。失效由写动作显式触发。
import type { ToolCtx } from "./types";

const TTL_BY_TOOL: Record<string, number> = {
  quote_search: 10 * 60_000,      // 运价镜像：快照级数据，10 分钟
  search_contacts: 3 * 60_000,    // 联系人：可能刚被动作卡改过，短些
  inbox_search: 2 * 60_000,       // 收件箱：新邮件随时到
  reminders_due: 5 * 60_000,
  queue_status: 30_000,            // 队列：秒级变化，半分钟
  accounts_status: 60_000,
};

/** 写动作之后该失效哪些前缀（按参数特征粗粒度失效，宁多勿漏） */
const INVALIDATE_ON_WRITE: Record<string, string[]> = {
  record_followup: ["search_contacts", "reminders_due"],
  send_queue_add: ["queue_status", "search_contacts"],
  // 动作卡的写（记跟进/标记已读/标记流失/建联系人/入队）在 actions 执行侧统一全清
};

const store = new Map<string, { at: number; ttl: number; result: string }>();

function keyOf(ctx: ToolCtx, toolName: string, args: unknown): string {
  return `${ctx.conversationId}|${toolName}|${JSON.stringify(args ?? {})}`;
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > v.ttl) store.delete(k);
  if (store.size > 300) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

/** 命中返回缓存结果（附标记，模型可知道这是刚才查过的同一份）；未命中 null */
export function lookupCache(ctx: ToolCtx, toolName: string, args: unknown): string | null {
  const ttl = TTL_BY_TOOL[toolName];
  if (!ttl) return null;                       // 不在缓存名单里 = 每次都真查
  prune();
  const hit = store.get(keyOf(ctx, toolName, args));
  if (!hit || Date.now() - hit.at > hit.ttl) return null;
  return `${hit.result}\n（缓存命中：与刚才 ${Math.round((Date.now() - hit.at) / 1000)} 秒前那次查询结果相同，可直接使用）`;
}

export function rememberCache(ctx: ToolCtx, toolName: string, args: unknown, result: string): void {
  const ttl = TTL_BY_TOOL[toolName];
  if (!ttl) return;
  prune();
  store.set(keyOf(ctx, toolName, args), { at: Date.now(), ttl, result });
}

/** 写动作后失效相关读缓存；不传 toolName 则全清（动作卡写操作用） */
export function invalidateCache(toolName?: string): void {
  if (!toolName) { store.clear(); return; }
  const prefixes = INVALIDATE_ON_WRITE[toolName] ?? [];
  for (const k of [...store.keys()]) {
    const tool = k.split("|")[1] ?? "";
    if (prefixes.includes(tool)) store.delete(k);
  }
}

/** 命中/总量统计（设置页显示缓存有没有在干活） */
export function cacheStats(): { entries: number; hitRateDenominator: number } {
  return { entries: store.size, hitRateDenominator: hits + misses };
}
let hits = 0;
let misses = 0;
export function countHit() { hits++; }
export function countMiss() { misses++; }
