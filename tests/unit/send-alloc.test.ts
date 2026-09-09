import { describe, it, expect } from "vitest";
import { pickAffinityAccount, partitionByAffinity, rotateAccountId, interleaveCompanies, nextStage } from "../../src/main/services/send.service";

// ═══════════════════════════════════════════════════════════════
// 亲和判定/分桶（不换人发，用户拍板 v6.0）：智能轮换建立在「对应联系人的
// 历史发信账号」之上——谁发过的客户还由谁发，只有从未发过的新联系人才进
// 轮换池。旧 pickAccountId 的「亲和超载让位」语义已被该需求否决（超载也
// 不换人；熔断整组缓发而非改派）。
// ═══════════════════════════════════════════════════════════════

describe("pickAffinityAccount — 联系人亲和判定（不换人发）", () => {
  const recipients = (ids: number[]) => ids.map(contactId => ({ contactId }));
  const active = new Set([1, 2, 3]);
  const noCircuit = new Set<number>();

  it("组内唯一历史账号且在可用池 → 沿用该账号（谁发过还谁发）", () => {
    const affinity = new Map([[11, 2], [12, 2]]);
    expect(pickAffinityAccount(recipients([11, 12]), affinity, active, noCircuit, false))
      .toEqual({ accountId: 2, deferred: false });
  });

  it("历史账号熔断中（启用但被摘出可选池）→ 整组缓发，绝不静默换号", () => {
    const affinity = new Map([[11, 2]]);
    expect(pickAffinityAccount(recipients([11]), affinity, new Set([1, 3]), new Set([2]), false))
      .toEqual({ deferred: true });
  });

  it("指定账号池（fixed 策略）内不缓发：池外亲和账号视同无历史交由轮换", () => {
    const affinity = new Map([[11, 2]]);
    expect(pickAffinityAccount(recipients([11]), affinity, new Set([1]), new Set([2]), true))
      .toEqual({ deferred: false });
  });

  it("历史账号已停用（不在池也不在熔断）→ 视同无历史交由轮换", () => {
    const affinity = new Map([[11, 9]]);
    expect(pickAffinityAccount(recipients([11]), affinity, active, noCircuit, false))
      .toEqual({ deferred: false });
  });

  it("组内历史账号不一致（BCC 一组只能一个发件人）→ 不硬凑，交由轮换", () => {
    const affinity = new Map([[11, 1], [12, 2]]);
    expect(pickAffinityAccount(recipients([11, 12]), affinity, active, noCircuit, false))
      .toEqual({ deferred: false });
  });

  it("全组无历史 → 轮换池", () => {
    expect(pickAffinityAccount(recipients([11, 12]), new Map(), active, noCircuit, false))
      .toEqual({ deferred: false });
  });
});

describe("partitionByAffinity — 亲和分桶（BCC 组内历史账号必须一致）", () => {
  it("同公司不同历史账号的联系人拆到不同桶", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const affinity = new Map([[1, 7], [2, 8], [3, 7]]);
    const buckets = partitionByAffinity(rows, affinity);
    expect(buckets.length).toBe(2);
    const byAffinity = new Map(buckets.map(b => [b.affinity, b.rows.length]));
    expect(byAffinity.get(7)).toBe(2);
    expect(byAffinity.get(8)).toBe(1);
  });

  it("无历史联系人归 0 号桶（轮换池）", () => {
    const buckets = partitionByAffinity([{ id: 1 }, { id: 2 }], new Map());
    expect(buckets).toEqual([{ affinity: 0, rows: [{ id: 1 }, { id: 2 }] }]);
  });

  it("桶内保持原有顺序（桶序按首次出现）", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const affinity = new Map([[2, 5], [3, 5]]);
    const buckets = partitionByAffinity(rows, affinity);
    expect(buckets.map(b => b.rows.map(r => r.id))).toEqual([[1], [2, 3]]);
    expect(buckets.map(b => b.affinity)).toEqual([0, 5]);
  });
});

describe("rotateAccountId — 发信账号轮换（队列编排）", () => {
  it("两账号严格交替，相邻两组不同账号", () => {
    const ids = [10, 20];
    const seq = [0, 1, 2, 3, 4].map(i => rotateAccountId(i, ids));
    expect(seq).toEqual([10, 20, 10, 20, 10]);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it("三账号循环回绕", () => {
    const ids = [1, 2, 3];
    expect([0, 1, 2, 3, 4, 5].map(i => rotateAccountId(i, ids))).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it("负载均匀：任意账号组数差不超过 1", () => {
    const ids = [7, 8, 9];
    const load = new Map<number, number>(ids.map(id => [id, 0]));
    for (let i = 0; i < 100; i++) load.set(rotateAccountId(i, ids), (load.get(rotateAccountId(i, ids)) ?? 0) + 1);
    const counts = [...load.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("单账号时全部归它（不越界）", () => {
    expect([0, 1, 2].map(i => rotateAccountId(i, [5]))).toEqual([5, 5, 5]);
  });

  it("负索引安全回绕（防 NaN/undefined）", () => {
    expect(rotateAccountId(-1, [1, 2, 3])).toBe(3);
  });
});

describe("interleaveCompanies — 队列公司交错打乱", () => {
  const mk = (n: number, company: number) => Array.from({ length: n }, (_, i) => ({ id: `${company}-${i}`, companyId: company }));

  it("多公司时相邻组不属同一公司", () => {
    for (let t = 0; t < 20; t++) { // 随机算法 → 多轮验证
      const items = [...mk(3, 1), ...mk(3, 2), ...mk(2, 3)];
      const out = interleaveCompanies(items);
      expect(out).toHaveLength(8);
      for (let i = 1; i < out.length; i++) {
        expect(out[i].companyId).not.toBe(out[i - 1].companyId);
      }
    }
  });

  it("单公司垄断时允许连发（无法避免）但不丢组", () => {
    const items = [...mk(5, 7), ...mk(1, 9)];
    const out = interleaveCompanies(items);
    expect(out).toHaveLength(6);
    expect(new Set(out.map(x => x.id))).toEqual(new Set(items.map(x => x.id)));
  });

  it("全部同公司：不丢组", () => {
    const items = mk(6, 1);
    const out = interleaveCompanies(items);
    expect(out).toHaveLength(6);
    expect(new Set(out.map(x => x.id))).toEqual(new Set(items.map(x => x.id)));
  });

  it("一家占多数时仍穿插其他公司（少数派不相邻）", () => {
    for (let t = 0; t < 20; t++) {
      const items = [...mk(6, 1), ...mk(2, 2)];
      const out = interleaveCompanies(items);
      for (let i = 1; i < out.length; i++) {
        expect(out[i].companyId === 2 && out[i - 1].companyId === 2).toBe(false);
      }
    }
  });

  it("空队列与单组安全", () => {
    expect(interleaveCompanies([])).toEqual([]);
    expect(interleaveCompanies([{ id: "a", companyId: 1 }])).toHaveLength(1);
  });

  it("与账号轮换组合：相邻组公司不同且账号不同（≥2账号）", () => {
    for (let t = 0; t < 20; t++) {
      const items = [...mk(3, 1), ...mk(3, 2), ...mk(3, 3)];
      const out = interleaveCompanies(items);
      const ids = [10, 20];
      for (let i = 1; i < out.length; i++) {
        expect(rotateAccountId(i - 1, ids)).not.toBe(rotateAccountId(i, ids)); // 轮换不变量天然保持
        expect(out[i].companyId).not.toBe(out[i - 1].companyId);
      }
    }
  });
});

describe("nextStage — 发送成功后阶段推进", () => {
  it("逐级推进 cold→f1→f2→f3→f4", () => {
    expect(nextStage("cold")).toBe("f1");
    expect(nextStage("f1")).toBe("f2");
    expect(nextStage("f2")).toBe("f3");
    expect(nextStage("f3")).toBe("f4");
  });

  it("f4 封顶不再推进", () => {
    expect(nextStage("f4")).toBe("f4");
  });

  it("空值/未知值视为 cold 起步", () => {
    expect(nextStage(null)).toBe("f1");
    expect(nextStage(undefined)).toBe("f1");
    expect(nextStage("")).toBe("f1");
    expect(nextStage("乱码")).toBe("f1");
  });
});
