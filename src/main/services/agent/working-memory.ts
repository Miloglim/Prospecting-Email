// ── 会话工作台（closed-loop working memory）读写唯一入口 ──────────────
// 为什么：工具结果从不进消息历史（见 memory.ts 头注），读过的邮件正文、查到的运价、
// 筛出的联系人下一轮就蒸发 → 模型「睁眼瞎」甚至编造。工作台把「决策相关的结构化结果」
// 落库：紧凑要点(contextLine)回放进上下文治失明，完整数据(payloadJson)供工具程序化直取治编造。
// 读(recallWorkBlock/getWork/listWork)写(rememberWork)都收口在这里，其余模块不直接碰表。
// 设计见 docs/agent-closed-loop-spec.md。
import * as crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { agentWorkingMemory } from "../../db/schema/agent";
import type { ChatMsg } from "./harness";

export type WmKind = "email" | "rates" | "contacts" | "inbox" | "backcheck" | "draft";

export interface WmItem {
  kind: WmKind;
  /** 去重键：email=messageId，rates/contacts=查询指纹（用 fingerprint() 生成）；同键 upsert 刷新而非堆叠 */
  refId: string;
  toolName: string;
  /** 回放进上下文的紧凑要点（1-3 行，含单位/口径）。超长按 CONTEXT_LINE_CAP 截断 */
  contextLine: string;
  /** 供工具程序化直取的完整结构化数据。超长按 PAYLOAD_CAP 裁剪（保条数、砍长文本字段） */
  payload: unknown;
}

/** 单条要点回放上限（字符） */
const CONTEXT_LINE_CAP = 400;
/** 单条 payload 落库上限（字节）：超限裁字段，绝不产出非法 JSON */
const PAYLOAD_CAP = 8_192;
/** 回放注入块总量上限（字符）：超出按新→旧保留，旧的丢尾 */
const RECALL_CHAR_CAP = 1_800;
/** 回放注入条数上限（对齐原 FACT_RECALL_LIMIT 口径） */
const RECALL_COUNT_CAP = 12;

/** 稳定查询指纹：把筛选参数对象归一成短哈希，做 rates/contacts 的 refId（同条件重查命中同一条） */
export function fingerprint(parts: Record<string, unknown>): string {
  const keys = Object.keys(parts).sort();
  const canon = keys.map(k => `${k}=${norm(parts[k])}`).join("&");
  return crypto.createHash("sha1").update(canon).digest("hex").slice(0, 16);
}
function norm(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(norm).join(",");
  return String(v).trim().toLowerCase();
}

/**
 * payload 落库前裁剪到 PAYLOAD_CAP 以内，始终产出合法 JSON：
 * 优先「保条数、砍每条的长文本字段」——数据行比行内长描述更值钱（治 P6：整页 JSON 被硬切损坏）。
 */
export function fitPayload(payload: unknown): string {
  let obj = payload;
  let s = safeStringify(obj);
  if (s.length <= PAYLOAD_CAP) return s;
  // 1) 找到最大的数组字段，逐轮砍其元素里的长字符串字段
  const arrKey = largestArrayKey(obj);
  if (arrKey) {
    for (const threshold of [200, 80, 30]) {
      obj = trimLongStrings(obj, arrKey, threshold);
      s = safeStringify(obj);
      if (s.length <= PAYLOAD_CAP) return s;
    }
    // 2) 还超：对半砍数组条数，直到达标或只剩 1 条
    let arr = (obj as Record<string, unknown>)[arrKey] as unknown[];
    while (Array.isArray(arr) && arr.length > 1 && s.length > PAYLOAD_CAP) {
      arr = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
      obj = { ...(obj as Record<string, unknown>), [arrKey]: arr, _truncated: true };
      s = safeStringify(obj);
    }
    if (s.length <= PAYLOAD_CAP) return s;
  }
  // 3) 兜底：整体截断成一个合法的「已裁剪」信封（绝不吐半截 JSON）
  return safeStringify({ _truncated: true, preview: s.slice(0, PAYLOAD_CAP - 64) });
}
function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? "null"; } catch { return "null"; }
}
function largestArrayKey(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  let best: string | null = null, bestLen = 0;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > bestLen) { best = k; bestLen = v.length; }
  }
  return best;
}
function trimLongStrings(obj: unknown, arrKey: string, threshold: number): unknown {
  const rec = obj as Record<string, unknown>;
  const arr = rec[arrKey];
  if (!Array.isArray(arr)) return obj;
  return {
    ...rec,
    [arrKey]: arr.map(el => {
      if (!el || typeof el !== "object") return el;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(el as Record<string, unknown>)) {
        out[k] = typeof v === "string" && v.length > threshold ? v.slice(0, threshold) + "…" : v;
      }
      return out;
    }),
  };
}

/** 写一条工作台项（upsert：同 conversationId+kind+refId 覆盖刷新）。失败吞掉，不阻塞主流程。 */
export function rememberWork(conversationId: string, item: WmItem): void {
  const contextLine = (item.contextLine || "").trim().slice(0, CONTEXT_LINE_CAP);
  const refId = (item.refId || "").trim().slice(0, 120);
  if (!contextLine || !refId) return;
  const payloadJson = fitPayload(item.payload);
  try {
    const db = getDb();
    const now = new Date().toISOString();   // 统一 ISO 毫秒：insert/update 同格式，回放 ORDER BY updatedAt 才不错序
    const existing = db.select().from(agentWorkingMemory)
      .where(and(
        eq(agentWorkingMemory.conversationId, conversationId),
        eq(agentWorkingMemory.kind, item.kind),
        eq(agentWorkingMemory.refId, refId),
      )).get();
    if (existing) {
      db.update(agentWorkingMemory)
        .set({ toolName: item.toolName, contextLine, payloadJson, updatedAt: now })
        .where(eq(agentWorkingMemory.id, existing.id)).run();
    } else {
      db.insert(agentWorkingMemory)
        .values({ conversationId, kind: item.kind, refId, toolName: item.toolName, contextLine, payloadJson, createdAt: now, updatedAt: now }).run();
    }
  } catch { /* 工作台写入失败不阻塞主流程 */ }
}

/** 回放注入块：取本会话最近若干条要点（总量封顶），没有就不出声（短对话零噪音）。 */
export function recallWorkBlock(conversationId: string): ChatMsg[] {
  let rows: Array<{ kind: string; contextLine: string; updatedAt: string }>;
  try {
    rows = getDb().select({
      kind: agentWorkingMemory.kind,
      contextLine: agentWorkingMemory.contextLine,
      updatedAt: agentWorkingMemory.updatedAt,
    }).from(agentWorkingMemory)
      .where(eq(agentWorkingMemory.conversationId, conversationId))
      .orderBy(desc(agentWorkingMemory.updatedAt), desc(agentWorkingMemory.id))
      .all();
  } catch { return []; }
  if (!rows.length) return [];
  // 新→旧累加到封顶，再翻回时间正序展示（旧的读起来顺，新的不会被总量挤掉）
  const picked: typeof rows = [];
  let chars = 0;
  for (const r of rows) {
    if (picked.length >= RECALL_COUNT_CAP) break;
    if (chars + r.contextLine.length > RECALL_CHAR_CAP) continue;   // 跳过过长的旧项，继续收更短的
    picked.push(r); chars += r.contextLine.length;
  }
  if (!picked.length) return [];
  picked.reverse();
  const lines = picked.map(r => `· ${r.contextLine}`).join("\n");
  return [{
    role: "user",
    content: `【系统注入·本会话工作台（此前已取到的真实数据，可直接引用）】\n${lines}\n`
      + "以上是本会话此前工具取到的真实结果，回答时直接引用；相同条件不要重复调用工具再查一遍；"
      + "不在这里、也没本轮查到的数据，一律不要编造。",
  }];
}

/** 程序化直取：按 kind(+可选 refId) 拿完整 payload（generate_draft 取真运价/邮件要素用）。无则 null。 */
export function getWork(conversationId: string, kind: WmKind, refId?: string): unknown | null {
  try {
    const db = getDb();
    const conds = refId
      ? and(eq(agentWorkingMemory.conversationId, conversationId), eq(agentWorkingMemory.kind, kind), eq(agentWorkingMemory.refId, refId))
      : and(eq(agentWorkingMemory.conversationId, conversationId), eq(agentWorkingMemory.kind, kind));
    const row = db.select().from(agentWorkingMemory).where(conds)
      .orderBy(desc(agentWorkingMemory.updatedAt), desc(agentWorkingMemory.id)).get();
    if (!row) return null;
    return JSON.parse(row.payloadJson) as unknown;
  } catch { return null; }
}

/** 列出某 kind 的工作台项（新→旧），供工具按会话上下文挑匹配数据。 */
export function listWork(conversationId: string, kind: WmKind, limit = 10): Array<{ refId: string; payload: unknown; updatedAt: string }> {
  try {
    const rows = getDb().select().from(agentWorkingMemory)
      .where(and(eq(agentWorkingMemory.conversationId, conversationId), eq(agentWorkingMemory.kind, kind)))
      .orderBy(desc(agentWorkingMemory.updatedAt), desc(agentWorkingMemory.id))
      .limit(limit).all();
    return rows.map(r => ({ refId: r.refId, payload: safeParse(r.payloadJson), updatedAt: r.updatedAt }));
  } catch { return []; }
}
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
