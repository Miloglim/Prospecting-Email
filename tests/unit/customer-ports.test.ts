import { describe, expect, it } from "vitest";
import {
  parsePreferredPorts, normalizePodName, prefsFromManual, cleanPortSegment, MAX_PREFS,
} from "../../src/main/services/customer-ports";

// ═══════════════════════════════════════════════════════════════════
// 港口偏好派生的纯逻辑（规范 docs/rate-update-push-spec.md §2）。
// 钉三件真出过事的地方：extra.preferredPorts 的历史双形态、脏港段归一、
// 人工登记与来信推断打平时谁说了算。
// ═══════════════════════════════════════════════════════════════════

describe("extra.preferredPorts 双形态解析（看板写的是 JSON 字符串，导入/AI 可能写数组）", () => {
  it("看板形态：字符串里套 JSON 数组", () => {
    expect(parsePreferredPorts(JSON.stringify([{ pol: "Ningbo", pod: "Santos" }])))
      .toEqual([{ pol: "Ningbo", pod: "Santos" }]);
  });

  it("数组形态（AI 写档案/导入直接塞数组）也认", () => {
    expect(parsePreferredPorts([{ pol: "", pod: "Veracruz" }])).toEqual([{ pol: "", pod: "Veracruz" }]);
  });

  it("脏数据一律不炸：非 JSON 字符串、null 项、缺 pod 的条目都剔掉", () => {
    expect(parsePreferredPorts("not json")).toEqual([]);
    expect(parsePreferredPorts(undefined)).toEqual([]);
    expect(parsePreferredPorts(null)).toEqual([]);
    expect(parsePreferredPorts("[]")).toEqual([]);
    expect(parsePreferredPorts([null, { pol: "X" }, { pod: "" }, { pod: "Santos" }])).toEqual([{ pol: "", pod: "Santos" }]);
    expect(parsePreferredPorts({ pod: "Santos" })).toEqual([]);   // 对象不是数组 → 不猜
  });
});

describe("港名归一（来信里那段往往是脏的）", () => {
  it("「Santos - BRSSZ (Santos, SP)」这类脏段 → 标准港名大写", () => {
    expect(normalizePodName({ pod: "Santos - BRSSZ (Santos, SP)", podCode: null })).toBe("SANTOS");
  });

  it("只给 LOCODE 也能归一", () => {
    expect(normalizePodName({ pod: null, podCode: "BRSSZ" })).toBe("SANTOS");
  });

  it("抽不到港返回 null，不拿别的港凑数", () => {
    expect(normalizePodName({ pod: "", podCode: null })).toBeNull();
    expect(normalizePodName({ pod: null, podCode: null })).toBeNull();
    expect(normalizePodName({ pod: "  ", podCode: "" })).toBeNull();
  });
});

describe("来信标签行的尾巴不混进港口（parseEmailInquiry 抓整行，偏好层再收紧）", () => {
  it("第一个逗号/分号前 + 柜型数量词前截断", () => {
    expect(cleanPortSegment("Santos - BRSSZ, ready cargo 2 x 40HQ")).toBe("Santos - BRSSZ");
    expect(cleanPortSegment("SANTOS (Brazil), 1 x 20GP.")).toBe("SANTOS (Brazil)");
    expect(cleanPortSegment("Cartagena, Colombia. Container: 3 x 20GP")).toBe("Cartagena");
    expect(cleanPortSegment("Veracruz")).toBe("Veracruz");
    expect(cleanPortSegment("   ")).toBeNull();
    expect(cleanPortSegment(null)).toBeNull();
  });

  it("收紧后再归一，脏行也能落到镜像标准港名", () => {
    expect(normalizePodName({ pod: "Santos - BRSSZ, ready cargo 2 x 40HQ", podCode: null })).toBe("SANTOS");
  });
});

describe("人工偏好 → PortPref（同港重复条目合并）", () => {
  it("登记过的港 score=4、出处=manual、hits 记 0（hits 只统计来信）", () => {
    const [p] = prefsFromManual([{ pol: "Ningbo", pod: "Santos" }]);
    expect(p).toMatchObject({ pod: "SANTOS", pol: "Ningbo", score: 4, sources: ["manual"], hits: 0 });
    expect(p?.lastSeenAt).toBeNull();
  });

  it("同一港登记两条（不同起运港）合并成一条、分数累加、pol 保留首个", () => {
    const list = prefsFromManual([{ pol: "Ningbo", pod: "Santos" }, { pol: "Shanghai", pod: "SANTOS" }]);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ pod: "SANTOS", pol: "Ningbo", score: 8 });
  });

  it("归一不到港名的条目也不丢弃（保留大写原文），但空 pod 进不来", () => {
    const list = prefsFromManual([{ pol: "", pod: "somecodeplace" }]);
    expect(list[0]?.pod).toBe("SOMECODEPLACE");
    expect(prefsFromManual([{ pol: "", pod: "a" }])).toEqual([]);   // 一个字母不足以认定为港
  });

  it("MAX_PREFS 是界面与方案的共同上限", () => {
    expect(MAX_PREFS).toBeGreaterThan(1);
  });
});
