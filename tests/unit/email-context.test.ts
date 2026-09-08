import { describe, expect, it } from "vitest";
import { composeEmailNote, EMAIL_BODY_CAP, type EmailNoteInput } from "../../src/main/services/agent/email-context";

// ═══════════════════════════════════════════════════════════════════
// 邮件上下文注记（docs 会话导出实锤）：2026-09-08 那轮「起草回信」翻车的根因不在模型，
// 在我们把 500 字的 bodyPreview 标成「全文已提供，不要再调用工具去读它」——它遵旨不读，
// 然后编造出对方根本没提的诉求（"is this FAK price or specific shipping line"）。
// 铁律：标注必须与实给内容一致。三种口径各有钉子。
// ═══════════════════════════════════════════════════════════════════

const base: EmailNoteInput = {
  id: 16703,
  subject: "Quotation Request FCL - QUOTE-1297-0926",
  who: "Isabella Mendes | Three Logistics <quotation@threelogintl.com>",
  classification: "other",
  receivedAt: "2026-09-04T20:46:10.000Z",
  matchIds: [],
  bodyPreview: "International Quotation Request - FCL",
  fullText: null,
};

describe("composeEmailNote 三种口径", () => {
  it("原文未落盘：只给预览也敢叫预览，并明令起草前先 email_read_full", () => {
    const note = composeEmailNote(base);
    expect(note).toContain("仅为入库预览");
    expect(note).toContain("必须先 email_read_full");
    expect(note).not.toContain("不要再调用工具去读它");   // 绝不冒称全文
    expect(note).toContain("International Quotation Request - FCL");
  });

  it("本地全文不超长：才许说「全文已提供」，并铺好回信的路（generate_draft 传 messageId）", () => {
    const full = "Dear Partner, Please provide your quotation... Freight Rate / Validity, Transit Time, ETD, Carrier.";
    const note = composeEmailNote({ ...base, fullText: full });
    expect(note).toContain("全文已随本次提问一并提供");
    expect(note).toContain("不要再调用工具去读它");
    expect(note).toContain(`generate_draft 直接传 messageId=${base.id}`);
    expect(note).toContain(full);
  });

  it("全文超长：给前段并如实标注截断，逐条应答前仍须 email_read_full", () => {
    const long = "x".repeat(EMAIL_BODY_CAP + 500);
    const note = composeEmailNote({ ...base, fullText: long });
    expect(note).toContain(`全文前 ${EMAIL_BODY_CAP} 字`);
    expect(note).toContain("先 email_read_full");
    expect(note).not.toContain("全文已随本次提问一并提供");
  });

  it("预览也为空：指路读原文，绝不叫用户粘贴正文", () => {
    const note = composeEmailNote({ ...base, bodyPreview: "", fullText: null });
    expect(note).toContain("email_read_full");
    expect(note).toContain(`generate_draft 传 messageId=${base.id}`);
    expect(note).toContain("绝不要让用户粘贴正文");
  });

  it("头部信息齐全：主题/发件人/分类/时间/多被退联系人一个不丢", () => {
    const note = composeEmailNote({ ...base, matchIds: [11, 22] });
    expect(note).toContain("QUOTE-1297-0926");
    expect(note).toContain("quotation@threelogintl.com");
    expect(note).toContain("分类 other");
    expect(note).toContain("已匹配联系人 #11、#22");
  });
});
