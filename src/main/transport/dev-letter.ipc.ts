// ── 自动开发信 / 运价查询卡片 IPC（首页功能卡的后端入口）──────────────
// 选人与排序始终是确定性规则（dev-letter.service）；传了 criteriaText 时，模型只负责把那句
// 话翻成结构化筛选条件，模型不可用就走关键词兜底（规范 docs/task-card-devletter-spec.md §4）。
// 运价查询卡片不发 IPC——它只是把用户填的信息拼成规范化提示词发进会话（见 renderer/lib/homeCards.ts）。
import { ipcMain } from "electron";
import { IPC } from "../contract";
import { recommendDevLetterGroup } from "../services/dev-letter.service";
import { parseDevLetterIntent } from "../services/dev-letter-intent";
import { okResult, failResult } from "../errors";
import { Log } from "../logger";

export function registerDevLetterIPC() {
  // 入参兼容两种形态：旧的位置 cap（number）与新的 { cap?, criteriaText? }
  ipcMain.handle(IPC.DEV_LETTER.RECOMMEND, async (_e, input?: number | { cap?: number; criteriaText?: string }) => {
    const obj = typeof input === "number" ? { cap: input } : (input ?? {});
    const cap = Number(obj.cap);
    const text = (obj.criteriaText ?? "").trim();
    let criteria;
    if (text) {
      try {
        criteria = await parseDevLetterIntent(text);
      } catch (err) {
        // 解析炸了也不能把用户的整条要求丢掉后就报错：退回默认推荐，理由里说明
        Log.warn("devLetter.intent", `要求解析失败，退回默认推荐: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const r = recommendDevLetterGroup(Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : undefined, new Date(), criteria);
    if (!r.success) return failResult(r.error);
    return okResult(r.data);
  });
}
