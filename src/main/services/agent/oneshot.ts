// ── 一次性 JSON 解析调用（轻量模型入口）─────────────────────────────────
// 与 runHarnessTurn 的区别：不进会话、不落 transcript、不带工具、不推事件、不要审批。
// 只承担一件事：把用户的一句自然语言翻成结构化参数（首页「自动开发信」的要求输入框）。
// 红线：名单由确定性规则选出（dev-letter.service），模型不决定选谁、也不发任何东西
//       （docs/home-cards-spec.md §5-3 + docs/task-card-devletter-spec.md §4）。
import OpenAI from "openai";
import { readActiveEndpoint } from "../endpoint.service";
import { netFetch } from "../../net-proxy";
import { Log } from "../../logger";

/** 模型端点是否可用（UI 要如实告诉用户"这次是关键词理解的"） */
export function onceModelReady(): boolean {
  try {
    const e = readActiveEndpoint();
    return !!(e.baseUrl && e.apiKey);
  } catch { return false; }
}

/**
 * 要一段严格 JSON 回来。任何失败（没配端点 / 网络 / 解析不出）一律返回 null，
 * 由调用方走确定性兜底——绝不因为"模型没听懂"就把用户的整条要求丢掉。
 */
export async function askJsonOnce<T>(system: string, user: string, timeoutMs = 20_000): Promise<T | null> {
  const e = readActiveEndpoint();
  if (!e.baseUrl || !e.apiKey) return null;
  // fetch 注入形状照 harness.ts：走 netFetch（设置里配了代理就经它出去，海外端点必须经代理）
  const fetchImpl: typeof fetch = async (url, init) =>
    (await netFetch(url as string, init as RequestInit)) as Response;
  const client = new OpenAI({ baseURL: e.baseUrl, apiKey: e.apiKey, timeout: timeoutMs, maxRetries: 1, fetch: fetchImpl });
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  try {
    const r = await client.chat.completions.create({
      model: e.model, temperature: 0, max_tokens: 400, messages,
      response_format: { type: "json_object" },
    });
    const hit = looseJson<T>(r.choices?.[0]?.message?.content ?? "");
    if (hit) return hit;
    throw new Error("返回里没有 JSON");
  } catch (err) {
    // 部分网关不认 response_format：去掉它再试一次；仍失败就交回调用方兜底
    try {
      const r = await client.chat.completions.create({ model: e.model, temperature: 0, max_tokens: 400, messages });
      return looseJson<T>(r.choices?.[0]?.message?.content ?? "");
    } catch (e2) {
      Log.warn("llm.once", `一次性解析失败: ${(err as Error).message} / ${(e2 as Error).message}`);
      return null;
    }
  }
}

/** 容忍 ```json 围栏与前后废话：截第一个 { 到最后一个 } 再 parse */
export function looseJson<T>(s: string): T | null {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}
