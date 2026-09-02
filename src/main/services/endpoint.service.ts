// ── 生效端点解析（唯一入口）───────────────────────────────────
// 谁在读模型配置：agent 会话（harness）、能力调用（背调/开发信/总结）。
// 过去两处各自读 env，容易出现"会话切了新端点、背调还在用旧 key"。现在统一走这里。
//
// 密钥存放规则（红线：只进 .env，不进库、不进对话、不回传渲染端）：
//   AGENT_KEY_ENV=PROVIDER_KEY_<ID>   ← 激活某个 profile 时写入的「指针」
//   PROVIDER_KEY_<ID>=sk-xxx          ← 该 profile 的密钥本体
//   AGENT_API_KEY=sk-xxx              ← 兼容旧的手写配置（无指针时回落它）
// 解析优先级：指针指向的密钥 > AGENT_API_KEY > 旧 DEEPSEEK_API_KEY（仅能力调用回落）。
import { Log } from "../logger";

export interface ActiveEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking: boolean;
  /** profile=界面激活的端点 / legacy=.env 手写 / none=未配置 */
  source: "profile" | "legacy" | "none";
}

const truthy = (v: string) => ["1", "true", "on", "yes"].includes(v.toLowerCase());

export function readActiveEndpoint(): ActiveEndpoint {
  const baseUrl = (process.env.AGENT_API_BASE_URL || "").trim();
  const model = (process.env.AGENT_MODEL || "").trim();
  const keyEnv = (process.env.AGENT_KEY_ENV || "").trim();
  const pointed = keyEnv ? (process.env[keyEnv] || "").trim() : "";
  const legacy = (process.env.AGENT_API_KEY || "").trim();
  const apiKey = pointed || legacy;
  const thinking = truthy((process.env.AGENT_THINKING || "").trim());
  const source: ActiveEndpoint["source"] = !baseUrl || !apiKey
    ? "none"
    : (pointed && keyEnv) ? "profile" : "legacy";
  if (source === "none" && (baseUrl || legacy) && process.env.AGENT_DEBUG_ENDPOINT) {
    Log.debug("endpoint", `未就绪 baseUrl=${!!baseUrl} key=${!!legacy}`);
  }
  return { baseUrl, apiKey, model, thinking, source };
}

/** 端点是否可用于 live 对话（缺 base 或 key 一律回落 Mock） */
export function isLiveEndpoint(e: ActiveEndpoint = readActiveEndpoint()): boolean {
  return !!(e.baseUrl && e.apiKey);
}

// ── 端点族识别与思考开关的参数方言 ───────────────────────────
// 各家对「非标准请求体字段」的容忍度不同：vLLM/agnes 认 chat_template_kwargs，
// Ollama 认 chat_template_kwargs.thinking，Google 的 OpenAI 兼容层只认自己的
// google.thinking_config —— 给 Google 塞 chat_template_kwargs 有被判 400 的风险。
// 所以注入必须按族走，不能一把梭。
export type EndpointFamily = "google" | "ollama" | "openai" | "compat";

export function endpointFamily(baseUrl: string): EndpointFamily {
  const u = (baseUrl || "").toLowerCase();
  if (u.includes("generativelanguage.googleapis.com")) return "google";
  if (/localhost|127\.0\.0\.1|:11434/.test(u)) return "ollama";
  if (u.includes("api.openai.com") || u.includes(".openai.azure.com") || u.includes("api.azure.com")) return "openai";
  return "compat";   // agnes / vLLM / 自建 OpenAI 兼容网关
}

/**
 * 要合并进请求体的额外字段（按族 + 按思考开关）。
 * thinking=false 时尽力关掉推理换首字速度；关不掉也不能把请求搞坏。
 */
export function thinkingExtras(family: EndpointFamily, thinking: boolean): Record<string, unknown> {
  switch (family) {
    case "google":
      // 实测（.trash 探针）：Gemini 的 OpenAI 兼容层对顶层 google / thinking_budget /
      // generation_config 一律判 400「Unknown name」，没有可用的思考控制字段。
      // 所以这里不注入任何东西；推理由端点自己决定，工具回合改走非流式（见 harness）来
      // 保住 thought_signature —— 那才是它在兼容层下的真正约束。
      return {};
    case "ollama":
      return { chat_template_kwargs: { thinking } };
    case "openai":
      // OpenAI 自家不认这些扩展键；推理强度另用 reasoning_effort 表达
      return thinking ? { reasoning_effort: "low" } : {};
    default:
      // vLLM/agnes：enable_thinking（flash 系）与 thinking（pro 系）混发，jinja 模板忽略未知键
      return { chat_template_kwargs: { enable_thinking: thinking, thinking } };
  }
}

/** 供 UI 展示的安全视图（绝不含密钥值） */
export function endpointView(e: ActiveEndpoint = readActiveEndpoint()):
  { hasBaseUrl: boolean; hasKey: boolean; baseUrl: string; model: string; thinking: boolean; source: ActiveEndpoint["source"]; keyEnv: string } {
  return {
    hasBaseUrl: !!e.baseUrl,
    hasKey: !!e.apiKey,
    baseUrl: e.baseUrl,
    model: e.model,
    thinking: e.thinking,
    source: e.source,
    keyEnv: (process.env.AGENT_KEY_ENV || "").trim(),
  };
}
