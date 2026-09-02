// ── KB 中转接口 http-dispatch 客户端 ─────────────────────────────
// 目标：把《KB 中转接口业务使用教程》里的调用协议，封成 Prospector 主进程的一层「代码壳」。
// 设计红线（对齐教程 + 本项目既有约定）：
//  · 两层鉴权绝不串位：外层 Authorization: Bearer <KB令牌> 只给 KB；内网接口自己的
//    X-API-Key/Authorization 一律塞进中转 body 的 headers 字段，KB 不会转发外层头。
//  · 令牌/密钥只进 .env（env-store），不落库、不进上下文、不回传渲染端。
//  · 组装请求体、错误分类都是纯函数（buildDispatchRequest / classifyResponse），
//    不发网络、可单测、可离线预览 —— 这正是「先跑通框架、再判断能到什么程度」的抓手。
//  · 写操作遇 502/504 结果未知时禁止盲目重试：标记 retriable=false 并给出回查提示。
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { upsertEnv, readEnvFile } from "../env-store";

export type KbMethod = "GET" | "POST";

/** 一次中转调用的业务入参（url 模式 或 application_id 模式，二选一） */
export interface KbRequestInput {
  method: KbMethod;
  /** 模式 A：目标内网接口完整地址（须 http/https 开头） */
  url?: string;
  /** 模式 B：接口提供方给的 KB Application ID + 相对路径 */
  applicationId?: string;
  path?: string;
  query?: Record<string, unknown>;
  /** 内网接口自身要求的请求头（鉴权写这里，不是外层！） */
  innerHeaders?: Record<string, string>;
  /** POST 提交的数据 */
  body?: unknown;
  /** 该接口是否为写操作（无法从 method 完全判定 POST 也可能是查询），影响超时/错误的重试策略 */
  writeOperation?: boolean;
}

/** 生效配置（令牌永不明文外泄，只回预览） */
export interface KbConfigView {
  baseUrl: string;
  hasToken: boolean;
  tokenPreview: string;
  hasApplicationId: boolean;
  applicationId: string;
  endpoint: string;
}

const ENV_BASE_URL = "KB_BASE_URL";
const ENV_TOKEN = "KB_TOKEN";
const ENV_APP_ID = "KB_APPLICATION_ID";
const DISPATCH_PATH = "/api/http-dispatch";

function normalizeBaseUrl(u: string): string {
  return (u || "").trim().replace(/\/+$/, "");
}

/** 拼出中转入口；无 baseUrl 时返回空串 */
export function dispatchEndpoint(baseUrl: string): string {
  const b = normalizeBaseUrl(baseUrl);
  return b ? `${b}${DISPATCH_PATH}` : "";
}

/** 读取当前配置视图（不含明文令牌） */
export function getKbConfig(): KbConfigView {
  const env = readEnvFile();
  const baseUrl = normalizeBaseUrl(env[ENV_BASE_URL] || process.env[ENV_BASE_URL] || "");
  const token = (env[ENV_TOKEN] || process.env[ENV_TOKEN] || "").trim();
  const applicationId = (env[ENV_APP_ID] || process.env[ENV_APP_ID] || "").trim();
  return {
    baseUrl,
    hasToken: !!token,
    tokenPreview: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : "",
    hasApplicationId: !!applicationId,
    applicationId,
    endpoint: dispatchEndpoint(baseUrl),
  };
}

/** 逐项写入 .env（空串=清除）。写后同步 process.env，本次运行即时生效，无需重启。 */
export function setKbConfig(input: { baseUrl?: string; token?: string; applicationId?: string }): Result<void> {
  try {
    if (input.baseUrl !== undefined) upsertEnv(ENV_BASE_URL, normalizeBaseUrl(input.baseUrl));
    if (input.token !== undefined) upsertEnv(ENV_TOKEN, input.token.trim());
    if (input.applicationId !== undefined) upsertEnv(ENV_APP_ID, input.applicationId.trim());
    Log.info("kb.setConfig", "KB 配置已更新（.env）");
    return okResult(undefined);
  } catch (err: unknown) {
    Log.error("kb.setConfig", "写入 .env 失败", err instanceof Error ? err.stack : String(err));
    return failResult("写入 KB 配置失败");
  }
}

/** 组装好的出站请求（外层头 + 中转 body）；令牌以入参给定，便于单测与预览 */
export interface AssembledRequest {
  endpoint: string;
  /** 只作用于「你的程序 → KB」这一跳 */
  outerHeaders: Record<string, string>;
  /** 发给 KB 的中转请求体；KB 依此代你访问内网接口 */
  payload: Record<string, unknown>;
  /** 是否写操作（供上层决定是否禁重试） */
  writeOperation: boolean;
}

/**
 * 纯函数：把业务入参翻译成中转请求体。不发网络。
 * 校验：baseUrl / 令牌齐备；method 仅 GET|POST；url 与 application_id+path 二选一；
 *      url 必须 http/https 开头。两层鉴权分离：innerHeaders 进 payload.headers，外层只有 Bearer + Content-Type。
 */
export function buildDispatchRequest(
  cfg: { baseUrl: string; token: string },
  input: KbRequestInput,
): Result<AssembledRequest> {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const token = (cfg.token || "").trim();
  if (!baseUrl) return failResult("KB_BASE_URL 未配置");
  if (!token) return failResult("KB 令牌未配置（本地调试用个人测试令牌 kbtt_ 开头，24h 过期）");

  const method = (input.method || "").toUpperCase() as KbMethod;
  if (method !== "GET" && method !== "POST") return failResult("method 只支持 GET 或 POST");

  const url = (input.url || "").trim();
  const appId = (input.applicationId || "").trim();
  const relPath = (input.path || "").trim();

  const hasUrl = !!url;
  const hasApp = !!appId && !!relPath;
  if (hasUrl && hasApp) return failResult("url 与 application_id+path 只能选一个");
  if (!hasUrl && !hasApp) return failResult("必须提供 url，或 application_id + path");
  if (hasUrl && !/^https?:\/\//i.test(url)) return failResult("url 必须以 http:// 或 https:// 开头");

  const payload: Record<string, unknown> = { method };
  if (hasUrl) {
    payload.url = url;
  } else {
    payload.application_id = appId;
    payload.path = relPath.startsWith("/") ? relPath : `/${relPath}`;
  }
  if (input.query && Object.keys(input.query).length > 0) payload.query = input.query;
  // 内网接口自己的头（含 X-API-Key / 内网 Authorization）—— 只进 body，绝不进外层
  if (input.innerHeaders && Object.keys(input.innerHeaders).length > 0) payload.headers = input.innerHeaders;
  if (input.body !== undefined) payload.body = input.body;

  // 外层头：只带 KB 令牌 + 内容类型。KB 不会把外层头转发给内网接口。
  const outerHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  return okResult({
    endpoint: dispatchEndpoint(baseUrl),
    outerHeaders,
    payload,
    writeOperation: input.writeOperation ?? (method === "POST"),
  });
}

/** 中转响应归类：error 出在 KB 层 / 内网业务透传 / 网络栈；以及重试与幂等策略 */
export type KbErrorLayer = "none" | "kb" | "business" | "network";

export interface KbResponseView {
  /** 最终 HTTP 状态码（KB 透传内网状态码）；网络层失败为 0 */
  status: number;
  ok: boolean;
  /** KB 中转层的规范错误码语义（教程表）；无法区分业务透传时给排查方向 */
  layer: KbErrorLayer;
  /** 是否可安全重试（写操作结果未知时恒为 false） */
  retriable: boolean;
  /** 写操作：遇超时/网关错误须先回查，勿盲目重发 */
  writeOperation: boolean;
  /** 面向用户/模型的下一步建议 */
  hint: string;
  /** 解析后的响应体（JSON 优先，坏 JSON 回落文本） */
  data: unknown;
}

/** KB 中转层自身的语义错误码 → 说明。业务接口透传的同名码由 hint 里提示排查 code。 */
const KB_LAYER_CODES = new Set([401, 403, 404, 502, 503, 504]);

/** 纯函数：按状态码 + 是否写操作，判定层级/可重试/提示。 */
export function classifyResponse(
  status: number,
  bodyText: string,
  opts: { writeOperation: boolean; networkFailure?: boolean } = { writeOperation: false },
): KbResponseView {
  let data: unknown = bodyText;
  try { data = JSON.parse(bodyText); } catch { /* 保留原文 */ }

  if (opts.networkFailure) {
    return {
      status: 0, ok: false, layer: "network",
      retriable: !opts.writeOperation, writeOperation: opts.writeOperation,
      hint: opts.writeOperation
        ? "网络中断且为写操作：结果未知，严禁直接重试；先回查业务是否已生效"
        : "无法连接 KB 中转服务，请检查 KB_BASE_URL 与网络",
      data,
    };
  }

  const ok = status >= 200 && status < 300;
  if (ok) {
    return { status, ok: true, layer: "none", retriable: false, writeOperation: opts.writeOperation, hint: "调用成功", data };
  }

  let hint = "";
  switch (status) {
    case 400:
      hint = "请求格式不对或 method 非 GET/POST：检查 JSON/地址/请求方式（也可能是内网业务 400 透传，看返回体 code）";
      break;
    case 401:
      hint = "KB 令牌错误或已过期：确认无空格后到 KB 个人中心重新申请测试令牌，并同步所有使用旧令牌的调用";
      break;
    case 403:
      hint = "application_id 无对应空间权限：联系空间 owner/admin";
      break;
    case 404:
      hint = "application_id 不存在：向接口提供方确认 ID";
      break;
    case 502:
      hint = "KB 连不上目标内网接口：核对内网地址或联系接口负责人";
      break;
    case 503:
      hint = "KB 中转服务未启用：联系 KB 平台负责人";
      break;
    case 504:
      hint = "内网接口处理超时：稍后重试";
      break;
    default:
      hint = `非 2xx（${status}），先看返回体 code 判断是 KB 层还是内网业务报错`;
  }

  const layer: KbErrorLayer = KB_LAYER_CODES.has(status) ? "kb" : "business";
  // 读操作：网关/超时类(502/504/超时)可重试；写操作：只要结果可能未知(502/504)一律禁重试须回查
  const uncertain = status === 502 || status === 504;
  const retriable = opts.writeOperation ? !uncertain : uncertain || status === 503;
  if (opts.writeOperation && uncertain) {
    hint += "；写操作结果未知，严禁直接重试，请先回查";
  }
  return { status, ok: false, layer, retriable, writeOperation: opts.writeOperation, hint, data };
}

/** 实际发起一次中转调用（走 Node 全局 fetch；密钥只从 .env 现读）。 */
export async function kbDispatch(input: KbRequestInput, timeoutMs = 60_000): Promise<Result<KbResponseView>> {
  const cfg = getKbConfig();
  const built = buildDispatchRequest(
    { baseUrl: cfg.baseUrl, token: readEnvFile()[ENV_TOKEN] || process.env[ENV_TOKEN] || "" },
    input,
  );
  if (!built.success) return built;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(built.data.endpoint, {
      method: "POST",
      headers: built.data.outerHeaders,
      body: JSON.stringify(built.data.payload),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    Log.debug("kb.dispatch", `HTTP ${res.status} ${text.slice(0, 300)}`);
    return okResult(classifyResponse(res.status, text, { writeOperation: built.data.writeOperation }));
  } catch (err: unknown) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    Log.error("kb.dispatch", aborted ? "超时" : "网络错误", err instanceof Error ? err.message : String(err));
    return okResult(classifyResponse(0, aborted ? `timeout ${timeoutMs}ms` : String(err), {
      writeOperation: built.data.writeOperation, networkFailure: true,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** 离线预览：返回将要发出的真实请求（令牌脱敏），用于验证两层鉴权是否串位。不发网络。 */
export function kbPreview(input: KbRequestInput): Result<{ endpoint: string; outerHeaders: Record<string, string>; payload: Record<string, unknown> }> {
  const cfg = getKbConfig();
  const built = buildDispatchRequest(
    { baseUrl: cfg.baseUrl, token: readEnvFile()[ENV_TOKEN] || process.env[ENV_TOKEN] || "" },
    input,
  );
  if (!built.success) return built;
  const masked = { ...built.data.outerHeaders };
  if (masked.Authorization) masked.Authorization = "Bearer <令牌已脱敏>";
  return okResult({ endpoint: built.data.endpoint, outerHeaders: masked, payload: built.data.payload });
}

/** 连通性探针结果（不含明文令牌） */
export interface KbConnectivity {
  /** KB 中转服务是否网络可达 */
  reachable: boolean;
  /** 是否鉴权通过（能进入 KB 中转逻辑） */
  authed: boolean;
  /** KB 返回的状态码；网络不可达为 0 */
  kbStatus: number;
  /** 面向用户的判定结论 */
  verdict: "connected" | "unreachable" | "auth_failed" | "no_permission" | "relay_unavailable";
  /** 下一步建议 */
  hint: string;
}

/**
 * 连通性 + 鉴权探针：发一个「缺 url/method」的最小中转请求，让 KB 用它自己的状态码回话。
 * 这样无需任何真实业务接口，就能区分「网络不通 / 令牌无效 / 无权限 / 中转未启用 / 一切正常」。
 * 期望：网络通 + 令牌有效时 KB 回 400（缺 url 属预期）→ 判 connected。
 */
export async function kbTestConnection(timeoutMs = 15_000): Promise<Result<KbConnectivity>> {
  const cfg = getKbConfig();
  if (!cfg.baseUrl) return failResult("KB_BASE_URL 未配置");
  const token = (readEnvFile()[ENV_TOKEN] || process.env[ENV_TOKEN] || "").trim();
  const endpoint = cfg.endpoint;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let netErr = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}), // 故意不填 url/method，触发 KB 层校验报错
      signal: controller.signal,
    });
    status = res.status;
  } catch (err: unknown) {
    netErr = (err as { name?: string })?.name === "AbortError" ? `超时 ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
  Log.debug("kb.testConnection", `status=${status} ${netErr}`);

  const view = (v: Omit<KbConnectivity, "kbStatus">): Result<KbConnectivity> =>
    okResult({ ...v, kbStatus: status });

  if (status === 0) {
    return view({
      reachable: false, authed: false, verdict: "unreachable",
      hint: `无法连接 ${endpoint}（${netErr || "网络错误"}）。请确认在公司内网 / 已连 VPN、KB 地址正确、KB 中转服务在线`,
    });
  }
  if (status === 401) {
    return view({
      reachable: true, authed: false, verdict: "auth_failed",
      hint: "KB 可达，但令牌无效或已过期（个人测试令牌 24h 过期）。到 KB 个人中心重新申请测试令牌",
    });
  }
  if (status === 403) {
    return view({
      reachable: true, authed: true, verdict: "no_permission",
      hint: "KB 可达但当前身份无中转权限：确认 KB 账号至少 writer 权限，或使用已授权的 application_id",
    });
  }
  if (status === 404 || status === 503) {
    return view({
      reachable: true, authed: true, verdict: "relay_unavailable",
      hint: `KB 可达但中转入口异常（${status}）：${status === 404 ? "application_id/路径不存在，向接口方确认" : "中转服务未启用，联系 KB 平台负责人"}`,
    });
  }
  if (status === 400 || (status >= 200 && status < 300)) {
    return view({
      reachable: true, authed: true, verdict: "connected",
      hint: "✅ 已连通：KB 中转在运行、鉴权通过（400 只是缺少目标 url 的预期报错，属正常）",
    });
  }
  return view({
    reachable: true, authed: status < 500, verdict: "connected",
    hint: `KB 已响应（${status}），中转层可达；实际调用时以业务接口返回为准`,
  });
}
