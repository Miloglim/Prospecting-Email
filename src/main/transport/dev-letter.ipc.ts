// ── 自动开发信 / 运价查询卡片 IPC（首页功能卡的后端入口）──────────────
// 与 agent 会话零耦合：devLetter:recommend 是确定性计算（无模型调用）。
// 运价查询卡片不发 IPC——它只是把用户填的信息拼成规范化提示词发进会话（见 renderer/lib/homeCards.ts）。
import { ipcMain } from "electron";
import { IPC } from "../contract";
import { recommendDevLetterGroup } from "../services/dev-letter.service";
import { okResult, failResult } from "../errors";

export function registerDevLetterIPC() {
  ipcMain.handle(IPC.DEV_LETTER.RECOMMEND, (_e, capOverride?: number) => {
    const cap = Number(capOverride);
    const r = recommendDevLetterGroup(Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : undefined);
    if (!r.success) return failResult(r.error);
    return okResult(r.data);
  });
}
