import { describe, it, expect } from "vitest";
import {
  normalizeContainer, parseValidity, mapRemoteRow,
} from "../../src/main/services/rate-sync.service";

describe("normalizeContainer — 柜型脏值归一", () => {
  it("标准码原样归一", () => {
    expect(normalizeContainer("20GP")).toBe("20GP");
    expect(normalizeContainer("40GP")).toBe("40GP");
    expect(normalizeContainer("40HQ")).toBe("40HQ");
  });
  it("撇号/引号变体折叠", () => {
    expect(normalizeContainer("40'HC")).toBe("40HQ");
    expect(normalizeContainer("40'GP")).toBe("40GP");
    expect(normalizeContainer("40HC")).toBe("40HQ");
  });
  it("组合柜型价排序合并为 A+B", () => {
    expect(normalizeContainer("40GP/40HC")).toBe("40GP+40HQ");
    expect(normalizeContainer("40HQ/HC")).toBe("40HQ");
  });
  it("NOR 系归一", () => {
    expect(normalizeContainer("NOR")).toBe("NOR");
    expect(normalizeContainer("40NOR")).toBe("NOR");
  });
  it("空/未知返回 null", () => {
    expect(normalizeContainer(null)).toBeNull();
    expect(normalizeContainer("面议")).toBeNull();
  });
});

describe("parseValidity — 有效期文本解析", () => {
  it("点分格式 + 消息年份", () => {
    expect(parseValidity("9.1-9.7", "2026-08-31T12:33:00+08:00"))
      .toEqual({ validFrom: "2026-09-01", validTo: "2026-09-07" });
  });
  it("中文月日格式", () => {
    expect(parseValidity("9月1日-9月7日", "2026-08-31"))
      .toEqual({ validFrom: "2026-09-01", validTo: "2026-09-07" });
  });
  it("跨年区间结束年份 +1", () => {
    expect(parseValidity("12.28-1.5", "2026-12-01"))
      .toEqual({ validFrom: "2026-12-28", validTo: "2027-01-05" });
  });
  it("补零与波浪线/至 分隔符", () => {
    expect(parseValidity("1.5 ~ 1.20", "2026-x"))
      .toEqual({ validFrom: "2026-01-05", validTo: "2026-01-20" });
  });
  it("不可解析返回 null 对", () => {
    expect(parseValidity("长期有效", null)).toEqual({ validFrom: null, validTo: null });
    expect(parseValidity(null, null)).toEqual({ validFrom: null, validTo: null });
    expect(parseValidity("99.99-88.88", null)).toEqual({ validFrom: null, validTo: null });
  });
});

describe("mapRemoteRow — board_server 行 → 归一化镜像行", () => {
  // board_server /api/rates 的行形态（字段名与本地 schema 不一致，靠别名容错）
  const fullRow = {
    record_id: "wYpsoB24bg",
    pol: "蛇口",
    pod: "KINGSTON/CAUCEDO",
    lane: "加勒比",
    carrier: "CMA",
    container_type: "20GP",
    freight_usd: 10200,
    validity_raw: "9.1-9.7",
    valid_from: "2026-09-01",
    valid_to: "2026-09-07",
    free_days: "9/07开 CMA CGM DIGNITY",
    shortfall_fee: "RMB3000",
    note: "9/07开 CMA CGM DIGNITY",
    source_group: "CMA/EMC/PIL交流群",
    sender: "Mandy李龙艳",
    msg_time: "2026-08-31T12:33:00+08:00",
    image_name: "达飞加勒比运价表_20260831.png",
  };

  it("完整行：直采 valid_from/valid_to，数字运价照收", () => {
    const r = mapRemoteRow(fullRow, "remote-0")!;
    expect(r.recordId).toBe("wYpsoB24bg");
    expect(r.podRaw).toBe("KINGSTON/CAUCEDO");
    expect(r.lane).toBe("加勒比");
    expect(r.carrier).toBe("CMA");
    expect(r.container).toBe("20GP");
    expect(r.oceanUsd).toBe(10200);
    expect(r.validFrom).toBe("2026-09-01");
    expect(r.validTo).toBe("2026-09-07");
    expect(r.sourceGroup).toBe("CMA/EMC/PIL交流群");
    expect(r.sender).toBe("Mandy李龙艳");
    expect(r.imageName).toBe("达飞加勒比运价表_20260831.png");
  });

  it("别名容错：container_type/freight_usd/pod 都能取到；缺 valid_* 时本地解析 validity_raw", () => {
    const r = mapRemoteRow({
      pod_raw: "PANAMA (MANZANILLO PA/BALBOA)",
      container_type: "40'HC",
      freight_usd: "10,400",
      validity_raw: "9.1-9.7",
      msg_time: "2026-08-31T12:33:00+08:00",
    }, "remote-1")!;
    expect(r.container).toBe("40HQ");
    expect(r.containerRaw).toBe("40'HC");
    expect(r.oceanUsd).toBe(10400);
    expect(r.validFrom).toBe("2026-09-01");
    expect(r.validTo).toBe("2026-09-07");
    expect(r.lane).toBeNull();
  });

  it("无目的港的行返回 null 跳过；无 record_id 用兜底主键", () => {
    expect(mapRemoteRow({ lane: "加勒比" }, "remote-2")).toBeNull();
    expect(mapRemoteRow({ pod: "XPORT" }, "remote-3")!.recordId).toBe("remote-3");
  });
});
