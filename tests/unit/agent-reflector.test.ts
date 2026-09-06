import { describe, it, expect } from "vitest";
import { reflectOnNumbers } from "../../src/main/services/agent/reflector";

const OUTPUTS = [
  JSON.stringify({ ok: true, total: 2350, returned: 50, say: "共 2350 封匹配，本条列出 50 封" }),
  JSON.stringify({ ok: true, results: [{ id: 839 }, { id: 7434 }] }),
];

describe("reflectOnNumbers（数量回溯）", () => {
  it("数量全部能回溯到工具返回 → 通过", () => {
    expect(reflectOnNumbers("收件箱共 2350 封邮件，这次列了 50 封", OUTPUTS)).toEqual([]);
  });

  it("编造的数量被抓出", () => {
    const bad = reflectOnNumbers("共有 99 封未读邮件，另有 3 条询盘", OUTPUTS);
    expect(bad).toContain("99封");
    expect(bad).toContain("3条");
  });

  it("真实数量断言即便带空格也在射程（2 个 = 数量，不是误伤）", () => {
    expect(reflectOnNumbers("发了 2 个 40HQ 的货", OUTPUTS)).toContain("2个");
  });

  it("不带量词的数字不在射程（日期/阶段/柜型不误伤）", () => {
    expect(reflectOnNumbers("9/3 推进到 F2，柜型 40HQ，报价单号 QUOTE-1268", OUTPUTS)).toEqual([]);
  });

  it("正文没有数量断言 → 通过", () => {
    expect(reflectOnNumbers("建议尽快跟进这位客户", OUTPUTS)).toEqual([]);
  });

  it("千分位数字按数值比对", () => {
    expect(reflectOnNumbers("总计 2,350 封", OUTPUTS)).toEqual([]);
  });

  it("用户输入里出现过的数字豁免（用户说 8714 就不能被纠成「若干」）", () => {
    // 用户问"8714 个联系人里沉默最久的是哪几个"→ 模型正文复述 8714 属实
    expect(reflectOnNumbers("您提到的 8714 个联系人里……", OUTPUTS, ["在 8714 个联系人里，沉默最久的是哪几个"])).toEqual([]);
    // 模型自己编的数字（用户没说过）依然被抓
    expect(reflectOnNumbers("共有 8714 位客户……", OUTPUTS, ["查一下谁该跟进"])).toContain("8714位");
  });
});
