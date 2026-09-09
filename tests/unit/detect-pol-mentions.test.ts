import { describe, it, expect } from "vitest";
import { detectPolMentions } from "../../src/main/services/rates-clean";

// ═══════════════════════════════════════════════════════════════
// 起运港自由文本识别（2026-09-08「蛇口到santos 却报出宁波/天津价」回归）：
// 模型漏传 pol 时，工具从用户原话确定性找回起运港约束。
// 关键语义：深圳/华南 是统称，按语义群去重只算一次意图；「新港」撞日常词须排除。
// ═══════════════════════════════════════════════════════════════

describe("detectPolMentions", () => {
  it("蛇口到santos：识别出单一意图 蛇口，群含 盐田/南沙/华南基本港", () => {
    const m = detectPolMentions("蛇口到santos的运价是多少");
    expect(m).toHaveLength(1);
    expect(m[0]!.word).toBe("蛇口");
    expect(m[0]!.group).toEqual(expect.arrayContaining(["蛇口", "盐田", "南沙", "华南基本港"]));
  });

  it("深圳是统称：蛇口/盐田/南沙 同属一个语义群，只算一次意图且保留原词", () => {
    const m = detectPolMentions("深圳到santos有什么价");
    expect(m).toHaveLength(1);
    expect(m[0]!.word).toBe("深圳");
  });

  it("多港对比：蛇口+宁波 = 两个意图，不该自动收敛成一个", () => {
    const m = detectPolMentions("对比一下蛇口和宁波到santos的价");
    expect(m.map(x => x.word).sort()).toEqual(["宁波", "蛇口"].sort());
  });

  it("盐田和蛇口同群：一起说只算一次意图", () => {
    const m = detectPolMentions("盐田和蛇口哪个便宜");
    expect(m).toHaveLength(1);
  });

  it("「更新港口」不误报天津（新港别名 deny）；其他无港口词的句子返回空", () => {
    expect(detectPolMentions("帮我更新港口的联系方式")).toEqual([]);
    expect(detectPolMentions("今天天气不错")).toEqual([]);
    expect(detectPolMentions("")).toEqual([]);
  });

  it("英文别名大小写不敏感、按词边界匹配：SHANGHAI 认出上海，不因子串误报", () => {
    const m = detectPolMentions("from SHANGHAI to Santos");
    expect(m).toHaveLength(1);
    expect(m[0]!.word).toBe("SHANGHAI");
    // 词边界：XINGANG 里的 GANG / SHA 里嵌套不成立——NINGBO 完整词才认
    expect(detectPolMentions("NGB office")).toHaveLength(1);
    expect(detectPolMentions("xingang mingcheng")).toHaveLength(1); // 词边界内认天津（XINGANG 别名）
    expect(detectPolMentions("mixed SHANGHAIMERGED word")).toEqual([]); // 无边界不认
  });
});
