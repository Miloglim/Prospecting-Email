type LogLevel = "debug" | "info" | "warn" | "error";

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
      // 生产环境输出到 console，后续可改为文件写入
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
