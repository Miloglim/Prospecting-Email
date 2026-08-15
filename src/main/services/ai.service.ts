import * as path from "path";
import * as fs from "fs";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";

// ── .env 加载（dotenv：Node 不内置 .env 解析）──────────
// 密钥不落代码、不进对话，只从 .env 读。
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(APP_ROOT, ".env") });

/** 读取密钥；未配置时返回 null（不崩溃，由调用方提示） */
export function getApiKey(name: "DEEPSEEK_API_KEY" | "EXA_API_KEY" | "TAVILY_API_KEY"): string | null {
  const v = process.env[name]?.trim();
  if (!v) { Log.warn("ai.key", `${name} 未配置`); return null; }
  return v;
}

export function isAiConfigured(): boolean {
  return !!getApiKey("DEEPSEEK_API_KEY");
}

export const API_KEY_NAMES = ["DEEPSEEK_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

/** 查询各密钥配置状态（不返回明文，只返回是否已配置） */
export function getApiKeyStatus(): Result<Record<ApiKeyName, boolean>> {
  return okResult({
    DEEPSEEK_API_KEY: !!getApiKey("DEEPSEEK_API_KEY"),
    EXA_API_KEY: !!getApiKey("EXA_API_KEY"),
    TAVILY_API_KEY: !!getApiKey("TAVILY_API_KEY"),
  });
}

/** 写入 API 密钥到 .env。空值=清除。写后更新 process.env（本次会话立即生效）。 */
export function setApiKey(name: ApiKeyName, value: string): Result<void> {
  if (!API_KEY_NAMES.includes(name)) return failResult(`未知密钥名: ${name}`);
  const envPath = path.join(APP_ROOT, ".env");
  try {
    let lines: string[] = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    }
    const key = String(name);
    const idx = lines.findIndex(l => l.startsWith(`${key}=`));
    const newLine = value.trim() ? `${key}=${value.trim()}` : "";
    if (idx >= 0) {
      if (newLine) lines[idx] = newLine;
      else lines.splice(idx, 1);
    } else if (newLine) {
      lines.push(newLine);
    }
    // 保证文件存在
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(envPath, lines.filter(l => l.trim() !== "").join("\n") + "\n", "utf-8");
    // 更新 process.env 让本次会话立即生效
    if (value.trim()) process.env[key] = value.trim();
    else delete process.env[key];
    Log.info("ai.setKey", `${name} 已${value.trim() ? "更新" : "清除"}`);
    return okResult(undefined);
  } catch (err: unknown) {
    Log.error("ai.setKey", `写入 ${name} 失败`, err instanceof Error ? err.stack : String(err));
    return failResult("写入 .env 失败");
  }
}

// ── LLM 调用（DeepSeek，OpenAI 兼容）────────────────────

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** 调用 DeepSeek，返回纯文本。超时 60s。 */
async function chat(system: string, user: string): Promise<Result<string>> {
  const key = getApiKey("DEEPSEEK_API_KEY");
  if (!key) return failResult("DeepSeek API Key 未配置，请在 .env 中设置 DEEPSEEK_API_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      Log.error("ai.chat", `HTTP ${res.status}`, body.slice(0, 500));
      return failResult(`DeepSeek 调用失败 (${res.status})`);
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return failResult("DeepSeek 返回为空");
    return okResult(content);
  } catch (err: unknown) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    Log.error("ai.chat", aborted ? "超时" : "网络错误", err instanceof Error ? err.stack : String(err));
    return failResult(aborted ? "DeepSeek 请求超时（60s）" : "DeepSeek 网络错误");
  } finally {
    clearTimeout(timer);
  }
}

/** 调 DeepSeek 并要求返回 JSON，解析失败时给 fail */
async function chatJson<T>(system: string, user: string): Promise<Result<T>> {
  const r = await chat(system, user);
  if (!r.success) return r;
  try {
    // 兼容 DeepSeek 偶尔在 JSON 外包裹 ```json ... ``` 的情况
    const cleaned = r.data.replace(/```json|```/g, "").trim();
    return okResult(JSON.parse(cleaned) as T);
  } catch {
    Log.error("ai.json", "JSON 解析失败", r.data.slice(0, 500));
    return failResult("AI 返回格式不正确，请重试");
  }
}

// ── 搜索调用（背调数据源）────────────────────────────────
// 优先 Exa，其次 Tavily。两者都没配 → fail 提示。

const EXA_ENDPOINT = "https://api.exa.ai/search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function searchExa(query: string): Promise<Result<SearchHit[]>> {
  const key = getApiKey("EXA_API_KEY");
  if (!key) return failResult("EXA_API_KEY 未配置");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(EXA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: 8, contents: { text: { maxCharacters: 800 } } }),
      signal: controller.signal,
    });
    if (!res.ok) return failResult(`Exa 调用失败 (${res.status})`);
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
    return okResult((json.results || []).map(r => ({
      title: r.title || "", url: r.url || "",
      snippet: (r.text || "").slice(0, 800),
    })));
  } catch (err: unknown) {
    Log.error("ai.exa", "Exa 搜索失败", err instanceof Error ? err.stack : String(err));
    return failResult("Exa 搜索失败");
  } finally { clearTimeout(timer); }
}

async function searchTavily(query: string): Promise<Result<SearchHit[]>> {
  const key = getApiKey("TAVILY_API_KEY");
  if (!key) return failResult("TAVILY_API_KEY 未配置");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: 8 }),
      signal: controller.signal,
    });
    if (!res.ok) return failResult(`Tavily 调用失败 (${res.status})`);
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return okResult((json.results || []).map(r => ({
      title: r.title || "", url: r.url || "",
      snippet: (r.content || "").slice(0, 800),
    })));
  } catch (err: unknown) {
    Log.error("ai.tavily", "Tavily 搜索失败", err instanceof Error ? err.stack : String(err));
    return failResult("Tavily 搜索失败");
  } finally { clearTimeout(timer); }
}

/** 搜索公司资料：Exa 优先，失败/未配时尝试 Tavily */
export async function searchCompany(query: string): Promise<Result<SearchHit[]>> {
  const exa = await searchExa(query);
  if (exa.success && exa.data.length > 0) return exa;
  const tavily = await searchTavily(query);
  return tavily;
}

// ── 功能调用：背调报告 / 开发信 / 邮件总结 ────────────────

export interface BackcheckInput {
  companyName: string;
  website?: string;
  country?: string;
}

export interface BackcheckReport {
  summary: string;
  importActivity: string;   // 进口活跃度判断
  categories: string[];     // 主营品类
  logisticsFit: string;     // 货代契合点
  rating: number;           // 1-5
  risk: string[];           // 风险/注意点
  sources: Array<{ title: string; url: string }>;
}

export async function generateBackcheckReport(input: BackcheckInput, hits: SearchHit[]): Promise<Result<BackcheckReport>> {
  const sources = hits.map(h => ({ title: h.title, url: h.url }));
  const searchText = hits.map(h => `· ${h.title}\n${h.snippet}`).join("\n\n");
  const system = "你是资深货代销售分析师。根据搜索资料生成公司背调报告。只输出 JSON，不要任何额外文字。";
  const user = `公司：${input.companyName}\n网站：${input.website || "未知"}\n国家：${input.country || "未知"}\n\n搜索资料：\n${searchText || "（无）"}\n\n请输出 JSON：{"summary":"一句话总结","importActivity":"进口活跃度判断","categories":["主营品类"],"logisticsFit":"货代契合点（如何切入）","rating":1-5数字,"risk":["风险"],"sources":[{"title","url"}]}`;
  return chatJson<BackcheckReport>(system, user);
}

export interface EmailDraftInput {
  language: string; // EN / ES / PT
  companyName: string;
  contactName: string;
  backcheck?: BackcheckReport | null;
}

export async function generateEmailDraft(input: EmailDraftInput): Promise<Result<string>> {
  const lang = input.language === "ES" ? "西班牙语" : input.language === "PT" ? "葡萄牙语" : "英语";
  const system = `你是货代销售文案专家。用${lang}写一封给潜在客户的开发信，语气专业但不生硬，3-4 段，带主题行（用 SUBJECT: 开头）和正文。不要多余解释。`;
  const back = input.backcheck
    ? `\n背调要点：${input.backcheck.summary}；契合点：${input.backcheck.logisticsFit}`
    : "";
  const user = `公司：${input.companyName}\n联系人：${input.contactName}\n${back}\n\n请写开发信。`;
  return chat(system, user);
}

export interface EmailSummaryInput {
  fromName: string | null;
  fromEmail: string;
  subject: string | null;
  bodyPreview: string | null;
  matchedContactName?: string | null;
  matchedCompany?: string | null;
}

export interface EmailSummary {
  summary: string;
  nextStep: string;
}

export async function summarizeEmail(input: EmailSummaryInput): Promise<Result<EmailSummary>> {
  const system = "你是货代销售助理。总结这封邮件内容并给出下一步建议。只输出 JSON：{\"summary\":\"一句话总结\",\"nextStep\":\"具体下一步动作\"}。";
  const user = `发件人：${input.fromName || input.fromEmail}（${input.fromEmail}）\n主题：${input.subject || "（无）"}\n关联联系人：${input.matchedContactName || "无"} / 公司：${input.matchedCompany || "无"}\n\n正文摘要：\n${input.bodyPreview || "（无）"}`;
  return chatJson<EmailSummary>(system, user);
}
