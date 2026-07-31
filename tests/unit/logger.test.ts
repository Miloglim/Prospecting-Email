import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../../src/main/logger";

describe("Logger", () => {
  it("debug 输出调试信息", () => {
    const fn = vi.fn();
    const log = createLogger({ writeFn: fn });
    log.debug("contacts.getById", "id=123");
    expect(fn).toHaveBeenCalledTimes(1);
    const output = fn.mock.calls[0]![0] as string;
    expect(output).toContain("[DEBUG]");
    expect(output).toContain("[contacts.getById]");
    expect(output).toContain("id=123");
  });

  it("info 输出信息", () => {
    const fn = vi.fn();
    const log = createLogger({ writeFn: fn });
    log.info("app.start", "服务启动");
    expect(fn).toHaveBeenCalledTimes(1);
    const output = fn.mock.calls[0]![0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("[app.start]");
    expect(output).toContain("服务启动");
  });

  it("error 输出错误信息和堆栈", () => {
    const fn = vi.fn();
    const log = createLogger({ writeFn: fn });
    const err = new Error("数据库错误");
    log.error("contacts.upsert", "插入失败", err.stack || "");
    expect(fn).toHaveBeenCalledTimes(1);
    const output = fn.mock.calls[0]![0] as string;
    expect(output).toContain("[ERROR]");
    expect(output).toContain("[contacts.upsert]");
    expect(output).toContain("插入失败");
    expect(output).toContain("Error: 数据库错误");
  });

  it("低于 minLevel 的日志不输出", () => {
    const fn = vi.fn();
    const log = createLogger({ writeFn: fn, level: "warn" });
    log.debug("test", "这条不应该出现");
    log.info("test", "这条也不应该出现");
    expect(fn).toHaveBeenCalledTimes(0);

    log.warn("test", "这条应该出现");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("日志包含北京时间", () => {
    const fn = vi.fn();
    const log = createLogger({ writeFn: fn });
    log.info("test", "时间检查");
    const output = fn.mock.calls[0]![0] as string;
    // 检查时间格式 YYYY-MM-DD HH:mm:ss
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });
});
