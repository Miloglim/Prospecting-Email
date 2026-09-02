// ── .env 读写（密钥唯一落盘处）────────────────────────────────
// 红线：密钥只进项目根 .env（已 gitignore），不进数据库、不进对话上下文、不回传渲染端。
// 写入后同步 process.env —— 各处配置都是「每次调用现读」，所以保存即生效，无需重启。
import * as path from "path";
import * as fs from "fs";
import { APP_ROOT } from "./config";
import { Log } from "./logger";

export function envPath(): string {
  // 允许覆盖（单测/多实例）：不传就是项目根 .env
  return process.env.QW_ENV_PATH?.trim() || path.join(APP_ROOT, ".env");
}

/** 读整个 .env 为键值表（不改动 process.env） */
export function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(envPath(), "utf-8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 文件不存在：视为空 */ }
  return out;
}

/** 写入/更新/删除单个变量；value 为空串即删除该行。同步 process.env 让本次运行立即生效。 */
export function upsertEnv(name: string, value: string | null): void {
  const file = envPath();
  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  } catch { lines = []; }

  const idx = lines.findIndex(l => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l) && l.split("=")[0]!.trim() === name);
  const v = (value ?? "").trim();
  if (v) {
    if (idx >= 0) lines[idx] = `${name}=${v}`;
    else lines.push(`${name}=${v}`);
    process.env[name] = v;
  } else {
    if (idx >= 0) lines.splice(idx, 1);
    delete process.env[name];
  }

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.filter(l => l.trim() !== "").join("\n") + "\n", "utf-8");
  Log.debug("env.upsert", `${name} ${v ? "已更新" : "已清除"}（本次运行即时生效）`);
}
