// ── Agent 记忆接口（唯一读写入口）─────────────────────────────────
// 两层：
//  · 工作记忆（会话消息）：近端 30 条原文 + 超出中段压成一条摘要注入；
//  · 工具事实（agent_facts）：每次工具成功调用抽一行事实（共 N 封 / 已导出 X /
//    到期 X · 逾期 Y…），加载历史时注入最近几条 —— 工具结果从不进消息历史，
//    不记下来，上一轮查过的数据下一轮就只能重查（实测「另外两个客户」翻车的根因）。
// 读（loadConversation）写（rememberToolFact）都收口在这里，其余模块不直接碰。
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { agentMessages, agentFacts } from "../../db/schema/agent";
import { chat as llmChat } from "../ai.service";
import type { ChatMsg } from "./harness";

/** 每次请求携带的历史条数上限（system 除外），防上下文膨胀 */
export const HISTORY_LIMIT = 30;
/** 加载历史时注入的工具事实条数：够覆盖「刚才查过的」，不喧宾夺主 */
const FACT_RECALL_LIMIT = 12;

/**
 * 读会话进上下文：中段摘要（如有）→ 已查事实（如有）→ 最近原文。
 * 摘要与事实都以「系统注入」前缀的 user 消息承载（与既有摘要口径一致）。
 */
export async function loadConversation(convId: string): Promise<ChatMsg[]> {
  const rows = getDb().select().from(agentMessages)
    .where(eq(agentMessages.conversationId, convId))
    .orderBy(asc(agentMessages.id)).all()
    .filter(r => r.role === "user" || r.role === "assistant");   // error 卡片只给人看，不进模型
  const factBlock = recallFactBlock(convId);
  if (rows.length <= HISTORY_LIMIT) {
    const recent = rows.map(r => ({ role: r.role as "user" | "assistant", content: r.content }));
    return [...factBlock, ...recent];
  }
  const dropped = rows.slice(0, rows.length - HISTORY_LIMIT);
  const recent = rows.slice(-HISTORY_LIMIT).map(r => ({ role: r.role as "user" | "assistant", content: r.content }));
  const summary = await summarizeEarlier(dropped);
  return [
    { role: "user", content: `【系统注入·此前对话摘要（${dropped.length} 条已压缩，不必再提）】\n${summary}` },
    ...factBlock,
    ...recent,
  ];
}

/** 已查事实注入块：没有就不出声（短对话零噪音） */
function recallFactBlock(convId: string): ChatMsg[] {
  const facts = getDb().select().from(agentFacts)
    .where(eq(agentFacts.conversationId, convId))
    .orderBy(desc(agentFacts.id)).limit(FACT_RECALL_LIMIT).all()
    .reverse();   // 旧 → 新
  if (!facts.length) return [];
  const lines = facts.map(f => `· ${f.toolName}：${f.fact}`).join("\n");
  return [{
    role: "user",
    content: `【系统注入·本会话已查过的数据】\n${lines}\n以上已是此前轮次查到的结果，可直接引用这些结论；相同条件不要重复调用工具再查一遍。`,
  }];
}

/** 写一条工具事实（记忆写入口；只记成功调用，失败不值得记） */
export function rememberToolFact(conversationId: string, toolName: string, fact: string): void {
  const text = fact.trim().slice(0, 120);
  if (!text) return;
  try {
    getDb().insert(agentFacts).values({ conversationId, toolName, fact: text }).run();
  } catch { /* 记忆写入失败不阻塞主流程 */ }
}

/**
 * 从工具结果（统一包络）抽一行事实：有 say 用 say，其次按结构特征归纳；
 * 抽不出来说明这次结果不值得跨轮记忆，返回 null。
 */
export function extractFact(toolName: string, result: unknown): string | null {
  try {
    const o = (typeof result === "string" ? JSON.parse(result) : result) as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || o.ok === false) return null;
    if (typeof o.say === "string" && o.say.trim()) return o.say.trim();
    const art = o.artifact as { name?: unknown } | undefined;
    if (art && typeof art.name === "string") return `已导出文件「${art.name}」`;
    const task = o.task as { total?: unknown } | undefined;
    if (task && typeof task.total === "number") return `已启动后台任务（共 ${task.total} 项）`;
    if (typeof o.dueCount === "number") return `到期 ${o.dueCount} · 逾期 ${(o.overdueCount as number) ?? 0} 条跟进提醒`;
    if (typeof o.healthy === "number" && typeof o.enabled === "number") return `发信账号 ${o.healthy}/${o.enabled} 健康`;
    if (typeof o.imported === "number") return `导入完成：新增 ${o.imported} 位联系人`;
    if (typeof o.total === "number") return `共查到 ${o.total} 条`;
    return null;
  } catch { return null; }
}

/** 压缩超限中段：轻任务端点，200 字以内中文要点；失败给占位而非报错（不阻塞对话） */
async function summarizeEarlier(dropped: Array<{ role: string; content: string }>): Promise<string> {
  const text = dropped.map(m => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 400)}`).join("\n").slice(0, 8000);
  try {
    const r = await llmChat(
      "你是对话压缩器。把以下多轮对话压成不超过 200 字的中文要点：已讨论的结论、已查到的关键数据、用户的偏好与未决事项。只输出要点本身。",
      text,
    );
    if (r.success) return r.data;
  } catch { /* 摘要失败不阻塞对话 */ }
  return `（本会话此前另有 ${dropped.length} 条消息，压缩失败已省略；如需回顾请重新说明要点）`;
}
