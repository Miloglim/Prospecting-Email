import { describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// email_read_full 的 HTML → 纯文本转换
// 用户实测翻车：agent 读全文工具把 Gmail 原始 HTML 原样返回，
// 对话卡里全是 <div>/<span> 标签和签名档 base64 内嵌图（单封 3 万+ 字符），
// 撑爆对话卡也撑爆模型上下文（26.8k input）。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/db", () => ({ getDb: () => null, saveDatabase: () => {}, getRawDb: () => null }));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", () => ({ APP_ROOT: ".", DB_PATH: "test.db" }));

const { htmlToText } = await import("../../src/main/services/inbox.service");

describe("htmlToText", () => {
  it("剔掉 data:URI base64 内嵌图（签名档大头）", () => {
    const html = `<div>Hi<img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ"></div>`;
    const out = htmlToText(html);
    expect(out).toBe("Hi");
    expect(out).not.toContain("base64");
  });

  it("去标签保段落，块级元素转换行", () => {
    const html = `<p>Greetings from the Philippines!</p><p>We are <strong>GCRA</strong>.</p><div>Best regards</div>`;
    const out = htmlToText(html);
    expect(out).toBe("Greetings from the Philippines!\n\nWe are GCRA.\n\nBest regards");
  });

  it("script/style/head 整块剔除，不漏样式正文", () => {
    const html = `<head><style>.x{color:red}</style></head><body><style>p{margin:0}</style><p>body text</p><script>alert(1)</script></body>`;
    const out = htmlToText(html);
    expect(out).toBe("body text");
  });

  it("常见 HTML 实体解码", () => {
    const html = `<p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp;end</p>`;
    const out = htmlToText(html);
    expect(out).toBe(`A & B <tag> "q" 's' end`);
  });

  it("多行空白压缩成最多一个空行", () => {
    const html = `<p>a</p>\n<p>b</p><br><br><br><p>c</p>`;
    const out = htmlToText(html);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain("a\n\nb\n\nc");
  });
});
