import { describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// 「None 类占位」归一（实测事故：模型把没填的可选参数写成字符串 "None"）
// 用户说「制作巴西运价表」→ 选「发运价更新邮件」→ rate_update_plan 报
// 「『None』在台账里不是可识别的目的港」、search_contacts 报 stage 值「None」不存在，
// 模型原样重试 4 次、烧掉 68k 输入，什么也没交付。
// 工具拒绝得对，但"没填"本就不该进入校验：可选参数在 schema 层归一掉。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/db", () => ({ getDb: () => null, saveDatabase: () => {}, getRawDb: () => null }));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { quoteSearchSchema, searchContactsSchema, isNoneish } =
  await import("../../src/main/services/agent/tools");

describe("isNoneish：什么算「等于没填」", () => {
  it("Python 风格与各种占位都算没填", () => {
    for (const v of ["None", "none", " NONE ", "null", "undefined", "nil", "N/A", "-", "—", "/", "不限", "全部", "无", ""]) {
      expect(isNoneish(v)).toBe(true);
    }
  });
  it("真实值不许被误杀", () => {
    for (const v of ["SANTOS", "巴西", "cold", "40HQ", "MSC", "0", "false", "no.email"]) expect(isNoneish(v)).toBe(false);
    expect(isNoneish(null)).toBe(true);
    expect(isNoneish(undefined)).toBe(true);
    expect(isNoneish(0)).toBe(false);
  });
});

describe("可选参数在 schema 层归一（不再进校验）", () => {
  it("quote_search：port/stage 类字段传 \"None\" 视同省略，其余筛选照常保留", () => {
    const p = quoteSearchSchema.parse({ pod: "None", carrier: "none", q: "SANTOS", container: "N/A", limit: 20 });
    expect(p.pod).toBeUndefined();
    expect(p.carrier).toBeUndefined();
    expect(p.container).toBeUndefined();
    expect(p.q).toBe("SANTOS");
    expect(p.limit).toBe(20);
  });

  it("search_contacts：stage=\"None\" 不再报 bad_filter，等于不按阶段筛", () => {
    const p = searchContactsSchema.parse({ country: "Brazil", stage: "None", sortBy: "none", industry: null, silenceDays: "None" });
    expect(p.stage).toBeUndefined();
    expect(p.sortBy).toBeUndefined();
    expect(p.industry).toBeUndefined();
    expect(p.silenceDays).toBeUndefined();
    expect(p.country).toBe("Brazil");
  });
});
