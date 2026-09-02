// ── 诊断包导出 ────────────────────────────────────────────────────
// 开发期/现场排障的固定诉求：「出错了？把日志导出发我」。本服务把
//   环境信息 + 日志尾部 + 配置快照（密钥一律掩码）+ 数据库行数 + 最近错误/工具异常
// 汇总成一份 markdown，落进产物目录（outputs/agent），设置的「打开位置」直接高亮文件。
// 红线：导出不含任何密钥值（key/token/secret/password/auth 字段整体打码）；
//       不导数据库本体，只导行数统计。
import * as fs from "fs";
import * as path from "path";
import { count, desc, isNotNull } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { sendQueue } from "../db/schema/send-queue";
import { agentConversations, agentMessages, agentToolCalls } from "../db/schema/agent";
import { rateQuotes } from "../db/schema/rates";
import { okResult, failResult, type Result } from "../errors";
import { writeArtifact, type ArtifactMeta } from "./artifact.service";
import { readActiveEndpoint } from "./endpoint.service";

/** 日志文件路径解析与 logger 同规则（打包 userData / 开发项目根）；electron 不可用时返回 null */
function logFile(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    const root = app.isPackaged ? app.getPath("userData") : APP_ROOT;
    return path.join(root, "logs", "app.log");
  } catch {
    return path.join(APP_ROOT, "logs", "app.log");
  }
}

const SECRET_KEY_RE = /(key|token|secret|password|passwd|auth|credential)/i;

/** 递归掩码：命中密钥语义的字段值 → "***"；对象/数组照常下钻。纯函数，单测覆盖 */
export function maskSecrets<T>(v: T, depth = 0): unknown {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) return v.map(x => maskSecrets(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***" : maskSecrets(val, depth + 1);
    }
    return out;
  }
  return v;
}

/** 取文本尾部至多 n 字节（从整行边界裁，不切半截 UTF-8） */
export function tailByBytes(text: string, n: number): string {
  if (Buffer.byteLength(text, "utf-8") <= n) return text;
  let cut = text.length - n;              // 先按字符数粗切（utf-8 下字节 ≥ 字符）
  const nl = text.indexOf("\n", cut);
  cut = nl >= 0 ? nl + 1 : cut;
  return `（前文超长省略）\n${text.slice(cut)}`;
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
}

function safeCount(name: string, fn: () => number | undefined): string {
  try { return `${name}: ${fn() ?? "?"}`; } catch (e) { return `${name}: 读取失败 ${e instanceof Error ? e.message : String(e)}`; }
}

/** 生成诊断包。成功返回文件元信息（含绝对路径，供前端「打开位置」）。 */
export function exportDiagnostics(): Result<ArtifactMeta> {
  const now = new Date();
  const lines: string[] = [];
  const logPath = logFile();

  // ── 环境 ──
  lines.push(`# Prospector 诊断包`, ``);
  lines.push(`- 时间：${now.toLocaleString("zh-CN")}`);
  lines.push(`- 版本：v${appVersion()} · Electron ${process.versions.electron ?? "-"} · Node ${process.versions.node}`);
  lines.push(`- 系统：${process.platform} ${process.arch} · locale ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`- 数据根目录：${APP_ROOT}`);

  // ── 日志文件 ──
  lines.push(``, `## 日志文件`);
  if (logPath && fs.existsSync(logPath)) {
    const st = fs.statSync(logPath);
    lines.push(`- ${logPath} · ${(st.size / 1024).toFixed(0)} KB · 最后写入 ${st.mtime.toLocaleString("zh-CN")}`);
    const rot = `${logPath}.1`;
    if (fs.existsSync(rot)) {
      const rs = fs.statSync(rot);
      lines.push(`- ${rot} · ${(rs.size / 1024).toFixed(0)} KB（轮转备份，未含入，需要时直接拷走）`);
    }
  } else {
    lines.push(`- 未找到日志文件（${logPath ?? "非 Electron 环境"}）`);
  }

  // ── 模型端点（永不含密钥） ──
  lines.push(``, `## 模型端点`);
  try {
    const ep = readActiveEndpoint();
    lines.push(`- baseUrl: ${ep.baseUrl || "（未配置 → Mock 模式）"}`);
    lines.push(`- model: ${ep.model || "-"} · thinking: ${ep.thinking ? "on" : "off"} · 密钥: ${ep.apiKey ? "已配置（值不外泄）" : "未配置"}`);
  } catch (e) {
    lines.push(`- 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 配置快照（send/config.json，递归掩码） ──
  lines.push(``, `## 配置快照（密钥已掩码）`);
  try {
    const cfgPath = path.join(APP_ROOT, "send", "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as unknown;
      lines.push("```json", JSON.stringify(maskSecrets(cfg), null, 2), "```");
    } else lines.push(`- send/config.json 不存在`);
  } catch (e) {
    lines.push(`- 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 数据库行数（不导数据本体） ──
  lines.push(``, `## 数据库行数`);
  const db = getDb();
  lines.push(
    safeCount("contacts", () => db.select({ c: count() }).from(contacts).get()?.c),
    safeCount("companies", () => db.select({ c: count() }).from(companies).get()?.c),
    safeCount("interactions", () => db.select({ c: count() }).from(interactions).get()?.c),
    safeCount("inbox_messages", () => db.select({ c: count() }).from(inboxMessages).get()?.c),
    safeCount("send_queue", () => db.select({ c: count() }).from(sendQueue).get()?.c),
    safeCount("rate_quotes", () => db.select({ c: count() }).from(rateQuotes).get()?.c),
    safeCount("agent_conversations", () => db.select({ c: count() }).from(agentConversations).get()?.c),
    safeCount("agent_messages", () => db.select({ c: count() }).from(agentMessages).get()?.c),
    safeCount("agent_tool_calls", () => db.select({ c: count() }).from(agentToolCalls).get()?.c),
  );

  // ── 最近工具异常（agent_tool_calls） ──
  try {
    const errs = db.select().from(agentToolCalls).where(isNotNull(agentToolCalls.error))
      .orderBy(desc(agentToolCalls.id)).limit(10).all();
    lines.push(``, `## 最近 10 条工具异常`);
    if (!errs.length) lines.push(`- 无`);
    for (const e of errs) lines.push(`- ${e.createdAt} · ${e.toolName} · ${e.approval} · ${(e.error ?? "").slice(0, 160)}`);
  } catch { /* 审计表读取失败不阻塞诊断包 */ }

  // ── 日志尾部（ERROR/WARN 优先 + 最后 N 行原文） ──
  lines.push(``, `## 日志尾部（ERROR / WARN）`);
  try {
    if (logPath && fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf-8");
      const hits = raw.split("\n").filter(l => /"level":"(error|warn)"|\bERROR\b|\bWARN\b/.test(l)).slice(-60);
      lines.push("```", hits.length ? hits.join("\n") : "（无 error/warn 行）", "```");
      lines.push(``, `## 日志最后 200 行`);
      const tail = raw.split("\n").slice(-200).join("\n");
      lines.push("```", tailByBytes(tail, 200_000), "```");
    }
  } catch (e) {
    lines.push(`读取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const w = writeArtifact(`诊断包 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`, "md", lines.join("\n"));
  if (!w.success) return failResult(w.error ?? "诊断包写入失败");
  return okResult(w.data);
}
