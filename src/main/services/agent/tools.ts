// ── Agent Harness 工具层 ──────────────────────────────────────────
// 每个工具 = @openai/agents tool() + policy 元数据（副作用分级/预算/审批）。
// execute 内强制：预算守卫 → 执行 → 审计落库。write 工具的 needsApproval 由
// SDK 中断流接管，execute 只在人工批准后才可能运行。
import { z } from "zod";
import { eq, like, or, and, desc } from "drizzle-orm";
import { tool } from "@openai/agents";
import { getDb, saveDatabase } from "../../db";
import { contacts } from "../../db/schema/contacts";
import { companies } from "../../db/schema/companies";
import { interactions } from "../../db/schema/interactions";
import { inboxMessages } from "../../db/schema/inbox";
import { emailAccounts } from "../../db/schema/accounts";
import { agentToolCalls } from "../../db/schema/agent";
import { Log } from "../../logger";
import { okResult, failResult } from "../../errors";
import { checkBudget, ToolBudgetError } from "./policy";
import { getBody } from "../inbox.service";
import { checkReminders } from "../crm.service";
import { getSendStatus, getQueueItems, startDynamicSend } from "../send.service";
import { summarizeEmail, generateBackcheckReport, generateEmailDraft, searchCompany, type BackcheckReport } from "../ai.service";
import { upsertCompany } from "../company.service";
import { upsertTemplate } from "../template.service";
import { registerAction, type ActionCard } from "./actions";
import { listQuotes, countQuotes, normalizeContainer } from "../rate-sync.service";

/** 动作卡三类：write（主进程持闭包，点击才执行）/ prompt（续问）/ navigate（跳转查看） */
const promptAction = (label: string, text: string) => ({ kind: "prompt" as const, label, text });
const navAction = (label: string, href: string) => ({ kind: "navigate" as const, label, href });
type AnyAction = ActionCard | ReturnType<typeof promptAction> | ReturnType<typeof navAction>;

const cell = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/** 按公司名模糊找库内记录：多命中时优先精确同名，其次首条（供背调联动判断「库里有没有」） */
function findCompanyByName(name: string) {
  const tokens = name.split(/\s+/).filter(Boolean).slice(0, 4);
  if (!tokens.length) return undefined;
  const rows = getDb().select().from(companies)
    .where(and(...tokens.map(t => like(companies.name, `%${t}%`)))).all();
  if (!rows.length) return undefined;
  const exact = rows.find(r => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact ?? rows[0];
}

/** 预算超限时不 throw（模型会把 tool error 当“接口故障”继续绕），改为明确引导语令其基于已有数据作答 */
function budgetNote(counts: Map<string, number>, toolName: string): string | null {
  try { checkBudget(counts, toolName); return null; }
  catch (e) {
    if (e instanceof ToolBudgetError) {
      return JSON.stringify({ error: "budget_exhausted", notice: "本工具本轮查询次数已达上限。这不是接口故障——请立即基于此前已返回的数据作答，不要再调用本工具。" });
    }
    throw e;
  }
}

export interface ToolCtx {
  conversationId: string;
  counts: Map<string, number>;
}

// ── Schema 设计原则（live 评测实锤）：能用「钳制/归一」解决的绝不 .max()/.enum() 拒绝 ——
//    zod 校验失败发生在 execute 之前，预算守卫拦不住，模型会反复重试直到 max turns。
export const searchContactsSchema = z.object({
  query: z.string().min(1).max(80).describe("姓名/邮箱/公司名关键词"),
  limit: z.number().int().min(1).optional().describe("返回条数上限，默认 10"),
});

export const recordFollowupSchema = z.object({
  contactId: z.number().int().positive().describe("联系人 id（来自 search_contacts 返回）"),
  note: z.string().min(1).max(500).describe("跟进记录内容"),
});

export const quoteSearchSchema = z.object({
  lane: z.string().max(20).optional().describe("航线（加勒比/南美东/南美西/墨西哥/中美洲/欧地），不传则全航线"),
  carrier: z.string().min(2).max(10).optional().describe("船司三字码，如 CMA/MSK/MSC"),
  pod: z.string().min(2).max(60).optional().describe("目的港关键词（英文港名，模糊匹配）"),
  container: z.string().min(2).max(10).optional().describe("柜型，如 20GP/40GP/40HQ/NOR（写 40HC 也会自动归一）"),
  includeExpired: z.boolean().optional().describe("是否包含已过有效期记录，默认 false"),
  limit: z.number().int().min(1).optional().describe("返回条数，默认 20，按价格升序"),
});

export const inboxSearchSchema = z.object({
  query: z.string().max(120).optional().describe("关键词，匹配发件人邮箱/主题/正文摘要；不传则返回最近邮件"),
  classification: z.enum(["inquiry", "reply", "bounce", "auto_reply", "normal"]).optional()
    .describe("按系统分类过滤：inquiry=询盘 reply=回复 bounce=退信 auto_reply=自动回复"),
  unreadOnly: z.boolean().optional().describe("只看未读，默认 false"),
  limit: z.number().int().min(1).optional().describe("返回条数，默认 10，按时间倒序"),
});

export const emailSummarizeSchema = z.object({
  messageId: z.number().int().positive().describe("邮件 id（来自 inbox_search 返回）"),
});

export const companyBackcheckSchema = z.object({
  companyName: z.string().min(2).max(80).describe("公司名（英文优先，可用行业常见拼写）"),
  country: z.string().max(40).optional().describe("国家/地区，帮助收敛搜索"),
});

export const generateDraftSchema = z.object({
  companyName: z.string().min(1).max(80).describe("目标公司名"),
  contactName: z.string().max(60).describe("收件人姓名"),
  language: z.enum(["EN", "ES", "PT"]).optional().describe("输出语言：EN 英语 / ES 西语 / PT 葡语，默认 EN"),
  focus: z.string().max(300).optional().describe("内容侧重提示，如主推航线、客户痛点"),
  contactId: z.number().int().positive().optional().describe("收件联系人 id（若来自 search_contacts，带上它才能一键入队）"),
});

export const sendQueueAddSchema = z.object({
  contactIds: z.array(z.number().int().positive()).min(1).max(50)
    .describe("收件联系人 id 列表（来自 search_contacts 返回的 id）"),
  subject: z.string().min(1).max(150).describe("邮件主题（可含 {{company}}/{{firstName}} 变量）"),
  body: z.string().min(1).max(8000).describe("邮件正文（纯文本/简单 HTML，可含联系人变量）"),
});

function audit(ctx: ToolCtx, toolName: string, sideEffect: string, args: unknown,
               result: unknown, approval: string, error?: string): void {
  try {
    getDb().insert(agentToolCalls).values({
      conversationId: ctx.conversationId,
      toolName,
      sideEffect,
      argsJson: JSON.stringify(args),
      resultJson: result === undefined ? undefined : JSON.stringify(result).slice(0, 4000),
      approval,
      error,
    }).run();
    saveDatabase();
  } catch (err) {
    Log.warn("agent.audit", `工具留痕写入失败 ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 审计层对外暴露：审批被拒时由 dispatcher 记一行 rejected */
export function auditRejected(ctx: ToolCtx, toolName: string, argsJson: string | undefined): void {
  audit(ctx, toolName, "write", argsJson ? safeParse(argsJson) : undefined, undefined, "rejected", "用户拒绝执行");
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export function buildHarnessTools(ctx: ToolCtx) {
  const searchContacts = tool({
    name: "search_contacts",
    description: "在本地联系人库按姓名/邮箱/公司名关键词检索，返回结构化记录（含 id/姓名/邮箱/公司/国家/阶段）。涉及客户的事实性回答必须且只能基于本工具返回的数据。",
    parameters: searchContactsSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "search_contacts");
      if (note) return note;
      // 按词切分匹配（live 评测实锤：模型常传全名 "Juan Garcia"，整串 LIKE 匹配不上单列 firstName/lastName → 误判查无此人）
      const perToken = args.query.split(/\s+/).filter(Boolean).slice(0, 4).map(tok => {
        const p = `%${tok}%`;
        return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
      });
      const rows = getDb()
        .select({
          id: contacts.id, email: contacts.email,
          firstName: contacts.firstName, lastName: contacts.lastName,
          country: contacts.country, stage: contacts.stage, status: contacts.status,
          companyName: companies.name,
        })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(and(...perToken))
        .limit(Math.min(args.limit ?? 10, 50))
        .all();
      const out = rows.map(r => ({
        id: r.id,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
        email: r.email, company: r.companyName, country: r.country,
        stage: r.stage, status: r.status,
      }));
      audit(ctx, "search_contacts", "read", args, out, "auto");
      // 空结果给显式收敛信号：模型往往会换词重试直至 max turns（live 评测实锤）
      if (out.length === 0) {
        return JSON.stringify({ results: [], notice: "库中没有匹配该关键词的联系人。请直接如实告知用户查无此人，不要用相同参数重复调用本工具。" });
      }
      // 唯一命中 → 直接续问写开发信（带上 contactId，草稿结果卡才能长出「入队」按钮）
      if (out.length === 1) {
        const one = out[0]!;
        return JSON.stringify({
          results: out,
          actions: [promptAction(
            "给 TA 写一封开发信",
            `给联系人 #${one.id} ${one.name}（${one.company || "无公司名"}${one.country ? `，${one.country}` : ""}）写一封开发信，先想清楚切入点再动笔`,
          )],
        });
      }
      return JSON.stringify(out);
    },
  });

  const recordFollowup = tool({
    name: "record_followup",
    description: "为指定联系人记录一条跟进备注（写操作，执行前会请求人工确认；被拒绝则放弃）。",
    parameters: recordFollowupSchema,
    needsApproval: true,
    execute: async (args) => {
      checkBudget(ctx.counts, "record_followup");
      const exists = getDb().select({ id: contacts.id }).from(contacts)
        .where(eq(contacts.id, args.contactId)).get();
      if (!exists) return `失败：联系人 #${args.contactId} 不存在，请先用 search_contacts 查询`;
      getDb().insert(interactions).values({
        contactId: args.contactId, type: "note", direction: "outbound",
        channel: "manual", bodyPreview: args.note,
      }).run();
      saveDatabase();
      audit(ctx, "record_followup", "write", args, { ok: true }, "approved");
      return `已为联系人 #${args.contactId} 记录跟进`;
    },
  });

  const quoteSearch = tool({
    name: "quote_search",
    description: "查询本地海运运价镜像库（源自钉钉《海运运价智能台账》，每日同步）。所有参数均可省略——用户只给目的港时仅传 pod 即可，省略的条件视为不限。返回 目的港/船司/柜型/USD价/有效期/备注 结构化列表，按价格升序。运价相关问题必须且只能基于本工具结果回答；结果为参考价，回答时须提醒以船司实时报价为准。",
    parameters: quoteSearchSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "quote_search");
      if (note) return note;
      const filters = {
        // 去掉口语后缀（「加勒比线」「南美东航线」→ 加勒比 / 南美东），配合 like 模糊匹配
        lane: args.lane?.replace(/航线$/, "").replace(/线$/, "").trim(),
        carrier: args.carrier?.toUpperCase().trim(),
        pod: args.pod,
        // 脏柜型归一（40HC→40HQ 等），识别不了则原样大写透传
        container: normalizeContainer(args.container ?? null) ?? args.container?.toUpperCase().trim(),
        includeExpired: args.includeExpired,
      };
      const r = listQuotes({ ...filters, limit: args.limit ?? 20 });
      if (!r.success) {
        audit(ctx, "quote_search", "read", args, undefined, "auto", r.error);
        return `查询失败：${r.error}`;
      }
      // total=满足条件的真总数（评测发现只给截断行数会让模型反复重试凑数直至 max turns）
      const total = countQuotes(filters);
      const out = {
        total, count: r.data.length, quotes: r.data,
        // 收敛信号：数据已完整时显式声明，防模型按航线/船司逐扇出重复查询（评测 rate-table 实锤 11 连击）
        ...(total > 0 && r.data.length >= total ? { complete: true, notice: "命中数据已全部返回，无需再调用本工具，直接作答" } : {}),
        // 空结果显式引导：直接如实回答，不要换参数重试
        ...(total === 0 ? { empty: true, notice: "镜像库中没有满足条件的报价。请直接如实告知用户「镜像库暂无该航线报价」，不要重复调用本工具。" } : {}),
        // 有命中 → 「把价格变成动作」的提示卡（点一下续问，产物留在对话里）
        ...(total > 0 ? {
          actions: [
            promptAction("按这批价写一封报价信", "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒"),
            navAction("在运价库筛选", "#/rates"),
          ],
        } : {}),
      };
      audit(ctx, "quote_search", "read", args, out, "auto");
      return JSON.stringify(out);
    },
  });

  const inboxSearch = tool({
    name: "inbox_search",
    description: "检索本地收件箱邮件（发件人/主题/正文摘要关键词，可按系统分类与未读过滤），返回 发件人/主题/分类/时间/id 列表。用户问「今天有什么新邮件/询盘/退信」「谁给我发过…」时使用本工具；要总结某封邮件先用本工具拿 id。",
    parameters: inboxSearchSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "inbox_search");
      if (note) return note;
      const conds = [];
      if (args.query) {
        const q = `%${args.query}%`;
        conds.push(or(like(inboxMessages.fromEmail, q), like(inboxMessages.subject, q), like(inboxMessages.bodyPreview, q)));
      }
      if (args.classification) conds.push(eq(inboxMessages.classification, args.classification));
      if (args.unreadOnly) conds.push(eq(inboxMessages.isRead, 0));
      const rows = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, classification: inboxMessages.classification,
        isRead: inboxMessages.isRead, receivedAt: inboxMessages.receivedAt,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(Math.min(args.limit ?? 10, 50))
        .all();
      const out = rows.map(r => ({ ...r, from: r.fromName || r.fromEmail, matchedContactId: r.matchedContactId ?? undefined }));
      audit(ctx, "inbox_search", "read", args, out, "auto");
      // 收敛信号：空结果如实回答；结果少于 limit 说明已全量返回
      if (out.length === 0) {
        return JSON.stringify({ messages: [], notice: "收件箱中没有匹配的邮件。请直接如实告知用户，不要重复调用本工具。" });
      }
      return JSON.stringify({
        total: out.length,
        ...(out.length < Math.min(args.limit ?? 10, 50) ? { complete: true, notice: "以上即全部匹配邮件，直接作答即可" } : {}),
        messages: out,
      });
    },
  });

  const emailSummarize = tool({
    name: "email_summarize",
    description: "总结一封收件箱邮件并给出下一步跟进建议（内部调用 LLM 生成 一句话总结 + nextStep）。先 inbox_search 拿到邮件 id 再调用本工具。",
    parameters: emailSummarizeSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "email_summarize");
      if (note) return note;
      const row = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
      if (!row) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", `邮件 #${args.messageId} 不存在`);
        return `失败：邮件 #${args.messageId} 不存在，请先用 inbox_search 查询`;
      }
      // 正文：全文本（懒加载含 IMAP 拉取）→ 去标签压成纯文本，避免 HTML 噪声进模型
      const bodyR = await getBody(args.messageId);
      const text = (bodyR.success ? bodyR.data : (row.bodyPreview || ""))
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);
      const contact = row.matchedContactId
        ? getDb().select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, companyId: contacts.companyId })
            .from(contacts).where(eq(contacts.id, row.matchedContactId)).get()
        : undefined;
      const r = await summarizeEmail({
        fromName: row.fromName, fromEmail: row.fromEmail, subject: row.subject,
        bodyPreview: text || (row.bodyPreview ?? ""),
        matchedContactName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : null,
        matchedCompany: contact?.companyId
          ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? null)
          : null,
      });
      if (!r.success) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", r.error);
        return `总结失败：${r.error}`;
      }
      const out = {
        id: row.id, from: row.fromName || row.fromEmail, subject: row.subject ?? "",
        summary: r.data.summary, nextStep: r.data.nextStep,
      };
      audit(ctx, "email_summarize", "read", args, out, "auto");
      return JSON.stringify(out);
    },
  });

  const companyBackcheck = tool({
    name: "company_backcheck",
    description: "对一家公司做公开网络背调并生成结构化报告（一句话总结/进口活跃度/主营品类/货代契合点/风险/评分/来源链接）。数据来自 Exa/Tavily 网络搜索，非本地库。用户问「XX公司什么背景/值得开发吗」时使用。",
    parameters: companyBackcheckSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "company_backcheck");
      if (note) return note;
      const query = `${args.companyName}${args.country ? ` ${args.country}` : ""} importer products supplier`;
      const hits = await searchCompany(query);
      if (!hits.success || hits.data.length === 0) {
        const msg = hits.success
          ? "网络搜索未找到该公司资料，无法生成背调报告"
          : `搜索数据源不可用：${hits.error}（需在设置中配置 EXA_API_KEY 或 TAVILY_API_KEY）`;
        audit(ctx, "company_backcheck", "read", args, undefined, "auto", msg);
        return msg;
      }
      const r = await generateBackcheckReport(
        { companyName: args.companyName, country: args.country },
        hits.data,
      );
      if (!r.success) {
        audit(ctx, "company_backcheck", "read", args, undefined, "auto", r.error);
        return `背调生成失败：${r.error}`;
      }
      const report = r.data;
      const matched = findCompanyByName(args.companyName);
      const industryGuess = Array.isArray(report.categories) ? report.categories.slice(0, 3).join("、") : "";
      const backcheckJson = JSON.stringify(report);
      const actions: AnyAction[] = [];

      if (matched) {
        // 库里已有 → 提议把背调结论写回公司档案（点击才执行）
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "company_backcheck",
          label: "写入公司档案",
          confirm: `把这次背调结论写入「${matched.name}」的公司档案`,
          detail: "只更新背调结论与空缺字段，不动已有联系人",
          diff: [
            { field: "backcheck", label: "背调结论", from: matched.backcheckData ? "已有旧版（将被覆盖）" : "无", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
            { field: "industry", label: "主营品类", from: cell(matched.industry), to: matched.industry || industryGuess || "—" },
            { field: "country", label: "国家", from: cell(matched.country), to: cell(matched.country || args.country) },
          ],
          target: { label: "查看公司档案", href: `#/customers?view=company&sel=${matched.id}` },
          run: async () => {
            const u = await upsertCompany({
              id: matched.id, name: matched.name,
              industry: matched.industry || (industryGuess || null),
              country: matched.country || (args.country ?? null),
              backcheckData: backcheckJson,
            });
            return u.success ? okResult(`已更新公司档案 #${matched.id}（${matched.name}）`) : failResult(u.error);
          },
        }));
        actions.push(navAction("查看公司档案", `#/customers?view=company&sel=${matched.id}`));
      } else {
        // 库里没有 → 提议建档
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "company_backcheck",
          label: "加入客户库",
          confirm: `新建公司「${args.companyName}」并写入这份背调结论`,
          detail: "只建公司档案，不创建联系人",
          diff: [
            { field: "name", label: "公司名", from: "—（库内无此公司）", to: args.companyName },
            { field: "industry", label: "主营品类", from: "—", to: industryGuess || "—" },
            { field: "country", label: "国家", from: "—", to: cell(args.country) },
            { field: "backcheck", label: "背调结论", from: "—", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
          ],
          target: { label: "查看公司库", href: "#/customers?view=company" },
          run: async () => {
            const u = await upsertCompany({
              name: args.companyName.trim(),
              industry: industryGuess || null,
              country: args.country ?? null,
              backcheckData: backcheckJson,
            });
            return u.success ? okResult(`已加入客户库：${u.data.name} #${u.data.id}`) : failResult(u.error);
          },
        }));
      }

      const out = {
        ...report,
        companyInDb: matched ? { id: matched.id, name: matched.name } : null,
        actions,
      };
      audit(ctx, "company_backcheck", "read", args, out, "auto");
      return JSON.stringify(out);
    },
  });

  const generateDraft = tool({
    name: "generate_draft",
    description: "为指定公司/联系人生成一封开发信草稿（带 SUBJECT: 主题行 + 正文，支持 EN/ES/PT）。本工具只产出文本，不会发送；用户可通过结果卡上的按钮一键存素材库或入队。撰写前若已有背调结论，把要点放进 focus；已知收件人时带上 contactId 才能入队。",
    parameters: generateDraftSchema,
    execute: async (args) => {
      const note = budgetNote(ctx.counts, "generate_draft");
      if (note) return note;
      const r = await generateEmailDraft({
        language: args.language ?? "EN",
        companyName: args.companyName,
        contactName: args.contactName,
        backcheck: args.focus ? ({ summary: args.focus } as BackcheckReport) : null,
      });
      if (!r.success) {
        audit(ctx, "generate_draft", "read", args, undefined, "auto", r.error);
        return `草稿生成失败：${r.error}`;
      }
      // 拆 SUBJECT 行 → 主题/正文（结果卡动作与入队都要用）
      const raw = r.data.trim();
      const m = /^SUBJECT:\s*(.+)\s*$/im.exec(raw);
      const subject = (m?.[1] ?? `Following up — ${args.companyName}`).trim().slice(0, 150);
      const body = (m ? raw.slice(m.index + m[0].length) : raw).replace(/^\s+/, "").trim();
      const lang = args.language ?? "EN";
      const tplName = `${args.companyName} · AI 开发信`.slice(0, 60);

      const actions: AnyAction[] = [
        registerAction({
          conversationId: ctx.conversationId, toolName: "generate_draft",
          label: "存入素材库",
          confirm: `把这封草稿存进素材库，以后在发送中心可直接复用`,
          detail: `名称「${tplName}」，语言 ${lang}`,
          diff: [
            { field: "name", label: "素材名", from: "—", to: tplName },
            { field: "subject", label: "主题", from: "—", to: subject },
            { field: "body", label: "正文", from: "—", to: `${body.slice(0, 60)}${body.length > 60 ? "…" : ""}` },
          ],
          target: { label: "查看素材库", href: "#/templates" },
          run: async () => {
            const t = await upsertTemplate({ name: tplName, language: lang, subject, body, category: "ai-draft" });
            return t.success ? okResult(`已存入素材库：${t.data.name}`) : failResult(t.error);
          },
        }),
      ];
      if (args.contactId) {
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "generate_draft",
          label: "入队发给这位联系人",
          confirm: `把这封信加入发送队列，收件人 #${args.contactId}`,
          detail: "入队 ≠ 发送：队列建好后不会自动开始，仍要你在「发送中心」点「开始」",
          diff: [
            { field: "subject", label: "主题", from: "—", to: subject },
            { field: "contact", label: "收件人", from: "—", to: `#${args.contactId} ${args.contactName || ""}`.trim() },
          ],
          target: { label: "去发送中心", href: "#/campaigns" },
          run: async () => {
            const s = await startDynamicSend([args.contactId!], subject, body, false);
            return s.success
              ? okResult(`已入队 ${s.data.queuedCount} 封（批次 ${s.data.batchId.slice(0, 8)}），等待你在发送中心点开始`)
              : failResult(s.error);
          },
        }));
      }
      // 不重复放 draft 全文：推送给前端的结果有 6000 字上限，长信会把 actions 挤出截断范围
      const out = { subject, body, language: lang, contactId: args.contactId ?? null, actions };
      audit(ctx, "generate_draft", "read", args, { subject, length: body.length, actions: actions.length }, "auto");
      return JSON.stringify(out);
    },
  });

  const queueStatus = tool({
    name: "queue_status",
    description: "查询发信引擎与队列实时状态：是否运行中/已暂停、总组数、已发组数、失败组数、待发的组数与收件人数。用户问「还有多少没发出去」「发送进度」「队列是不是卡住了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const note = budgetNote(ctx.counts, "queue_status");
      if (note) return note;
      const s = getSendStatus();
      const q = getQueueItems();
      const items = q.success ? q.data : [];
      const pending = items.filter(i => i.status === "pending");
      const out = {
        running: s.success ? s.data.isRunning : false,
        paused: s.success ? s.data.isPaused : false,
        totalGroups: s.success ? s.data.totalItems : 0,
        sentGroups: s.success ? s.data.sentCount : 0,
        failedGroups: s.success ? s.data.failedCount : 0,
        pendingGroups: pending.length,
        pendingRecipients: pending.reduce((n, i) => n + i.recipients.length, 0),
      };
      audit(ctx, "queue_status", "read", {}, out, "auto");
      return JSON.stringify(out);
    },
  });

  const remindersDue = tool({
    name: "reminders_due",
    description: "查询到期与已逾期的跟进提醒（CRM 今日待跟进清单），返回联系人 id/姓名/公司/提醒时间/跟进备注。用户问「今天该跟进谁」「有哪些到期提醒」「哪些客户 overdue 了」时必须先调用本工具。",
    parameters: z.object({}),
    execute: async () => {
      const note = budgetNote(ctx.counts, "reminders_due");
      if (note) return note;
      const r = checkReminders();
      if (!r.success) {
        audit(ctx, "reminders_due", "read", {}, undefined, "auto", r.error);
        return `查询失败：${r.error}`;
      }
      const brief = (c: (typeof r.data.due)[number]) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email,
        company: c.companyName ?? "", reminderAt: c.reminderAt ?? "", note: c.followupNote ?? "",
      });
      const due = r.data.due.map(brief);
      const overdue = r.data.overdue.map(brief);
      const out = { dueCount: due.length, overdueCount: overdue.length, due, overdue };
      audit(ctx, "reminders_due", "read", {}, out, "auto");
      if (due.length === 0 && overdue.length === 0) {
        return JSON.stringify({ ...out, notice: "今天没有到期或逾期的提醒。请如实告知用户，不要重复调用本工具。" });
      }
      return JSON.stringify(out);
    },
  });

  const accountsStatus = tool({
    name: "accounts_status",
    description: "查询发信/收信账号的配置与健康状态：总数、启用数、健康数（无熔断且无连续失败），以及每个异常账号的具体问题（停用/发信熔断/连续失败次数/最近收信错误）。用户问「几个账号能用」「账号有没有问题」「哪个账号挂了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const note = budgetNote(ctx.counts, "accounts_status");
      if (note) return note;
      const rows = getDb().select({
        id: emailAccounts.id, email: emailAccounts.email, isActive: emailAccounts.isActive,
        consecutiveFails: emailAccounts.consecutiveFails, circuitOpenAt: emailAccounts.circuitOpenAt,
        lastFetchError: emailAccounts.lastFetchError, fetchFailCount: emailAccounts.fetchFailCount,
      }).from(emailAccounts).all();
      const issues = rows.map(r => {
        const probs: string[] = [];
        if (r.isActive !== 1) probs.push("已停用");
        if (r.circuitOpenAt) probs.push("发信熔断中");
        if (r.consecutiveFails > 0) probs.push(`发信连续失败 ${r.consecutiveFails} 次`);
        if (r.fetchFailCount > 0) probs.push(`收信连续失败 ${r.fetchFailCount} 次${r.lastFetchError ? `：${r.lastFetchError}` : ""}`);
        else if (r.lastFetchError) probs.push(`最近收信异常：${r.lastFetchError}`);
        return probs.length ? { id: r.id, email: r.email, problems: probs.join("、") } : null;
      }).filter((x): x is { id: number; email: string; problems: string } => x !== null);
      const healthyCount = rows.filter(r =>
        r.isActive === 1 && !r.circuitOpenAt && r.consecutiveFails === 0 && r.fetchFailCount === 0).length;
      const out = { total: rows.length, enabled: rows.filter(r => r.isActive === 1).length, healthy: healthyCount, issues };
      audit(ctx, "accounts_status", "read", {}, out, "auto");
      return JSON.stringify(out);
    },
  });

  const sendQueueAdd = tool({
    name: "send_queue_add",
    description: "把一封邮件加入发送队列。触发时机：用户明确说「把/给 X 发一封邮件」「发给 X」「发报价给 X」时，必须先 search_contacts 拿到 contactId，再调用本工具入队 —— 系统随后会弹人工确认框，那一步就是征求同意，因此不要只在正文里问「要不要发」而不调用本工具。本工具只入队不发送：队列建好后处于未启动状态，用户仍需在「发送中心」点「开始」才真正外发。主题与正文可含 {{company}}/{{firstName}}/{{lastName}} 变量。",
    parameters: sendQueueAddSchema,
    needsApproval: true,
    execute: async (args) => {
      checkBudget(ctx.counts, "send_queue_add");
      const r = await startDynamicSend(args.contactIds, args.subject, args.body, false);
      if (!r.success) {
        audit(ctx, "send_queue_add", "write", args, undefined, "approved", r.error);
        return `入队失败：${r.error}`;
      }
      audit(ctx, "send_queue_add", "write", args, r.data, "approved");
      return `已加入发送队列：${r.data.queuedCount} 封（批次 ${r.data.batchId.slice(0, 8)}，${r.data.dropped} 组因限额被丢弃）。队列已建立但尚未启动，请提示用户到「发送中心」确认后手动点开始发送。`;
    },
  });

  return [
    searchContacts, recordFollowup, quoteSearch, inboxSearch, emailSummarize,
    companyBackcheck, generateDraft, queueStatus, remindersDue, accountsStatus, sendQueueAdd,
  ];
}
