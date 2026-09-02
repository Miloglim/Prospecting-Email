// ── Agent 后台长任务服务 ──────────────────────────────────────────
// 批量背调 / 批量开发信草稿这类活，一轮对话塞不下（maxTurns/看门狗/工具预算都拦着），
// 由 start_batch_task 工具起一个后台任务：串行逐项执行，每步全量推 EVENTS.AGENT_TASK，
// 渲染端的任务卡原地刷新。
// 红线：本服务只读（外部搜索 + 本地生成 + 落盘产物）——不引用 send.service、不写业务表，
// 也永远不出现「开始发送」能力。
import * as crypto from "crypto";
import { EVENTS } from "../events";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { inboxMessages } from "../db/schema/inbox";
import { searchCompany, generateBackcheckReport, generateEmailDraft, summarizeEmail, type BackcheckReport } from "./ai.service";
import { writeArtifact, type ArtifactMeta } from "./artifact.service";

export type BgTaskKind = "backcheck" | "draft" | "email_summary";
export type BgTaskState = "running" | "done" | "failed" | "cancelled";
export type BgItemState = "pending" | "running" | "done" | "failed";

export interface BgTaskItem { label: string; state: BgItemState; note?: string }

export interface BgTask {
  id: string;
  conversationId: string;
  kind: BgTaskKind;
  title: string;
  items: BgTaskItem[];
  state: BgTaskState;
  artifact?: ArtifactMeta;
  startedAt: string;
  finishedAt?: string;
}

const tasks = new Map<string, BgTask>();
const cancelFlags = new Map<string, boolean>();

/** 项间间隔：给搜索/模型端点喘口气，也让人眼看得到进度在动 */
const STEP_DELAY_MS = 2_000;
/** 任务数上限：超出先清已完结的（内存注册表，重启本就清零） */
const MAX_TASKS = 60;

/**
 * 批量任务入参归一（纯函数，单测覆盖）：
 * 无名条目丢弃；name≤40 字、country≤20 字；整体钳 10 家。
 */
export function normalizeBatchItems(raw: unknown): Array<{ name: string; country?: string }> {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 10)
    .map((entry): { name: string; country?: string } | null => {
      if (!entry || typeof entry !== "object") return null;
      const o = entry as Record<string, unknown>;
      const name = String(o.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!name) return null;
      const country = String(o.country ?? "").trim().slice(0, 20);
      return country ? { name, country } : { name };
    })
    .filter((x): x is { name: string; country?: string } => x !== null);
}

/** kind 同义词归一：email/邮件总结→email_summary；写信·开发信→draft；其余 backcheck */
export function normalizeBatchKind(raw: unknown): BgTaskKind {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^(email_summary|email|summary|邮件总结|总结邮件|邮件)$/.test(s)) return "email_summary";
  if (/^(draft|drafts|开发信|写信|信件)$/.test(s)) return "draft";
  return "backcheck";
}

/** 邮件批量入参归一（纯函数）：取正整数 id、去重、钳 60 封 */
export function normalizeMessageIds(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  for (const v of arr) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); if (seen.size >= 60) break; }
  }
  return [...seen];
}

function nowIso(): string { return new Date().toISOString(); }

function snapshot(t: BgTask): BgTask {
  return {
    ...t,
    items: t.items.map(i => ({ ...i })),
    ...(t.artifact ? { artifact: { ...t.artifact } } : {}),
  };
}

function pruneFinished(): void {
  if (tasks.size <= MAX_TASKS) return;
  for (const [id, t] of tasks) {
    if (tasks.size <= MAX_TASKS - 10) break;
    if (t.state !== "running") { tasks.delete(id); cancelFlags.delete(id); }
  }
}

/** 单家背调：与 company_backcheck 工具同源（搜索 → 报告生成） */
async function runOneBackcheck(c: { name: string; country?: string }): Promise<Result<{ note: string; report: BackcheckReport }>> {
  const hits = await searchCompany(c.country ? `${c.name} ${c.country}` : c.name);
  if (!hits.success || !hits.data.length) {
    return failResult(hits.success ? "没有搜到该公司的公开信息" : (hits.error ?? "搜索失败"));
  }
  const rep = await generateBackcheckReport({ companyName: c.name, country: c.country }, hits.data);
  if (!rep.success) return failResult(rep.error ?? "报告生成失败");
  return okResult({ note: `评级 ${rep.data.rating}/5`, report: rep.data });
}

/** 单家开发信草稿（无具体联系人时按公司写） */
async function runOneDraft(c: { name: string; country?: string }): Promise<Result<{ note: string; body: string }>> {
  const r = await generateEmailDraft({ language: "EN", companyName: c.name, contactName: "" });
  if (!r.success) return failResult(r.error ?? "草稿生成失败");
  const first = r.data.split("\n").find(l => l.trim()) ?? "";
  return okResult({ note: first.slice(0, 60), body: r.data });
}

/** 单封邮件总结：读摘要正文 → summarizeEmail（与 email_summarize 同源，走 bodyPreview 不做 IMAP 懒取） */
async function runOneEmailSummary(messageId: number): Promise<Result<{ note: string; text: string }>> {
  const row = getDb().select({
    id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
    subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
  }).from(inboxMessages).where(eq(inboxMessages.id, messageId)).get();
  if (!row) return failResult(`邮件 #${messageId} 不存在`);
  const text = (row.bodyPreview || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);
  const from = row.fromName || row.fromEmail || "—";
  const r = await summarizeEmail({
    fromName: row.fromName, fromEmail: row.fromEmail, subject: row.subject,
    bodyPreview: text || (row.bodyPreview ?? ""), matchedContactName: null, matchedCompany: null,
  });
  if (!r.success) return failResult(r.error ?? "总结失败");
  const md = [
    `- 发件人：${from}`,
    `- 主题：${row.subject || "—"}`,
    ``,
    `**一句话**：${r.data.summary}`,
    ``,
    `**建议下一步**：${r.data.nextStep || "—"}`,
  ].join("\n");
  return okResult({ note: (row.subject || from).slice(0, 60), text: md });
}

/** 收尾产物：≥1 项成功才落盘（md 汇总），失败项只列原因 */
function buildSummary(t: BgTask, results: Array<{ ok: boolean; name: string; text: string }>): ArtifactMeta | undefined {
  const okCount = results.filter(r => r.ok).length;
  if (!okCount) return undefined;
  const unit = t.kind === "email_summary" ? "封" : "家";
  const lines: string[] = [
    `# ${t.title}`,
    ``,
    `生成于 ${new Date().toLocaleString("zh-CN")} · 共 ${t.items.length} ${unit}，成功 ${okCount} ${unit}，失败 ${t.items.length - okCount} ${unit}`,
    ``,
  ];
  for (const r of results) {
    lines.push(`## ${r.name}`, ``);
    lines.push(r.ok ? r.text : `（失败：${r.text}）`);
    lines.push(``);
  }
  const w = writeArtifact(t.title, "md", lines.join("\n"));
  return w.success ? w.data : undefined;
}

/** 启动后台任务。立即返回任务卡元信息，执行在后台串行跑。 */
export function startTask(
  push: (channel: string, data: unknown) => void,
  input: { conversationId: string; kind: BgTaskKind; companies?: Array<{ name: string; country?: string }>; messageIds?: number[] },
): Result<{ taskId: string; title: string; total: number }> {
  const isEmail = input.kind === "email_summary";
  const companies = isEmail ? [] : (input.companies ?? []);
  const messageIds = isEmail ? (input.messageIds ?? []) : [];
  const count = isEmail ? messageIds.length : companies.length;
  if (count === 0) return failResult(isEmail ? "批量总结至少需要 1 封邮件 id" : "批量任务至少需要 1 家公司");
  pruneFinished();

  const id = crypto.randomUUID();
  const kindLabel = input.kind === "email_summary" ? "批量邮件总结" : input.kind === "draft" ? "批量开发信草稿" : "批量背调";
  const unit = isEmail ? "封" : "家";

  // 邮件任务：预取主题/发件人做条目标签（缺则退化 邮件 #id）
  const labelOf = new Map<number, string>();
  if (isEmail && messageIds.length) {
    const rows = getDb().select({ id: inboxMessages.id, subject: inboxMessages.subject, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail })
      .from(inboxMessages).where(inArray(inboxMessages.id, messageIds)).all();
    for (const r of rows) labelOf.set(r.id, (r.subject || r.fromName || r.fromEmail || `邮件 #${r.id}`).slice(0, 40));
  }
  const labels: string[] = isEmail
    ? messageIds.map((mid) => labelOf.get(mid) || `邮件 #${mid}`)
    : companies.map((c) => (c.country ? `${c.name}（${c.country}）` : c.name));

  const targets: Array<{ name?: string; country?: string; messageId?: number }> =
    isEmail ? messageIds.map((mid) => ({ messageId: mid })) : companies.map((c) => ({ name: c.name, country: c.country }));

  const task: BgTask = {
    id, conversationId: input.conversationId, kind: input.kind,
    title: `${kindLabel} ${count} ${unit}`,
    items: labels.map((label) => ({ label, state: "pending" as BgItemState })),
    state: "running", startedAt: nowIso(),
  };
  tasks.set(id, task);
  cancelFlags.set(id, false);

  const emit = () => push(EVENTS.AGENT_TASK, { conversationId: task.conversationId, taskId: id, task: snapshot(task) });
  emit();
  Log.info("agent.bgtask", `启动 ${id.slice(0, 8)} ${task.title} conv=${task.conversationId.slice(0, 8)}`);

  void (async () => {
    const results: Array<{ ok: boolean; name: string; text: string }> = [];
    for (let i = 0; i < targets.length; i++) {
      if (cancelFlags.get(id)) {
        task.state = "cancelled";
        task.finishedAt = nowIso();
        emit();
        Log.info("agent.bgtask", `${id.slice(0, 8)} 已取消（完成 ${i}/${targets.length}）`);
        return;
      }
      const target = targets[i]!;
      const item = task.items[i]!;
      item.state = "running";
      emit();
      let ok = false;
      let note = "";
      let text = "";
      if (task.kind === "backcheck") {
        const r = await runOneBackcheck({ name: target.name ?? "", country: target.country });
        if (r.success) { ok = true; note = r.data.note; text = formatBackcheckMd(r.data.report); }
        else note = r.error ?? "失败";
      } else if (task.kind === "draft") {
        const r = await runOneDraft({ name: target.name ?? "", country: target.country });
        if (r.success) { ok = true; note = r.data.note; text = r.data.body; }
        else note = r.error ?? "失败";
      } else {
        const r = await runOneEmailSummary(target.messageId ?? -1);
        if (r.success) { ok = true; note = r.data.note; text = r.data.text; }
        else note = r.error ?? "失败";
      }
      if (ok) {
        item.state = "done";
        item.note = note;
        results.push({ ok: true, name: item.label, text });
      } else {
        item.state = "failed";
        item.note = note.slice(0, 80);
        results.push({ ok: false, name: item.label, text: item.note });
      }
      emit();
      if (i < targets.length - 1) await new Promise(res => setTimeout(res, STEP_DELAY_MS));
    }
    const okCount = results.filter(r => r.ok).length;
    task.state = okCount === 0 ? "failed" : "done";
    task.finishedAt = nowIso();
    task.artifact = buildSummary(task, results);
    emit();
    Log.info("agent.bgtask", `${id.slice(0, 8)} ${task.state}（成功 ${okCount}/${targets.length}）${task.artifact ? ` 产物=${task.artifact.name}` : ""}`);
  })();

  return okResult({ taskId: id, title: task.title, total: count });
}

/** 背调报告 → 汇总 md 段落 */
function formatBackcheckMd(r: BackcheckReport): string {
  return [
    `- 评级：${r.rating}/5`,
    `- 进口活跃度：${r.importActivity}`,
    `- 主营品类：${r.categories.join("、") || "—"}`,
    `- 货代契合点：${r.logisticsFit}`,
    r.risk.length ? `- 风险/注意：${r.risk.join("；")}` : "",
    ``,
    r.summary,
  ].filter(Boolean).join("\n");
}

/** 任务卡挂载时的初始快照 */
export function getTask(taskId: string): Result<BgTask> {
  const t = taskId ? tasks.get(taskId) : undefined;
  return t ? okResult(snapshot(t)) : failResult("任务不存在（应用重启后失效）");
}

/** 取消：置标志位，当前项做完即停（不打断进行中的外部调用） */
export function cancelTask(taskId: string): Result<void> {
  const t = taskId ? tasks.get(taskId) : undefined;
  if (!t) return failResult("任务不存在（应用重启后失效）");
  if (t.state !== "running") return failResult("任务已结束");
  cancelFlags.set(taskId, true);
  Log.info("agent.bgtask", `${taskId.slice(0, 8)} 收到取消请求`);
  return okResult(undefined);
}
