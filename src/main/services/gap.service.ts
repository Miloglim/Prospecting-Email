// ── 能力缺口台账（开发期需求探针）──────────────────────────────────
// 策略（用户拍板）：agent「做不到」不遮掩、不加防御闸门 —— 让它如实说完做不到后
// 用 report_gap 登记一笔，抱怨次数（hits）就是排功能优先级的信号。
// 本服务只做台账读写，无任何业务副作用。
import { getDb, saveDatabase } from "../db";
import { agentGaps } from "../db/schema/agent";
import { desc, eq } from "drizzle-orm";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";

export interface GapInput { wanted?: string | null; scene?: string | null; workaround?: string | null }

export interface GapDto {
  id: number;
  wanted: string;
  scene: string | null;
  workaround: string | null;
  hits: number;
  lastSeenAt: string;
}

/** 归一比较键：去空白与常见标点，"把他加入联系人库" ≈ "把 他 加入联系人库"，供同义合并 */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s，。、！？!?.,;:「」“”()（）"'·-]/g, "");
}

/**
 * 登记一条能力缺口。同义缺口（归一后互相包含）不新增行，hits+1 并刷新 last_seen_at
 * ——「被抱怨三次」才是加功能的信号，三条一样的记录只是噪声。
 */
export function reportGap(input: GapInput): Result<{ gapId: number; hits: number; merged: boolean }> {
  const wanted = String(input.wanted ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!wanted) return failResult("参数错误: wanted 必填");
  const key = normKey(wanted);
  const now = new Date().toISOString();
  try {
    const db = getDb();
    const all = db.select().from(agentGaps).all();
    const dup = all.find(g => {
      const k = normKey(g.wanted);
      return k === key || k.includes(key) || key.includes(k);
    });
    if (dup) {
      db.update(agentGaps)
        .set({ hits: dup.hits + 1, lastSeenAt: now })
        .where(eq(agentGaps.id, dup.id)).run();
      saveDatabase();
      Log.info("agent.gap", `缺口重复合并 #${dup.id}「${dup.wanted.slice(0, 40)}」hits=${dup.hits + 1}`);
      return okResult({ gapId: dup.id, hits: dup.hits + 1, merged: true });
    }
    db.insert(agentGaps).values({
      wanted,
      scene: String(input.scene ?? "").trim().slice(0, 120) || null,
      workaround: String(input.workaround ?? "").trim().slice(0, 200) || null,
      hits: 1, createdAt: now, lastSeenAt: now,
    }).run();
    saveDatabase();
    // 取回自增 id（sql.js/better-sqlite3 双适配器下 lastInsertRowid 形状不一，查回来最稳）
    const row = db.select({ id: agentGaps.id }).from(agentGaps)
      .where(eq(agentGaps.wanted, wanted)).all().pop();
    Log.info("agent.gap", `新登记缺口 #${row?.id ?? "?"}「${wanted.slice(0, 40)}」`);
    return okResult({ gapId: row?.id ?? 0, hits: 1, merged: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.warn("agent.gap", `登记失败：${msg}`);
    return failResult(`缺口登记失败：${msg}`);
  }
}

/** 缺口清单：按被抱怨次数降序、同级按最近出现 —— 排最前面的就是最该做的 */
export function listGaps(limit = 20): Result<GapDto[]> {
  try {
    const rows = getDb().select().from(agentGaps)
      .orderBy(desc(agentGaps.hits), desc(agentGaps.lastSeenAt))
      .limit(Math.min(Math.max(limit, 1), 100)).all();
    return okResult(rows.map(r => ({
      id: r.id, wanted: r.wanted, scene: r.scene, workaround: r.workaround,
      hits: r.hits, lastSeenAt: r.lastSeenAt,
    })));
  } catch (err) {
    return failResult(err instanceof Error ? err.message : String(err));
  }
}
