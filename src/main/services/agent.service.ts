import * as path from "path";
import * as crypto from "crypto";
import { eq, asc, desc } from "drizzle-orm";
import OpenAI from "openai";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { EVENTS } from "../events";
import { getDb, saveDatabase } from "../db";
import { agentConversations, agentMessages } from "../db/schema/agent";

// .env 加载（与 ai.service 同源，dotenv 幂等，双处调用无冲突）
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(APP_ROOT, ".env") });

/** 主进程 → 渲染进程事件推送器（由 transport 层注入，service 不 import electron） */
export type PushFn = (channel: string, data: unknown) => void;

// ── 会话存储：消息正文落库（agent_conversations / agent_messages），
//    运行态（中断控制器/防重入标志）仅存内存，重启自然清零 ──

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RuntimeState {
  abort: AbortController | null;
  running: boolean;
}

const runtime = new Map<string, RuntimeState>();

const SYSTEM_PROMPT = [
  "你是 Prospector 桌面客户端里的 AI 业务助手，服务对象是国际货代行业的销售。",
  "你运行在客户的本地工作台中，后续会逐步接入联系人、客户跟进、邮件队列等工具。",
  "回答风格：简洁、专业、中文优先（用户是中文使用者，涉及邮件文案时按其要求语言输出）。",
  "当前阶段你只能对话，无法读取或修改程序数据。回答涉及客户数据的问题时，先说明你还没有接入数据工具，不要编造任何数字。",
].join("\n");

/** 每次请求携带的历史条数上限（system 除外），防上下文膨胀 */
const HISTORY_LIMIT = 30;

// ── Provider 配置 ────────────────────────────────────────

interface ProviderConfig {
  mode: "mock" | "live";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 读取模型端点配置。live 需同时具备 BASE_URL + KEY；否则回落 mock。 */
function getProviderConfig(): ProviderConfig {
  const baseUrl = (process.env.AGENT_API_BASE_URL || "").trim();
  const apiKey = (process.env.AGENT_API_KEY || "").trim();
  const model = (process.env.AGENT_MODEL || "").trim();
  if (baseUrl && apiKey) return { mode: "live", baseUrl, apiKey, model: model || "gpt-4o-mini" };
  return { mode: "mock", baseUrl, apiKey, model };
}

/** 配置状态（不含密钥值），供 UI 显示模式横幅 */
export function status(): Result<{ mode: "mock" | "live"; model: string; hasBaseUrl: boolean; hasKey: boolean }> {
  const c = getProviderConfig();
  return okResult({ mode: c.mode, model: c.model, hasBaseUrl: !!c.baseUrl, hasKey: !!c.apiKey });
}

// ── 会话读写 ─────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

/** 会话不存在则创建，标题取首条用户消息前 24 字（豆包式自动命名） */
function ensureConversation(id: string, firstUserText: string): void {
  const db = getDb();
  const existing = db.select().from(agentConversations).where(eq(agentConversations.id, id)).get();
  if (existing) return;
  const title = firstUserText.replace(/\s+/g, " ").trim().slice(0, 24) || "新对话";
  const now = nowIso();
  db.insert(agentConversations).values({ id, title, createdAt: now, updatedAt: now }).run();
  saveDatabase();
}

function appendMessage(convId: string, role: "user" | "assistant", content: string): void {
  const db = getDb();
  db.insert(agentMessages).values({ conversationId: convId, role, content, createdAt: nowIso() }).run();
  db.update(agentConversations).set({ updatedAt: nowIso() }).where(eq(agentConversations.id, convId)).run();
  saveDatabase();
}

/** 读会话消息（asc），仅带最近 HISTORY_LIMIT 条进上下文 */
function loadHistory(convId: string): ChatMsg[] {
  const rows = getDb().select().from(agentMessages)
    .where(eq(agentMessages.conversationId, convId))
    .orderBy(asc(agentMessages.id)).all();
  return rows.slice(-HISTORY_LIMIT).map(r => ({ role: r.role as "user" | "assistant", content: r.content }));
}

// ── Mock Provider：端点未配置时模拟流式，用于打通/演示链路 ──

async function streamMock(sessionId: string, userText: string, push: PushFn, signal: AbortSignal): Promise<string> {
  const full = [
    "（Mock 模式 — 模型端点未生效）",
    "",
    `我收到了你的消息：「${userText.slice(0, 200)}」，以下是模拟回复。`,
    "",
    "真实模型需在项目根目录 `.env` 配置三项（BASE_URL + KEY 缺一即回落 Mock）：",
    "",
    "```",
    "AGENT_API_BASE_URL=https://你的服务商/v1",
    "AGENT_API_KEY=密钥",
    "AGENT_MODEL=模型名",
    "```",
    "",
    "配置后重启应用即可。当前流式渲染、停止按钮、会话持久化均为真实链路。",
  ].join("\n");
  for (let i = 0; i < full.length; i += 6) {
    if (signal.aborted) return full.slice(0, i);
    push(EVENTS.AGENT_CHUNK, { conversationId: sessionId, delta: full.slice(i, i + 6) });
    await new Promise(r => setTimeout(r, 20));
  }
  return full;
}

// ── Live Provider：OpenAI 兼容端点流式对话 ────────────────

async function streamLive(
  cfg: ProviderConfig, history: ChatMsg[], push: PushFn, sessionId: string, signal: AbortSignal,
): Promise<string> {
  const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: 90_000, maxRetries: 1 });
  // ponytail: chat_template_kwargs.enable_thinking=false 是 agnes 端点的扩展字段
  // （官方文档"Thinking"章节）— agnes-2.0-flash 默认先思考再答，聊天场景首字延迟
  // 高达数十秒；关闭后实测 reasoning_tokens 归零、首字时间大幅提前。
  // SDK 类型不含该字段，走 options.body 合并进请求体（官方推荐的扩展字段注入方式）。
  const stream = await client.chat.completions.create({
    model: cfg.model,
    messages: history,
    stream: true,
    temperature: 0.3,
    max_tokens: 2000,
  }, {
    signal,
    body: { chat_template_kwargs: { enable_thinking: false } },
  });

  let full = "";
  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      push(EVENTS.AGENT_CHUNK, { conversationId: sessionId, delta });
    }
  }
  return full;
}

// ── 对外：发起对话 / 停止 ─────────────────────────────────

export interface ChatInput {
  conversationId?: string;
  text: string;
}

/** 发起一轮对话。立即返回会话/消息 ID，正文与结束/错误状态走事件推送。 */
export function chat(push: PushFn, input: ChatInput): Result<{ conversationId: string; messageId: string }> {
  const text = input?.text?.trim();
  if (!text) return failResult("参数错误: text 必填");

  const conversationId = input.conversationId?.trim() || crypto.randomUUID();
  const messageId = crypto.randomUUID();

  ensureConversation(conversationId, text);
  appendMessage(conversationId, "user", text);

  let rt = runtime.get(conversationId);
  if (!rt) { rt = { abort: null, running: false }; runtime.set(conversationId, rt); }
  if (rt.running) return failResult("上一轮回答仍在进行中，请先停止");
  const state = rt;

  // 异步流式回合（不阻塞 IPC 返回）
  void (async () => {
    state.running = true;
    state.abort = new AbortController();
    const cfg = getProviderConfig();
    Log.debug("agent.chat", `回合开始 conv=${conversationId.slice(0, 8)} mode=${cfg.mode}`);
    try {
      const history: ChatMsg[] = [{ role: "system", content: SYSTEM_PROMPT }, ...loadHistory(conversationId)];
      const answer = cfg.mode === "live"
        ? await streamLive(cfg, history, push, conversationId, state.abort.signal)
        : await streamMock(conversationId, text, push, state.abort.signal);
      if (answer) appendMessage(conversationId, "assistant", answer);
      push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: state.abort.signal.aborted });
    } catch (err: unknown) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (aborted) {
        push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: true });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        Log.error("agent.chat", `模型调用失败 ${cfg.mode}`, err instanceof Error ? (err.stack ?? msg) : msg);
        push(EVENTS.AGENT_ERROR, { conversationId, message: cfg.mode === "live" ? `模型调用失败: ${msg}` : msg });
      }
    } finally {
      state.running = false;
      state.abort = null;
    }
  })();

  return okResult({ conversationId, messageId });
}

/** 中断指定会话的生成。无进行中回合时也算成功（幂等）。 */
export function stop(conversationId: string): Result<void> {
  const rt = runtime.get(conversationId);
  if (rt?.abort) {
    Log.debug("agent.stop", conversationId.slice(0, 8));
    rt.abort.abort();
  }
  return okResult(undefined);
}

// ── 会话管理（左侧历史列表）──────────────────────────────

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function listConversations(): Result<ConversationMeta[]> {
  const rows = getDb().select().from(agentConversations)
    .orderBy(desc(agentConversations.updatedAt)).all();
  return okResult(rows.map(r => ({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt })));
}

export interface MessageDto { role: string; content: string; createdAt: string }

export function getMessages(conversationId: string): Result<MessageDto[]> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const rows = getDb().select().from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.id)).all();
  return okResult(rows.map(r => ({ role: r.role, content: r.content, createdAt: r.createdAt })));
}

export function renameConversation(conversationId: string, title: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const t = title?.trim();
  if (!t) return failResult("标题不能为空");
  const db = getDb();
  const existing = db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)).get();
  if (!existing) return failResult(`会话不存在: ${conversationId.slice(0, 8)}`);
  db.update(agentConversations).set({ title: t.slice(0, 60), updatedAt: nowIso() })
    .where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  Log.debug("agent.rename", `${conversationId.slice(0, 8)} → ${t.slice(0, 20)}`);
  return okResult(undefined);
}

export function deleteConversation(conversationId: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const db = getDb();
  db.delete(agentMessages).where(eq(agentMessages.conversationId, conversationId)).run();
  db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  runtime.delete(conversationId);
  Log.debug("agent.delete", conversationId.slice(0, 8));
  return okResult(undefined);
}
