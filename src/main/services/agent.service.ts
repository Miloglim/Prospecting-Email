import * as path from "path";
import * as crypto from "crypto";
import OpenAI from "openai";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { EVENTS } from "../events";

// .env 加载（与 ai.service 同源，dotenv 幂等，双处调用无冲突）
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(APP_ROOT, ".env") });

/** 主进程 → 渲染进程事件推送器（由 transport 层注入，service 不 import electron） */
export type PushFn = (channel: string, data: unknown) => void;

// ── 会话内存储（Step 1：内存态；Step 2 落库 conversations/messages 两张表） ──

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Session {
  messages: ChatMsg[];
  abort: AbortController | null;
  running: boolean;
}

const sessions = new Map<string, Session>();

const SYSTEM_PROMPT = [
  "你是 Prospector 桌面客户端里的 AI 业务助手，服务对象是国际货代行业的销售。",
  "你运行在客户的本地工作台中，后续会逐步接入联系人、客户跟进、邮件队列等工具。",
  "回答风格：简洁、专业、中文优先（用户是中文使用者，涉及邮件文案时按其要求语言输出）。",
  "当前阶段你只能对话，无法读取或修改程序数据。回答涉及客户数据的问题时，先说明你还没有接入数据工具，不要编造任何数字。",
].join("\n");

/** 历史上文裁剪：仅带最近 N 条（含本轮 user 之前的），防上下文膨胀 */
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
  const model = (process.env.AGENT_MODEL || "").trim() || "deepseek-chat";
  if (baseUrl && apiKey) return { mode: "live", baseUrl, apiKey, model };
  return { mode: "mock", baseUrl, apiKey, model };
}

/** 配置状态（不含密钥值），供 UI 显示模式横幅 */
export function status(): Result<{ mode: "mock" | "live"; model: string; hasBaseUrl: boolean; hasKey: boolean }> {
  const c = getProviderConfig();
  return okResult({ mode: c.mode, model: c.model, hasBaseUrl: !!c.baseUrl, hasKey: !!c.apiKey });
}

// ── Mock Provider：无密钥时模拟流式，用于打通/演示链路 ────

async function streamMock(sessionId: string, userText: string, push: PushFn, signal: AbortSignal): Promise<string> {
  const full = [
    "（Mock 模式 — 尚未配置模型接口）",
    "",
    `我收到了你的消息：「${userText.slice(0, 200)}」，以下是模拟回复。`,
    "",
    "要在真实模型下运行，请在项目根目录 `.env` 中配置三项：",
    "",
    "```",
    "AGENT_API_BASE_URL=https://你的接口服务商/v1",
    "AGENT_API_KEY=你的密钥",
    "AGENT_MODEL=模型名",
    "```",
    "",
    "配置后重启应用，本条横幅即消失。当前流式渲染、停止按钮、会话历史均为真实链路。",
  ].join("\n");
  // 逐段推送，模拟打字机；每段检查中断
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
  const stream = await client.chat.completions.create({
    model: cfg.model,
    messages: history,
    stream: true,
    temperature: 0.3,
  }, { signal });

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

  let session = sessions.get(conversationId);
  if (!session) {
    session = { messages: [{ role: "system", content: SYSTEM_PROMPT }], abort: null, running: false };
    sessions.set(conversationId, session);
    Log.debug("agent.chat", `新会话 ${conversationId.slice(0, 8)}`);
  }
  if (session.running) return failResult("上一轮回答仍在进行中，请先停止");

  session.messages.push({ role: "user", content: text });
  const s = session;

  // 异步流式回合（不阻塞 IPC 返回）
  void (async () => {
    s.running = true;
    s.abort = new AbortController();
    const cfg = getProviderConfig();
    Log.debug("agent.chat", `回合开始 conv=${conversationId.slice(0, 8)} mode=${cfg.mode} 历史${s.messages.length}条`);
    try {
      const history: ChatMsg[] = [
        s.messages[0]!,
        ...s.messages.slice(1, -1).slice(-HISTORY_LIMIT),
        s.messages[s.messages.length - 1]!,
      ];
      const answer = cfg.mode === "live"
        ? await streamLive(cfg, history, push, conversationId, s.abort.signal)
        : await streamMock(conversationId, text, push, s.abort.signal);
      s.messages.push({ role: "assistant", content: answer });
      push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: s.abort.signal.aborted });
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
      s.running = false;
      s.abort = null;
    }
  })();

  return okResult({ conversationId, messageId });
}

/** 中断指定会话的生成。无进行中回合时也算成功（幂等）。 */
export function stop(conversationId: string): Result<void> {
  const s = sessions.get(conversationId);
  if (s?.abort) {
    Log.debug("agent.stop", conversationId.slice(0, 8));
    s.abort.abort();
  }
  return okResult(undefined);
}
