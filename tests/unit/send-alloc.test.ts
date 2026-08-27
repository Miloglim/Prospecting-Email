import { describe, it, expect } from "vitest";
import { pickAccountId, rotateAccountId } from "../../src/main/services/send.service";

/** 模拟整批分配，返回每个账号最终拿到多少组 */
function allocate(total: number, accountIds: number[], preferredOf: (i: number) => number | undefined) {
  const load = new Map<number, number>(accountIds.map(id => [id, 0]));
  const cap = Math.ceil(total / accountIds.length);
  for (let i = 0; i < total; i++) {
    const aid = pickAccountId(preferredOf(i), load, cap);
    load.set(aid, (load.get(aid) ?? 0) + 1);
  }
  return load;
}

describe("pickAccountId — 发信账号负载均衡", () => {
  it("亲和账号未超载时优先使用（同一客户由同一账号跟进）", () => {
    const load = new Map([[1, 0], [2, 5]]);
    expect(pickAccountId(2, load, 10)).toBe(2);
  });

  it("亲和账号已达上限时让位给最闲的", () => {
    const load = new Map([[1, 0], [2, 10]]);
    expect(pickAccountId(2, load, 10)).toBe(1);
  });

  it("没有亲和记录时选最闲的账号", () => {
    const load = new Map([[1, 7], [2, 3], [3, 5]]);
    expect(pickAccountId(undefined, load, 10)).toBe(2);
  });

  // 这条是用户报的 bug 的回归测试：历史上全部发信都用账号 1，
  // 旧逻辑会把 800 组全压给账号 1 导致限流
  it("全部联系人都亲和同一账号时，仍然均分而不是压垮它", () => {
    const load = allocate(800, [1, 2, 3, 4], () => 1);
    expect(load.get(1)).toBe(200);
    expect(load.get(2)).toBe(200);
    expect(load.get(3)).toBe(200);
    expect(load.get(4)).toBe(200);
  });

  it("无法整除时最大最小差不超过 1 组", () => {
    const load = allocate(101, [1, 2, 3], () => undefined);
    const counts = [...load.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("单账号时全部归它（不崩）", () => {
    const load = allocate(50, [9], () => 9);
    expect(load.get(9)).toBe(50);
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
