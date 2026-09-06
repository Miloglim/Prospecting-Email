// ── Reflector：数字回溯校验（规则版，零额外 LLM 调用）──────────────
// 回合收尾时校验最终正文里的「数量」是否都能回溯到本轮工具返回的原值
// （系统提示词的「数字硬校验」纪律第一次有了程序化的牙齿）。
// 回溯不过 → 用已采集的工具数据做一次轻量自纠；仍不过就在文末附注，
// 不做校验死循环。只查「数字 + 量词」与「共/总 N」这类数量断言 —— 日期、
// 阶段号（F2）、柜型（40HQ）不带量词，不在射程内，避免误伤。
import { chat as llmChat } from "../ai.service";

const QUANTITY_PATTERNS: RegExp[] = [
  /(\d[\d,]*)\s*(封|条|个|位|家|笔|组|人|次|步)/g,
  /共\s*(\d[\d,]*)/g,
  /总(?:共|计)\s*(\d[\d,]*)/g,
];

/**
 * 从一段文本里收集数字池（含 JSON 里的 total/returned/数组元素）
 * 工具输出与用户输入共用：用户给的数字（如自己说"8714 个联系人"）天然可信，豁免校验
 */
function collectNumbers(texts: string[]): Set<number> {
  const pool = new Set<number>();
  for (const out of texts) {
    for (const m of String(out).matchAll(/\d[\d,]*/g)) {
      const v = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(v)) pool.add(v);
    }
  }
  return pool;
}

/**
 * 返回正文里回溯不过的数量断言（如「5 封」「共 12」）。
 * 空数组 = 全部可回溯（或正文里根本没有数量断言）。
 * exempt：用户输入原文 —— 其中出现过的数字视为已获授权，不进校验射程。
 */
export function reflectOnNumbers(answer: string, toolOutputs: string[], exempt: string[] = []): string[] {
  const text = String(answer || "");
  if (!text.trim()) return [];
  const pool = collectNumbers(toolOutputs);
  const ok = collectNumbers(exempt);
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const re of QUANTITY_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1]!;
      const v = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(v)) continue;
      if (pool.has(v) || ok.has(v)) continue;
      const label = m[2] ? `${raw}${m[2]}` : `共 ${raw}`;
      if (!seen.has(label)) { seen.add(label); bad.push(label); }
    }
  }
  return bad;
}

/**
 * 轻量自纠（最多一次的「反思」动作）：把对不上的数量与本轮工具证据一起
 * 交给轻任务端点，只许依据证据改数字、不许重写其余内容。
 * 返回纠后全文；端点失败/返回空 → null（调用方保留原文 + 附注兜底）。
 */
export async function selfCorrectNumbers(answer: string, bad: string[], toolOutputs: string[]): Promise<string | null> {
  const evidence = toolOutputs.map(o => String(o).slice(0, 1500)).join("\n---\n").slice(0, 8000);
  if (!evidence.trim()) return null;   // 没有工具证据就没有纠正依据，别空跑一次模型
  try {
    const r = await llmChat(
      "你是数字校对器。下面的回答里有与工具数据不符的数量。只允许依据「工具数据」修改这些数量本身，"
        + "其余文字一字不动；工具数据里没有的数量改成「若干」并保留句式。只输出纠正后的完整回答，不要解释。",
      `与工具数据不符的数量：${bad.join("、")}\n\n工具数据（唯一依据）：\n${evidence}\n\n原回答：\n${answer.slice(0, 4000)}`,
    );
    const fixed = r.success ? r.data.trim() : "";
    return fixed && fixed.length >= Math.min(20, answer.length) ? fixed : null;
  } catch { return null; }
}
