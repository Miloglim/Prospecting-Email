import { describe, expect, it } from "vitest";
import {
  GROUP_PROMPT, GROUP_TITLES, MAX_PER_GROUP, PICK_PER_GROUP, RULE_TEMPLATES,
  beijingDay, buildItemPrompt, fillTemplate, fingerprint, parseBatch, pickTwo, ruleBatches,
  shouldRegenerate, signalsMoved, slotValues, type Snapshot,
} from "../../src/main/services/suggestion.service";

/**
 * 首页「AI 建议行动」的纯逻辑（不碰库、不碰模型）。钉住三件用户直接感得到的事：
 *  ① 卡上的数字永远是「今天」的 —— 批次存 {slot} 模板，显示时才填；
 *  ② 数据为空的项不上卡（不会问「0 封未读要不要总结」），但每张卡照样有两条；
 *  ③ 模型产出不合口径（写死数字、编槽名、给做不到的事出题）→ 整版退回本地规则版。
 */

const rich: Snapshot = {
  quotes: { total: 132, expired: 12, topPod: "Santos", lastSyncDays: 1 },
  inbox: { unread: 9, inquiries7d: 4, latest: { who: "Juan", subject: "RFQ Santos 40HQ 询价" } },
  crm: { dueToday: 2, overdue: 5, staleMaxDays: 12, topName: "Deniz" },
  send: { pendingGroups: 40, pendingRecipients: 118, failed: 3, running: false, paused: true },
  accounts: { enabled: 4, healthy: 3, broken: "ops@acme.com" },
  contacts: { total: 300, cold: 88 },
};

const blank: Snapshot = {
  quotes: { total: 0, expired: 0, topPod: null, lastSyncDays: null },
  inbox: { unread: 0, inquiries7d: 0, latest: null },
  crm: { dueToday: 0, overdue: 0, staleMaxDays: 0, topName: null },
  send: { pendingGroups: 0, pendingRecipients: 0, failed: 0, running: false, paused: false },
  accounts: { enabled: 0, healthy: 0, broken: null },
  contacts: { total: 0, cold: 0 },
};

const values = slotValues(rich);

describe("槽位与填槽", () => {
  it("值为 0 / 空的槽不进表", () => {
    expect(slotValues(blank).size).toBe(0);
    expect(slotValues(rich).get("crm.overdue")).toBe("5");
    expect(slotValues(rich).get("quotes.topPod")).toBe("Santos");
  });

  it("同一模板在昨天的数据与今天的数据下填出不同句子（数字不会过期）", () => {
    const t = "台账里 {quotes.expired} 条过期报价，按航线列一下";
    expect(fillTemplate(t, slotValues({ ...rich, quotes: { ...rich.quotes, expired: 7 } })))
      .toBe("台账里 7 条过期报价，按航线列一下");
    expect(fillTemplate(t, slotValues(rich))).toBe("台账里 12 条过期报价，按航线列一下");
  });

  it("引用了不可用槽位的模板判废，可用时正常填", () => {
    const t = "{inbox.unread} 封未读里最值得回的三封，总结一下";
    expect(fillTemplate(t, slotValues(blank))).toBeNull();
    expect(fillTemplate(t, slotValues(rich))).toBe("9 封未读里最值得回的三封，总结一下");
  });

  it("数量槽后面接「天」判废 —— 挡的就是实测到的「逾期 5 位」被写成「逾期 5 天」", () => {
    expect(fillTemplate("逾期 {crm.overdue} 天了，先处理他", slotValues(rich))).toBeNull();
    expect(fillTemplate("逾期最久的沉默了 {crm.staleMaxDays} 天", slotValues(rich)))
      .toBe("逾期最久的沉默了 12 天");
  });

  it("规则版模板不许引用白名单之外的槽名（防漂移）", () => {
    const known = new Set<string>([...slotValues(rich).keys()]);
    for (const t of Object.values(RULE_TEMPLATES).flat()) {
      for (const m of t.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)) {
        expect(known.has(m[1]!), `未知槽位 {${m[1]}} 出现在「${t}」`).toBe(true);
      }
    }
  });
});

describe("规则版批次：首屏永远有内容的那一半", () => {
  it("空库时每个分区也至少留出两条（卡片绝不开天窗）", () => {
    for (const g of ruleBatches(blank)) {
      expect(g.templates.length, g.title).toBeGreaterThanOrEqual(PICK_PER_GROUP);
    }
  });

  it("任何分区都不超过用户定的 8 条上限", () => {
    for (const g of ruleBatches(rich)) expect(g.templates.length).toBeLessThanOrEqual(MAX_PER_GROUP);
  });

  it("批次里留下的模板今天必然填得上（否则就不该进批次）", () => {
    const values = slotValues(blank);
    for (const g of ruleBatches(blank)) {
      for (const t of g.templates) expect(fillTemplate(t, values)).not.toBeNull();
    }
  });
});

describe("AI 批次的准入", () => {
  const varied = GROUP_TITLES.map(t => ({
    title: t,
    items: [
      `${t}时先看{quotes.topPod}这条线行吗`,
      `${t}要不要从{contacts.total}个联系人里挑`,
      `{crm.overdue}位逾期里${t}先办哪个`,
      `未读{inbox.unread}封里${t}先看谁`,
      `{send.pendingGroups}组待发对${t}有影响吗`,
      `${accountsHint(t)}健康账号还能用几个`,
    ],
  }));
  function accountsHint(t: string): string { return `{accounts.healthy}个${t}`; }

  it("合规批次收下：六组、每组 5–8 条", () => {
    const parsed = parseBatch(JSON.stringify(varied), values);
    expect(parsed).toHaveLength(6);
    for (const g of parsed!) expect(g.templates.length).toBeGreaterThanOrEqual(5);
  });

  it("模型爱加的解释文字与 ```json 围栏都吃得下", () => {
    expect(parseBatch(`按你的数据排的：\n\`\`\`json\n${JSON.stringify(varied)}\n\`\`\`\n请查收`)).toHaveLength(6);
  });

  it("写死裸数字的句子逐条丢弃，某区因此凑不满 5 条 → 整版判废", () => {
    const hard = varied.map(g => ({ ...g, items: g.items.map(i => i.replace(/\{[a-zA-Z0-9_.]+\}/g, "1200")) }));
    expect(parseBatch(JSON.stringify(hard), values)).toBeNull();
  });

  it("自己编的槽名（{overdue}）不被接受", () => {
    expect(parseBatch(JSON.stringify(GROUP_TITLES.map(title => ({
      title, items: ["{overdue} 位逾期的先看哪个好", "{unread} 封未读要总结吗", "{total} 个联系人查谁呢",
        "台账 {expired} 条过期怎么列", "{topPod} 现在最便宜到多少呢", "{broken} 这个账号怎么了修",
      ]
    }))), values)).toBeNull();
  });

  it("组数不对 / 标题错位 / 条数太少 / 根本不是 JSON —— 一律判废", () => {
    expect(parseBatch(JSON.stringify(varied.slice(0, 5)), values)).toBeNull();
    expect(parseBatch(JSON.stringify(varied.map((g, i) => (i === 2 ? { ...g, title: "查运价" } : g))), values)).toBeNull();
    expect(parseBatch(JSON.stringify(GROUP_TITLES.map(title => ({ title, items: ["我今天该跟进谁呀呀"] }))), values)).toBeNull();
    expect(parseBatch("我的建议是：查运价、看行情、管邮件", values)).toBeNull();
  });

  it("某区给了超过 8 条 → 截到上限", () => {
    const many = GROUP_TITLES.map(title => ({
      title,
      items: Array.from({ length: 12 }, (_, i) => `${title}第${"一二三四五六七八九十甲乙"[i]}看{quotes.topPod}这条线`),
    }));
    const parsed = parseBatch(JSON.stringify(many), values);
    expect(parsed).toHaveLength(6);
    for (const x of parsed!) expect(x.templates.length).toBeLessThanOrEqual(MAX_PER_GROUP);
  });
});

describe("每张卡随机抽两条", () => {
  const pool = ["甲", "乙", "丙", "丁", "戊"];
  it("固定给两条，且不重复", () => {
    for (let i = 0; i < 20; i++) {
      const got = pickTwo("抽两条测试组", pool);
      expect(got).toHaveLength(2);
      expect(new Set(got).size).toBe(2);
      expect(got.every(x => pool.includes(x))).toBe(true);
    }
  });
  it("池子不足两条就有几条给几条（空库也不报错）", () => {
    expect(pickTwo("池子不足组", ["单条"])).toEqual(["单条"]);
    expect(pickTwo("空池组", [])).toEqual([]);
  });
  it("连着两次尽量给不同的一批（首页反复进不该总看到同样两条）", () => {
    const first = pickTwo("轮转组", pool);
    let sawDifferent = false;
    for (let i = 0; i < 12; i++) {
      if (pickTwo("轮转组", pool).some(x => !first.includes(x))) { sawDifferent = true; break; }
    }
    expect(sawDifferent).toBe(true);
  });
});

describe("长度按「填完之后」判（占位符本身很长，量原文会整批误杀）", () => {
  const sixWith = (tpl: (t: string) => string) => GROUP_TITLES.map(title => ({
    title, items: [tpl(title), tpl("再问一遍"), tpl("第三条看"), tpl("第四条问"), tpl("第五条先办")],
  }));
  it("槽名占 15 字符、填完只有十几个字的模板照常收下", () => {
    const parsed = parseBatch(JSON.stringify(sixWith(t => `${t}过期的${"{quotes.expired}"}条按航线列一下`)), values);
    expect(parsed).toHaveLength(6);
  });
  it("填完仍然超长的模板丢掉", () => {
    const long = sixWith(t => `${t}${"{quotes.topPod}"}那条线的公开市场行情和我们的台账价相比到底算什么水平呢麻烦帮我详细对比一下看看`);
    expect(parseBatch(JSON.stringify(long), values)).toBeNull();
  });
});

describe("批次归属日", () => {
  it("按北京时间切天：UTC 的下午还是同一天", () => {
    expect(beijingDay(Date.parse("2026-09-03T16:30:00Z"))).toBe("2026-09-04");
    expect(beijingDay(Date.parse("2026-09-03T15:30:00Z"))).toBe("2026-09-03");
  });
});

describe("隐藏提示词：卡上显示短句，点击发送方法论", () => {
  it("六个分区都有非空的方法论前缀", () => {
    for (const t of GROUP_TITLES) {
      expect(GROUP_PROMPT[t]?.trim().length, t).toBeGreaterThan(10);
    }
  });

  it("拼装格式 = 分区前缀 + 换行 + 检索目标：显示文本", () => {
    expect(buildItemPrompt("看市场行情", "上海到桑托斯现在公开市场报多少"))
      .toBe(`${GROUP_PROMPT["看市场行情"]}\n检索目标：上海到桑托斯现在公开市场报多少`);
  });

  it("行情分区的前缀钉住既定方法论措辞（交叉核对 + 标注不可核实）", () => {
    expect(GROUP_PROMPT["看市场行情"]).toContain("交叉核对");
    expect(GROUP_PROMPT["看市场行情"]).toContain("无法核实或可能过期");
  });

  it("写操作分区的前缀都带确认门槛（不许模型越过人工确认）", () => {
    expect(GROUP_PROMPT["跟进客户"]).toContain("确认");
    expect(GROUP_PROMPT["准备发信"]).toContain("不能自动发送");
    expect(GROUP_PROMPT["管邮件"]).toContain("等我确认");
  });
});

// ── 变化触发：只在「该关心什么」真的变了时再打模型 ──────────────────

const fpOf = (patch: Partial<ReturnType<typeof fingerprint>>) => ({ ...fingerprint(rich), ...patch });
const gap = 31 * 60_000;

describe("指纹差分的阈值", () => {
  it("数据没动就不触发；小步波动也不算（免得卡片跟着抖）", () => {
    expect(signalsMoved(fingerprint(rich), fingerprint(rich))).toBeNull();
    expect(signalsMoved(fpOf({ unread: 9 }), fpOf({ unread: 11}))).toBeNull();   // +2 不算
    expect(signalsMoved(fpOf({ pendingGroups: 40 }), fpOf({ pendingGroups: 43 }))).toBeNull();  // +3 不算
  });

  it("够量的变化各命中一条原因", () => {
    expect(signalsMoved(fpOf({ unread: 9 }), fpOf({ unread: 12 }))).toContain("未读");
    expect(signalsMoved(fpOf({ pendingGroups: 40 }), fpOf({ pendingGroups: 45 }))).toContain("队列");
    expect(signalsMoved(fpOf({ overdue: 0 }), fpOf({ overdue: 1 }))).toContain("逾期");
    expect(signalsMoved(fpOf({ broken: null }), fpOf({ broken: "ops@acme.com" }))).toContain("账号");
    expect(signalsMoved(fpOf({ quotesExpired: 12 }), fpOf({ quotesExpired: 3 }))).toContain("台账");
    expect(signalsMoved(fpOf({ healthyAccounts: 3 }), fpOf({ healthyAccounts: 2 }))).toContain("健康");
  });
});

describe("重排的限流闸门", () => {
  const at = Date.parse("2026-09-04T02:00:00Z");
  const state = (patch: Record<string, unknown>) => ({
    day: beijingDay(at), tries: 1, lastAt: at - gap, fp: fingerprint(rich), ...patch,
  });

  it("没生成过 / 隔天 → 不算重排（那是常规补批次的活）", () => {
    expect(shouldRegenerate(null, fingerprint(rich), at)).toBeNull();
    expect(shouldRegenerate(state({ day: "2026-01-01" }), fpOf({ unread: 30 }), at)).toBeNull();
  });

  it("30 分钟冷却内不重复打模型，哪怕数据在动", () => {
    expect(shouldRegenerate(state({ lastAt: at - 60_000 }), fpOf({ unread: 40 }), at)).toBeNull();
  });

  it("当天封顶 6 次，端点一直抖也烧不出第七次", () => {
    expect(shouldRegenerate(state({ tries: 6 }), fpOf({ unread: 40 }), at)).toBeNull();
    expect(shouldRegenerate(state({ tries: 5 }), fpOf({ unread: 40 }), at)).toContain("未读");
  });

  it("冷却已过且确实变了才放行，并带回原因", () => {
    expect(shouldRegenerate(state({}), fpOf({ unread: 40 }), at)).toContain("未读");
    expect(shouldRegenerate(state({}), fingerprint(rich), at)).toBeNull();  // 没变依然省钱
  });
});
