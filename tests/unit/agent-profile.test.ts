import { describe, it, expect } from "vitest";
import { pickTools } from "../../src/main/services/agent/manifest";

const fake = (names: string[]) => names.map(name => ({ name }));

describe("AgentProfile 工具子集（配置驱动，新增角色不改内核）", () => {
  it("未配置 = 全量", () => {
    expect(pickTools(fake(["a", "b"]), undefined)).toHaveLength(2);
  });

  it("空数组 = 全量", () => {
    expect(pickTools(fake(["a", "b"]), [])).toHaveLength(2);
  });

  it("子集过滤保持全量集原序（不按配置顺序）", () => {
    const out = pickTools(fake(["search_contacts", "quote_search", "inbox_search"]), ["inbox_search", "search_contacts"]);
    expect(out.map(t => t.name)).toEqual(["search_contacts", "inbox_search"]);
  });

  it("配置里的未知名自然忽略，不报错", () => {
    const out = pickTools(fake(["a", "b"]), ["a", "不存在的工具"]);
    expect(out.map(t => t.name)).toEqual(["a"]);
  });
});
