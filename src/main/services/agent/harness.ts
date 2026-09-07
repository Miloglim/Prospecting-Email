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
import { endpointFamily, thinkingExtras } from "../endpoint.service";
import { netFetch } from "../../net-proxy";
import { buildHarnessTools, auditRejected, normalizePlan, noteToolOutcome, isToolRuntimeError, isEnvelopeFailure, type ToolCtx, type PlanItem } from "./tools";
import { toolRoutesBlock, pickTools } from "./manifest";
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
  // 工具清单由注册表（agent/manifest.ts）派生 —— 加工具不再需要改这份提示词
  toolRoutesBlock(),
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
  "未读邮件意图路由：用户问「我有哪些未读 / 今日邮件 / 邮件清单」——直接 inbox_search({ unreadOnly:true, limit:30 })，" +
    "回答围绕这批量做；**禁止**用 queue_status / accounts_status / reminders_due 去回答邮件类问题，那些是别的意图。",
  "数字硬校验（重要）：回答里出现的任何数量（几封 / 几条 / 几个 / 总共多少）都必须来自本轮工具返回的 total 或数组长度原值，" +
    "禁止凭印象、估算或记忆作答。结果里若带 complete:false 或 notice 提示未取全，必须明说「已显示前 N 条，共 M 条」，不许把 N 当 M。" +
    "被 budget_exhausted 拦下时，如实报出已经查到的部分数字并说「其余未查」，绝不补估。" +
    "同一轮里若两次数字打架，以最后一次**完整**查询为准，并明确告诉用户「更正：之前说的 X 不准确，实际 Y」，不要静默改口。",
  "歧义列候选：用户说「那封 X / 这个客户」而检索命中多条（例如 COSCO 加勒比有 8/22、9/1、9/8 三个周期），" +
    "必须列候选（id + 主题 + 日期）让用户点选，不许自己挑「最近一封」当答案。",
  "长清单防截断：邮件清单/长表在正文里最多列 15 行；超过就只列最新 15 行 + 一句「另有 N 封，需要的话可以导出成文件」，" +
    "别硬撑一整张长表把输出截断。",
  "少查一步：inbox_search 加了 classification 命中为空时，**放宽一次**（去掉 classification 或传空）再查即可；" +
    "同一轮不要连环换多种过滤条件把工具预算烧光。",
  "L0 规则：涉及客户、联系人、跟进状态、收件箱邮件的事实性问题，必须先调用工具，仅基于工具返回的数据回答；",
  "运价问题必须调用 quote_search——同一次调用会连带返回该航线/港口的近期舱位动态（spaces/spaceTable）。" +
    "回答顺序固定：先运价、再舱位（舱位类型/船名航次/ETD/截关/箱量照工具返回的原值说），" +
    "并注明镜像价为参考价、以船司实时报价为准，舱位为群内动态、以订舱时确认为准。" +
    "没命中时按返回 notice 的分层口径作答：不得把「本地镜像查不到」说成「该航线没有报价」，也不得编造价格或舱位。" +
    "库内条数、最低价、有哪些航线船司这类统计问题同样必须先调用（没有筛选条件就传空对象），禁止凭记忆或凭常识作答。",
  "宁查勿问（重要）：用户问题缺少筛选条件（没说是哪条航线/柜型/船司）时，一律视为不限——" +
    "就用已给出的关键词直接调用工具，把查到的结果按船司/柜型/港口汇总出来回答，禁止先反问等用户补齐条件；" +
    "只有查询结果为空或明显有歧义时，才在给出已有结果后顺带追问。",
  "台账价 vs 市场价：问「我们报过多少 / 库里有没有 / 台账上多少钱」用 quote_search；" +
    "问「外面报多少 / 现在什么行情 / 最近有没有新船期 / 我们这价在市场算什么水平」用 market_research（联网多源核实，产出带来源链接与日期的报告）；" +
    "两种都要就先用 quote_search 查台账、再用 market_research 查市场，对照着说，不许把两边的数混成一句。",
  "market_research 是「宁查勿问」的唯一例外：它必须有起运港和目的港才跑得起来。工具返回 needPorts 时，" +
    "就用一句话问「从哪个港到哪个港？」（柜型与时间窗可以不说，走默认），禁止自己编一个港口或按常见航线猜一条去查。",
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
  "工具返回统一带 ok 字段：ok:false 表示这一次没办成。读它的 error.message 与 notice，" +
    "决定改一个参数重试一次还是换条路子——禁止拿一模一样的参数原样重试（那只会重复失败）。",
  "工具参数必须是合法 JSON。若收到 Invalid JSON input for tool 的错误，说明参数结构写坏了：" +
    "立即换**更简单**的参数结构再试一次——少一层嵌套、缩短每格文本、去掉引号等特殊字符，" +
    "或改用 md 格式把整块内容放进 content 一个字段里。绝不用一模一样的参数再试第二次。",
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
  "内部限制永不出口：工具配额、连续失败熔断、回合步数上限都是程序内部机制，" +
    "对用户不说「次数/上限/限制/配额/工具不可用」这类话。受限时的正确姿势＝把已取到的结果先完整交付，" +
    "没做完的部分用一句自然的话带过（如「其余的下条接着查」），禁止把受限原因讲给用户听。",
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

/**
 * Agent 角色 = 一份配置：系统提示词工厂 + 工具子集 + 步数上限。
 * 新增角色不复制/修改内核 —— 加一个 profile 即可；不填 toolNames 用注册表全集。
 */
export interface AgentProfile {
  name: string;
  maxTurns: number;
  /** 要挂载的工具名（注册表内的子集）；缺省 = 全部 */
  toolNames?: string[];
  /** 系统指令工厂：每次回合现拼（身份档案等改完即时生效） */
  buildInstructions(): string;
}

/** 默认角色：Prospector 业务助手（全量工具） */
export const DEFAULT_PROFILE: AgentProfile = {
  name: "prospector-assistant",
  maxTurns: 16,
  buildInstructions: () => AGENT_INSTRUCTIONS + identityBlock(),
};

export interface TurnOutcome {
  kind: "done" | "approval";
  text: string;
  conversationId: string;
  approvalId?: string;
  /** done 且本轮被 maxTurns 截断：活没排完，前端据此出「继续吗」请示卡 */
  capped?: boolean;
  /** 本回合真实 token 结算；端点没回 usage 时为 undefined（宁可没有，也不猜数） */
  usage?: { requests: number; input: number; output: number; cached: number };
  /** 本轮各工具输出（截断留存）：只供反思层做数字回溯，不回放进模型上下文 */
  toolOutputs?: string[];
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
  maxTurns: number;
}

const pendingApprovals = new Map<string, PendingApproval>();

// 写操作一律每次都人工确认（无会话豁免）：审批中断流见 resolveApproval 与 collectRunResult。
// 「本会话内不再询问」机制已于 2026-09-07 连根移除——判据只可加严，不留旋钮。

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

/** OpenAI 兼容客户端。恒关思考，按端点族注入正确的「关推理」方言（见 endpoint.service）：
 *  vLLM/agnes 认 chat_template_kwargs，Ollama 认 chat_template_kwargs.thinking，
 *  DeepSeek 认顶层 thinking:{type:"disabled"}，Gemini/OpenAI 兼容层不注入。 */
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
  const extras = thinkingExtras(endpointFamily(baseUrl));
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (Array.isArray(body.messages)) {
          Object.assign(body, extras);
          // 流式默认不回报 token 用量；加上后 DeepSeek/vLLM/OpenAI 会在末帧给 usage
          if (body.stream === true && !body.stream_options) body.stream_options = { include_usage: true };
          // 输出上限必须给足：工具参数 JSON 被端点默认上限截断 → Invalid JSON input for tool，
          // 这类故障发生在 execute 之前、熔断够不着，模型会同参重试到撞墙（规范 §2.2 的根因修）
          const maxOut = Number(process.env.AGENT_MAX_OUTPUT_TOKENS || 16384);
          if (Number.isFinite(maxOut) && maxOut > 0 && body.max_tokens == null && body.max_completion_tokens == null) {
            body[endpointFamily(baseUrl) === "google" ? "max_completion_tokens" : "max_tokens"] = maxOut;
          }
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
export async function runHarnessTurn(profile: AgentProfile, o: HarnessOptions): Promise<TurnOutcome> {
  disableTracingOnce();
  const model = new OpenAIChatCompletionsModel(makeClient(o.baseUrl, o.apiKey), o.model);
  const ctx: ToolCtx = { conversationId: o.conversationId, push: o.push, counts: new Map(), failures: new Map() };
  // 工具子集：按角色配置从全量里挑；未配置 = 全量
  const tools = pickTools(buildHarnessTools(ctx), profile.toolNames);
  // 身份档案每次现读：在设置里改完「助手身份」立刻生效，不用重启应用
  let instructions = profile.buildInstructions();
  if (o.contextNote) {
    instructions += `\n\n当前页面上下文（用户正停留在此页面，相关问题优先围绕它回答）：${o.contextNote}`;
  }
  const agent = new Agent<any, any>({
    name: profile.name,
    instructions,
    tools,
    model,
  });
  return streamRun(agent, ctx, o, undefined, profile.maxTurns);
}

/** 人工审批结论回填 → 恢复执行（拒绝时模型会收到 reject 消息并据此回复）。
 *  审批只对"这一次调用的这一份参数"生效：下一次写操作仍会重新中断询问。 */
export async function resolveApproval(
  approvalId: string, approved: boolean, o: HarnessOptions,
): Promise<TurnOutcome> {
  const p = pendingApprovals.get(approvalId);
  if (!p) return { kind: "done", text: "", conversationId: o.conversationId };
  pendingApprovals.delete(approvalId);
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
  return streamRun(p.agent, p.ctx, bound, p.state, p.maxTurns);
}

/** 推给前端的结果 JSON 上限：太小会让长草稿把 actions 截掉（JSON 不完整 → 整张卡消失） */
const RESULT_CAP = 24_000;

/**
 * 工具输出统一剥成纯文本再推前端。
 * SDK 的 FunctionCallResultItem.output 是联合类型：有时是纯字符串，有时被包成
 * {type:"text",text:"…"} 内容包（或其数组）。实测后者被整包 JSON.stringify 后，
 * 前端只看到一坨裸 JSON、表格卡与动作按钮全部解析失败。这里剥壳还原文本：
 * 字符串原样；内容包取其 text（数组则拼接）；其余对象兜底序列化。
 */
export function toolOutputText(o: unknown): string {
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map(toolOutputText).join("");
  if (o && typeof o === "object") {
    const p = o as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") return p.text;
  }
  return JSON.stringify(o ?? "");
}

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
 * 非流式回合的结果转事件：工具过程逐条补推（calling/done），正文一次性推出。
 * 前端契约与流式路径完全一致，只是没有逐字效果。
 */
async function collectRunResult(
  r: RunResultLite, agent: Agent<any, any>, ctx: ToolCtx, o: HarnessOptions, maxTurns: number,
): Promise<TurnOutcome> {
  const items = r.output ?? [];
  const callName = new Map<string, string>();
  const toolOutputs: string[] = [];
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
      const out = toolOutputText(it.output);
      noteToolOutcome(ctx, (it.callId && callName.get(it.callId)) || it.name, out);
      if (toolOutputs.length < 40) toolOutputs.push(out.slice(0, 8000));
      o.push(EVENTS.AGENT_TOOL_CALL, {
        conversationId: o.conversationId,
        tool: name, callId: it.callId,
        status: "done", result: out.slice(0, RESULT_CAP),
        failed: isToolRuntimeError(out) || isEnvelopeFailure(out),   // 失败卡不再画成「已{动词}」绿勾
      });
    } else if (it.type === "message") {
      const t = (it.content ?? []).map(c => c.text ?? "").join("");
      if (t) text += t;
    }
  }
  if (!text) text = String(r.finalOutput ?? "");

  const interruptions = r.state.getInterruptions();
  if (interruptions.length > 0) {
    const approvalId = crypto.randomUUID();
    pendingApprovals.set(approvalId, { state: r.state as unknown as RunState<any, any>, agent, ctx, maxTurns });
    o.push(EVENTS.AGENT_APPROVAL, {
      conversationId: o.conversationId, approvalId,
      items: interruptions.map(i => ({
        tool: String(i.name ?? "unknown"), args: i.arguments,
      })),
    });
    Log.info("agent.harness", `（非流式）写操作待审批 ${approvalId.slice(0, 8)}`);
    return { kind: "approval", text, conversationId: o.conversationId, approvalId, usage: readUsage(r.usage), toolOutputs };
  }

  if (text) o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta: text });
  return { kind: "done", text, conversationId: o.conversationId, usage: sumStreamUsage() ?? readUsage(r.usage), toolOutputs };
}

async function streamRun(
  agent: Agent<any, any>, ctx: ToolCtx, o: HarnessOptions,
  resumeState: RunState<any, any> | undefined,
  maxTurns: number,
): Promise<TurnOutcome> {
  // Gemini 的 OpenAI 兼容层要求回放 function call 时带回 extra_content.google.thought_signature，
  // 而 SDK 的流式分支只累积 name/arguments/callId（把签名丢了 → 第 2 轮直接 400）；
  // 非流式分支会把整条 tool_call 存进 providerData 并原样 spread 回去。故对 google 族走非流式。
  const family = endpointFamily(o.baseUrl);
  const streaming = family !== "google";

  if (!streaming) {
    const r = await run(agent, (resumeState ?? o.history) as never, {
      stream: false, signal: o.signal, maxTurns,
    }) as unknown as RunResultLite;
    return collectRunResult(r, agent, ctx, o, maxTurns);
  }

  if (!resumeState) lastStreamUsage.length = 0;      // 新回合才清零；审批续跑接着上一段累计，否则用量只剩后半截
  const raw = await run(agent, (resumeState ?? o.history) as never, {
    stream: true, signal: o.signal, maxTurns,
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
  const toolOutputs: string[] = [];
  let text = "";
  /**
   * 逐字思考：chat-completions 适配器把每个原始 chunk 以 {type:'model', event:chunk} 透传成
   * raw_model_stream_event，但它自己只消费 delta.content —— delta.reasoning（OpenAI 方言）被它
   * 攒到整段结束才合成一个 reasoning item，delta.reasoning_content（DeepSeek/Qwen/vLLM 网关键名）
   * 干脆丢掉，前端于是看不到 agent 在想什么。这里直接读原始 chunk 的推理增量，≥120ms 合并一次
   * 推给前端（逐 token 一发会把 IPC 打穿）；边界事件（正文开始、工具调用、思考定块、循环收尾）
   * 前先冲缓冲，保证顺序不乱。
   */
  const THINK_FLUSH_MS = 120;
  let thinkBuf = "";
  let lastThinkPushAt = 0;
  const flushThink = () => {
    if (!thinkBuf) return;
    o.push(EVENTS.AGENT_TOOL_CALL, {
      conversationId: o.conversationId, tool: "reasoning", status: "reasoning_delta",
      delta: thinkBuf.slice(0, 4000),
    });
    thinkBuf = "";
    lastThinkPushAt = Date.now();
  };
  // maxTurns 刹车识别：SDK 在步数用尽时从迭代器抛错，但此刻已产出的增量都已推给前端——
  // 用守卫生成器把异常截下，循环后按「完成但受限」交付（上层据此出请示卡），其余错误原样上抛
  let iterErr: unknown = null;
  const guarded = (async function* () {
    try { yield* result as unknown as AsyncIterable<unknown>; } catch (e) { iterErr = e; }
  })();
  let maxTurnsHit = false;
  for await (const unknownEv of guarded) {
    const e = unknownEv as {
      type?: string; data?: {
        type?: string; delta?: unknown;
        choices?: Array<{ delta?: { content?: string } }>;
        event?: { choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string } }> };
      };
      name?: string;
      item?: { rawItem?: { type?: string; name?: string; callId?: string; arguments?: string; output?: unknown; rawContent?: Array<{ text?: string }> } };
    };
    if (e.type === "raw_model_stream_event") {
      const d = e.data;
      const rawDelta = (d?.event ?? d)?.choices?.[0]?.delta as { reasoning?: string; reasoning_content?: string } | undefined;
      const think = rawDelta?.reasoning ?? rawDelta?.reasoning_content;
      if (typeof think === "string" && think) {
        thinkBuf += think;
        if (Date.now() - lastThinkPushAt >= THINK_FLUSH_MS) flushThink();
      }
      const delta = d?.type === "output_text_delta" && typeof d.delta === "string" ? d.delta
        : d?.choices?.[0]?.delta?.content;
      if (delta) {
        flushThink();          // 开始出正文 = 这段思考到此为止
        text += delta;
        o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta });
      }
    } else if (e.type === "run_item_stream_event") {
      const ri = e.item?.rawItem;
      if (e.name === "tool_called" && ri) {
        flushThink();
        if (ri.callId && ri.name) callName.set(ri.callId, ri.name);
        if (ri.name === PLAN_TOOL) { pushPlanEvent(o.push, o.conversationId, ri.arguments); continue; }
        o.push(EVENTS.AGENT_TOOL_CALL, {
          conversationId: o.conversationId, tool: ri.name, callId: ri.callId, status: "calling",
          args: (ri.arguments ?? "").slice(0, 200),
        });
      } else if (e.name === "tool_output" && ri) {
        const name = (ri.callId && callName.get(ri.callId)) || ri.name || "";
        if (name === PLAN_TOOL) continue;   // 清单只以快照形式呈现，不留过程行
        const out = toolOutputText(ri.output);
        // SDK 层校验失败走不到 execute/audit，只能在这里补记，否则熔断对这类故障失明
        noteToolOutcome(ctx, name, out);
        if (toolOutputs.length < 40) toolOutputs.push(out.slice(0, 8000));
        // result 供前端渲染「数据表格卡 + 动作卡」（模型上下文走 SDK 内部通道，与此无关）。
        // 上限要够大：截断会让 JSON 不合法 → 整张卡消失；actions 又在末尾，长草稿会被切掉。
        o.push(EVENTS.AGENT_TOOL_CALL, {
          conversationId: o.conversationId, tool: name, callId: ri.callId, status: "done",
          result: out.slice(0, RESULT_CAP),
          failed: isToolRuntimeError(out) || isEnvelopeFailure(out),   // 失败卡不再画成「已{动词}」绿勾
        });
      } else if (e.name === "reasoning_item_created" && ri) {
        flushThink();          // 定稿块之前先把在途增量交付，前端才不会把同一段思考画成两张卡
        const think = (ri.rawContent ?? []).map(c => c.text ?? "").join("\n").trim();
        if (think) o.push(EVENTS.AGENT_TOOL_CALL, { conversationId: o.conversationId, tool: "reasoning", callId: ri.callId, status: "reasoning", result: think.slice(0, 1500) });
      }
    }
  }
  flushThink();   // 收尾（含抛错退出）：残留在途思考，别让最后一张思考卡停在半截

  if (iterErr) {
    const isMaxTurns = (iterErr as { name?: string })?.name === "MaxTurnsExceededError"
      || /max\s*turns/i.test(iterErr instanceof Error ? iterErr.message : String(iterErr));
    if (!isMaxTurns || !text) throw iterErr;
    maxTurnsHit = true;
    Log.warn("agent.harness", `达 maxTurns，交付本轮已产出的 ${text.length} 字`);
  }

  // ⚠ v0.17 的 RunState 暴露 getInterruptions() 方法而非 interruptions 属性——
  //   曾按属性读取恒为 undefined → 审批网关整体失效（写工具静默执行，评测 fu-* 卡暴露）
  const state = result.state as unknown as {
    getInterruptions(): Array<Record<string, unknown>>;
    approve(item: unknown): void;
  };
  const interruptions = state.getInterruptions();
  if (interruptions.length > 0) {
    const approvalId = crypto.randomUUID();
    pendingApprovals.set(approvalId, { state: result.state, agent, ctx, maxTurns });
    o.push(EVENTS.AGENT_APPROVAL, {
      conversationId: o.conversationId,
      approvalId,
      items: interruptions.map(i => ({
        tool: String(i.name ?? "unknown"), args: i.arguments,
      })),
    });
    Log.info("agent.harness", `写操作待审批 ${approvalId.slice(0, 8)}（${interruptions.length} 项）`);
    return { kind: "approval", text, conversationId: o.conversationId, approvalId, usage: sumStreamUsage() ?? readUsage(result.usage), toolOutputs };
  }

  const finalText = text || String((result as { finalOutput?: unknown }).finalOutput ?? "");
  // 兜底：本轮一个字都没流出来但拿到了完整最终文本（模型/端点差异）→ 整段补推，前端不留空骨架
  if (!text && finalText) o.push(EVENTS.AGENT_CHUNK, { conversationId: o.conversationId, delta: finalText });
  return { kind: "done", text: finalText, conversationId: o.conversationId, ...(maxTurnsHit ? { capped: true } : {}), usage: sumStreamUsage() ?? readUsage(result.usage), toolOutputs };
}
