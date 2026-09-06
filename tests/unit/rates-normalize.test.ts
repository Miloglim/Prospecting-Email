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

describe("mapRemoteRow — board_server 行 → 归一化镜像行（键名=2026-09-06 线上实测）", () => {
  // 实测样例（docs/运价接口字段对接说明.md §4）：freight_usd 是字符串、备注叫 remark、航线叫 route
  const fullRow = {
    id: 1477, pol: "宁波", pod: "MANZANILLO", route: "墨西哥",
    carrier: "ZIM", container_type: "20GP", freight_usd: "6815.00",
    validity_raw: "9.6", valid_from: "2026-09-06", valid_to: "2026-09-06",
    etd: null, free_days: null, dead_freight: null,
    remark: "ZIM墨西哥现舱；ams另加30；JADE I/9E ETD 9.6",
    source_group: "宁波舱位滚动更新群", sender: "罗瑶 Lorraine",
    message_time: "2026-09-03",
    image_url: "1477-宁波-nb_zim_mx.png", status: "当前生效",
    content_key: "97025e16abc", mid: null,
  };

  it("完整行：route→lane / remark→note / content_key→recordId / 独立采信 valid_*", () => {
    const r = mapRemoteRow(fullRow, "remote-0")!;
    expect(r.recordId).toBe("97025e16abc");
    expect(r.podRaw).toBe("MANZANILLO");
    expect(r.lane).toBe("墨西哥");
    expect(r.carrier).toBe("ZIM");
    expect(r.container).toBe("20GP");
    expect(r.oceanUsd).toBe(6815);            // 字符串 "6815.00" → 数字
    expect(r.validFrom).toBe("2026-09-06");
    expect(r.validTo).toBe("2026-09-06");
    expect(r.note).toBe("ZIM墨西哥现舱；ams另加30；JADE I/9E ETD 9.6");
    expect(r.shortfallFee).toBeNull();        // dead_freight 为 null
    expect(r.imageName).toBe("1477-宁波-nb_zim_mx.png");
    expect(r.msgTime).toBe("2026-09-03");
  });

  it("别名容错：缺 valid_to 时本地解析 validity_raw 补上；container_type null 容错", () => {
    const r = mapRemoteRow({
      pod: "PANAMA (MANZANILLO PA/BALBOA)",
      route: "加勒比",
      carrier: "CMA",
      container_type: null,
      freight_usd: "10,400.50",
      validity_raw: "9.1-9.7",
      message_time: "2026-08-31 17:59",
      dead_freight: "RMB3000",
    }, "remote-1")!;
    expect(r.container).toBeNull();           // 柜型没标就是没标，不猜
    expect(r.oceanUsd).toBe(10401);           // 千分位+小数字符串
    expect(r.validFrom).toBe("2026-09-01");   // 服务端没给，本地解析补
    expect(r.validTo).toBe("2026-09-07");
    expect(r.lane).toBe("加勒比");
    expect(r.shortfallFee).toBe("RMB3000");   // dead_freight 别名命中
    expect(r.msgTime).toBe("2026-08-31 17:59");
  });

  it("无目的港的行返回 null 跳过；无 content_key 用兜底主键", () => {
    expect(mapRemoteRow({ route: "加勒比" }, "remote-2")).toBeNull();
    expect(mapRemoteRow({ pod: "XPORT" }, "remote-3")!.recordId).toBe("remote-3");
  });
});
