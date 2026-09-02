// ── Agent 产物文件服务 ────────────────────────────────────────────
// AI 的可带走产物（导出的汇总/清单、后台批量任务的总结）统一落盘到
// <APP_ROOT>/outputs/agent/，文件卡据此提供「打开位置 / 复制路径」。
// 纯文件操作、无 electron 依赖；打开前的路径安全校验也由本层提供。
import * as fs from "fs";
import * as path from "path";
import { APP_ROOT } from "../config";
import { okResult, failResult, type Result } from "../errors";

/** 产物目录（与仓库里已存在的 outputs/ 同级约定） */
export const ARTIFACT_DIR = path.join(APP_ROOT, "outputs", "agent");

export type ArtifactFormat = "md" | "csv";

export interface ArtifactMeta {
  name: string;
  path: string;
  sizeBytes: number;
  format: ArtifactFormat;
}

/** 文件名 slug：只留中英文/数字/连字符/下划线，空白折成连字符，钳 40 字 */
export function slugify(title: string): string {
  const base = String(title ?? "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "artifact";
}

/** csv 单元格转义（RFC4180）：含逗号/引号/换行 → 整体加引号，引号翻倍 */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 二维数组 → csv 文本（首行即表头，由调用方备好） */
export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** 时间戳前缀：20260902-163005 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 产物落盘。目录自动创建；同名冲突追加 -2/-3…（上限 50，防恶意循环）。
 * 内容长度由调用方钳制（工具层负责），本层只管写。
 */
export function writeArtifact(title: string, format: ArtifactFormat, content: string): Result<ArtifactMeta> {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const base = `${stamp()}-${slugify(title)}`;
    let name = `${base}.${format}`;
    for (let i = 2; i <= 50 && fs.existsSync(path.join(ARTIFACT_DIR, name)); i++) {
      name = `${base}-${i}.${format}`;
    }
    if (fs.existsSync(path.join(ARTIFACT_DIR, name))) return failResult("同名文件过多，请换个文件名再导出");
    const file = path.join(ARTIFACT_DIR, name);
    fs.writeFileSync(file, content, "utf-8");
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    return okResult({ name, path: file, sizeBytes, format });
  } catch (err) {
    return failResult(`产物写入失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 打开前校验：解析成绝对路径后必须仍在 ARTIFACT_DIR 之内（防 ../ 越权） */
export function isInsideArtifactDir(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  const resolved = path.resolve(p);
  return resolved === ARTIFACT_DIR || resolved.startsWith(ARTIFACT_DIR + path.sep);
}
