// ── 首页功能卡片的纯逻辑（提示词拼装 + 推荐名单交接）──────────────────
// 运价查询卡片：用户填 起运港/目的港/柜型/备注 → 这里拼成一段"固定流程"提示词发进会话。
// 标准化两头保证：提示词写死流程步骤（不反问、分层报数、表格原样贴、查不到明说）；
// quote_search 服务端已预计算 answer/两张表，模型只许照抄（docs/home-cards-spec.md §1）。
export interface QuoteCardInput {
  pol?: string;        // 起运港，可空=不限
  pod: string;         // 目的港，必填
  container?: string;  // 柜型，可空
  remark?: string;     // 备注，可空（用户键入的附加要求）
}

/** 拼规范化查价提示词。纯函数，导出供单测（流程步骤的措辞变更要过测试）。 */
export function buildQuotePrompt(input: QuoteCardInput): string {
  const pol = (input.pol ?? "").trim();
  const pod = (input.pod ?? "").trim();
  const container = (input.container ?? "").trim();
  const remark = (input.remark ?? "").trim();
  const lines: string[] = [];
  lines.push(`【运价查询】起运港：${pol || "不限"}；目的港：${pod}${container ? `；柜型：${container}` : ""}${remark ? `；备注：${remark}` : ""}`);
  lines.push("按以下固定流程执行，不要反问我：");
  lines.push(`1) 调一次 quote_search：pol="${pol || ""}"，pod="${pod}"${container ? `，container="${container}"` : ""}，一次拿全；`);
  lines.push("2) 先说明目的港属于哪条航线，再分层报数：本港专属价在前（条数+最低价），航线级适用价在后（注明适用基本港），两类不混；");
  lines.push("3) 同批带出近 21 天舱位动态，照表原值说；");
  lines.push("4) 表格照工具返回原样贴（12 列工作表），数字与列名不改；查不到就明说（区分「有过期价」与「真没有」），不要用市场价或记忆补数；");
  if (remark) lines.push(`5) 用户备注：「${remark}」——与本次查价相关的要求一并满足。`);
  return lines.join("\n");
}

/** 卡片三「让助手逐封看」的固定流程提示词（概览数字由程序算，深挖交给 agent，口径写死防跑偏）。 */
export function buildMailBriefPrompt(): string {
  return [
    "总结今天的邮箱情况，按这个流程来，不要反问我：",
    "1) 调 inbox_search 取今天的邮件（未读优先，limit 给足）；要看正文再逐封 email_read_full，别拿预览当全文；",
    "2) 逐封给「发件人 / 主题 / 一句话摘要 / 下一步建议」，客户回复与询价排前面并标出已等多久；",
    "3) 退信与自动回复单独归类说明（自动回复不用回）；",
    "4) 需要回复或写入跟进的，先给草稿或清单让我确认——不得自动发送、不得替我入队。",
  ].join("\n");
}

// ── 自动开发信名单交接：首页推荐 → 发送中心「新建任务」预选 ─────────────
// localStorage 一次性交接（读走即删）：跨页面传几十个 id，比 hash 传参干净。
export const DEV_LETTER_PRESET_KEY = "dev-letter-preset";

export function stashDevLetterPreset(ids: number[], note: string): void {
  try { localStorage.setItem(DEV_LETTER_PRESET_KEY, JSON.stringify({ ids, note, at: Date.now() })); } catch { /* 存不进去就不预选 */ }
}

export function takeDevLetterPreset(): { ids: number[]; note: string } | null {
  try {
    const raw = localStorage.getItem(DEV_LETTER_PRESET_KEY);
    if (!raw) return null;
    localStorage.removeItem(DEV_LETTER_PRESET_KEY);
    const p = JSON.parse(raw) as { ids?: unknown; note?: unknown };
    if (Array.isArray(p.ids) && p.ids.every(n => typeof n === "number")) {
      return { ids: p.ids as number[], note: typeof p.note === "string" ? p.note : "来自首页「自动开发信」推荐" };
    }
  } catch { /* 坏数据当没有 */ }
  return null;
}
