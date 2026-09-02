import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { parallaxFor, subscribePointer } from "@/lib/pointer";
import "./DiamondLogo.css";

// ── 程序菱形标识（Prospector 菱形 logo）──
// 描边/内核用 currentColor：深色侧栏继承白色、浅色页面继承黑色，无需分场景配色。
// state：static 无动效（按钮内联用）；idle 呼吸（待机"活着"）；running 旋转+内核快闪（agent 输出中）。
// 视差：外圈(.dl-track--box)与中心点(.dl-track--core)按**全局指针**做不同系数位移，
// 形成立体轨迹跟踪——与 hover 无关，鼠标在窗口任意位置都会朝它偏转。
// 规范见 docs/diamond-logo-parallax-spec.md。

export type DiamondState = "static" | "idle" | "running";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function DiamondLogo({ size = 16, state = "idle", className }: {
  size?: number; state?: DiamondState; className?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const boxTrack = useRef<HTMLSpanElement>(null);
  const coreTrack = useRef<HTMLSpanElement>(null);

  const bw = Math.max(1.5, +(size * 0.09).toFixed(2));
  const core = Math.max(3, Math.round(size * 0.2));
  const trackable = state !== "static";

  // 全局指针跟踪：所有实例共用 lib/pointer 的单个 window 监听（rAF 批量派发）
  useEffect(() => {
    if (!trackable || prefersReducedMotion()) return;
    return subscribePointer((x, y) => {
      const root = rootRef.current;
      if (!root) return;
      const boxEl = boxTrack.current, coreEl = coreTrack.current;
      if (Number.isNaN(x)) {                       // 指针离开窗口 → 慢回弹归零
        root.classList.remove("dl-near");
        if (boxEl) boxEl.style.translate = "0px 0px";
        if (coreEl) coreEl.style.translate = "0px 0px";
        return;
      }
      const r = root.getBoundingClientRect();
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return;  // 不可见不浪费帧
      const p = parallaxFor(x - (r.left + r.width / 2), y - (r.top + r.height / 2), size);
      root.classList.toggle("dl-near", p.near);    // 半径内快跟随，半径外走回弹曲线
      if (boxEl) boxEl.style.translate = `${p.bx}px ${p.by}px`;
      if (coreEl) coreEl.style.translate = `${p.cx}px ${p.cy}px`;
    });
  }, [trackable, size]);

  return (
    <span
      ref={rootRef}
      className={cn("dl", `dl-${state}`, trackable && "dl-trackable", className)}
      style={{ width: size, height: size }}
    >
      <span ref={boxTrack} className="dl-track dl-track--box">
        <span className="dl-box" style={{ borderWidth: bw }} />
      </span>
      {state !== "static" && (
        <span ref={coreTrack} className="dl-track dl-track--core">
          <span className="dl-core" style={{ width: core, height: core }} />
        </span>
      )}
    </span>
  );
}
