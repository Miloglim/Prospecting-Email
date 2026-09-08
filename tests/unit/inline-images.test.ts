import { describe, expect, it } from "vitest";
import { embedInlineImages, deadImageRefs } from "../../src/main/services/inline-images";
import { deadImageRefs as editorDeadRefs } from "../../src/renderer/lib/signature";

// ═══════════════════════════════════════════════════════════════════
// 发信内联图片归一（签名图片失效的根治）：能取到内容的图片（data/file/http）一律转 CID 附件，
// 取不到的（悬空 cid:、相对路径）如实上报。这里用注入 loader 的纯函数路径，不碰 fs/net。
// 样本 1x1 PNG 的 base64。
// ═══════════════════════════════════════════════════════════════════
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const DATA = `data:image/png;base64,${PNG_B64}`;

const loader = async (src: string) =>
  src.includes("missing") ? null : { buffer: Buffer.from(PNG_B64, "base64"), ext: "png" };

describe("data / file / http 图片转 CID 内嵌附件", () => {
  it("双引号 data URI：转附件并改写 src，附件内容与类型正确", async () => {
    const r = await embedInlineImages(`<p><img src="${DATA}" style="max-width:100%"></p>`, loader);
    expect(r.converted).toBe(1);
    expect(r.attachments[0]?.filename).toBe("img0.png");
    expect(r.attachments[0]?.content.length).toBeGreaterThan(0);
    expect(r.html).toContain(`src="cid:${r.attachments[0]!.cid}"`);
    expect(r.html).not.toContain("data:image");
  });

  it("单引号 src 也认（Word/邮件签名常见写法），旧实现只认双引号导致漏转", async () => {
    const r = await embedInlineImages(`<img src='${DATA}'>`, loader);
    expect(r.converted).toBe(1);
    expect(r.html).toContain("cid:");
  });

  it("file:/// 与本地绝对路径、http(s) 交给 loader 取字节后内嵌", async () => {
    const r = await embedInlineImages(
      `<img src="file:///C:/Users/me/sign.png"><img src="C:\\\\signs\\\\logo.jpg"><img src="http://192.168.1.9:8788/images/x.png">`,
      loader,
    );
    expect(r.converted).toBe(3);
    expect(r.unresolved).toEqual([]);
    expect(r.html.match(/cid:img/g)).toHaveLength(3);
  });

  it("取不到内容的图片不阻断发信：保留原样并上报", async () => {
    const r = await embedInlineImages(`<img src="https://x.dev/missing.png">`, loader);
    expect(r.converted).toBe(0);
    expect(r.html).toContain("missing.png");
    expect(r.unresolved).toEqual(["https://x.dev/missing.png"]);
  });

  it("同一个 src 多处引用只做一个附件", async () => {
    const r = await embedInlineImages(`<img src="${DATA}"><img src="${DATA}">`, loader);
    expect(r.attachments.length).toBe(1);
    expect((r.html.match(/cid:/g) ?? []).length).toBe(2);
  });

  it("background 属性与 CSS url() 里的图片同样内嵌", async () => {
    const r = await embedInlineImages(
      `<table><tr><td background="${DATA}"><div style="background:url('${DATA}')"></div></td></tr></table>`,
      loader,
    );
    expect(r.converted).toBe(1);
    expect(r.html.match(/cid:/g)).toHaveLength(2);
  });

  it("超出张数上限的保留原样（防签名+正文塞爆邮件）", async () => {
    const many = Array.from({ length: 5 }, (_, i) => `<img src="https://x.dev/p${i}.png">`).join("");
    const r = await embedInlineImages(many, loader, { maxImages: 2 });
    expect(r.converted).toBe(2);
    expect(r.unresolved.length).toBe(3);
  });

  it("正文里没有图片时零改动", async () => {
    const r = await embedInlineImages("<p>纯文字签名 Zayne / YQN</p>", loader);
    expect(r.converted).toBe(0);
    expect(r.attachments).toEqual([]);
    expect(r.html).toBe("<p>纯文字签名 Zayne / YQN</p>");
  });
});

describe("救不回来的引用判据：main 与编辑器侧必须同一套口径", () => {
  const samples = [
    `<img src="cid:image001.png@01D9...">`,          // Word/Outlook 粘贴带来的悬空引用
    `<img src="logo.png">`,                           // 相对路径：收件人无 base 可解析
    `<img src='blob:http://localhost/abc'>`,         // 编辑器粘贴未落库
    `<img src="about:blank">`,
  ];
  for (const [i, html] of samples.entries()) {
    it(`样本 ${i + 1}：两边都判为不可内嵌`, async () => {
      const r = await embedInlineImages(html, loader);
      expect(r.converted).toBe(0);
      expect(r.unresolved.length).toBe(1);
      expect(editorDeadRefs(html).length).toBe(1);
    });
  }

  it("能救的引用两边都不报警（file/http/data/绝对路径）", async () => {
    const ok = `<img src="${DATA}"><img src="http://192.168.1.9/a.png"><img src="C:\\a.png"><img src="/srv/a.png">`;
    expect(editorDeadRefs(ok)).toEqual([]);
    const r = await embedInlineImages(ok, loader);
    expect(r.unresolved).toEqual([]);
    expect(r.converted).toBe(4);
  });

  it("deadImageRefs（main 侧导出）与编辑器实现一致", () => {
    for (const html of samples) {
      expect(deadImageRefs(html).length, html).toBe(1);
      expect(editorDeadRefs(html).length, html).toBe(1);
    }
  });
});
