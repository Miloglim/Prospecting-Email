import { describe, it, expect } from "vitest";
import { renderTemplate } from "../../src/main/services/send.service";

const baseVars = {
  firstName: "John", lastName: "Smith", company: "ACME Corp",
  email: "john@acme.com", title: "CEO", phone: "+12345678",
};

describe("renderTemplate — 模板变量渲染", () => {
  it("渲染全部基础变量", () => {
    const out = renderTemplate("Hi {{firstName}} {{lastName}} at {{company}}, {{email}} {{title}} {{phone}}", baseVars);
    expect(out).toBe("Hi John Smith at ACME Corp, john@acme.com CEO +12345678");
  });

  it("兼容 contact.* 前缀写法与多余空格", () => {
    const out = renderTemplate("{{ contact.firstName }} / {{  company  }}", baseVars);
    expect(out).toBe("John / ACME Corp");
  });

  it("未提供的变量清空，不留 {{}} 残渣", () => {
    const out = renderTemplate("Hi {{unknown}}!", { email: "a@b.c" });
    expect(out).toBe("Hi !");
  });

  it("null/undefined 字段渲染为空字符串", () => {
    const out = renderTemplate("Hi {{firstName}} {{lastName}}", { firstName: null, lastName: undefined, email: "a@b.c" });
    expect(out).toBe("Hi  ");
  });

  it("随机词 {a|b|c} 每次渲染取其一", () => {
    const out = renderTemplate("Hello {World|There}!", baseVars);
    expect(["Hello World!", "Hello There!"]).toContain(out);
  });

  it("$& $' 等特殊序列不破坏正文（价格场景）", () => {
    // 公司名含 replace 特殊序列 — 旧实现会把 $& 解释成"整个匹配"导致正文损坏
    const company = 'Best Price $100 $& $\' $` Co.';
    const vars = { ...baseVars, company };
    const out = renderTemplate("Deal with {{company}} now", vars);
    expect(out).toBe("Deal with " + company + " now");
  });

  it("变量值里的美元符号原样保留", () => {
    const out = renderTemplate("Quote: {{company}}", { ...baseVars, company: "USD $50 FOB" });
    expect(out).toBe("Quote: USD $50 FOB");
  });

  it("空模板与空联系人安全", () => {
    expect(renderTemplate("", baseVars)).toBe("");
    expect(renderTemplate("static text", { email: "" })).toBe("static text");
  });
});
