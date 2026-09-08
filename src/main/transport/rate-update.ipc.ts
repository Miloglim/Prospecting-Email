// ── 定向运价更新推送 IPC（跟进看板「运价更新」抽屉的唯一后端入口）──────────
// 与 agent 工具走的是同一个 service（rate-update.service.ts）：会话里跑的方案和抽屉里跑的方案必须一模一样。
// 红线：这里没有任何"开始发送"的通道 —— ENQUEUE 只入队，发送由人在发送中心点开始（见规范 §8）。
import { ipcMain } from "electron";
import { IPC } from "../contract";
import {
  buildRateUpdatePlan, planView, pendingPlanRateUpdate, enqueueRateUpdatePlan,
  type RateUpdateOpts,
} from "../services/rate-update.service";
import { deriveCustomerPorts } from "../services/customer-ports";
import { okResult, failResult, type Result } from "../errors";

export function registerRateUpdateIPC() {
  // 生成方案（纯读，不写库；结果留在主进程 pending store，界面只拿投影）
  ipcMain.handle(IPC.RATE_UPDATE.PLAN, (_e, opts?: RateUpdateOpts) => {
    const r = buildRateUpdatePlan(opts ?? {});
    if (!r.success) return failResult(r.error);
    return okResult(planView(r.data));
  });

  // 单组预览：正文 HTML + 客户明细（列表投影刻意不带正文，避免大包过 IPC 把界面卡住）
  ipcMain.handle(IPC.RATE_UPDATE.GROUP_BODY, (_e, planId: string, groupKey: string): Result<unknown> => {
    const plan = planId ? pendingPlanRateUpdate(planId) : null;
    if (!plan) return failResult("方案已过期，请重新生成");
    const g = plan.groups.find(x => x.key === groupKey);
    if (!g) return failResult(`分组不存在：${groupKey}`);
    return okResult({
      key: g.key, pod: g.pod, language: g.language, subject: g.subject, bodyHtml: g.bodyHtml,
      customers: g.customers,
      quotes: g.quotes.map(q => ({
        carrier: q.carrier, pol: q.pols.join("/") || q.polText, pod: q.pod,
        p20: q.p20, p40: q.p40, pNor: q.pNor, freeDays: q.freeDays,
        etd: q.etd, validFrom: q.validFrom, validTo: q.validTo,
      })),
    });
  });

  // 入队（只入队）；队列被既有待发批次占住时返回 occupied，由界面弹二次确认后才带 overwrite 重试
  ipcMain.handle(IPC.RATE_UPDATE.ENQUEUE, async (_e, planId: string, groupKeys?: string[], overwrite?: boolean) => {
    const r = await enqueueRateUpdatePlan(String(planId || ""), groupKeys, overwrite === true);
    if (!r.success) return failResult(r.error);
    return okResult(r.data);
  });

  // 单客户的港口偏好（详情面板：手工登记的之外，把来信推断出来的摆出来让人一键采用）
  ipcMain.handle(IPC.RATE_UPDATE.PORTS, (_e, contactId: number, days?: number) => {
    const id = Number(contactId);
    if (!Number.isInteger(id) || id <= 0) return failResult("无效的联系人 ID");
    const one = deriveCustomerPorts([id], { days: Number(days) || undefined });
    return okResult(one[0]?.prefs ?? []);
  });
}
