import { describe, it, expect } from "vitest";
import { parseEmailInquiry, normContainer, pickRatesForEmail } from "../../src/main/services/agent/email-parse";
import { buildRateContext } from "../../src/main/services/ai.service";

// ═══════════════════════════════════════════════════════════════
// Phase 2 闭环：来信询价要素解析 + 工作台真价匹配 + 起草提示块。
// 样例取自用户实录那封 QUOTE-1297-0926（宁波→桑托斯 1×40'HC）——就是"读过却说没柜型"的那封。
// ═══════════════════════════════════════════════════════════════

const SAMPLE = `三个物流
Technology that moves your cargo
日期：2026年9月4日
国际整箱报价申请
报价编号：QUOTE-1297-0926
尊敬的合作伙伴，
请提供以下货柜的报价：
- 贸易条款：FOB
- 起运港：宁波港 (CNNBG)
- 目的港：桑托斯 (BRSSZ, 圣保罗州)
- 货物：F.A.K. / 非危险品 / 可堆叠
- 货值：USD 17,300.00
- 柜型：1 × 40' HC
- 体积：50.16 CBM / 6,260 Kgs
请提供：
- 运费费率 / 有效期
- 航程时间
期待您的回复。`;

describe("parseEmailInquiry（来信要素结构化抽取）", () => {
  const inq = parseEmailInquiry(SAMPLE);

  it("柜型：1×40'HC → 归一 40HQ", () => {
    expect(inq.container).toBe("40HQ");
    expect(inq.containerRaw).toContain("40");
  });
  it("起运港/目的港：名与 LOCODE 分离", () => {
    expect(inq.pol).toBe("宁波港");
    expect(inq.polCode).toBe("CNNBG");
    expect(inq.pod).toBe("桑托斯");
    expect(inq.podCode).toBe("BRSSZ");
  });
  it("条款/货描/货值/询价号/体积/重量", () => {
    expect(inq.incoterm).toBe("FOB");
    expect(inq.cargo).toContain("F.A.K");
    expect(inq.cargoValueUsd).toBe(17300);
    expect(inq.quoteRef).toBe("QUOTE-1297-0926");
    expect(inq.volumeCbm).toBe(50.16);
    expect(inq.weightKg).toBe(6260);
  });
  it("抽不到的字段留 null，不猜", () => {
    const bare = parseEmailInquiry("Hi, please quote me your best price. Thanks.");
    expect(bare.container).toBeNull();
    expect(bare.pod).toBeNull();
    expect(bare.cargoValueUsd).toBeNull();
  });
});

describe("normContainer（柜型归一）", () => {
  it("HC/HQ 同义、光写尺寸给默认、NOR 保留", () => {
    expect(normContainer("40'HC")).toBe("40HQ");
    expect(normContainer("40HQ")).toBe("40HQ");
    expect(normContainer("20GP")).toBe("20GP");
    expect(normContainer("40")).toBe("40HQ");
    expect(normContainer("40NOR")).toBe("40NOR");
    expect(normContainer(null)).toBeNull();
    expect(normContainer("乱写的")).toBeNull();
  });
});

describe("pickRatesForEmail（工作台真价匹配）", () => {
  const inq = parseEmailInquiry(SAMPLE);
  const rows40 = [
    { carrier: "CMA", container: "40HQ", pol: "天津", pod: "SANTOS", price: 8000, validFrom: null, validTo: null, note: "成本价" },
    { carrier: "EMC", container: "40HQ", pol: "宁波", pod: "SANTOS", price: 9200, validFrom: "9/8", validTo: "9/14", note: null },
  ];

  it("柜型命中即选中，并按柜型过滤 rows", () => {
    const items = [
      { refId: "a", payload: { pod: "SANTOS", container: "40HC", total: 3, rows: [...rows40, { carrier: "X", container: "20GP", pol: "宁波", pod: "SANTOS", price: 5000, validFrom: null, validTo: null, note: null }] } },
    ];
    const got = pickRatesForEmail(inq, items);
    expect(got).not.toBeNull();
    expect(got!.rows!.every(r => normContainer(r.container) === "40HQ")).toBe(true);
    expect(got!.rows).toHaveLength(2);   // 20GP 那条被柜型过滤掉
  });

  it("多候选都不匹配（柜型/港都对不上）→ null（宁可不注入，不乱报价）", () => {
    const items = [
      { refId: "a", payload: { pod: "MANZANILLO", container: "20GP", rows: [{ carrier: "A", container: "20GP", pol: "X", pod: "MANZANILLO", price: 1, validFrom: null, validTo: null, note: null }] } },
      { refId: "b", payload: { pod: "PIRAEUS", container: "40NOR", rows: [{ carrier: "B", container: "40NOR", pol: "Y", pod: "PIRAEUS", price: 2, validFrom: null, validTo: null, note: null }] } },
    ];
    expect(pickRatesForEmail(inq, items)).toBeNull();
  });

  it("只有一个候选且无强匹配 → 用它（读信→查价→起草的单查询流）", () => {
    const items = [{ refId: "a", payload: { pod: "SANTOS", container: null, rows: rows40 } }];
    const got = pickRatesForEmail(inq, items);
    expect(got).not.toBeNull();
    expect(got!.rows).toHaveLength(2);
  });

  it("空 rows / 无候选 → null", () => {
    expect(pickRatesForEmail(inq, [])).toBeNull();
    expect(pickRatesForEmail(inq, [{ refId: "a", payload: { rows: [] } }])).toBeNull();
  });
});

describe("buildRateContext（起草提示块）", () => {
  it("有真价 → 硬口径：据此报价、禁编造/占位，并列出行", () => {
    const block = buildRateContext(
      [{ carrier: "EMC", container: "40HQ", pol: "宁波", pod: "SANTOS", price: 9200, validFrom: "9/8", validTo: "9/14", note: null }],
      { container: "40HQ", pod: "桑托斯", incoterm: "FOB", quoteRef: "QUOTE-1297-0926" },
    );
    expect(block).toContain("真实运价");
    expect(block).toContain("禁止编造");
    expect(block).toContain("EMC");
    expect(block).toContain("9200");
    expect(block).toContain("来信要素");
    expect(block).toContain("40HQ");
  });
  it("无价无要素 → 空串（不注入噪音）", () => {
    expect(buildRateContext(null, null)).toBe("");
    expect(buildRateContext([], undefined)).toBe("");
  });
  it("只有要素没有价 → 只出来信要素，不谎称有运价", () => {
    const block = buildRateContext(null, { container: "40HQ", pod: "桑托斯" });
    expect(block).toContain("来信要素");
    expect(block).not.toContain("真实运价");
  });
});
