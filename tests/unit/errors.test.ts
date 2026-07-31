import { describe, it, expect } from "vitest";
import { okResult, failResult } from "../../src/main/errors";

describe("okResult", () => {
  it("返回 success=true 的结果", () => {
    const result = okResult({ name: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "test" });
    }
  });

  it("支持 void 类型", () => {
    const result = okResult(undefined);
    expect(result.success).toBe(true);
  });

  it("支持数字类型", () => {
    const result = okResult(42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(42);
    }
  });
});

describe("failResult", () => {
  it("返回 success=false 的结果", () => {
    const result = failResult("发生错误");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("发生错误");
    }
  });

  it("支持可选的 cause 参数", () => {
    const cause = new Error("原始错误");
    const result = failResult("包装错误", cause);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("包装错误");
      expect(result.cause).toBe(cause);
    }
  });

  it("不传 cause 时 cause 为 undefined", () => {
    const result = failResult("简单错误");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.cause).toBeUndefined();
    }
  });
});
