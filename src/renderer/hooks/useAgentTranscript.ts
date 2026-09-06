import { useSyncExternalStore } from "react";
import { CONVS_CHANGED, gotoConversation } from "../lib/agent-route";
import { ensureToolMeta, followUpsOf } from "../lib/tool-meta";

/**
 * 助手「回合现场」的存放处 —— 模块级单例，不属于任何组件。
 *
 * 为什么必须有它（规范：docs/agent-live-transcript-spec.md）：
 * 以前整份流水只活在 AssistantPage 的 useState 里，换路由=组件卸载=事件监听器全注销，
 * 而 AI 正文要等回合结束才落库，于是「切页再回来，正在流式的气泡整个不见了」。
 * 这里把监听器提到模块层注册一次、永不注销，事件按 conversationId 落到各自条目：
 * 页面在不在，现场都在；顺带把「后台会话的 chunk 画进前台会话」的串台问题一起收掉。
 */

// ── 消息形状（渲染层唯一数据源）──────────────────────────────

export interface Msg {
  key: string;
  role: "user" | "ai" | "tool";
  content: string;
  /** 等待首个增量时显示呼吸点 */
  loading?: boolean;
  /** 正在流式接收 */
  streaming?: boolean;
  error?: boolean;
  /** 产生时刻（过程行折叠后据此算「用时 Xs」；历史消息可缺省） */
  ts?: number;
  /** 过程卡结构化字段（role=tool 时） */
  chip?: {
    kind: "calling" | "done" | "reasoning";
    tool?: string;
    /** 工具调用 id：calling → done 原地升级按它配对，同名连发不会错配 */
    callId?: string;
    args?: string;
    detail?: string;   // 参数摘要 / 结果摘要 / 思考全文
    brief?: string;    // done 卡的「N 条结果」小尾巴
    /** 这次调用其实失败了（SDK 校验/执行错误）：卡面画失败态，不写「已{动词}」 */
    failed?: boolean;
    /** 思考还在逐字生长（画光标，封口后转普通思考条目） */
    live?: boolean;
  };
  /** 任务清单快照（role=tool，由 agent:plan 全量覆盖、原地刷新） */
  plan?: PlanStep[];
  /** 后台任务卡引用（工具结果里的 task 字段，进度走 agent:task 事件） */
  task?: { taskId: string };
  /** 本轮 token 结算（挂在收尾的 AI 气泡上；端点没回 usage 就不显示） */
  usage?: { requests?: number; input?: number; output?: number; cached?: number };
  /** 动作执行后的回执行（role=tool 无 chip 时），带可选跳转 */
  link?: { label: string; href: string };
}

/** 任务清单里的一步（与主进程 update_plan 归一后的形状一致；id 为步骤稳定标识） */
export interface PlanStep { id?: string; text: string; state: "pending" | "doing" | "done" }

export interface ApprovalReq {
  approvalId: string;
  conversationId?: string;
  /** autoApprovable 由主进程按 policy 下发：只有低风险写工具才允许「本会话内不再询问」 */
  items: Array<{ tool?: string; args?: unknown; autoApprovable?: boolean }>;
}

/** 一个会话的完整现场：流水 + 回合态 + 回合内部计数 */
export interface ConvState {
  /** 真实会话 id；新草稿在首轮发送时定住 */
  id?: string;
  messages: Msg[];
  /** 回合进行中（per-conversation，不再是页面级：切会话不互相干扰） */
  sending: boolean;
  /** DB 历史是否已装进 messages */
  loaded: boolean;
  /** 历史读取中（骨架屏） */
  loading: boolean;
  /** 页面上下文锚点（contact:12 / company:3 / message:45） */
  ctx?: string;
  approval: ApprovalReq | null;
  /** 本轮被步数上限截断 → 「继续吗」请示卡 */
  budgetAsk: boolean;
  /** 排队输入（单槽） */
  queued: string | null;
  sessionUsage: { input: number; output: number } | null;
  followUps: string[];
  doneActions: Record<string, string>;
  turnUser: string;
  turnText: string;
  turnTools: string[];
  flushGen: number;
  followGen: number;
  /** 正在逐字生长的思考卡 key（null = 没有） */
  liveReasoning: string | null;
}

type IpcResult<T> = { success: boolean; data?: T; error?: string };

/** 尚未落 id 的新草稿条目键 */
export const NEW_KEY = "__new__";

let seq = 0;
export const nextKey = (): string => `m${++seq}`;

// ── 过程卡文本工具（实时事件与历史回放共用）──────────────────

/** tool_called 参数摘要 */
export function fmtChipArgs(a?: string): string {
  if (!a) return "";
  try {
    const o = JSON.parse(a) as Record<string, unknown>;
    return Object.entries(o).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  } catch { return a.slice(0, 48); }
}

/** tool_output 结果 → done 卡的小尾巴 */
export function resultBrief(r?: string): string {
  if (!r) return "";
  try {
    const o = JSON.parse(r) as unknown;
    if (Array.isArray(o)) return `${o.length} 条结果`;
    // 统一包络失败：尾巴给原因摘要（卡头已是「{动词}失败」）
    const env = o as { ok?: unknown; error?: { message?: unknown } };
    if (env.ok === false) {
      const msg = typeof env.error?.message === "string" ? env.error.message : "";
      return msg ? `未办成：${msg}` : "未办成";
    }
    const p2 = o as { artifact?: { name?: unknown }; task?: { total?: unknown }; checked?: unknown };
    // 调研结果同时带产物与核实数：核实数更能说明这次到底查到了什么
    if (typeof p2.checked === "string") return p2.checked;
    if (p2.artifact && typeof p2.artifact.name === "string") return `已生成 ${p2.artifact.name}`;
    if (p2.task && typeof p2.task.total === "number") return `共 ${p2.task.total} 家`;
    const obj = o as {
      total?: number; count?: number; quotes?: unknown; data?: { length?: number };
      results?: unknown[]; dueCount?: number; overdueCount?: number; pendingGroups?: number; healthy?: number; enabled?: number;
    };
    if (typeof obj.dueCount === "number") return `到期 ${obj.dueCount} · 逾期 ${obj.overdueCount ?? 0}`;
    if (typeof obj.pendingGroups === "number") return `待发 ${obj.pendingGroups} 组`;
    if (typeof obj.healthy === "number" && typeof obj.enabled === "number") return `${obj.healthy}/${obj.enabled} 健康`;
    if (typeof obj.total === "number") return `共 ${obj.total} 条`;
    if (typeof obj.count === "number") return `${obj.count} 条结果`;
    if (Array.isArray(obj.results)) return `${obj.results.length} 条结果`;
    if (obj.data?.length != null) return `${obj.data.length} 条`;
  } catch { /* 非 JSON 结果不展示摘要 */ }
  return "";
}

/** 过程卡插入在「正在流式的 AI 气泡」之前，保证回答气泡恒在列表末尾（过程在上、答案在下） */
export function insertBeforeStreamingBubble(prev: Msg[], chip: Msg): Msg[] {
  const stamped = { ...chip, ts: chip.ts ?? Date.now() };
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]!;
    if (m.role === "ai" && m.streaming) return [...prev.slice(0, i), stamped, ...prev.slice(i)];
  }
  return [...prev, stamped];
}

/** 本轮调用过的工具 → 「接下来可以问」引导（让能力被连续体验到）：
 *  清单唯一事实源在主进程注册表（agent/manifest.ts），经 tool-meta 缓存取；
 *  未收录/未就绪的工具回退默认引导 */
const DEFAULT_FOLLOW_UPS = ["我今天该跟进谁", "总结一下我的未读邮件"];

// ── 条目存储 ────────────────────────────────────────────

const BLANK: ConvState = Object.freeze({
  messages: [], sending: false, loaded: false, loading: false, approval: null, budgetAsk: false,
  queued: null, sessionUsage: null, followUps: [], doneActions: {}, turnUser: "", turnText: "",
  turnTools: [], flushGen: 0, followGen: 0, liveReasoning: null,
}) as ConvState;

const entries = new Map<string, ConvState>();
/** 最近使用顺序（队尾最新），仅用于条数上限淘汰 */
const lru: string[] = [];
const convListeners = new Map<string, Set<() => void>>();
const shellListeners = new Set<() => void>();
/** 缓存条目上限：切过的会话再多也只留最近这些个（运行中的永不淘汰） */
const MAX_ENTRIES = 20;
/** 思考中卡的正文上限：超过则只留尾部，防单轮长思考把内存撑爆 */
const REASONING_CAP = 8000;

let activeKey = NEW_KEY;
/** 组件首次挂载的那次 navigate 必须真走一遍（带 ctx、装历史），不能被「同键早退」吃掉 */
let navigated = false;
let listening = false;
let runningIds: string[] = [];
const loadTokens = new Map<string, number>();

function newConv(id?: string): ConvState {
  return { ...BLANK, id };
}

function touchLru(key: string): void {
  const i = lru.indexOf(key);
  if (i >= 0) lru.splice(i, 1);
  lru.push(key);
  // 淘汰：只动「没在跑、且不是当前视图/新草稿」的条目
  while (lru.length > MAX_ENTRIES) {
    const victim = lru.find(k => k !== activeKey && k !== NEW_KEY && !entries.get(k)?.sending);
    if (!victim) break;
    lru.splice(lru.indexOf(victim), 1);
    entries.delete(victim);
  }
}

function ensureEntry(key: string): ConvState {
  let s = entries.get(key);
  if (!s) { s = newConv(key === NEW_KEY ? undefined : key); entries.set(key, s); }
  touchLru(key);
  return s;
}

function notifyConv(key: string): void {
  convListeners.get(key)?.forEach(cb => cb());
  syncRunning();
}

/** 导航栏「正在运行」呼吸点的数据源：只在集合真的变了时才通知，避免每次增量都刷侧栏 */
function syncRunning(): void {
  const now = [...entries.entries()].filter(([, s]) => s.sending).map(([k]) => k).sort();
  if (now.join("|") === runningIds.join("|")) return;
  runningIds = now;
  shellListeners.forEach(cb => cb());
}

function notifyShell(): void { shellListeners.forEach(cb => cb()); }

/** copy-on-write 改一份条目：产出新引用，订阅方在未变更期间拿到的快照恒定 */
function patch(key: string, fn: (s: ConvState) => ConvState): ConvState {
  const next = fn(ensureEntry(key));
  entries.set(key, next);
  notifyConv(key);
  return next;
}

/** 事件归属：主进程所有 agent 事件都带 conversationId；极少数不带（续跑失败推的空串）退回当前视图 */
function keyOf(conversationId?: string): string {
  return conversationId && conversationId.length > 0 ? conversationId : activeKey;
}

// ── 事件处理（模块级注册，页面卸载后继续累积）────────────────

interface ChunkEv { conversationId?: string; delta?: string }
interface DoneEv { conversationId?: string; usage?: Msg["usage"]; capped?: boolean }
interface ErrorEv { conversationId?: string; message?: string }
interface ToolEv {
  conversationId?: string; tool?: string; callId?: string; status?: string;
  args?: string; result?: string; delta?: string; failed?: boolean;
}
interface PlanEv { conversationId?: string; items?: PlanStep[] }
interface ApprovalEv {
  conversationId?: string; approvalId?: string; items?: ApprovalReq["items"];
}

/** 封口在途思考卡（done / error / 整块 reasoning 三个入口共用） */
function sealReasoning(s: ConvState, full?: string): ConvState {
  const key = s.liveReasoning;
  if (!key) return s;
  const messages = s.messages.map(m => (m.key === key && m.chip
    ? { ...m, chip: { ...m.chip, live: false, detail: pickText(full, m.chip.detail) } }
    : m));
  return { ...s, messages, liveReasoning: null };
}
const pickText = (a?: string, b?: string): string => ((a && a.length >= (b?.length ?? 0)) ? a : b ?? a ?? "");

function onChunk(d: ChunkEv): void {
  const key = keyOf(d.conversationId);
  const delta = d.delta ?? "";
  if (!delta) return;
  patch(key, s => {
    const msgs = [...s.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "ai" && m.streaming) {
        msgs[i] = { ...m, loading: false, content: m.content + delta };
        return { ...s, messages: msgs, turnText: s.turnText + delta };
      }
    }
    // 没有骨架气泡（条目由事件建起来 / 极端竞态）→ 自愈开一条，增量绝不丢
    return {
      ...s,
      messages: [...msgs, { key: nextKey(), role: "ai" as const, content: delta, streaming: true }],
      turnText: s.turnText + delta,
    };
  });
}

function onDone(d: DoneEv): void {
  const key = keyOf(d.conversationId);
  const u = d.usage;
  const queued = entries.get(key)?.queued ?? null;
  const gen = entries.get(key)?.flushGen ?? 0;
  patch(key, s => {
    let next: ConvState = sealReasoning(s);
    const msgs = next.messages.map(m => (m.streaming ? { ...m, streaming: false, loading: false } : m));
    if (u) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === "ai") { msgs[i] = { ...msgs[i]!, usage: u }; break; }
      }
    }
    next = {
      ...next,
      messages: msgs,
      sending: false,
      followUps: ruleFollowUps(s.turnTools),
      turnTools: [],
      queued: queued ? null : s.queued,
      ...(queued ? {} : { budgetAsk: !!d.capped }),   // 排了下一条就不打扰
      ...(u ? { sessionUsage: { input: (s.sessionUsage?.input ?? 0) + (u.input ?? 0), output: (s.sessionUsage?.output ?? 0) + (u.output ?? 0) } } : {}),
    };
    return next;
  });
  // 排队输入：本轮收尾后发出下一条（done 落定再发，120ms 让 sending 先落到 UI）
  if (queued) {
    setTimeout(() => {
      if ((entries.get(key)?.flushGen ?? 0) !== gen) return;   // 期间停止 / 切会话 → 放弃
      void send(key, queued);
    }, 120);
  }
  // 追问引导：规则版已先占位，再让 AI 覆盖（代数守卫，迟到结果不盖新一轮）
  const cur = entries.get(key);
  const userText = cur?.turnUser ?? "";
  const aiText = cur?.turnText ?? "";
  const followGen = cur?.followGen ?? 0;
  if (aiText.trim()) {
    void (async () => {
      const r = await window.api.invoke("ai:followUps", { userText, aiText }) as { success: boolean; data?: string[] };
      const now = entries.get(key);
      if (!now || now.followGen !== followGen) return;
      if (r?.success && Array.isArray(r.data) && r.data.length) patch(key, s => ({ ...s, followUps: r.data!.slice(0, 3) }));
    })();
  }
  window.dispatchEvent(new Event(CONVS_CHANGED));
}

function ruleFollowUps(tools: string[]): string[] {
  const used = [...new Set(tools)];
  if (used.length === 0) return DEFAULT_FOLLOW_UPS;
  const picked = used.slice(0, 2).flatMap(t => followUpsOf(t)).slice(0, 3);
  return picked.length ? picked : DEFAULT_FOLLOW_UPS;   // 注册表未就绪时不留空
}

function onErrorEv(d: ErrorEv): void {
  const key = keyOf(d.conversationId);
  const message = d.message || "生成失败";
  patch(key, s => {
    const sealed = sealReasoning(s);
    const msgs = [...sealed.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "ai" && m.streaming) {
        msgs[i] = { ...m, streaming: false, loading: false, error: true, content: message };
        return { ...sealed, messages: msgs, sending: false, queued: null, budgetAsk: false, flushGen: sealed.flushGen + 1 };
      }
    }
    // 没有骨架气泡可挂（空列表 / 已被封口）→ 另起一条错误气泡，错误信息绝不吞掉
    return {
      ...sealed,
      messages: [...msgs, { key: nextKey(), role: "ai" as const, content: message, error: true }],
      sending: false, queued: null, budgetAsk: false, flushGen: sealed.flushGen + 1,
    };
  });
  window.dispatchEvent(new Event(CONVS_CHANGED));
}

function onToolCall(d: ToolEv): void {
  const key = keyOf(d.conversationId);
  patch(key, s => {
    if (d.status === "reasoning_delta") {
      const open = s.liveReasoning;
      if (open) {
        const messages = s.messages.map(m => {
          if (m.key !== open || !m.chip) return m;
          const grew = (m.chip.detail ?? "") + (d.delta ?? "");
          return { ...m, chip: { ...m.chip, detail: grew.length > REASONING_CAP ? grew.slice(-REASONING_CAP) : grew } };
        });
        return { ...s, messages };
      }
      const chip: Msg = {
        key: nextKey(), role: "tool", content: "",
        chip: { kind: "reasoning", tool: "reasoning", callId: d.callId, detail: d.delta ?? "", live: true },
      };
      return { ...s, liveReasoning: chip.key, messages: insertBeforeStreamingBubble(s.messages, chip) };
    }
    if (d.status === "reasoning") {
      // 整块定稿：有在途卡就封口（取更长的一份），没有则单独插一张
      if (s.liveReasoning) return sealReasoning(s, d.result);
      const chip: Msg = {
        key: nextKey(), role: "tool", content: "",
        chip: { kind: "reasoning", tool: "reasoning", callId: d.callId, detail: d.result },
      };
      return { ...s, messages: insertBeforeStreamingBubble(s.messages, chip) };
    }
    if (d.status === "calling") {
      const chip: Msg = {
        key: nextKey(), role: "tool", content: "",
        chip: { kind: "calling", tool: d.tool, callId: d.callId, args: fmtChipArgs(d.args) },
      };
      return {
        ...s,
        turnTools: d.tool ? [...s.turnTools, d.tool] : s.turnTools,
        messages: insertBeforeStreamingBubble(s.messages, chip),
      };
    }
    // done：先按 callId 精确配对（同名连发/并行不会错配），端点没给 callId 时退回同名倒找
    const next = [...s.messages];
    let idx = d.callId
      ? next.findIndex(m => m.role === "tool" && m.chip?.kind === "calling" && m.chip.callId === d.callId)
      : -1;
    if (idx < 0) {
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i]!;
        if (m.role === "tool" && m.chip?.kind === "calling" && m.chip.tool === d.tool) { idx = i; break; }
      }
    }
    if (idx < 0) return s;
    const prevChip = next[idx]!.chip!;
    next[idx] = {
      ...next[idx]!, ts: Date.now(),
      chip: {
        kind: "done", tool: d.tool, callId: d.callId ?? prevChip.callId, args: prevChip.args,
        brief: resultBrief(d.result), detail: d.result,
        failed: d.failed || undefined,
      },
    };
    return { ...s, messages: next };
  });
}

function onPlan(d: PlanEv): void {
  const key = keyOf(d.conversationId);
  const steps = Array.isArray(d.items) ? d.items : [];
  patch(key, s => {
    const prev = s.messages;
    let turnStart = 0;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]!.role === "user") { turnStart = i + 1; break; }
    }
    let idx = -1;
    for (let i = prev.length - 1; i >= turnStart; i--) {
      if (prev[i]!.plan) { idx = i; break; }
    }
    if (idx < 0) {
      return steps.length
        ? { ...s, messages: insertBeforeStreamingBubble(prev, { key: nextKey(), role: "tool", content: "", plan: steps }) }
        : s;
    }
    if (!steps.length) return { ...s, messages: prev.filter((_, i) => i !== idx) };   // 空快照 → 清单收起
    const next = [...prev];
    next[idx] = { ...next[idx]!, plan: steps };
    return { ...s, messages: next };
  });
}

function onApproval(d: ApprovalEv): void {
  const key = keyOf(d.conversationId);
  patch(key, s => ({
    ...s,
    approval: { approvalId: d.approvalId ?? "", conversationId: d.conversationId, items: d.items ?? [] },
    // 续跑的增量要落到一条新骨架气泡上（本轮回答还没结束，气泡不能少）
    messages: [...s.messages, { key: nextKey(), role: "ai" as const, content: "", loading: true, streaming: true }],
  }));
}

/** 首次用到时挂上监听：整个应用生命周期内不注销，页面卸载也继续收事件 */
function ensureListening(): void {
  if (listening) return;
  listening = true;
  void ensureToolMeta();   // 工具中文名/追问引导：注册表派生，幂等拉取
  window.api.on("agent:chunk", d => onChunk(d as ChunkEv));
  window.api.on("agent:done", d => onDone(d as DoneEv));
  window.api.on("agent:error", d => onErrorEv(d as ErrorEv));
  window.api.on("agent:toolCall", d => onToolCall(d as ToolEv));
  window.api.on("agent:plan", d => onPlan(d as PlanEv));
  window.api.on("agent:approval", d => onApproval(d as ApprovalEv));
}

// ── DB 历史 → messages ──────────────────────────────────

interface DbRow {
  role: string; content: string; toolName?: string; argsJson?: string; resultJson?: string;
  /** 审计行的 error 列：带值 = 这次工具调用没办成，回放画失败态 */
  error?: string; createdAt?: string;
}

function mapHistory(rows: DbRow[]): Msg[] {
  return rows.map(m => {
    if (m.role === "user") return { key: nextKey(), role: "user" as const, content: m.content };
    if (m.role === "error") return { key: nextKey(), role: "ai" as const, content: m.content, error: true };
    if (m.role === "tool") {
      // 审计回放：重建为已完成的工具过程卡（产物/表格/草稿卡由 detail 复活）
      return {
        key: nextKey(), role: "tool" as const, content: "",
        ts: m.createdAt ? Date.parse(m.createdAt.includes("T") ? m.createdAt : `${m.createdAt.replace(" ", "T")}Z`) : undefined,
        chip: {
          kind: "done" as const, tool: m.toolName,
          args: fmtChipArgs(m.argsJson), brief: resultBrief(m.resultJson), detail: m.resultJson,
          failed: !!m.error || undefined,
        },
      };
    }
    return { key: nextKey(), role: "ai" as const, content: m.content };
  });
}

/** 装历史（只在没有缓存时真读库）；切页回来命中缓存直接沿用 —— 这就是气泡不再消失的落点 */
async function loadHead(key: string): Promise<void> {
  if (key === NEW_KEY) { patch(key, s => ({ ...s, loaded: true })); return; }
  const cur = entries.get(key);
  if (!cur || cur.loaded) return;
  const token = (loadTokens.get(key) ?? 0) + 1;
  loadTokens.set(key, token);
  patch(key, s => ({ ...s, loading: true }));
  const r = await window.api.invoke("agent:getConversation", key) as IpcResult<DbRow[]>;
  if ((loadTokens.get(key) ?? 0) !== token) return;          // 期间已重开/删除 → 丢过期响应
  if (!entries.has(key)) return;
  patch(key, s => {
    if (s.loaded) return s;
    const head = r?.success && r.data ? mapHistory(r.data) : [];
    const tail = s.messages;
    if (!tail.length || !s.sending) return { ...s, messages: head, loaded: true, loading: false };
    // 回合在途：库里最新一条就是本轮 user 消息，尾部丢掉它及之前，避免重复气泡
    const firstUser = tail.findIndex(m => m.role === "user");
    return { ...s, messages: [...head, ...(firstUser < 0 ? tail : tail.slice(firstUser + 1))], loaded: true, loading: false };
  });
}

// ── 对新草稿定住 id：条目改键 + 路由跟上 ───────────────────

function migrateTo(from: string, id: string): string {
  const s = entries.get(from);
  if (s) {
    entries.delete(from);
    const i = lru.indexOf(from);
    if (i >= 0) lru.splice(i, 1);
    entries.set(id, { ...s, id, loaded: true });
  }
  if (activeKey === from) activeKey = id;
  notifyConv(from);
  touchLru(id);
  gotoConversation(id);
  notifyShell();
  return id;
}

// ── 对外 API ────────────────────────────────────────────

/** 发起一轮对话（含新草稿定 id）。运行中的重复提交由调用方挡在排队逻辑里。 */
export async function send(key: string, raw: string): Promise<void> {
  ensureListening();
  const text = raw.trim();
  if (!text) return;
  let k = key;
  const entry = ensureEntry(k);
  if (!entry.id) {
    k = migrateTo(k, crypto.randomUUID());
  } else {
    k = entry.id;
    if (activeKey !== k) { activeKey = k; notifyShell(); }
  }
  const id = k;
  const aiKey = nextKey();
  patch(k, s => ({
    ...s,
    sending: true, loaded: true, budgetAsk: false, followUps: [],
    turnUser: text, turnText: "", turnTools: [], followGen: s.followGen + 1,
    messages: [
      ...s.messages,
      { key: nextKey(), role: "user" as const, content: text },
      { key: aiKey, role: "ai" as const, content: "", loading: true, streaming: true },
    ],
  }));
  const r = await window.api.invoke("agent:chat", {
    conversationId: id, text, context: entries.get(k)?.ctx,
  }) as IpcResult<{ conversationId: string; messageId: string }>;
  if (!r?.success) {
    patch(k, s => ({
      ...s, sending: false,
      messages: s.messages.map(m => (m.key === aiKey
        ? { ...m, streaming: false, loading: false, error: true, content: r?.error || "发起失败" }
        : m)),
    }));
    return;
  }
  window.dispatchEvent(new Event(CONVS_CHANGED));   // 新会话立即可见（标题已在主进程生成）
}

/** 排队输入（单槽）：本轮 done 后自动发出 */
export function enqueue(key: string, text: string): void {
  patch(key, s => ({ ...s, queued: text }));
}

export function clearQueued(key: string): void {
  patch(key, s => ({ ...s, queued: null }));
}

/** 中断本会话生成（其他会话的回合不受影响） */
export function stop(key: string): void {
  const s = entries.get(key);
  if (!s) return;
  patch(key, prev => ({
    ...prev, approval: null, queued: null, budgetAsk: false, flushGen: prev.flushGen + 1,
  }));
  if (s.id) void window.api.invoke("agent:stop", s.id);
}

/** 写操作审批结论：确认/拒绝后等续跑的流（done 收尾） */
export async function resolveApproval(key: string, approved: boolean, rememberTool?: string): Promise<void> {
  const a = entries.get(key)?.approval;
  if (!a) return;
  patch(key, s => ({ ...s, approval: null }));
  const r = await window.api.invoke("agent:resolveApproval", {
    approvalId: a.approvalId, approved, rememberTool,
  }) as IpcResult<{ resumed: boolean }>;
  if (!r?.success) {
    pushLocal(key, { key: nextKey(), role: "tool", content: `审批失败：${r?.error || "未知错误"}` });
    patch(key, s => ({ ...s, sending: false }));
  }
}

/** 就地追加一条本地行（斜杠命令回执、动作执行回执） */
export function pushLocal(key: string, msg: Msg): void {
  patch(key, s => ({ ...s, messages: [...s.messages, msg] }));
}

export function pushLocalText(key: string, content: string, error?: boolean): void {
  pushLocal(key, { key: nextKey(), role: "tool", content, ...(error ? { error } : {}) });
}

export function markAction(key: string, actionId: string, stamp: string): void {
  patch(key, s => ({ ...s, doneActions: { ...s.doneActions, [actionId]: stamp } }));
}

export function setBudgetAsk(key: string, on: boolean): void {
  patch(key, s => ({ ...s, budgetAsk: on }));
}

export function setCtx(key: string, ctx: string | undefined): void {
  patch(key, s => (s.ctx === ctx ? s : { ...s, ctx }));
}

/** 清掉「接下来可以问」引导（点了一条准备再问时） */
export function clearFollowUps(key: string): void {
  patch(key, s => ({ ...s, followUps: [] }));
}

/**
 * 切换活动会话（挂载与 hashchange 都走这里）。
 * 同一会话的重复导航直接早退 —— 自家 send 写 hash 引起的回环不会清空现场。
 */
export function navigate(id: string | undefined, ctxFromHash?: string): void {
  ensureListening();
  const key = id || NEW_KEY;
  if (navigated && key === activeKey) {
    if (ctxFromHash) setCtx(key, ctxFromHash);
    return;
  }
  navigated = true;
  activeKey = key;
  ensureEntry(key);
  // 换会话：上下文 chip 跟随 hash（不带就清），与改造前一致
  setCtx(key, ctxFromHash);
  notifyShell();
  void loadHead(key);
}

/** 会话删除：连带丢掉缓存条目（导航栏调用） */
export function drop(key: string): void {
  entries.delete(key);
  const i = lru.indexOf(key);
  if (i >= 0) lru.splice(i, 1);
  loadTokens.delete(key);
  notifyConv(key);
}

/** 新草稿复位（/新对话：不中断任何在途回合） */
export function resetDraft(): void {
  drop(NEW_KEY);
  ensureEntry(NEW_KEY);
  if (activeKey !== NEW_KEY) { activeKey = NEW_KEY; notifyShell(); }
}

export function getConv(key: string): ConvState {
  return entries.get(key) ?? BLANK;
}

function subscribeConv(key: string, cb: () => void): () => void {
  let set = convListeners.get(key);
  if (!set) { set = new Set(); convListeners.set(key, set); }
  set.add(cb);
  return () => { set!.delete(cb); };
}

function subscribeShell(cb: () => void): () => void {
  shellListeners.add(cb);
  return () => { shellListeners.delete(cb); };
}

// ── Hooks ───────────────────────────────────────────────

/** 当前视图看的是哪份现场 */
export function useActiveConvKey(): string {
  return useSyncExternalStore(subscribeShell, () => activeKey);
}

/** 某会话的现场快照（未变更期间引用恒定） */
export function useConvState(key: string): ConvState {
  return useSyncExternalStore(cb => subscribeConv(key, cb), () => getConv(key));
}

/** 正在跑回合的会话（导航栏呼吸点；在任何页面都能看出 agent 还在干活） */
export function useRunningConvIds(): string[] {
  return useSyncExternalStore(subscribeShell, () => runningIds);
}
