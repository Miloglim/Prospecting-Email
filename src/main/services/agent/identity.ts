// ── 助手身份档案（我方是谁 / 我们公司 / 固定扮演的角色）──────────────
// 为什么需要：此前 agent 的系统提示词只说"你是货代销售助手"，不知道用户是谁、公司叫什么、
// 签名长什么样 —— 起草回信时只能留 {{firstName}} {{company}} {{phone}} 这种占位符，
// 而真发信时 send.service 会自动追加署名，两边不一致。身份在这里一次读出，注入每轮对话。
import { loadConfig } from "../../config";

export interface Identity {
  /** 正文自称（如 Zayne） */
  selfName: string;
  /** 发件人显示名 */
  fromName: string;
  /** 我方公司名 */
  company: string;
  /** 职位 */
  title: string;
  /** 主营航线/服务口径（例：拉美整箱，主做 CMA/MSC） */
  business: string;
  /** 固定扮演的角色与口径（例：我代表我方公司与客户谈舱位与报价，不承诺未确认的价格） */
  persona: string;
  /** 邮件署名（含联系方式） */
  signature: string;
}

export function readIdentity(): Identity {
  const c = loadConfig();
  const id = c.identity || {};
  return {
    selfName: (c.bodyName || "").trim(),
    fromName: (c.fromName || "").trim(),
    company: (id.company || "").trim(),
    title: (id.title || "").trim(),
    business: (id.business || "").trim(),
    persona: (id.persona || "").trim(),
    signature: (c.signature || "").trim(),
  };
}

/** 缺失的关键项（供界面提示"助手还不知道你是谁"） */
export function identityGaps(i: Identity = readIdentity()): string[] {
  const gaps: string[] = [];
  if (!i.selfName && !i.fromName) gaps.push("自称/发件人名称");
  if (!i.company) gaps.push("我方公司名");
  if (!i.signature) gaps.push("邮件署名");
  return gaps;
}

/**
 * 注入到系统提示词的身份块。全部为空时返回空串（不污染上下文）。
 * 只讲事实与口径，不替代工具：涉及库内数据仍必须先查。
 */
export function identityBlock(i: Identity = readIdentity()): string {
  const lines: string[] = [];
  const who = [i.selfName || i.fromName, i.title, i.company].filter(Boolean).join(" · ");
  if (who) lines.push(`我方身份：${who}`);
  if (i.business) lines.push(`我方业务：${i.business}`);
  if (i.persona) lines.push(`你的固定角色：${i.persona}`);
  if (i.signature) lines.push(`邮件署名（写正文/回信时直接用它落款）：\n${i.signature}`);
  if (!lines.length) return "";
  lines.push("写信/回信默认用上面这些信息自称与落款；禁止再留 {{firstName}}/{{company}}/{{phone}} 之类占位符，只有确实不知道的收件人字段才用 {{占位}}，并一句话说明缺什么。");
  return "\n\n【我方身份档案】\n" + lines.join("\n");
}
