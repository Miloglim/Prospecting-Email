// ── 模型端点 Profile 管理（界面可增删改、一键热切换）────────────
// 设计：profile 只存非敏感字段（baseUrl/model/名称/思考开关）在 ai/providers.json；
// 密钥一律进 .env（变量名 PROVIDER_KEY_<ID>），激活时只写「指针」AGENT_KEY_ENV，
// 不把密钥复制成第二份 —— 切换端点后不会在 .env 里留下旧密钥的副本。
// 因为各处配置都是每次调用现读 env，激活后立即可用，无需重启应用。
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { upsertEnv, readEnvFile } from "../env-store";
import { readActiveEndpoint, endpointView } from "./endpoint.service";
import { netFetch } from "../net-proxy";

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** .env 中该端点密钥的变量名（密钥本身不落此文件） */
  keyEnv: string;
  thinking: boolean;
}

export interface ProfileDto extends ProviderProfile {
  hasKey: boolean;
  active: boolean;
}

interface Store {
  activeId: string | null;
  profiles: ProviderProfile[];
}

function storePath(): string {
  return process.env.AI_PROVIDERS_PATH?.trim() || path.join(APP_ROOT, "ai", "providers.json");
}

export function keyEnvFor(id: string): string {
  return `PROVIDER_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function normalizeBaseUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, "");
  return s;
}

function seedStore(): Store {
  // 首次使用：把 .env 里已有的手写配置收成一个 profile，避免用户配好的一换界面就丢
  const env = readEnvFile();
  const baseUrl = normalizeBaseUrl(env.AGENT_API_BASE_URL || "");
  const keyEnv = (env.AGENT_KEY_ENV || "").trim() || (env.AGENT_API_KEY ? "AGENT_API_KEY" : "");
  if (!baseUrl) return { activeId: null, profiles: [] };
  const p: ProviderProfile = {
    id: "current",
    name: "当前配置",
    baseUrl,
    model: (env.AGENT_MODEL || "").trim(),
    keyEnv: keyEnv || keyEnvFor("current"),
    thinking: /^(1|true|on|yes)$/i.test((env.AGENT_THINKING || "").trim()),
  };
  return { activeId: keyEnv ? "current" : null, profiles: [p] };
}

function readStore(): Store {
  const file = storePath();
  try {
    if (!fs.existsSync(file)) {
      const seeded = seedStore();
      if (seeded.profiles.length) writeStore(seeded);
      return seeded;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Store>;
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.filter((p): p is ProviderProfile => !!p && typeof p.id === "string" && typeof p.name === "string")
      : [];
    return { activeId: typeof raw.activeId === "string" ? raw.activeId : null, profiles };
  } catch (err) {
    Log.warn("provider.store", `读取 providers.json 失败，按空配置继续: ${err instanceof Error ? err.message : String(err)}`);
    return { activeId: null, profiles: [] };
  }
}

function writeStore(s: Store): void {
  const file = storePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), "utf-8");
}

function toDto(s: Store, p: ProviderProfile): ProfileDto {
  const key = (process.env[p.keyEnv] || "").trim();
  return { ...p, hasKey: !!key, active: s.activeId === p.id };
}

/** 列出全部端点（永不含密钥值） */
export function listProfiles(): Result<ProfileDto[]> {
  const s = readStore();
  return okResult(s.profiles.map(p => toDto(s, p)));
}

/** 当前生效情况 + 激活中的端点，供设置页与对话页角标显示 */
export function getEndpointStatus(): Result<{
  profiles: ProfileDto[];
  activeId: string | null;
  endpoint: ReturnType<typeof endpointView>;
  /** 端点是否可用（未配置就是 false，界面直接提示去配置，不再有 Mock 假流） */
  configured: boolean;
}> {
  const s = readStore();
  const e = readActiveEndpoint();
  return okResult({
    profiles: s.profiles.map(p => toDto(s, p)),
    activeId: s.activeId,
    endpoint: endpointView(e),
    configured: !!(e.baseUrl && e.apiKey),
  });
}

export interface ProfileInput {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  thinking?: boolean;
}

/** 新增或修改端点（密钥请用 setProfileKey，此处不接受密钥入参） */
export function upsertProfile(input: ProfileInput): Result<ProfileDto> {
  const name = input.name?.trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl || "");
  if (!name) return failResult("端点名必填");
  if (!/^https?:\/\//i.test(baseUrl)) return failResult("Base URL 需以 http:// 或 https:// 开头");
  const s = readStore();
  if (input.id) {
    const p = s.profiles.find(x => x.id === input.id);
    if (!p) return failResult(`端点不存在: ${input.id}`);
    p.name = name; p.baseUrl = baseUrl;
    p.model = input.model?.trim() ?? p.model;
    if (typeof input.thinking === "boolean") p.thinking = input.thinking;
    writeStore(s);
    Log.info("provider.upsert", `更新端点 ${p.id}（${p.name}）`);
    return okResult(toDto(s, p));
  }
  const id = (crypto.randomUUID().slice(0, 8));
  const p: ProviderProfile = {
    id, name, baseUrl,
    model: input.model?.trim() ?? "",
    keyEnv: keyEnvFor(id),
    thinking: !!input.thinking,
  };
  s.profiles.push(p);
  writeStore(s);
  Log.info("provider.upsert", `新增端点 ${id}（${name}）`);
  return okResult(toDto(s, p));
}

export function deleteProfile(id: string): Result<void> {
  const s = readStore();
  const idx = s.profiles.findIndex(p => p.id === id);
  if (idx < 0) return failResult(`端点不存在: ${id}`);
  const [gone] = s.profiles.splice(idx, 1);
  if (s.activeId === id) {
    s.activeId = null;
    upsertEnv("AGENT_KEY_ENV", null);   // 撤指针，不撤 base/model（下次激活会覆盖）
  }
  writeStore(s);
  // 顺手清掉该端点残留在 .env 的密钥，避免留下无人引用的旧 key
  if (gone && gone.keyEnv !== "AGENT_API_KEY") upsertEnv(gone.keyEnv, null);
  Log.info("provider.delete", `删除端点 ${id}（含其 .env 密钥）`);
  return okResult(undefined);
}

/** 写入/清除某个端点的密钥（只进 .env） */
export function setProfileKey(id: string, value: string): Result<void> {
  const s = readStore();
  const p = s.profiles.find(x => x.id === id);
  if (!p) return failResult(`端点不存在: ${id}`);
  upsertEnv(p.keyEnv, value);
  Log.info("provider.key", `${p.keyEnv} 已${value.trim() ? "更新" : "清除"}`);
  return okResult(undefined);
}

/** 切换思考模式：写 profile 并同时更新生效端点的 AGENT_THINKING */
export function setProfileThinking(id: string, thinking: boolean): Result<ProfileDto> {
  const s = readStore();
  const p = s.profiles.find(x => x.id === id);
  if (!p) return failResult(`端点不存在: ${id}`);
  p.thinking = thinking;
  writeStore(s);
  if (s.activeId === id) upsertEnv("AGENT_THINKING", thinking ? "1" : "");
  return okResult(toDto(s, p));
}

/** 激活 = 写指针与生效参数到 .env + 同步 process.env，立即生效（无需重启） */
export function activateProfile(id: string): Result<{ configured: boolean; model: string; name: string }> {
  const s = readStore();
  const p = s.profiles.find(x => x.id === id);
  if (!p) return failResult(`端点不存在: ${id}`);
  const key = (readEnvFile()[p.keyEnv] || process.env[p.keyEnv] || "").trim();
  if (!key) return failResult(`该端点还没有密钥：请先在「${p.name}」上点「设置密钥」`);

  s.activeId = id;
  writeStore(s);
  upsertEnv("AGENT_API_BASE_URL", p.baseUrl);
  upsertEnv("AGENT_MODEL", p.model);
  upsertEnv("AGENT_KEY_ENV", p.keyEnv);
  upsertEnv("AGENT_THINKING", p.thinking ? "1" : "");
  const e = readActiveEndpoint();
  Log.info("provider.activate", `切换到 ${p.name}（model=${p.model || "默认"} thinking=${p.thinking}）即时生效`);
  return okResult({ configured: !!(e.baseUrl && e.apiKey), model: e.model, name: p.name });
}

export function deactivateProfile(): Result<void> {
  const s = readStore();
  s.activeId = null;
  writeStore(s);
  upsertEnv("AGENT_KEY_ENV", null);
  return okResult(undefined);
}

// ── 连通性测试（真实调用，不做 TCP 假检测）────────────────────

export interface EndpointTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  preview?: string;
  /** 失败归类：auth / model / rate / timeout / network / empty / badrequest */
  kind?: string;
  error?: string;
}

const TEST_TIMEOUT_MS = 15_000;

/** 最小一次补全：既验密钥也验模型名，顺带告诉你首字延迟 */
export async function testProfile(id: string): Promise<Result<EndpointTestResult>> {
  const s = readStore();
  const p = s.profiles.find(x => x.id === id);
  if (!p) return failResult(`端点不存在: ${id}`);
  const key = (process.env[p.keyEnv] || readEnvFile()[p.keyEnv] || "").trim();
  if (!key) return okResult({ ok: false, latencyMs: 0, model: p.model, kind: "auth", error: "尚未设置该端点的密钥" });
  if (!p.model.trim()) return okResult({ ok: false, latencyMs: 0, model: "", kind: "model", error: "模型名未填" });

  // 关闭思考再测：pro/flash 档开思考会拖到十几秒，测的是连通性不是推理
  const isOllama = /localhost|127\.0\.0\.1|:11434/i.test(p.baseUrl);
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 8,
    temperature: 0,
  };
  body.chat_template_kwargs = isOllama ? { thinking: false } : { enable_thinking: false, thinking: false };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await netFetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return okResult({ ok: false, latencyMs, model: p.model, ...classifyHttp(res.status, text) });
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return okResult({ ok: false, latencyMs, model: p.model, kind: "empty", error: "端点返回空内容（模型名可用但没出字，试试关掉思考或换模型）" });
    return okResult({ ok: true, latencyMs, model: p.model, preview: content.slice(0, 40) });
  } catch (err: unknown) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return okResult({
      ok: false, latencyMs: Date.now() - t0, model: p.model,
      kind: aborted ? "timeout" : "network",
      error: aborted ? `超时（${TEST_TIMEOUT_MS / 1000}s 无响应）` : "无法连接（检查 Base URL、网络或该端点是否在本机运行）",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP 状态 → 人话归类（对齐邮箱校验的口径） */
export function classifyHttp(status: number, body: string): { kind: string; error: string } {
  const msg = (body || "").slice(0, 200);
  if (status === 401 || status === 403) return { kind: "auth", error: "密钥无效或无权限（401/403）" };
  if (status === 404) return { kind: "model", error: `端点或模型不存在（404）：检查 Base URL 与模型名` };
  if (status === 429) return { kind: "rate", error: "被限流（429）：免费档并发/额度限制，稍后再试或换端点" };
  if (status === 400) {
    if (/model/i.test(msg) && /empty|not found|invalid|unknown/i.test(msg)) {
      return { kind: "model", error: `模型名不被接受（400）：${msg}` };
    }
    return { kind: "badrequest", error: `请求被拒（400）：${msg}` };
  }
  if (status >= 500) return { kind: "server", error: `端点异常（${status}）：${msg}` };
  return { kind: "badrequest", error: `HTTP ${status}：${msg}` };
}
