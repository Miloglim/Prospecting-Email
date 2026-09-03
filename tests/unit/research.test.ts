import { describe, expect, it, vi } from "vitest";
import { CRED_LABEL } from "../../src/main/services/research.service";

// ═══════════════════════════════════════════════════════════════════
// 联网调研底座：方法论里「不靠提示词自觉」的那几条硬规则，全部落成可单测的纯函数
// （来源分级、日期识别、金额抽取、交叉核对、结论数字回溯），外加一条
// 打桩跑通整条管线的编排测试（检索 → 抓页 → 分级 → 成稿 → 落文件）。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/services/ai.service", () => ({
  searchWeb: vi.fn(),
  chatJson: vi.fn(),
  hasSearchSource: vi.fn(() => true),
}));
vi.mock("../../src/main/net-proxy", () => ({ netFetch: vi.fn() }));
vi.mock("../../src/main/services/artifact.service", () => ({
  writeArtifact: vi.fn(() => ({ success: true, data: { name: "report.md", path: "/tmp/report.md", sizeBytes: 123, format: "md" } })),
}));

const R = await import("../../src/main/services/research.service");
const A = await import("../../src/main/services/ai.service");
const NP = await import("../../src/main/net-proxy");

/** 相对今天往前 N 天的日期串（测试不锁死真实时钟） */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("调研底座：来源分级与字段抽取", () => {
  it("来源优先级按域名分层：船司官网 > 聚合平台 > 行业媒体 > 陌生营销页", () => {
    expect(R.sourceTier("https://www.msc.com/en/news")).toBe(1);
    expect(R.sourceTier("https://www.searates.com/rate/santos")).toBe(2);
    expect(R.sourceTier("https://theloadstar.com/xyz")).toBe(4);
    expect(R.sourceTier("https://some-forwarder-blog.tld/post")).toBe(5);
  });

  it("日期识别覆盖 JSON-LD / 中英两种语序，认不出就不给（宁可标可能过期）", () => {
    expect(R.extractPublished('meta datePublished: "2026-08-30T10:00:00Z"').iso).toBe("2026-08-30");
    expect(R.extractPublished("Updated: 2026-08-28 by editor").iso).toBe("2026-08-28");
    expect(R.extractPublished("发布日期：2026年8月28日").iso).toBe("2026-08-28");
    expect(R.extractPublished("Published 30 Aug 2026").iso).toBe("2026-08-30");
    expect(R.extractPublished("没有日期的正文").iso).toBeUndefined();
  });

  it("金额抽取认得住币种前后缀与裸四位数，但不把年份和柜型当运价", () => {
    expect(R.extractAmounts("40HQ ocean freight USD 3,200 per container")).toContain(3200);
    expect(R.extractAmounts("桑托斯运价 3150，20GP 1800")).toEqual(expect.arrayContaining([3150, 1800]));
    const noYear = R.extractAmounts("2026 年的报价 3200，有效期到 2026-09-30");
    expect(noYear).toContain(3200);
    expect(noYear).not.toContain(2026);
    expect(R.extractAmounts("40HQ 1200 元/柜")).not.toContain(1200);   // 人民币不混进美元列
    expect(R.extractAmounts("20GP 1800 元，40HQ USD 3200")).toEqual(expect.arrayContaining([3200]));
  });

  it("可信度由代码判：只有摘要=未核实；抓到页但认不出日期或超时效=可能过期；权威源在时效内=已核实", () => {
    const base = { domain: "x.com", title: "t", snippet: "s", tier: 2, amounts: [] as number[] };
    expect(R.gradeEvidence({ ...base, url: "https://x.com/a", fetched: false }, 28)).toBe("unverified");
    expect(R.gradeEvidence({ ...base, url: "https://x.com/a", fetched: true, text: "无日期" }, 28)).toBe("stale");
    expect(R.gradeEvidence({ ...base, url: "https://x.com/a", fetched: true, text: "x", publishedAt: daysAgo(60) }, 28)).toBe("stale");
    expect(R.gradeEvidence({ ...base, url: "https://x.com/a", fetched: true, text: "x", publishedAt: daysAgo(2) }, 28)).toBe("verified");
    expect(R.gradeEvidence({ ...base, url: "https://x.com/a", fetched: true, text: "x", publishedAt: daysAgo(2), tier: 4 }, 28)).toBe("single-source");
  });

  it("交叉核对：同一金额在两个不同域名下出现，孤证升为已核实", () => {
    const rows = [
      { credibility: "single-source" as const, url: "https://a.com/r", amounts: [3200] },
      { credibility: "single-source" as const, url: "https://b.com/r", amounts: [3200] },
      { credibility: "single-source" as const, url: "https://c.com/r", amounts: [9999] },
    ];
    R.crossCheck(rows);
    expect(rows[0]!.credibility).toBe("verified");
    expect(rows[2]!.credibility).toBe("single-source");   // 没有第二家附议就不升
  });

  it("结论数字必须能回溯到引用资料；小数字与年份不核", () => {
    expect(R.unverifiableNumbers("40HQ 报 3,200 USD，航程 33 天", ["... USD 3,200 per container ..."])).toEqual([]);
    expect(R.unverifiableNumbers("均价约 4500 USD", ["只有 3200"])).toEqual(["4500"]);
    expect(R.unverifiableNumbers("2026 年 8 月涨了三成", [])).toEqual([]);
  });

  it("检索词模板中英并行，且带上柜型与明确年份", () => {
    const q = R.laneQueries(
      { polCn: "上海", polEn: "Shanghai", podCn: "桑托斯", podEn: "Santos" },
      { container: "40HQ", weeks: 4, today: new Date("2026-09-03T02:00:00Z") },
    );
    expect(q).toHaveLength(6);
    expect(q.some(x => x.includes("上海到桑托斯") && x.includes("40HQ"))).toBe(true);
    expect(q.some(x => /Shanghai to Santos freight rate .*2026/.test(x))).toBe(true);
    expect(q.some(x => x.includes("船期") && x.includes("2026年9月"))).toBe(true);
  });
});

describe("调研底座：整条管线（打桩，不联网）", () => {
  const html = (amount: string, days: number) =>
    `<html><head><meta property="article:published_time" content="${daysAgo(days)}"></head>` +
    `<body><h1>Lane report</h1><p>Updated: ${daysAgo(days)}</p>` +
    `<p>Shanghai to Santos 40HQ ocean freight ${amount} per container, transit 33 days.</p>` +
    `<p>${" filler text.".repeat(12)}</p></body></html>`;

  function stub(opts: { amounts: [string, string] }) {
    (A.searchWeb as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      success: true,
      data: [
        { title: "SeaRates lane report", url: "https://www.searates.com/rate/santos", snippet: "Shanghai Santos 40HQ rate page" },
        { title: "MSC service news", url: "https://www.msc.com/en/news/santos", snippet: "new weekly string service to Santos" },
        { title: "Random forwarder blog", url: "https://blog-forwarder.example/post", snippet: `报价 ${opts.amounts[1]} 元/柜` },
      ],
    });
    (A.chatJson as unknown as { mockImplementation: (fn: (system: string, user: string) => Promise<unknown>) => void })
      .mockImplementation(async (system: string, user: string) => {
        void system;
        if (user.includes("起运港")) {
          return { success: true, data: { polCn: "上海", polEn: "Shanghai", podCn: "桑托斯", podEn: "Santos" } };
        }
        return {
          success: true,
          data: {
            conclusions: [
              { text: `40HQ 即期约 ${opts.amounts[0]} USD，航程 33 天`, refs: [1, 2] },   // 数字可回溯
              { text: "市场均价已达 9,900 USD，涨幅明显", refs: [1] },                      // 资料里没有这个数
              { text: "有船司新开周班航线", },                                                // 未标来源
            ],
          },
        };
      });
    (NP.netFetch as unknown as { mockImplementation: (fn: (url: string) => Promise<unknown>) => void })
      .mockImplementation(async (url: string) => {
        if (url.includes("searates")) return { ok: true, status: 200, text: async () => html(`${opts.amounts[0]} USD`, 2) };
        if (url.includes("msc.com")) return { ok: false, status: 403, text: async () => "" };   // 反爬：只试一次就降级
        return { ok: true, status: 200, text: async () => "<html><body>too short</body></html>" };
      });
  }

  it("抓得到的进明细表并标已核实；抓不到的进缺口；数字回溯不过的结论被剔除；报告落文件", async () => {
    stub({ amounts: ["3200", "3150"] });
    const r = await R.runResearchScene({ pol: "上海", pod: "桑托斯", container: "40HQ" });
    expect(r.success).toBe(true);
    const o = r.success ? r.data.out : null;
    expect(o).toBeTruthy();
    const verified = o!.rates.filter(x => x.credibility !== "unverified");
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.some(x => CRED_LABEL[x.credibility] === "已核实")).toBe(true);
    expect(o!.rates.every(x => x.url.startsWith("http") && x.published !== "")).toBe(true);   // 每条都要链接与日期
    expect(o!.conclusions).toHaveLength(1);
    expect(o!.conclusions[0]!.text).toContain("3200");
    expect(o!.dropped.join("|")).toContain("9,900");            // 编出来的数字被剔除
    expect(o!.dropped.join("|")).toContain("未标注来源");
    expect(o!.gaps.join("|")).toContain("msc.com");              // 抓取失败进覆盖缺口清单
    expect(o!.report).toContain("## 1. 关键结论");
    expect(o!.report).toContain("## 5. 建议下一步");
    expect(o!.report).toContain("以天计变化");
    expect(r.success ? r.data.artifact.name : "").toBe("report.md");
  });

  it("检索源没配时前置拦住：一个请求都不发，只给指路文案", async () => {
    const src = A.hasSearchSource as unknown as { mockReturnValue: (v: boolean) => void };
    const searchCalls = (A.searchWeb as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const llmCalls = (A.chatJson as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    src.mockReturnValue(false);
    try {
      const r = await R.runResearchScene({ pol: "上海", pod: "桑托斯" });
      expect(r.success).toBe(false);
      expect(r.success ? "" : r.error).toContain("未配置联网检索源");
      expect((A.searchWeb as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(searchCalls);
      expect((A.chatJson as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(llmCalls);
    } finally {
      src.mockReturnValue(true);
    }
  });

  it("起运港或目的港缺失时直接拒答追问，不发起任何检索", async () => {
    const before = (A.searchWeb as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const r = await R.runResearchScene({ pol: "上海", pod: "  " });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("起运港");
    expect((A.searchWeb as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });
});
