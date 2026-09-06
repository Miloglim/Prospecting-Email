// ── Agent 输出解析器 ────────────────────────────────────────────
// LLM 文本产物 → 结构化数据的唯一入口。此前「SUBJECT: 行 + 正文」的拆分正则
// 在 tools.ts 复制了三份，任一处改了其余不同步；收敛到这里，可单测。
// 渲染端 TemplateList 有一份同构变体（跨 bundle 不共享），改动需与之同步。

export interface DraftParts { subject: string; body: string }

/**
 * 拆分草稿输出：`SUBJECT: xxx` 行 + 正文。
 * 解析不到 SUBJECT 行时用兜底主题；失败不抛错，返回安全值。
 */
export function parseDraft(raw: string, fallbackSubject: string): DraftParts {
  const text = String(raw ?? "").trim();
  const m = /^SUBJECT:\s*(.+)\s*$/im.exec(text);
  const subject = (m?.[1] ?? fallbackSubject).trim().slice(0, 150);
  const body = (m ? text.slice(m.index + m[0].length) : text).replace(/^\s+/, "").trim();
  return { subject, body };
}

/** 解析出的 TSV 表格（首行为表头的二维数组） */
export type TsvRows = string[][];

/**
 * 把模型给的 TSV 文本解析成二维数组（csv 导出用）。
 * 弱模型手拼嵌套 JSON 数组极易写坏参数 JSON（Invalid JSON input，schema 层救不了），
 * 所以 csv 导出的协议改成：模型在 content 单字段里写多行 TSV 文本，解析归本函数。
 * 容错：全角空格当制表符（弱模型常见误用）、多余空行跳过。
 */
export function parseTsv(raw: string): TsvRows {
  return String(raw ?? "")
    .replace(/\u3000/g, "\t")
    .split(/\r?\n/)
    .map(line => line.split("\t").map(c => c.trim()))
    .filter(cols => cols.some(c => c.length > 0));
}
