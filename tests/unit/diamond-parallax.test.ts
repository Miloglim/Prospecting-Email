import { describe, expect, it } from "vitest";
import { parallaxFor, REACH_PX } from "../../src/renderer/lib/pointer";

// ═══════════════════════════════════════════════════════════════════
// 菱形标识的全局指针视差（纯数学部分）
// 要点：跟踪不依赖 hover；近中心不抖、远处朝指针稳定偏转并在影响半径外饱和。
// ═══════════════════════════════════════════════════════════════════

describe("parallaxFor（全局指针视差）", () => {
  it("指针正对图标中心时零偏转（近处不抖）", () => {
    const p = parallaxFor(0, 0, 16);
    expect([p.bx, p.by, p.cx, p.cy]).toEqual([0, 0, 0, 0]);
    expect(p.near).toBe(true);
  });

  it("中心点位移大于外圈（浮起感），方向与指针同侧", () => {
    const p = parallaxFor(60, -40, 44);
    expect(p.bx).toBeGreaterThan(0);
    expect(p.cx).toBeGreaterThan(p.bx);
    expect(p.by).toBeLessThan(0);
    expect(p.cy).toBeLessThan(p.by);
  });

  it("超出影响半径后饱和：再远也不会更大", () => {
    const atReach = parallaxFor(REACH_PX, 0, 44);
    const beyond = parallaxFor(REACH_PX * 4, 0, 44);
    expect(beyond.bx).toBeCloseTo(atReach.bx, 2);
    expect(atReach.near).toBe(true);          // 边界上仍算"近"，用快跟随曲线
    expect(parallaxFor(REACH_PX * 2, 0, 44).near).toBe(false);   // 远处走回弹曲线
  });

  it("满偏不超过系数上限（外圈 ≤ 0.14·size，中心点 ≤ 0.32·size）", () => {
    const p = parallaxFor(9999, 9999, 44);
    expect(Math.abs(p.bx)).toBeLessThanOrEqual(44 * 0.14 + 0.01);
    expect(Math.abs(p.cx)).toBeLessThanOrEqual(44 * 0.32 + 0.01);
  });

  it("同一直线上大小对称（左偏与右偏等量反号）", () => {
    const right = parallaxFor(120, 0, 16);
    const left = parallaxFor(-120, 0, 16);
    expect(right.bx).toBeCloseTo(-left.bx, 2);
    expect(right.cx).toBeCloseTo(-left.cx, 2);
  });
});
