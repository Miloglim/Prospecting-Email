import { describe, it, expect } from "vitest";
import { migrateTagsValue } from "../../src/main/db/tags-migrate";

describe("migrateTagsValue — v4.0 tags 收敛迁移", () => {
  it("保留已有的阶段 key，丢弃自定义标签", () => {
    expect(migrateTagsValue('["reaching","VIP"]', "reached")).toBe('["reaching"]');
  });

  it("无阶段 key → 丢弃全部 → null", () => {
    expect(migrateTagsValue('["VIP"]', "replied")).toBeNull();
  });

  it("空数组 → null", () => {
    expect(migrateTagsValue("[]", "replied")).toBeNull();
  });

  it("无阶段但 status=reached → 补触达中", () => {
    expect(migrateTagsValue(null, "reached")).toBe('["reaching"]');
  });

  it("已有阶段不受 status 影响（保留 quoting）", () => {
    expect(migrateTagsValue('["quoting"]', "replied")).toBe('["quoting"]');
  });

  it("非法 JSON → 视为未设置 → null", () => {
    expect(migrateTagsValue("not-json", "replied")).toBeNull();
  });
});
