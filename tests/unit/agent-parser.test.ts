import { describe, it, expect } from "vitest";
import { parseDraft, parseTsv } from "../../src/main/services/agent/parser";

describe("parseTsv（csv 导出的 content 解析）", () => {
  it("标准 TSV：首行表头，逐行分列", () => {
    expect(parseTsv("航线\t价格\n南美东\t3200")).toEqual([["航线", "价格"], ["南美东", "3200"]]);
  });

  it("全角空格当制表符容错（弱模型常见误用）", () => {
    expect(parseTsv("航线　价格\n南美东　3200")).toEqual([["航线", "价格"], ["南美东", "3200"]]);
  });

  it("空行跳过、首尾空白清理", () => {
    expect(parseTsv("\n a \t b \n\n c \t d \n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("空输入 → 空表", () => {
    expect(parseTsv("")).toEqual([]);
  });
});

describe("parseDraft（SUBJECT 行拆分唯一实现）", () => {
  it("拆出 SUBJECT 行与正文", () => {
    const r = parseDraft("SUBJECT: Hello there\n\nBody line 1\nBody line 2", "fallback");
    expect(r.subject).toBe("Hello there");
    expect(r.body).toBe("Body line 1\nBody line 2");
  });

  it("正文中间的 SUBJECT 行也能识别（不区分大小写位置）", () => {
    const r = parseDraft("前言一句\nsubject: Later hi\n正文在这", "fallback");
    expect(r.subject).toBe("Later hi");
    expect(r.body).toBe("正文在这");
  });

  it("无 SUBJECT 行时用兜底主题、全文当正文", () => {
    const r = parseDraft("just a body", "Fallback subject");
    expect(r.subject).toBe("Fallback subject");
    expect(r.body).toBe("just a body");
  });

  it("只有 SUBJECT 行时正文为空", () => {
    const r = parseDraft("SUBJECT: only", "fb");
    expect(r.subject).toBe("only");
    expect(r.body).toBe("");
  });

  it("空输入安全回退", () => {
    const r = parseDraft("", "fb");
    expect(r.subject).toBe("fb");
    expect(r.body).toBe("");
  });

  it("主题截断到 150 字", () => {
    const r = parseDraft(`SUBJECT: ${"x".repeat(200)}`, "fb");
    expect(r.subject.length).toBe(150);
  });

  it("SUBJECT 行后的空行与缩进被吃掉", () => {
    const r = parseDraft("SUBJECT: s\n\n\n  body", "fb");
    expect(r.body).toBe("body");
  });
});
