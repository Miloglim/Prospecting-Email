import { beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// 首页「自动开发信」要求输入框的解析层（docs/task-card-devletter-spec.md §4）：
// 模型只负责"把话翻成结构化条件"，认不出的字段一律丢；模型不可用必须有关键词兜底，
// 兜底也认不出就不加条件（宁可不筛，也不假装听懂）。选人规则本身在 dev-letter.test.ts 里锁。
// ═══════════════════════════════════════════════════════════════════

const ask = vi.hoisted(() => vi.fn());
vi.mock("../../src/main/services/agent/oneshot", () => ({
  askJsonOnce: ask,
  onceModelReady: () => true,
}));

const { parseDevLetterIntent, keywordParse, sanitize, describeCriteria } =
  await import("../../src/main/services/dev-letter-intent");

describe("parseDevLetterIntent：模型优先，失败即兜底", () => {
  beforeEach(() => { ask.mockReset(); });

  it("没写要求 = 不过滤（parsedBy=none，且一次模型都不调）", async () => {
    const r = await parseDevLetterIntent("   ");
    expect(r).toEqual({ parsedBy: "none" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("模型给的条件按白名单收：认不出的字段丢掉，国家归一成中文，limit 不设天花板", async () => {
    ask.mockResolvedValue({ country: "Brazil", language: "en", clientType: "boss", limit: 999, extra: "模型爱编的字段" });
    const r = await parseDevLetterIntent("巴西的英文客户，来 999 位");
    expect(r).toMatchObject({ country: "巴西", language: "EN", parsedBy: "model" });
    expect(r.clientType).toBeUndefined();          // "boss" 不是我们的客户类型
    expect(r.limit).toBe(999);                     // 解析层不夹 50，取数时才按日限额/候选池夹
    expect((r as Record<string, unknown>).extra).toBeUndefined();
  });

  it("模型一条条件都没给 → 关键词兜底，解析来源如实标 keyword", async () => {
    ask.mockResolvedValue(null);
    const r = await parseDevLetterIntent("只要墨西哥的葡语客户，前 12 位");
    expect(r.parsedBy).toBe("keyword");
    expect(r.country).toBe("墨西哥");
    expect(r.language).toBe("PT");
    expect(r.limit).toBe(12);
  });

  it("要发给跟进过的老客户：不编筛子漏人，给一句可执行的说明", async () => {
    ask.mockResolvedValue(null);
    const r = await parseDevLetterIntent("给跟进过的老客户再发一轮");
    expect(r.parsedBy).toBe("keyword");
    expect(r.country).toBeUndefined();
    expect(r.note ?? "").toContain("从未联系过");
  });
});

describe("sanitize / keywordParse / describeCriteria 边界", () => {
  it("sanitize 容忍脏输入：非对象、未知语言、limit 字符串", () => {
    expect(sanitize(null)).toEqual({});
    expect(sanitize(["x"])).toEqual({});
    expect(sanitize({ language: "DE" })).toEqual({});           // 句库/模板只有 EN/ES/PT
    expect(sanitize({ limit: "8" })).toEqual({ limit: 8 });
    expect(sanitize({ limit: 0 })).toEqual({});                 // 0 = 没说数量
  });

  it("keywordParse 认不出的说法一律不编条件", () => {
    expect(keywordParse("随便来点人")).toEqual({});
    expect(keywordParse("亚特兰大那片的直客")).toEqual({ clientType: "direct" });   // 不是我们认识的国家名就不瞎猜
  });

  it("keywordParse 认得出点名的数量（含无单位/超 50），且不夹 50", () => {
    expect(keywordParse("改成30")).toEqual({ limit: 30 });
    expect(keywordParse("换成 120 位")).toEqual({ limit: 120 });
    expect(keywordParse("前 8 个")).toEqual({ limit: 8 });
    expect(keywordParse("给我 999")).toEqual({ limit: 999 });
  });

  it("describeCriteria：无条件说「默认规则」，有条件逐项拼", () => {
    expect(describeCriteria(undefined)).toBe("默认规则");
    expect(describeCriteria({ parsedBy: "none" })).toBe("默认规则");
    expect(describeCriteria({ country: "巴西", language: "EN", limit: 20, parsedBy: "model" }))
      .toBe("巴西 · 英语 · 前 20 位");
  });
});
