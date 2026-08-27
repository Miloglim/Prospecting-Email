import { describe, it, expect } from "vitest";
import { trimByBudget, isValidEmail } from "../../src/main/services/send.service";

function item(id: string, n: number) {
  return { id, recipients: Array.from({ length: n }, (_, i) => ({ email: `u${i}@x.com` })) };
}

describe("trimByBudget — 配额裁剪（按封数、整组保留）", () => {
  it("预算充足时全部保留，keptCount=总收件人数", () => {
    const items = [item("a", 20), item("b", 5), item("c", 10)];
    const r = trimByBudget(items, 100);
    expect(r.kept).toHaveLength(3);
    expect(r.keptCount).toBe(35);
    expect(r.dropped).toBe(0);
  });

  it("整组保留不拆 BCC 组：超预算的组连同后续全部丢弃", () => {
    const items = [item("a", 20), item("b", 15), item("c", 10)];
    // 预算 25：a(20) 保留，b(15) 会超 → b、c 整组丢弃
    const r = trimByBudget(items, 25);
    expect(r.kept.map(i => i.id)).toEqual(["a"]);
    expect(r.keptCount).toBe(20);
    expect(r.dropped).toBe(2);
  });

  it("恰好用完预算的组保留（used + n > budget 才停）", () => {
    const items = [item("a", 10), item("b", 10), item("c", 10)];
    const r = trimByBudget(items, 20);
    expect(r.kept.map(i => i.id)).toEqual(["a", "b"]);
    expect(r.keptCount).toBe(20);
    expect(r.dropped).toBe(1);
  });

  it("budget=-1 表示不限，全量通过", () => {
    const items = [item("a", 100), item("b", 200)];
    const r = trimByBudget(items, -1);
    expect(r.kept).toHaveLength(2);
    expect(r.keptCount).toBe(300);
    expect(r.dropped).toBe(0);
  });

  it("预算装不下第一组时全部丢弃（不部分发送）", () => {
    const items = [item("a", 20)];
    const r = trimByBudget(items, 5);
    expect(r.kept).toHaveLength(0);
    expect(r.keptCount).toBe(0);
    expect(r.dropped).toBe(1);
  });

  it("空队列安全", () => {
    const r = trimByBudget([], 10);
    expect(r.kept).toHaveLength(0);
    expect(r.keptCount).toBe(0);
    expect(r.dropped).toBe(0);
  });
});

describe("isValidEmail — 收件人邮箱校验", () => {
  it("常规邮箱通过", () => {
    expect(isValidEmail("john.doe@acme.com")).toBe(true);
    expect(isValidEmail("a_b+c@sub.domain.co")).toBe(true);
  });

  it("缺域名/TLD/含空格的地址拒绝", () => {
    expect(isValidEmail("plainaddress")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});
