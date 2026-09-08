import { describe, expect, it } from "vitest";
import { customerRemarkEn } from "../../src/main/services/rates-clean";

// ═══════════════════════════════════════════════════════════════════
// 客户报价表 REMARK 英化出口（用户定案：客户表全英文，内部信息不外流）。
// 素材 = 2026-09-08 会话导出里 QUOTE-1297-0926 草稿表格的 9 条真实台账备注——
// 当时它们带着「成本价」「批价8800…刷箱」这类中文直接发到了客户邮件里，就是事故。
// 铁律：内部词整条判丢 → 有限词表机械译英 → 译完仍含中文一律置 "/"（宁可空，不中英混排）。
// ═══════════════════════════════════════════════════════════════════

describe("customerRemarkEn（会话导出实锤的 9 条真备注）", () => {
  it("内部操作语整条判丢：成本价 / 批价+刷箱+可以申请 / 特价合约舱位", () => {
    expect(customerRemarkEn("成本价")).toBe("/");
    expect(customerRemarkEn("现舱申请已批价8800（对比FAK 9.8-9.14 为9200）；今天才开始刷箱，有需要的可以申请")).toBe("/");
    expect(customerRemarkEn("成本价；特价合约舱位 2个高柜")).toBe("/");
  });

  it("船期变更与附加费：译完全英，数字与单位原样保留", () => {
    expect(customerRemarkEn("蛇口9/14 delay至9/21 FL2-HYUNDAI TOKYO 0165W；20GP VGM低于10吨可-100"))
      .toBe("SHEKOU 9/14 delayed to 9/21 FL2-HYUNDAI TOKYO 0165W; 20GP VGM under 10t -100");
    expect(customerRemarkEn("重柜费：毛重18-23.99吨USD100/20'DC，24吨及以上USD300/20'DC"))
      .toBe("Heavy-duty surcharge: gross weight 18-23.99t USD100/20'DC, 24t and above USD300/20'DC");
    expect(customerRemarkEn("含EFS +$150/TEU Dry,+$90/TEU Reefer；随机抽单收碳排放usd30/60；ISPS14,F"))
      .toBe("incl. EFS +$150/TEU Dry,+$90/TEU Reefer; random carbon audit usd30/60; ISPS14,F");
  });

  it("舱位动态与价格更新：航线名给受控英文缩写", () => {
    expect(customerRemarkEn("PIL南美东可以继续收货；ES2/CMA CGM IRON 8.29拖班到9.11；SSZ/RIO: -100/BOX；"))
      .toBe("PIL S.America open for booking; ES2/CMA CGM IRON 8.29 shifted to 9.11; SSZ/RIO: -100/BOX;");
    expect(customerRemarkEn("feeder before 9.14 connect ASE QIE 11W；ZIM南美东参考价格"))
      .toBe("feeder before 9.14 connect ASE QIE 11W; ZIM S.America ref. rate");
    expect(customerRemarkEn("降价更新（图片价格表 VALID 9/SEP-14/SEP）"))
      .toBe("rate update (price sheet VALID 9/SEP-14/SEP)");
  });

  it("空与未知词：空给 "/"，词表盖不住的中文绝不外流", () => {
    expect(customerRemarkEn(null)).toBe("/");
    expect(customerRemarkEn("   ")).toBe("/");
    expect(customerRemarkEn("满舱请电询")).toBe("/");                 // 词表没盖住 → 置空，不出中英混排
    expect(customerRemarkEn("space taking")).toBe("space taking");   // 纯英文原样过
  });
});
