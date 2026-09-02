// ── 「问 AI」深链入口 ────────────────────────────────────────────
// 任意页面带上下文跳到对话页：#/assistant?ctx=<锚点>&q=<自动发送的问题>
// ctx 锚点格式与主进程 resolveContextNote 对齐：contact:<id> | company:<id> | message:<id>
// q 由对话页读取后立即发送并从 hash 中清除（刷新不重复发送）。
export type AskCtx = `contact:${number}` | `company:${number}` | `message:${number}` | (string & {});

export function askAssistant(o: { ctx?: AskCtx; question: string }): void {
  const sp = new URLSearchParams();
  if (o.ctx) sp.set("ctx", o.ctx);
  sp.set("q", o.question);
  // 同一路径下仅 query 变化也会触发 hashchange；已在对话页时同样生效
  window.location.hash = `#/assistant?${sp.toString()}`;
}

/** 一行按钮文案统一的便捷封装，供各页面「问 AI」按钮复用 */
export const ASK_AI_HINT = "带着当前对象的信息问 AI 助手";
