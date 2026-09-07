import { EVENTS } from "../events";

// ── 建议流热更新总线 ─────────────────────────────────────────────
// 数据变化点（新邮件/退信/发送进度/运价同步/跟进写入）调 nudge()，
// debounce 合并抖动后重算 feed 并推送 SUGGESTIONS_CHANGED；内容没变不推。
// 刻意做成零依赖小模块：crm.service / inbox.ipc / send.ipc / rate-sync 都能
// 安全 import 而不与 suggestion.service 成环（suggestion.service 依赖它们取数）。
// 规范：docs/suggestion-feed-spec.md §5

type FeedHandler = () => unknown;
type PushFn = (channel: string, data: unknown) => void;

let handler: FeedHandler | null = null;
let push: PushFn | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastJson = "";

const DEBOUNCE_MS = 500;

/** 应用启动时注册一次：重算函数 + 推送通道 */
export function initSuggestionBus(h: FeedHandler, p: PushFn): void {
  handler = h;
  push = p;
}

/** 数据变了：500ms 合并同秒多事件，重算后内容真变了才推 */
export function nudge(): void {
  const h = handler;
  const p = push;
  if (!h || !p) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      const feed = h();
      const json = JSON.stringify(feed);
      if (json === lastJson) return;
      lastJson = json;
      p(EVENTS.SUGGESTIONS_CHANGED, feed);
    } catch {
      /* 重算失败不打扰：空态保持上一份，下一次事件再试 */
    }
  }, DEBOUNCE_MS);
}

/** 单测/重置用：清掉待飞的 debounce */
export function cancelNudge(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
