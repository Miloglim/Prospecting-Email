// ── 出网代理（自动检测，无需用户配置）─────────────────────────
// 为什么需要：应用主进程用 Node 的 fetch，它不读 Windows 系统代理；浏览器能通的地址，
// 这里不通 —— Gemini 这类海外端点在这台机器上就是这么连不上的。
//
// 自动检测顺序（都不通就直连，行为与改动前一致）：
//   1) 环境变量 HTTPS_PROXY / HTTP_PROXY（命令行工具习惯）
//   2) 注册表 HKCU\...\Internet Settings 的 ProxyServer（浏览器/客户端写的那份）
//      —— 不看 ProxyEnable 开关：实测有客户端只在后台起代理而不翻开关；
//      改为对该地址做一次 TCP 探活，活着才用，避免"配了死代理把请求全打死"。
// 探活失败后每 60 秒重试一次，所以 VPN 中途开启也能自动跟上。
//
// 只影响模型相关请求（ai.service / provider 测试 / agent harness），不碰其它网络调用。
import * as net from "net";
import { execFile } from "child_process";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { Log } from "./logger";
import { okResult, type Result } from "./errors";

const RETRY_MS = 60_000;
const PROBE_TIMEOUT_MS = 400;
const REG_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;

let agent: ProxyAgent | null = null;
let agentUrl = "";           // 当前 dispatcher 实际使用的代理（"" = 直连）
let lastProbeAt = 0;         // 上次探测时间（节流，避免每请求都读注册表）
let inFlight: Promise<string> | null = null;
let lastSeen = "";           // 展示用：最近一次探测到的候选代理

/** 解析注册表 ProxyServer：兼容 "127.0.0.1:7890" 与 "http=h:1;https=h:1;ftp=..." 形式 */
export function parseProxyServer(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const parts = s.split(";");
  const pick = (key: string) => parts.find(p => p.toLowerCase().startsWith(key + "="))?.split("=")[1]?.trim();
  const one = pick("https") || pick("http") || (s.includes("=") ? "" : s.split("=")[0]!.trim());
  const host = (one || "").trim();
  if (!host || !/^[^:/\s]+:\d{1,5}$/.test(host)) return "";
  return host.startsWith("http") ? host : `http://${host}`;
}

function tcpAlive(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const m = /^https?:\/\/([^:/\s]+):(\d{1,5})/.exec(url);
    if (!m) return resolve(false);
    const sock = net.connect({ host: m[1]!, port: Number(m[2]) });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function readRegistryProxy(): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("");
  return new Promise(resolve => {
    execFile("reg", ["query", REG_KEY, "/v", "ProxyServer"], { timeout: 1000 }, (err, out) => {
      if (err) return resolve("");
      const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out);
      resolve(m ? parseProxyServer(m[1]!) : "");
    });
  });
}

/** 计算应使用的代理地址（env → 注册表 + 探活），带节流与并发去重 */
async function detectProxy(): Promise<string> {
  const env = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
  if (env) {
    const url = env.includes("://") ? env : `http://${env}`;
    lastSeen = url;
    return url;
  }
  const reg = await readRegistryProxy();
  if (!reg) return "";
  lastSeen = reg;
  return (await tcpAlive(reg)) ? reg : "";
}

/** 用检测到的代理重建 dispatcher；返回当前生效的代理地址（"" 表示直连） */
export async function refreshProxy(force = false): Promise<string> {
  const now = Date.now();
  // 节流：避免每个请求都读注册表；force 供首次调用与设置页手动刷新
  if (!force && now - lastProbeAt < RETRY_MS) return agentUrl;
  if (inFlight) return inFlight;
  inFlight = detectProxy().finally(() => { inFlight = null; });
  const want = await inFlight;
  lastProbeAt = Date.now();      // 探测失败也计入节流，避免每次请求都重试
  if (want === agentUrl) return agentUrl;
  try { agent?.close(); } catch { /* 关闭失败不影响重建 */ }
  if (!want) { agent = null; agentUrl = ""; Log.info("net.proxy", "未检测到可用代理，直连"); return ""; }
  try {
    agent = new ProxyAgent({ uri: want });
    agentUrl = want;
    Log.info("net.proxy", `自动启用代理 ${want}`);
  } catch (err) {
    agent = null; agentUrl = "";
    Log.warn("net.proxy", `代理不可用，改回直连: ${err instanceof Error ? err.message : String(err)}`);
  }
  return agentUrl;
}

/** 模型请求统一出口：有可用代理走 undici+ProxyAgent，否则走全局 fetch（与改动前一致） */
export async function netFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (!lastProbeAt) await refreshProxy(true);   // 首次调用立刻探测
  if (agent) {
    const r = await undiciFetch(input as string, { ...(init as object), dispatcher: agent } as never);
    return r as unknown as Response;
  }
  return fetch(input as never, init as never);
}

/** 只读状态，供设置页显示一行「代理：xxx（自动）」 */
export function proxyStatus(): Result<{ active: boolean; proxy: string; candidate: string }> {
  return okResult({ active: !!agent, proxy: agentUrl, candidate: lastSeen });
}

/** 设置页用：立刻探测一次并返回结果（force=true 绕过节流） */
export async function proxyInfo(): Promise<Result<{ active: boolean; proxy: string; candidate: string }>> {
  await refreshProxy(true);
  return proxyStatus();
}
