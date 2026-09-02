import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { TOOL_SPECS, classifyTool, canAutoApprove } from "../../src/main/services/agent/policy";
import { normalizeBatchItems, normalizeBatchKind } from "../../src/main/services/bg-task.service";
import { slugify, csvCell, toCsv, writeArtifact, isInsideArtifactDir, ARTIFACT_DIR } from "../../src/main/services/artifact.service";

describe("P2 policy 登记", () => {
  it("export_artifact / start_batch_task 都是免审批读工具", () => {
    expect(classifyTool("export_artifact")).toMatchObject({ sideEffect: "read", requiresApproval: false });
    expect(classifyTool("start_batch_task")).toMatchObject({ sideEffect: "read", requiresApproval: false });
  });

  it("元能力工具不在「本会话内不再询问」范围（豁免只认显式标记的写工具）", () => {
    expect(canAutoApprove("export_artifact")).toBe(false);
    expect(canAutoApprove("start_batch_task")).toBe(false);
  });

  it("注册表全部条目仍有副作用分级与预算", () => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(["read", "write"], `${name} sideEffect`).toContain(spec.sideEffect);
      expect(spec.budgetPerTurn, name).toBeGreaterThan(0);
    }
  });
});

describe("后台批量任务入参归一", () => {
  it("无名条目丢弃；整体钳 10 家", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `C${i}` }));
    many.push({ country: "巴西" });              // 无 name → 丢弃
    many.push({ name: "   " });                  // 空白 name → 丢弃
    const out = normalizeBatchItems(many);
    expect(out).toHaveLength(10);
    expect(out.every(c => c.name.length > 0)).toBe(true);
  });

  it("name/country 长度钳制", () => {
    const out = normalizeBatchItems([{ name: "A".repeat(99), country: "B".repeat(99) }]);
    expect(out[0]!.name).toHaveLength(40);
    expect(out[0]!.country).toHaveLength(20);
  });

  it("脏输入不抛错", () => {
    expect(normalizeBatchItems(undefined)).toEqual([]);
    expect(normalizeBatchItems("nope")).toEqual([]);
    expect(normalizeBatchItems([null, 7, { state: "x" }])).toEqual([]);
  });

  it("kind 同义词归一", () => {
    expect(normalizeBatchKind("draft")).toBe("draft");
    expect(normalizeBatchKind("开发信")).toBe("draft");
    expect(normalizeBatchKind("写信")).toBe("draft");
    expect(normalizeBatchKind("backcheck")).toBe("backcheck");
    expect(normalizeBatchKind(undefined)).toBe("backcheck");
    expect(normalizeBatchKind("随便什么")).toBe("backcheck");
  });
});

describe("产物文件名与 csv", () => {
  it("slugify：非法字符剔除、空白折连字符、钳 40 字、空名兜底", () => {
    expect(slugify("未读邮件 总结/2026")).toBe("未读邮件-总结2026");
    expect(slugify("a".repeat(60))).toHaveLength(40);
    expect(slugify("///")).toBe("artifact");
    expect(slugify("")).toBe("artifact");
  });

  it("csvCell：含逗号/引号/换行时加引号，引号翻倍（RFC4180）", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
  });

  it("toCsv：行以 CRLF 连接，结尾带换行", () => {
    expect(toCsv([["a", "b"], ["1", "2"]])).toBe("a,b\r\n1,2\r\n");
  });
});

describe("产物落盘与路径安全", () => {
  const created: string[] = [];

  afterAll(() => {
    // 清理本测试自己生成的临时产物（只删自己写的那几个文件）
    for (const f of created) { try { fs.rmSync(f); } catch { /* 已不存在 */ } }
  });

  it("writeArtifact 落盘成功且元信息完整；同名追加序号", () => {
    const w1 = writeArtifact("P2测试产物", "md", "# hello");
    expect(w1.success).toBe(true);
    if (w1.success) {
      created.push(w1.data.path);
      expect(fs.existsSync(w1.data.path)).toBe(true);
      expect(w1.data.name.endsWith(".md")).toBe(true);
      expect(w1.data.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("isInsideArtifactDir 只放行产物目录内路径", () => {
    expect(isInsideArtifactDir(path.join(ARTIFACT_DIR, "a.md"))).toBe(true);
    expect(isInsideArtifactDir(path.join(ARTIFACT_DIR, "..", "secret.txt"))).toBe(false);
    expect(isInsideArtifactDir("C:\\Windows\\system32\\cmd.exe")).toBe(false);
    expect(isInsideArtifactDir("")).toBe(false);
  });
});
