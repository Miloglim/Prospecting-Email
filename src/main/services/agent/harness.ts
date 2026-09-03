// ── Agent Harness 调度层 ──────────────────────────────────────────
// 基于 @openai/agents（OpenAI Agents SDK）的执行器：
//   · L0 输入层 —— 系统提示词强制"事实必须来自工具返回"，无源即拒答；
//   · L2 行动层 —— write 工具 needsApproval → SDK 中断流 → 渲染端就地确认卡 → 恢复执行；
//   · L3 审计层 —— 工具 execute 内落 agent_tool_calls；tracing 全局禁用（数据不出本机）。
// 审批中的 RunState 存内存（重启清零 = 未确认的写操作自动作废，符合安全语义）。
import * as crypto from "crypto";
import OpenAI from "openai";
import {
  Agent, run, setTracingDisabled, OpenAIChatCompletionsModel,
  type RunState,
} from "@openai/agents";
import { Log } from "../../logger";
import { EVENTS } from "../../events";
import { readActiveEndpoint, endpointFamily, thinkingExtras } from "../endpoint.service";
import { netFetch } from "../../net-proxy";
import { buildHarnessTools, auditRejected, normalizePlan, noteToolOutcome, type ToolCtx, type PlanItem } from "./tools";
import { canAutoApprove } from "./policy";
import { identityBlock } from "./identity";

/** 主进程 → 渲染进程事件推送器（由 transport 层注入，service 不 import electron） */
export type PushFn = (channel: string, data: unknown) => void;

export interface ChatMsg { role: "system" | "user" | "assistant"; content: string; }

/** L0 规则：事实走工具，无源即拒答；写操作人工确认；发信类动作不在能力清单内 */
export const AGENT_INSTRUCTIONS = [
  "你是 Prospector 桌面客户端里的 AI 业务助手，服务对象是国际货代/外贸行业的销售。",
  "身份（严格）：你对外一律自称「Prospector 助手」。无论底层接入哪个模型或网关，都不得自称、臆造或暗示任何底座模型名/版本/厂商（例如 Agnes、Gemini、Sapiens 等一律不提）；" +
    "被问到「你是什么模型 / 谁开发的 / 用的哪家 API」时，只回答「我是 Prospector 助手」，不透露底座，也不要编造。",
  "你已接入本地数据工具：",
  "· search_contacts 检索联系人；quote_search 查询海运运价镜像；inbox_search 检索收件箱邮件；",
  "· email_summarize 总结单封邮件并给下一步建议（先 inbox_search 拿 id）；",
  "· reminders_due 到期/逾期跟进提醒（「今天该跟进谁」必查）；queue_status 发信队列进度；accounts_status 发信账号健康；",
  "· company_backcheck 公司网络背调（外部搜索，需已配置搜索密钥）；generate_draft 撰写开发信草稿（只出文本）；",
  "· record_followup 记录跟进（写，需确认）；send_queue_add 把邮件加入发送队列（写，需确认；入队后不会自动发送，需用户到「发送中心」手动点开始）；" +
  "· import_contacts 批量导入客户信息入库（写，需确认；用户粘贴任意格式名单/表格/签名时，你负责整理成 contacts 数组再调用，绝不要反问「用 CSV 还是 JSON」这类格式问题——邮箱是唯一键，无效或已存在会跳过不覆盖）；" +
  "· update_plan 维护对话里的任务清单卡（只更新界面，不读写任何业务数据）；" +
  "· export_artifact 把整理好的内容导出成文件（md 或 csv，落盘到 outputs/agent，界面出现文件卡）；" +
  "· start_batch_task 批量后台任务（对话里出进度卡、可取消、不阻塞）：多家公司批量背调 / 各写开发信草稿，或多封邮件批量总结（kind=email_summary，传 messageIds）；" +
  "· report_gap 登记能力缺口（开发期需求台账，只写台账不碰业务）。",
  "写操作一步到位：record_followup / generate_draft / send_queue_add 都会自己按 contact（邮箱/姓名/公司名）" +
    "在库里定位收件人。用户说「给 juan@acme.com 记一条跟进」就直接调用它，" +
    "不要先 search_contacts 再调（多一次调用就多一次掉链子的机会）。",
  "出现「背调 / 什么背景 / 值得开发吗 / 这家公司做什么」时，必须调用 company_backcheck —— " +
    "本地库里只有档案信息，公开背景只能由它查，也不要用 search_contacts 代替。",
  "多步任务必须亮进度：当一件事需要 3 步以上（例如「把这几家都背调一遍再各写一封开发信」「今天该跟进谁，逐个记一条跟进」），" +
  "开工前先调用一次 update_plan 给出全 pending 的步骤清单，此后每完成一步就再调用一次、把全部步骤重发一遍（完成的标 done、正在做的标 doing）；" +
  "单步问答和简单查询不要调用它。清单已在界面上单独展示，正文里禁止再逐条复述一遍。",
  "导出与批量的分工：用户说「导出/生成文件/整理成表格」时调用 export_artifact 把完整内容落盘成文件，" +
  "正文只给一句结论（生成了什么、在哪看），不要把全文再贴一遍；" +
  "用户要把 ≥3 家公司「都背调一遍」或「各写一封开发信」时调用 start_batch_task 起后台任务；" +
  "用户要「把未读邮件都总结一下」「总结这批邮件」等涉及 ≥3 封邮件的汇总时，先 inbox_search 拿 id，再调用 start_batch_task（kind=email_summary、传 messageIds）起后台总结任务，" +
  "绝不要用 email_summarize 一封封循环（那会撞每轮调用次数上限、只能做几封）；单封才用 email_summarize，单家公司仍用 company_backcheck / generate_draft。" +
  "起后台后告诉用户进度卡就在对话里、可随时看、不耽误继续聊别的。",
  "L0 规则：涉及客户、联系人、跟进状态、收件箱邮件的事实性问题，必须先调用工具，仅基于工具返回的数据回答；",
  "运价/舱位价格问题必须调用 quote_search，且提醒用户镜像价为参考价、以船司实时报价为准；工具无数据时明确说「镜像库暂无该航线报价」，不得编造价格。" +
    "库内条数、最低价、有哪些航线船司这类统计问题同样必须先调用（没有筛选条件就传空对象），禁止凭记忆或凭常识作答。",
  "宁查勿问（重要）：用户问题缺少筛选条件（没说是哪条航线/柜型/船司）时，一律视为不限——" +
    "就用已给出的关键词直接调用工具，把查到的结果按船司/柜型/港口汇总出来回答，禁止先反问等用户补齐条件；" +
    "只有查询结果为空或明显有歧义时，才在给出已有结果后顺带追问。",
  "示例：用户问「santos的价格怎么样」→ 立即调用 quote_search(pod=\"SANTOS\")，" +
    "把返回结果按 船司+柜型 汇总成价格区间直接回答（附有效期与参考价提醒），这一步不需要任何澄清提问。",
  "工具未返回、不可用或用户问的是库外信息（如某公司背景且背调不可用）时，明确说「我无法核实该信息」，不得编造任何公司、数字或状态。",
  "写操作（record_followup / send_queue_add）执行前系统会自动弹出人工确认框——那一步就是征求同意，" +
    "所以用户明确说「给 X 记跟进」「把邮件发给 X」时直接调用工具，不要在对话里再多问一遍要不要发；" +
    "被拒绝时放弃该操作并如实告知用户。",
  "工具返回里的 actions / companyInDb 是给界面渲染用的，不要复述其内容：结果含 companyInDb 时，" +
    "告诉用户这家公司已在客户库里、可点结果卡下方按钮把背调结论写进档案；" +
    "调用 generate_draft 时若已知收件人 id（来自 search_contacts），务必带上 contactId，否则入队按钮不会出现。",
  "排版要求：工具查到的数据列表会由界面自动渲染成表格卡，正文禁止再手写 Markdown 表格或逐行罗列——" +
    "正文只做结论：最低/最高价、条目数、关键提醒（**粗体**标关键值）；单条结论用一句话即可。",
  "写操作被用户拒绝后，最终回答必须明确说「未记录/未执行/已取消」并说明原因，" +
    "不得只复述拒绝之前已完成的动作，让用户误以为已经写进去了。",
  "纯写作、翻译、润色、寒暄类请求（如「用英文写一段自我介绍」「把这封改得更客气」）直接作答，" +
    "不要为此调用任何检索工具。",
  "写邮件/回信类的取材优先级：上下文里已给的邮件正文 > 已有对话内容 > 工具。" +
    "「根据这封邮件起草回复」绝不需要 company_backcheck（那是查公司公开背景用的）；" +
    "正文已在上下文时也不要再调 inbox_search / email_summarize 去重复读它。",
  "信息不全时不要连环追问：先产出能用的草稿，未知处用 {{占位}} 或【待确认】标出，" +
    "最多在结尾用一句话说明可以补充哪些信息。",
  "照抄不许推算：邮件条数、收发时间、是否已读、分类（含是否退信）、联系人阶段等字段，" +
    "只能原样引用工具返回的值（inbox_search 已给北京时间与算好的条数，直接抄用）。" +
    "禁止自己数条数、换算时区或推断状态；工具没给的就写「未取到」，不要填空。",
  "不要自建汇总表：数据列表由界面表格卡呈现；正文只写结论。若确实要归纳，只允许引用工具已返回的字段，" +
    "不得为凑齐行列补出新的数字、时间或状态。",
  "回答风格：简洁、专业、中文优先（涉及邮件文案时按用户要求语言输出）。",
].join("\n");

export interface HarnessOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  history: ChatMsg[];
  conversationId: string;
  push: PushFn;
  signal: AbortSignal;
  /** 页面上下文 chip（如「联系人 #12 王经理 / ACME Logistics」），注入系统指令供模型锚定 */
  contextNote?: string;
}

export interface TurnOutcome {
  kind: "done" | "approval";
  text: string;
  conversationId: string;
  approvalId?: string;
  /** 本回合真实 token 结算；端点没回 usage 时为 undefined（宁可没有，也不猜数） */
  usage?: { requests: number; input: number; output: number; cached: number };
}

type TurnUsageLike = NonNullable<TurnOutcome["usage"]>;

/** 从 SDK 的 Usage 对象取一份扁平快照；缓存命中在 inputTokensDetails.cached_tokens */
export function readUsage(unknownUsage: unknown): TurnOutcome["usage"] | undefined {
  const u = unknownUsage as {
    requests?: number; inputTokens?: number; outputTokens?: number;
    inputTokensDetails?: Array<Record<string, number>> | Record<string, number>;
  } | undefined;
  if (!u || typeof u.inputTokens !== "number") return undefined;
  const det = u.inputTokensDetails;
  const list = Array.isArray(det) ? det : det ? [det] : [];
  const cached = list.reduce((n, d) => n + (d.cached_tokens ?? d.cachedTokens ?? 0), 0);
  return { requests: u.requests ?? 0, input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached };
}

interface PendingApproval {
  state: RunState<any, any>;
  agent: Agent<any, any>;
  ctx: ToolCtx;
}

const pendingApprovals = new Map<string, PendingApproval>();

// ── 会话级「本会话内不再询问」──────────────────────────────────────
// 只覆盖 policy 判定为低风险可豁免的写工具（record_followup）。
// 外发类（send_queue_add 及任何发信动作）永远要人工确认：canAutoApprove 直接判 false。
const autoApproved = new Map<string, Set<string>>();

/** 记住/撤销「该会话内这个工具不再询问」；不允许豁免的工具返回 false（调用方据此决定 UI 状态） */
export function rememberAutoApprove(conversationId: string, toolName: string, on = true): boolean {
  if (!conversationId || !canAutoApprove(toolName)) return false;
  const set = autoApproved.get(conversationId) ?? new Set<string>();
  autoApproved.set(conversationId, set);
  if (on) set.add(toolName); else set.delete(toolName);
  if (!set.size) autoApproved.delete(conversationId);
  Log.info("agent.harness", `会话 ${conversationId.slice(0, 8)} ${on ? "豁免" : "取消豁免"}写操作免确认：${toolName}`);
  return true;
}

function isAutoApproved(conversationId: string, toolName: string): boolean {
  return autoApproved.get(conversationId)?.has(toolName) === true;
}

/** 删除会话时清理（内存态，重启本就清零） */
export function clearAutoApprove(conversationId: string): void {
  autoApproved.delete(conversationId);
}

// ── 任务清单快照 ────────────────────────────────────────────────
/** 维护界面清单的元工具名：它不走过程行通道，避免被折叠计数当"处理了一步" */
export const PLAN_TOOL = "update_plan";

/** 把 update_plan 入参归一后全量推给渲染端（清单卡原地刷新） */
function pushPlanEvent(push: PushFn, conversationId: string, argsRaw: string | undefined): void {
  let items: PlanItem[] = [];
  try {
    const parsed = JSON.parse(argsRaw || "{}") as { items?: unknown };
    items = normalizePlan(parsed.items);
  } catch {
    // 模型给了非 JSON：推空清单让界面收起，同时不影响回合继续
    items = [];
  }
  push(EVENTS.AGENT_PLAN, { conversationId, items });
}

let tracingOff = false;
function disableTracingOnce(): void {
  if (tracingOff) return;
  setTracingDisabled(true);   // 隐私红线：trace 不外发，审计走本地 agent_tool_calls
  tracingOff = true;
}

/** OpenAI 兼容客户端。思考/推理开关按端点族注入正确方言（见 endpoint.service）：
 *  vLLM/agnes 认 chat_template_kwargs，Ollama 认 chat_template_kwargs.thinking，
 *  Gemini 认 google.thinking_config，OpenAI 认 reasoning_effort。
 *  开关来源：设置页「模型与端点」的思考拨杆（落在 .env 的 AGENT_THINKING），切换即时生效。 */
// ── 流式 usage 嗅探 ─────────────────────────────────────────────
// SDK 的流式分支不透传末帧 usage；这里在 fetch 层解包 SSE，抓 usage 帧存到回调里，
// 正文行原样重组成流返回（零语义改动）。端点不给 usage 就什么都不记。
function sniffStreamUsage(res: Response, onUsage: (u: TurnUsageLike) => void): Response {
  if (!res.body) return res;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = res.body.getReader();
  let buffer = "";
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload) as { usage?: Record<string, unknown> };
          const u = j.usage;
          if (u && typeof u.prompt_tokens === "number") {
            onUsage({
              requests: 1,
              input: u.prompt_tokens,
              output: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
              cached: (() => {
                const det = (u as { prompt_tokens_details?: Record<string, unknown> }).prompt_tokens_details;
                const hit = typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : 0;   // DeepSeek
                const cachedTok = det && typeof det.cached_tokens === "number" ? det.cached_tokens : 0;      // OpenAI/vLLM/Agnes
                return hit || cachedTok;
              })(),
            });
          }
        } catch { /* 非 JSON 行透传 */ }
      }
      controller.enqueue(value!);
    },
    cancel() { return reader.cancel(); },
  });
  return new Response(stream, { status: res.status, headers: res.headers });
}

function makeClient(baseUrl: string, apiKey: string): OpenAI {
  const extras = thinkingExtras(endpointFamily(baseUrl), readActiveEndpoint().thinking);
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (Array.isArray(body.messages)) {
          Object.assign(body, extras);
          // 流式默认不回报 token 用量；加上后 DeepSeek/vLLM/OpenAI 会在末帧给 usage
          if (body.stream === true && !body.stream_options) body.stream_options = { include_usage: true };
          init = { ...init, body: JSON.stringify(body) };
          if (process.env.AGENT_DEBUG_BODY === "1") {
            // 成本核算用：落盘真实请求体（含 tools 定义），离线复放即可量到精确 token
            try { require("fs").writeFileSync(".trash/last-request.json", JSON.stringify(body), "utf-8"); } catch { /* 目录不存在则忽略 */ }
          }
        }
      } catch { /* 非 JSON 请求体原样透传 */ }
    }
    // 走 netFetch：设置里配了代理就经它出去（海外端点在这类网络下必须经代理）
    const res = await netFetch(url as string, init as RequestInit);
    // 流式响应：解包 SSE 嗅探 usage（非流式的 usage 由 SDK 的 Usage 对象读取）
    let isSSE = false;
    try { isSSE = JSON.parse(String(init?.body ?? "{}")).stream === true; } catch { /* 非串行 body */ }
    if (isSSE && res.ok && res.body) return sniffStreamUsage(res, u => { lastStreamUsage.push(u); });
    return res;
  };
  return new OpenAI({ baseURL: baseUrl, apiKey, timeout: 90_000, maxRetries: 2, fetch: fetchImpl });
}

/** 本回合流式路径累计到的 usage（每次流式回合开跑时清零） */
const lastStreamUsage: TurnUsageLike[] = [];

/** SDK Usage 为空时兜底：把嗅探到的各请求 usage 求和 */
function sumStreamUsage(): TurnOutcome["usage"] | undefined {
  if (!lastStreamUsage.length) return undefined;
  return lastStreamUsage.reduce((acc, u) => ({
    requests: acc.requests + u.requests,
    input: acc.input + u.input,
    output: acc.output + u.output,
    cached: acc.cached + u.cached,
  }), { requests: 0, input: 0, output: 0, cached: 0 });
}

/** 用户停止/切换会话时作废该会话的待审批写操作（未确认即丢弃） */
export function rejectPendingFor(conversationId: string): void {
  for (const [id, p] of [...pendingApprovals]) {
    if (p.ctx.conversationId !== conversationId) continue;
    pendingApprovals.delete(id);
    Log.info("agent.harness", `会话 ${conversationId.slice(0, 8)} 停止，作废待审批 ${id.slice(0, 8)}`);
  }
}

export function hasPending(approvalId: string): boolean {
  return pendingApprovals.has(approvalId);
}

/** 发起一轮带工具的流式执行；遇 write 工具中断时返回 approval 态，等 resolveApproval 续跑 */
export async function runHarnessTurn(o: HarnessOptions): Promise<TurnOutcome> {
  disableTracingOnce();
  const model = new OpenAIChatCompletionsModel(makeClient(o.baseUrl, o.apiKey), o.model);
  const ctx: ToolCtx = { conversationId: o.conversationId, push: o.push, counts: new Map(), failures: new Map() };
  const tools = buildHarnessTools(ctx);
  // 身份档案每次现读：在设置里改完「助手身份」立刻生效，不用重启应用
  let instructions = AGENT_INSTRUCTIONS + identityBlock();
  if (o.contextNote) {
    instructions += `\n\n当前页面上下文（用户正停留在此页面，相关问题优先围绕它回答）：${o.contextNote}`;
  }
  const agent = new Agent<any, any>({
    name: "prospector-assistant",
    instructions,
    tools,
    model,
  });
  return streamRun(agent, ctx, o, undefined);
}

/** 人工审批结论回填 → 恢复执行（拒绝时模型会收到 reject 消息并据此回复）。
 *  rememberTool：批准时顺带登记「该工具本会话内不再询问」（仅低风险写工具，见 canAutoApprove）。 */
export async function resolveApproval(
  approvalId: string, approved: boolean, o: HarnessOptions, rememberTool?: string,
): Promise<TurnOutcome> {
  const p = pendingApprovals.get(approvalId);
  if (!p) return { kind: "done", text: "", conversationId: o.conversationId };
  pendingApprovals.delete(approvalId);
  if (approved && rememberTool) rememberAutoApprove(p.ctx.conversationId, rememberTool);
  const state = p.state as unknown as {
    getInterruptions(): Array<Record<string, unknown>>;
    approve(item: unknown): void;
    reject(item: unknown, opts?: { message?: string }): void;
  };
  const bound: HarnessOptions = { ...o, conversationId: p.ctx.conversationId };
  for (const item of state.getInterruptions()) {
    if (approved) {
      state.approve(item);
    } else {
      state.reject(item, { message: "用户拒绝了这次写操作，请放弃并告知用户" });
      auditRejected(p.ctx, String(item.name ?? "unknown"), typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments));
    }
  }
  return streamRun(p.agent, p.ctx, bound, p.state);
}

/** 推给前端的结果 JSON 上限：太小会让长草稿把 actions 截掉（JSON 不完整 → 整张卡消失） */
const RESULT_CAP = 24_000;

type RunItemLite = {
  type?: string; name?: string; callId?: string; arguments?: string;
  output?: unknown; content?: Array<{ text?: string }> | undefined;
};
interface RunResultLite {
  output?: RunItemLite[];
  finalOutput?: unknown;
  usage?: unknown;
  state: {
    getInterruptions(): Array<Record<string, unknown>>;
    approve(item: unknown): void;
  };
}

/**
 * 中断项全部命中「本会话内不再询问」→ 直接批准并续跑，不再打扰用户。
 * 发信类工具进不来这里（canAutoApprove 判 false）；返回 null 表示仍需人工确认。
 */
async function resumeIfAutoApproved(
  agent: Agent<any, any>, ctx: ToolCtx, o: HarnessOptions,
  state: { getInterruptions(): Array<Record<string, unknown>>; approve(item: unknown): void },
  interruptions: Array<Record<string, unknown>>,
): Promise<TurnOutcome | null> {
  if (!interruptions.length) return null;
  if (!interruptions.every(i => isAutoApproved(o.conversationId, String(i.name ?? "")))) return null;
  for (const item of interruptions) state.approve(item);
  Log.info("agent.harness", `会话 ${o.conversationId.slice(0, 8)} 免确认续跑（${interruptions.length} 项写操作）`);
  return streamRun(agent, ctx, o, state as unknown as RunState<any, any>);
}

/**
 * 非流式回合的结果转事件：工具过程逐条补推（calling/done），正文一次性推出。
 * 前端契约与流式路径完全一致，只是没有逐字效果。
 */
async function collectRunResult(
  r: RunResultLite, agent: Agent<any, any>, ctx: ToolCtx, o: HarnessOptions,
): Promise<TurnOutcome> {
  const items = r.output ?? [];
  const callName = new Map<string, string>();
  let text = "";
  for (const it of items) {
    if (it.type === "function_call") {
      if (it.callId && it.name) callName.set(it.callId, it.name);
      if (it.name === PLAN_TOOL) { pushPlanEvent(o.push, o.conversationId, it.arguments); continue; }
      o.push(EVENTS.AGENT_TOOL_CALL, {
        conversationId: o.conversationId, tool: it.name, callId: it.callId, status: "calling",
        args: (it.arguments ?? "").slice(0, 200),
      });
    } else if (it.type === "function_call_output") {
      const name = (it.callId && callName.get(it.callId)) || it.name || "";
      if (name === PLAN_TOOL) continue;   // 清单只以快照形式呈现，不留过程行
      const out = typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "");
      noteToolOutcome(ctx, (it.callId && callName.get(it.callId)) || it.name, out);
      o.push(EVENTS.AGENT_TOOL_CALL, {
        conversationId: o.conversationId,
        tool: name, callId: it.callId,
        status: "done", result: out.slice(0, RESULT_CAP),
      });
    } else if (it.type === "message") {
      const t = (it.content ?? []).map(c => c.text ?? "").join("");
      if (t) text += t;
    }
  }
  if (!text) text = String(r.finalOutput ?? "");

  const interruptions = r.state.getInterruptions();
  if (interruptions.length > 0) {
    const auto = await resumeIfAutoApproved(agent, ctx, o, r.state, interruptions);
    if (auto) return auto;
    const approvalId = crypto.randomUUID();
    pendingApprovals.set(approvalId, { state: r.state as unknown as RunState<any, any>, agent, ctx });
    o.push(EVENTS.AGENT_APPROVAL, {
      conversationId: o.conversationId, approvalId,
      items: interruptions.map(i => ({
        tool: String(i.name ?? "unknown"), args: i.arguments,
        autoApprovable: canAutoApprove(String(i.name ?? "")),
      })),
    });
    Log.info("agent.harness", `（非流式）写操作待审批 ${approvalId.slice(0, 8)}`);
    return { kind: "approval", text, conversationId: o.conversationId, approvalId, usage: readUsage(r.usage) };
  }

  if (text) o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta: text });
  return { kind: "done", text, conversationId: o.conversationId, usage: sumStreamUsage() ?? readUsage(r.usage) };
}

async function streamRun(
  agent: Agent<any, any>, ctx: ToolCtx, o: HarnessOptions,
  resumeState: RunState<any, any> | undefined,
): Promise<TurnOutcome> {
  // Gemini 的 OpenAI 兼容层要求回放 function call 时带回 extra_content.google.thought_signature，
  // 而 SDK 的流式分支只累积 name/arguments/callId（把签名丢了 → 第 2 轮直接 400）；
  // 非流式分支会把整条 tool_call 存进 providerData 并原样 spread 回去。故对 google 族走非流式。
  const family = endpointFamily(o.baseUrl);
  const streaming = family !== "google";

  if (!streaming) {
    const r = await run(agent, (resumeState ?? o.history) as never, {
      stream: false, signal: o.signal, maxTurns: 8,
    }) as unknown as RunResultLite;
    return collectRunResult(r, agent, ctx, o);
  }

  if (!resumeState) lastStreamUsage.length = 0;      // 新回合才清零；审批续跑接着上一段累计，否则用量只剩后半截
  const raw = await run(agent, (resumeState ?? o.history) as never, {
    stream: true, signal: o.signal, maxTurns: 8,
  });
  const result = raw as unknown as AsyncIterable<unknown> & {
    state: RunState<any, any>; finalOutput?: unknown; usage?: unknown;
  };

  /**
   * @openai/agents SDK 真实事件流（对照 dist/events.d.ts 与 openaiChatCompletionsStreaming.js）：
   *  · raw_model_stream_event.data → chat-completions 适配器产出 {type:'output_text_delta', delta}
   *  · run_item_stream_event.name  → tool_called / tool_output / reasoning_item_created / message_output_created
   *    tool_called 的 rawItem = {type:'function_call', callId, name, arguments}
   *    tool_output 的 rawItem = {type:'function_call_output', callId, output}（无 name → 用 callId 映射）
   *  旧实现按 'raw_response_event'/'run_item_streamed' 匹配，SDK 从无这些类型 → 事件全部静默丢失。
   */
  const callName = new Map<string, string>();
  let text = "";
  for await (const unknownEv of result) {
    const e = unknownEv as {
      type?: string; data?: { type?: string; delta?: unknown; choices?: Array<{ delta?: { content?: string } }> };
      name?: string;
      item?: { rawItem?: { type?: string; name?: string; callId?: string; arguments?: string; output?: unknown; rawContent?: Array<{ text?: string }> } };
    };
    if (e.type === "raw_model_stream_event") {
      const d = e.data;
      const delta = d?.type === "output_text_delta" && typeof d.delta === "string" ? d.delta
        : d?.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta });
      }
    } else if (e.type === "run_item_stream_event") {
      const ri = e.item?.rawItem;
      if (e.name === "tool_called" && ri) {
        if (ri.callId && ri.name) callName.set(ri.callId, ri.name);
        if (ri.name === PLAN_TOOL) { pushPlanEvent(o.push, o.conversationId, ri.arguments); continue; }
        o.push(EVENTS.AGENT_TOOL_CALL, {
          conversationId: o.conversationId, tool: ri.name, callId: ri.callId, status: "calling",
          args: (ri.arguments ?? "").slice(0, 200),
        });
      } else if (e.name === "tool_output" && ri) {
        const name = (ri.callId && callName.get(ri.callId)) || ri.name || "";
        if (name === PLAN_TOOL) continue;   // 清单只以快照形式呈现，不留过程行
        const out = typeof ri.output === "string" ? ri.output : JSON.stringify(ri.output ?? "");
        // SDK 层校验失败走不到 execute/audit，只能在这里补记，否则熔断对这类故障失明
        noteToolOutcome(ctx, name, out);
        // result 供前端渲染「数据表格卡 + 动作卡」（模型上下文走 SDK 内部通道，与此无关）。
        // 上限要够大：截断会让 JSON 不合法 → 整张卡消失；actions 又在末尾，长草稿会被切掉。
        o.push(EVENTS.AGENT_TOOL_CALL, {
          conversationId: o.conversationId, tool: name, callId: ri.callId, status: "done",
          result: out.slice(0, RESULT_CAP),
        });
      } else if (e.name === "reasoning_item_created" && ri) {
        const think = (ri.rawContent ?? []).map(c => c.text ?? "").join("\n").trim();
        if (think) o.push(EVENTS.AGENT_TOOL_CALL, { conversationId: o.conversationId, tool: "reasoning", callId: ri.callId, status: "reasoning", result: think.slice(0, 1500) });
      }
    }
  }

  // ⚠ v0.17 的 RunState 暴露 getInterruptions() 方法而非 interruptions 属性——
  //   曾按属性读取恒为 undefined → 审批网关整体失效（写工具静默执行，评测 fu-* 卡暴露）
  const state = result.state as unknown as {
    getInterruptions(): Array<Record<string, unknown>>;
    approve(item: unknown): void;
  };
  const interruptions = state.getInterruptions();
  if (interruptions.length > 0) {
    const auto = await resumeIfAutoApproved(agent, ctx, o, state, interruptions);
    if (auto) return auto;
    const approvalId = crypto.randomUUID();
    pendingApprovals.set(approvalId, { state: result.state, agent, ctx });
    o.push(EVENTS.AGENT_APPROVAL, {
      conversationId: o.conversationId,
      approvalId,
      items: interruptions.map(i => ({
        tool: String(i.name ?? "unknown"), args: i.arguments,
        autoApprovable: canAutoApprove(String(i.name ?? "")),
      })),
    });
    Log.info("agent.harness", `写操作待审批 ${approvalId.slice(0, 8)}（${interruptions.length} 项）`);
    return { kind: "approval", text, conversationId: o.conversationId, approvalId, usage: sumStreamUsage() ?? readUsage(result.usage) };
  }

  const finalText = text || String((result as { finalOutput?: unknown }).finalOutput ?? "");
  // 兜底：本轮一个字都没流出来但拿到了完整最终文本（模型/端点差异）→ 整段补推，前端不留空骨架
  if (!text && finalText) o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta: finalText });
  return { kind: "done", text: finalText, conversationId: o.conversationId, usage: sumStreamUsage() ?? readUsage(result.usage) };
}
