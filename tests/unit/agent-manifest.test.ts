import { describe, it, expect } from "vitest";
import { TOOL_MANIFEST, toolMeta, toolRoutesBlock, toolLabelMap, toolFollowUpMap } from "../../src/main/services/agent/manifest";
import { TOOL_SPECS, requiresApprovalOf } from "../../src/main/services/agent/policy";

describe("工具注册表（唯一事实源）", () => {
  it("名单无重名、每条有标签与路由", () => {
    const names = TOOL_MANIFEST.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of TOOL_MANIFEST) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.route.length).toBeGreaterThan(0);
    }
  });

  it("TOOL_SPECS 全量派生自注册表（无第二份清单）", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual([...TOOL_MANIFEST.map(m => m.name)].sort());
    for (const m of TOOL_MANIFEST) expect(TOOL_SPECS[m.name]).toBe(m.spec);
  });

  it("write 工具一律需要人工审批", () => {
    const writes = TOOL_MANIFEST.filter(m => m.spec.sideEffect === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const m of writes) expect(m.spec.requiresApproval).toBe(true);
  });

  it("审批闸门 = 注册表派生：write 必问、read 不问，无会话豁免通道", () => {
    for (const m of TOOL_MANIFEST) {
      expect(requiresApprovalOf(m.name), m.name).toBe(m.spec.sideEffect === "write");
      // 豁免旋钮已连根删除：类型上不存在这个键，运行时也不该有人偷偷塞回来
      expect("autoApprovable" in m.spec, m.name).toBe(false);
    }
    expect(requiresApprovalOf("不存在的工具")).toBe(false);
  });

  it("UI 标签无重复", () => {
    const labels = TOOL_MANIFEST.map(m => m.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("系统提示词路由段与派生映射覆盖全部工具", () => {
    const block = toolRoutesBlock();
    for (const m of TOOL_MANIFEST) expect(block).toContain(m.name);
    expect(Object.keys(toolLabelMap()).length).toBe(TOOL_MANIFEST.length);
    const fu = toolFollowUpMap();
    for (const [name, list] of Object.entries(fu)) {
      expect(toolMeta(name)).toBeTruthy();
      expect(list.length).toBeGreaterThan(0);
    }
  });
});
