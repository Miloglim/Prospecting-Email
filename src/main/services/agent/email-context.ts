// ── 邮件上下文注记（纯函数，可单测）────────────────────────────────
// 会话带 message:N 锚点时注入模型的「这封邮件是什么」注记。2026-09-08 会话导出实锤：
// bodyPreview 只有 500 字（询价信常常只剩一行标题），旧实现却标注
// 「全文已提供，不要再调用工具去读它」——模型遵旨不读，转头编造出对方根本没提的诉求。
// 现在的铁律：**标注必须与实给内容一致**——
//   · 本地落盘全文且没截断 → 才许说「全文已提供，不要再读」；
//   · 全文超长 → 给前段 + 明说「逐条应答前先 email_read_full」；
//   · 只有预览（原文未落盘）→ 明说「仅为预览，起草/总结前必须先 email_read_full」。
// htmlToText 由调用方做完再传进来（本模块零依赖，不拖 inbox/electron 链路进单测）。

export const EMAIL_BODY_CAP = 1600;

export interface EmailNoteInput {
  id: number;
  subject: string | null;
  /** 已拼好的「名字 <邮箱>」或纯邮箱 */
  who: string;
  classification: string | null;
  receivedAt: string;
  /** 关联联系人 id（退信一对多 + 单列兼容） */
  matchIds: number[];
  /** bodyPreview（入库摘要，≤500 字） */
  bodyPreview: string | null;
  /** 本地落盘正文转出的纯文本；null = 原文未落盘 */
  fullText: string | null;
}

/** 组装注入用的邮件上下文注记（一行头 + 一行正文 + 可选回信指路） */
export function composeEmailNote(e: EmailNoteInput): string {
  const header = `邮件 #${e.id}｜主题「${e.subject || "(无主题)"}」｜发件人 ${e.who}`
    + `｜分类 ${e.classification || "其他"}｜时间 ${e.receivedAt}`
    + `${e.matchIds.length ? `｜已匹配联系人 ${e.matchIds.map(x => `#${x}`).join("、")}` : ""}`;

  if (e.fullText !== null) {
    const body = e.fullText.slice(0, EMAIL_BODY_CAP);
    const state = e.fullText.length > EMAIL_BODY_CAP
      ? `（以下为全文前 ${EMAIL_BODY_CAP} 字，后面还有内容——逐条应答前先 email_read_full 读 messageId=${e.id}）`
      : "（全文已随本次提问一并提供，直接据此作答，不要再调用工具去读它）";
    return header + `\n正文${state}：${body}`
      + `\n要回复这封邮件：generate_draft 直接传 messageId=${e.id}（回信模式自动读全文逐条应答），不需要先 email_read_full。`;
  }

  // 原文未落盘：预览能给的先给，但绝不冒称全文
  const preview = (e.bodyPreview || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, EMAIL_BODY_CAP);
  if (!preview) {
    return header + `\n正文（库里摘要为空，原文也未落盘）：先 email_read_full 读 messageId=${e.id}`
      + "（系统会懒加载原文），或直接 generate_draft 传 messageId=" + e.id + " 起草回复；绝不要让用户粘贴正文。";
  }
  return header + `\n正文（以下仅为入库预览，原文未落盘——总结或起草回复前必须先 email_read_full 读全文，绝不许凭预览推断对方诉求）：${preview}`;
}
