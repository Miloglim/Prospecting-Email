// ── 全局指针轨道（多处视差图标共用一个监听）────────────────────
// 为什么要共享：DiamondLogo 在侧栏、页头、空态里同时存在多个实例，各自 addEventListener
// 会把 pointermove 变成 N 份回调；这里一个 window 监听 + rAF 批量派发，所有订阅者同帧更新。
export const REACH_PX = 220;      // 影响半径：超过即饱和为满偏
const BOX_K = 0.14;               // 外圈位移系数（视觉更远）
const CORE_K = 0.32;              // 中心点位移系数（视觉更近，浮起感）

export interface Parallax { bx: number; by: number; cx: number; cy: number; near: boolean }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 视差偏转量（纯函数，便于单测）：
 * 近中心→偏移趋 0（不抖），越远偏转越大，到 REACH 饱和为满偏并保持"朝向"指针。
 */
export function parallaxFor(dxp: number, dyp: number, size: number, reach = REACH_PX): Parallax {
  const nx = clamp(dxp / reach, -1, 1);
  const ny = clamp(dyp / reach, -1, 1);
  return {
    bx: +(nx * size * BOX_K).toFixed(2),
    by: +(ny * size * BOX_K).toFixed(2),
    cx: +(nx * size * CORE_K).toFixed(2),
    cy: +(ny * size * CORE_K).toFixed(2),
    near: Math.hypot(dxp, dyp) <= reach,
  };
}

type PointerCb = (x: number, y: number) => void;
const subs = new Set<PointerCb>();
let raf = 0;
let last: { x: number; y: number } | null = null;

function flush(): void {
  raf = 0;
  if (!last) return;
  for (const cb of subs) cb(last.x, last.y);
}

function onMove(e: PointerEvent): void {
  last = { x: e.clientX, y: e.clientY };
  if (!raf) raf = requestAnimationFrame(flush);
}

function onLeave(): void {
  // 指针离开窗口：以"无穷远"通知订阅者回弹（由调用方按 near=false 走慢回弹）
  last = null;
  for (const cb of subs) cb(Number.NaN, Number.NaN);
}

function onOut(e: PointerEvent): void {
  if (!e.relatedTarget) onLeave();
}

/** 订阅全局指针；返回退订函数。首个订阅者才挂 window 监听。 */
export function subscribePointer(cb: PointerCb): () => void {
  const first = subs.size === 0;
  subs.add(cb);
  if (first && typeof window !== "undefined") {
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerout", onOut, { passive: true });
    window.addEventListener("blur", onLeave);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      window.removeEventListener("blur", onLeave);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
  };
}
