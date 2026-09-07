import { describe, it, expect } from "vitest";
import {
  cleanPol, cleanPod, cleanCarrier, parsePrices, cleanFreeDays, cleanEtd, quoteState,
  stripLaneTag, fmtValidity, fmtEtdShort, cleanQuoteRow, pivotQuotes, groupByPol,
  cleanTableMarkdown, customerQuoteMarkdown, locatePodLines, type QuoteRowRaw,
} from "../../src/main/services/rates-clean";

// 真源实测原文 A：一条消息拆成 4 个 pod 行，价对四港共享（USD3300/3900+）
const TEXT_A = [
  "CMA 土耳其推广 9.1~9.30   一水  5高    不能 电放  可以 SW或者正本",
  "POL 盐田/蛇口   南沙",
  "ISTANBUL/ IZMIT/ MERSIN/ ALIAGA",
  "USD3300/3900+",
  "21 combined",
  "现舱",
  "9.21   蛇口 -IZMIT   3高     BEX  TEXAS  TRIUMPH  0BXOLW1MA",
  "9.16   蛇口-ISTanbul   1高   COSCO SHIPPING ROSE 0BXOJW1MA",
].join("\n");

// 真源实测原文 B：同一条消息里不同港不同价 —— 错价高危样例
const TEXT_B = [
  "南沙 CUL  直航快船CLS9.11",
  "ALEX   4200/5100",
  "ISTANBUL/MERSIN/ALIAGA 4100/4800",
  "ETD-6取消，亏仓费CNY300/柜",
  "埃及目免21，土耳其14，+USD150/300买21",
].join("\n");

const row = (o: Partial<QuoteRowRaw> = {}): QuoteRowRaw => ({
  carrier: null, pol: null, podRaw: null, lane: null, container: null, containerRaw: null,
  oceanUsd: null, freeDays: null, etd: null, validityRaw: null, validFrom: null, validTo: null,
  note: null, sourceGroup: null, sender: null, msgTime: null, syncedAt: null, status: null,
  messageText: null, ...o,
});
const prices = (o: Partial<Parameters<typeof parsePrices>[0]> = {}) =>
  parsePrices({ container: null, oceanUsd: null, messageText: null, note: null, pods: [], ...o });

describe("起运港：固定十值 + 拆开多港（真源脏值实测）", () => {
  it("深圳与大铲湾归到蛇口/盐田/南沙三候选，不猜一个", () => {
    expect(cleanPol("深圳").pols).toEqual(["蛇口", "盐田", "南沙"]);
    expect(cleanPol("大铲湾").pols).toEqual(["蛇口", "盐田", "南沙"]);
  });
  it("+ 与 / 分隔的多港串拆开", () => {
    expect(cleanPol("青岛+太仓+南沙").pols).toEqual(["青岛", "南沙"]);
    expect(cleanPol("蛇口/香港/盐田/厦门").pols).toEqual(["蛇口", "盐田", "厦门"]);
    expect(cleanPol("盐田/蛇口").pols).toEqual(["盐田", "蛇口"]);
  });
  it("全角括号与英文长串", () => {
    expect(cleanPol("天津新港（Xingang）").pols).toEqual(["天津"]);
    expect(cleanPol("天津新港（XINGANG）").pols).toEqual(["天津"]);
    expect(cleanPol("Dalian, Dalian, Liaoning, China;Shekou, Shenzhen, Guangdong, China;Xiamen, Xiamen, Fujian, China").pols)
      .toEqual(expect.arrayContaining(["大连", "蛇口", "盐田", "南沙", "厦门"]));
  });
  it("三字码串：认得的归一，不认得的进 leftovers 并标待核实", () => {
    const r = cleanPol("SGH/NPO/YAT/YOK/BUS；TST/HSK");
    expect(r.pols).toContain("盐田");                 // YAT
    expect(r.unverified.join()).toContain("非十值");
  });
  it("非十值口岸不硬塞", () => {
    expect(cleanPol("福州").pols).toEqual([]);
    expect(cleanPol("福州").unverified[0]).toContain("福州");
  });
});

describe("目的港：标准英文唯一名（全大写）", () => {
  it("剥译名/国别括注/尾部航线小字", () => {
    expect(cleanPod("ISTANBUL 伊斯坦布尔(土耳其) 地东").pods).toEqual(["ISTANBUL"]);
    expect(cleanPod("BALBOA, PA 巴尔博亚(巴拿马)").pods).toEqual(["BALBOA"]);
    expect(cleanPod("Santos").pods).toEqual(["SANTOS"]);
  });
  it("多港拆开去重", () => {
    expect(cleanPod("ISTANBUL/ IZMIT/ MERSIN/ ALIAGA").pods)
      .toEqual(["ISTANBUL", "IZMIT", "MERSIN", "ALIAGA"]);
  });
});

describe("船司：真源 26 个实测值", () => {
  it("中文与长名归一，三字码原样采信", () => {
    expect(cleanCarrier("中远海特").carrier).toBe("COSCO");
    expect(cleanCarrier("SINOTRANS 外运").carrier).toBe("SINOTRANS");
    expect(cleanCarrier("CUL").carrier).toBe("CUL");
    expect(cleanCarrier("AKKON").carrier).toBe("AKKON");
  });
  it("「未注明」不是船司名 → 空", () => {
    expect(cleanCarrier("未注明").carrier).toBe("");
  });
});

describe("三列柜型价：结构化优先，原文按港定位（防错价）", () => {
  it("container_type 真源枚举 40HQ/HC 归 40HQ|HC 列", () => {
    expect(prices({ container: "40HQ/HC", oceanUsd: 4800 }).p40).toBe(4800);
    expect(prices({ container: "20GP", oceanUsd: 3300 }).p20).toBe(3300);
    expect(prices({ container: "40NOR", oceanUsd: 5200 }).pNor).toBe(5200);
  });
  it("样例A：结构化只有 40HQ/HC=3900，20GP=3300 从原文补（港组共享价）", () => {
    const r = prices({ container: "40HQ/HC", oceanUsd: 3900, messageText: TEXT_A, pods: ["ALIAGA"] });
    expect(r.p40).toBe(3900);
    expect(r.p20).toBe(3300);
  });
  it("样例B：pod=ALIAGA 必须取 4100/4800，绝不能取 ALEX 那行的 4200/5100", () => {
    const aliaga = prices({ container: "40HQ/HC", oceanUsd: 4800, messageText: TEXT_B, pods: ["ALIAGA"] });
    expect(aliaga.p20).toBe(4100);
    expect(aliaga.p40).toBe(4800);
    const alex = prices({ container: "40HQ/HC", oceanUsd: 5100, messageText: TEXT_B, pods: ["ALEX"] });
    expect(alex.p20).toBe(4200);
    expect(alex.p40).toBe(5100);
  });
  it("多处不同价又定位不到本港 → 不猜，标待核实", () => {
    const r = prices({ container: null, oceanUsd: null, messageText: TEXT_B, pods: ["UNKNOWNPORT"] });
    expect([r.p20, r.p40, r.pNor]).toEqual([null, null, null]);
    expect(r.unverified.join()).toContain("未按港定位");
  });
  it("高 2000 / 小 1000", () => {
    expect(prices({ messageText: "高 2000 小1000" }).p40).toBe(2000);
    expect(prices({ messageText: "高 2000 小1000" }).p20).toBe(1000);
  });
  it("解析不出三列全空并标待核实（不填 0）", () => {
    const r = prices({ messageText: "价格面议" });
    expect([r.p20, r.p40, r.pNor]).toEqual([null, null, null]);
    expect(r.unverified.join()).toContain("三列未解析");
  });
  it("柜型为 null 的价不入三列，改进备注（塞错列就是错价）", () => {
    const c = cleanQuoteRow(row({
      carrier: "CMA", pol: "天津", podRaw: "SANTOS", container: null, oceanUsd: 9894, validTo: "2099-12-31",
    }));
    expect([c.p20, c.p40, c.pNor]).toEqual([null, null, null]);
    expect(c.note).toContain("未标柜型价 $9,894");
  });
  it("按港定位原文行", () => {
    expect(locatePodLines(TEXT_B, ["ALIAGA"])).toContain("4100/4800");
    expect(locatePodLines(TEXT_B, ["ALEX"])).toContain("4200/5100");
    expect(locatePodLines(TEXT_B, ["NOWHERE"])).toBeNull();
  });
});

describe("目免：按国别/港定位，不按第一个数字", () => {
  it("free_days 有值直接采信；1-30 之外转备注", () => {
    expect(cleanFreeDays({ freeDays: "14", messageText: null, note: null, pods: [] }).days).toBe(14);
    expect(cleanFreeDays({ freeDays: "45", messageText: null, note: null, pods: [] })).toMatchObject({ days: null });
  });
  it("样例B：土耳其港取 14，埃及港取 21（真源 free_days 全为 null）", () => {
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_B, note: null, pods: ["ALIAGA"] }).days).toBe(14);
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_B, note: null, pods: ["ALEX"] }).days).toBe(21);
  });
  it("样例A：21 combined 无限定词但全篇唯一 → 采信", () => {
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_A, note: null, pods: ["ALIAGA"] }).days).toBe(21);
  });
});

describe("ETD：结构化优先，原文兜底且按港定位", () => {
  it("结构化 etd 与 9.6晚开9.10（前截关后开船）", () => {
    expect(cleanEtd({ etd: "2026-09-18", messageText: null, msgTime: null, pods: [] })).toBe("2026-09-18");
    expect(cleanEtd({ etd: null, messageText: "9.6晚开9.10 SANTOS", msgTime: "2026-09-03", pods: ["SANTOS"] }))
      .toMatch(/^\d{4}-09-10$/);
  });
  it("样例A：IZMIT 取 9.21 那行，ISTANBUL 取 9.16 那行", () => {
    expect(cleanEtd({ etd: null, messageText: TEXT_A, msgTime: "2026-09-03", pods: ["IZMIT"] })).toMatch(/-09-21$/);
    expect(cleanEtd({ etd: null, messageText: TEXT_A, msgTime: "2026-09-03", pods: ["ISTANBUL"] })).toMatch(/-09-16$/);
  });
  it("解析不出返回 null，不猜", () => {
    expect(cleanEtd({ etd: null, messageText: "船期待定", msgTime: null, pods: [] })).toBeNull();
  });
});

describe("状态与报价格式", () => {
  it("状态由有效期函数判断（不新增存储列）", () => {
    expect(quoteState("2099-12-31")).toBe("当前有效");
    expect(quoteState(null)).toBe("当前有效");
    expect(quoteState("2000-01-01")).toBe("已过期");
  });
  it("VALIDITY / ETD 报价格式", () => {
    expect(fmtValidity("2026-09-01", "2026-09-15")).toBe("1-15 Sep");
    expect(fmtValidity("2026-08-31", "2026-09-06")).toBe("31 Aug – 6 Sep");
    expect(fmtValidity(null, "2026-09-16")).toBe("16 Sep");
    expect(fmtValidity(null, null)).toBe("/");
    expect(fmtEtdShort("2026-09-16")).toBe("16 Sep");
    expect(fmtEtdShort(null)).toBe("/");
  });
});

describe("清洗成行 / 宽表透视 / 按港分组", () => {
  it("真源样例A的一行 → 规范行（三列价齐、目免 21、ETD 9.21、状态当前有效）", () => {
    const c = cleanQuoteRow(row({
      carrier: "CMA", pol: "盐田/蛇口", podRaw: "ALIAGA", lane: "地东",
      container: "40HQ/HC", oceanUsd: 3900, validityRaw: "9.1~9.30",
      validFrom: "2026-09-01", validTo: "2026-09-30", messageText: TEXT_A,
      note: "CMA土耳其推广；21 combined", sourceGroup: "土耳其价格更新", sender: "杜佳仪 Alby",
      msgTime: "2026-09-07 15:03", syncedAt: "2026-09-07T07:40:31.000Z", status: "当前生效",
    }));
    expect(c.carrier).toBe("CMA");
    expect(c.pols).toEqual(["盐田", "蛇口"]);
    expect(c.pod).toBe("ALIAGA");
    expect(c.lane).toBe("地东");
    expect(c.p40).toBe(3900);
    expect(c.p20).toBe(3300);
    expect(c.freeDays).toBe(21);
    expect(c.state).toBe("当前有效");
    expect(c.unverified).toEqual([]);
  });

  it("同船司同港同效期的多柜型行合并成一行三列", () => {
    const merged = pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 1000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "40HQ/HC", oceanUsd: 2000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "40NOR", oceanUsd: 1200, validTo: "2099-12-31" })),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ p20: 1000, p40: 2000, pNor: 1200 });
  });

  it("按起运港分组：多港行在每个候选港都计一次", () => {
    const g = groupByPol(pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "天津", podRaw: "SANTOS", container: "20GP", oceanUsd: 3200 })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 3000 })),
      cleanQuoteRow(row({ carrier: "CUL", pol: "南沙", podRaw: "ALIAGA", container: "40HQ/HC", oceanUsd: 4800 })),
    ]));
    expect(g.find(x => x.pol === "青岛")?.cheapest).toBe(3000);
    expect(g.find(x => x.pol === "南沙")?.cheapest).toBe(4800);
    expect(g.find(x => x.pol === "南沙")?.cheapestCol).toBe("40HQ/HC");
  });
});

describe("两张表的形态", () => {
  const rows = pivotQuotes([cleanQuoteRow(row({
    carrier: "中远海特", pol: "宁波", podRaw: "MANZANILLO 曼萨尼略(墨西哥) 墨西哥", lane: "墨西哥",
    container: "40HQ/HC", oceanUsd: 1800, freeDays: "7", etd: "2026-09-16",
    validFrom: "2026-09-01", validTo: "2026-09-15", sourceGroup: "墨西哥群", sender: "李四",
    msgTime: "2026-09-03", syncedAt: "2026-09-07T01:00:00.000Z", note: "含 AMS",
  }))]);

  it("工作结果表：字段顺序锁死", () => {
    const t = cleanTableMarkdown(rows);
    expect(t.split("\n")[0]).toBe("| 船司 | 起运港 | 目的港 | 20GP | 40HQ/HC | 40NOR | 目免 | 有效期 | 备注 | 来源 | 发送人 | 入库时间 |");
    expect(t).toContain("COSCO");
    expect(t).toContain("MANZANILLO");
    expect(t).toContain("1-15 Sep");
  });

  it("客户报价表：十一列、缺项与 TT 一律 /", () => {
    const t = customerQuoteMarkdown(rows);
    expect(t.split("\n")[0]).toBe("| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |");
    const body = t.split("\n")[2]!;
    expect(body).toContain("| NINGBO |");
    expect(body).toContain("| MANZANILLO |");
    expect(body).toContain("| 16 Sep |");
    expect(body.split("|").length).toBe(13);          // 11 列 + 首尾空段
    expect(body.slice(body.indexOf("| 1-15 Sep |"))).toContain("| / |");   // TT 恒 /
  });

  it("多起运港在客户表里拆行（POL 唯一）", () => {
    const multi = pivotQuotes([cleanQuoteRow(row({
      carrier: "CUL", pol: "深圳", podRaw: "ALIAGA", container: "40HQ/HC", oceanUsd: 4800, validTo: "2099-12-31",
    }))]);
    const lines = customerQuoteMarkdown(multi).split("\n").slice(2);
    expect(lines.length).toBe(3);                     // 蛇口 / 盐田 / 南沙 各一行
    expect(lines.join()).toContain("SHEKOU");
  });
});

describe("尾缀剥离护栏", () => {
  it("正常形态不切碎", () => {
    expect(stripLaneTag("BALBOA, PA 巴尔博亚(巴拿马)", "加勒比").podRaw).toBe("BALBOA, PA 巴尔博亚(巴拿马)");
    expect(stripLaneTag("PANAMA (MANZANILLO PA/BALBOA)", "加勒比").podRaw).toBe("PANAMA (MANZANILLO PA/BALBOA)");
    expect(stripLaneTag("MANZANILLO", "墨西哥").podRaw).toBe("MANZANILLO");
    expect(stripLaneTag("ISTANBUL 伊斯坦布尔(土耳其) 地东", null)).toEqual({ podRaw: "ISTANBUL 伊斯坦布尔(土耳其)", lane: "地东" });
  });
});
