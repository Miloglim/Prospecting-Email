import * as fs from "fs";
import * as path from "path";

type LogLevel = "debug" | "info" | "warn" | "error";

// 日志文件路径（打包→userData/logs，开发→项目根/logs；非 Electron 环境返回 null 不写文件）
function resolveLogFile(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    const root = app.isPackaged ? app.getPath("userData") : path.resolve(__dirname, "..", "..");
    return path.join(root, "logs", "app.log");
  } catch {
    return null;
  }
}

function appendLogFile(line: string): void {
  try {
    const file = resolveLogFile();
    if (!file) return;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch { /* 写日志失败静默，避免日志影响业务 */ }
}

interface LoggerOpts {
  writeFn?: (line: string) => void; // 测试注入
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(opts: LoggerOpts = {}) {
  const minLevel = LEVEL_ORDER[opts.level || "debug"] || 0;

  function formatTime(): string {
    const now = new Date();
    const shanghai = new Date(now.getTime() + 8 * 3600000);
    return shanghai.toISOString().replace("T", " ").slice(0, 19);
  }

  function write(level: LogLevel, ctx: string, msg: string, extra?: string) {
    if (LEVEL_ORDER[level] < minLevel) return;

    const line = `[${formatTime()}] [${level.toUpperCase()}] [${ctx}] ${msg}${
      extra ? "\n" + extra : ""
    }`;

    if (opts.writeFn) {
      opts.writeFn(line);
    } else {
      appendLogFile(line);
      // 同时输出到 console（便于开发调试）
      switch (level) {
        case "error":
          console.error(line);
          break;
        case "warn":
          console.warn(line);
          break;
        default:
          console.log(line);
      }
    }
  }

  return {
    debug(ctx: string, msg: string) {
      write("debug", ctx, msg);
    },
    info(ctx: string, msg: string) {
      write("info", ctx, msg);
    },
    warn(ctx: string, msg: string) {
      write("warn", ctx, msg);
    },
    error(ctx: string, msg: string, stack?: string) {
      write("error", ctx, msg, stack);
    },
  };
}

/** 全局日志实例 */
export const Log = createLogger();
