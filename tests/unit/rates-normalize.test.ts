import { describe, it, expect } from "vitest";
import {
  normalizeContainer, parseValidity, parseSnapshot,
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

describe("parseSnapshot — dws 快照 → 归一化行", () => {
  // 2026-08-31 从《海运运价智能台账》实拉的记录形态（含选项对象/附件数组/文本数字）
  const snapshot = {
    data: {
      records: [
        {
          recordId: "wYpsoB24bg",
          cells: {
            rj3c4Dc: "蛇口",
            M6UMJ2Y: "KINGSTON/CAUCEDO",
            xAfTdzf: { id: "dpMwinj0H2", name: "加勒比" },
            Gc7HG8P: { id: "oKkdYLNPZN", name: "CMA" },
            "4Ye7pSe": { id: "NIhCmDotkS", name: "20GP" },
            RDG9zEx: "10200",
            "32NW82C": "9.1-9.7",
            uFJRuSd: "9/07开 CMA CGM DIGNITY",
            I0vGzUV: "CMA/EMC/PIL交流群",
            "1NU3Dkx": "Mandy李龙艳",
            HbQfZtf: "2026-08-31T12:33:00+08:00",
            F5UZCQj: [{ filename: "达飞加勒比运价表_20260831.png", url: "https://…" }],
          },
        },
        {
          recordId: "g2XWbgI7Bd",
          cells: {
            M6UMJ2Y: "PANAMA (MANZANILLO PA/BALBOA/COLON FREE ZONE)",
            "4Ye7pSe": { name: "40'HC" },
            RDG9zEx: "10,400",
          },
        },
        { recordId: "empty-pod", cells: { xAfTdzf: { name: "加勒比" } } }, // 无目的港 → 丢弃
      ],
    },
  };

  const rows = parseSnapshot(snapshot);

  it("过滤无目的港行", () => {
    expect(rows).toHaveLength(2);
  });
  it("完整记录：选项对象/附件/数字文本全部归位", () => {
    const r0 = rows[0]!;
    expect(r0.recordId).toBe("wYpsoB24bg");
    expect(r0.lane).toBe("加勒比");
    expect(r0.carrier).toBe("CMA");
    expect(r0.container).toBe("20GP");
    expect(r0.oceanUsd).toBe(10200);
    expect(r0.validFrom).toBe("2026-09-01");
    expect(r0.validTo).toBe("2026-09-07");
    expect(r0.imageName).toBe("达飞加勒比运价表_20260831.png");
    expect(r0.sourceGroup).toBe("CMA/EMC/PIL交流群");
    expect(r0.sender).toBe("Mandy李龙艳");
  });
  it("稀疏记录容错 + 千分位价格 + 柜型变体归一", () => {
    const r1 = rows[1]!;
    expect(r1.container).toBe("40HQ");
    expect(r1.containerRaw).toBe("40'HC");
    expect(r1.oceanUsd).toBe(10400);
    expect(r1.lane).toBeNull();
    expect(r1.validTo).toBeNull();
  });
  it("无 recordId 时生成兜底主键", () => {
    const loose = parseSnapshot({ records: [{ cells: { M6UMJ2Y: "XPORT" } }] });
    expect(loose[0]!.recordId).toBe("local-0");
  });
  it("顶层直接是 records 数组的包装也兼容", () => {
    expect(parseSnapshot({ records: [{ recordId: "a", cells: { M6UMJ2Y: "P" } }] })).toHaveLength(1);
  });
});
