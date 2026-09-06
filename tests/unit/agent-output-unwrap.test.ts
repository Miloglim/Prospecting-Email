import { describe, expect, it } from "vitest";
import { toolOutputText } from "../../src/main/services/agent/harness";

/**
 * 工具输出剥壳：SDK 的 function_call_output.output 是联合类型，
 * 有时回内容包 {type:"text",text:"…"}（或其数组）。不剥壳的话前端拿到
 * 整包 JSON.stringify，表格卡/动作按钮全部解析失败（实测现场抓到过）。
 */
describe("toolOutputText：工具输出统一剥成纯文本", () => {
  it("字符串原样通过（最常见的工具返回形态）", () => {
    expect(toolOutputText('{"ok":true,"total":3}')).toBe('{"ok":true,"total":3}');
  });

  it("单个 {type:\"text\"} 内容包 → 取出 text", () => {
    expect(toolOutputText({ type: "text", text: '{"ok":true}' })).toBe('{"ok":true}');
  });

  it("内容包数组 → 逐个剥壳拼接", () => {
    expect(toolOutputText([
      { type: "text", text: '{"ok":' },
      { type: "text", text: "true}" },
    ])).toBe('{"ok":true}');
  });

  it("其它对象兜底序列化，不丢信息", () => {
    expect(toolOutputText({ a: 1 })).toBe('{"a":1}');
    expect(toolOutputText(null)).toBe('""');   // 与旧行为一致：null ?? "" 后序列化
  });
});
