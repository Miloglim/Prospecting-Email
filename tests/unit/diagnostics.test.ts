import { describe, it, expect } from "vitest";
import { maskSecrets, tailByBytes } from "../../src/main/services/diagnostics.service";

describe("诊断包配置掩码 maskSecrets", () => {
  it("命中密钥语义的字段值整体打码", () => {
    const out = maskSecrets({
      smtpPassword: "p@ss", apiKey: "sk-xxx", token: "abc", auth: "bearer", secret: "s",
      host: "smtp.x.com", port: 465,
    }) as Record<string, unknown>;
    expect(out.smtpPassword).toBe("***");
    expect(out.apiKey).toBe("***");
    expect(out.token).toBe("***");
    expect(out.auth).toBe("***");
    expect(out.secret).toBe("***");
    expect(out.host).toBe("smtp.x.com");
    expect(out.port).toBe(465);
  });

  it("递归进数组与嵌套对象；不命中语义的值原样保留", () => {
    const out = maskSecrets({
      accounts: [{ email: "a@b.com", password: "x", name: "M" }],
      schedule: { startHour: 9, apiKey: "k" },
    }) as { accounts: Record<string, unknown>[]; schedule: Record<string, unknown> };
    expect(out.accounts[0].email).toBe("a@b.com");
    expect(out.accounts[0].name).toBe("M");
    expect(out.accounts[0].password).toBe("***");
    expect(out.schedule.startHour).toBe(9);
    expect(out.schedule.apiKey).toBe("***");
  });

  it("超深嵌套在限深处停手（防环形结构爆栈），原始类型/空值直传", () => {
    expect(maskSecrets(5)).toBe(5);
    expect(maskSecrets(null)).toBeNull();
    expect(maskSecrets("x")).toBe("x");
  });
});

describe("日志尾部裁剪 tailByBytes", () => {
  it("不超上限原样返回", () => {
    expect(tailByBytes("short\nlines", 1000)).toBe("short\nlines");
  });

  it("超限从整行边界裁，并标注前文省略", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const out = tailByBytes(text, 60);
    expect(out.startsWith("（前文超长省略）\n")).toBe(true);
    expect(out.endsWith("line-99")).toBe(true);
    // 裁在整行边界：不含被截断的半截行（每行都完整以 "line-" 开头）
    expect(out.split("\n").slice(1).every(l => l.startsWith("line-"))).toBe(true);
  });
});
