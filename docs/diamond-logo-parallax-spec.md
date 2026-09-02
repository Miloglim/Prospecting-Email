# DiamondLogo 指针视差轨迹跟踪 设计规范

> 落点：`src/renderer/components/DiamondLogo.tsx` / `.css`。改实现先改本规范。

## 目标

菱形标识拆为两层——外圈（描边菱形）与中心点——对指针做**不同偏移量**的跟随，
产生"中心点浮在外圈上方"的立体轨迹跟踪效果。

## 分层结构

```
.dl            组件根（定位上下文 + 指针事件面）
└─ .dl-track   视差层 ×2（JS 写 transform，只管位移）
   ├─ .dl-box  外圈：可见菱形边框，承担旋转/呼吸/光晕
   └─ .dl-core 中心点：可见圆角方块，承担闪烁
```

规则：**动画（spin/breathe/pulse）只作用于内层视觉元素，视差位移只作用于 .dl-track 层**，
两层各写各的 transform，互不覆盖。

## 跟踪参数

**跟踪是指针的全局属性，与 hover 无关。** 鼠标在窗口任意位置，图标都应朝它偏转；
hover 只负责"指向性交互"（光晕、idle 放大、running 加速），不再承担视差输入。

| 参数 | 值 | 说明 |
|------|----|------|
| 输入源 | `window` 的 pointermove（全局） | 不再要求指针悬停在图标上 |
| 归一化 | `dx, dy = (指针 − 图标中心) / REACH`，clamp 到 [−1, 1] | `REACH = 220px` 影响半径 |
| 幅度 | 距中心越远偏转越大，到 `REACH` 处饱和为满偏 | 近处不抖（偏移自然趋 0），远处稳定"朝向"指针 |
| 外圈位移系数 | `0.14 × size` | 位移小 = 视觉上更远 |
| 中心点位移系数 | `0.32 × size` | 位移大 = 视觉上更近（浮起感） |
| 跟随过渡 | `translate .12s ease-out`（指针在 REACH 内，JS 加 `.dl-near`） | 顺滑但不黏滞 |
| 回弹 | `translate .48s cubic-bezier(.34,1.56,.64,1)`（超出半径/指针离开窗口） | 轻微过冲弹回中心 |
| 多实例 | 全页共用 1 个 window 监听 + rAF 批量派发（`lib/pointer.ts`） | 侧栏/页头/空态多个图标不各挂一份 |
| 实现 | ref 直写 `style.translate`，不走 React state | 避免 mousemove 引发重渲染 |
| 不可见时 | 图标 rect 在视口外则跳过计算 | 折叠侧栏、切走页面不浪费帧 |

## 状态矩阵

| state | 呼吸 | 旋转 | 中心点 | 视差跟踪 |
|-------|------|------|--------|----------|
| static | — | — | 无 | **关**（内联小按钮不抖动） |
| idle | ✓ | — | ✓ 慢闪 | **开（全局指针）** |
| running | — | ✓（hover 加速） | ✓ 快闪 | **开（全局指针）** |

## 无障碍

`prefers-reduced-motion: reduce` 时 JS 跳过跟踪（呼吸/旋转仍由 CSS 媒体查询豁免另述——本期从简，仅跟踪响应媒体查询）。

## hover 光晕

保留现行：`.dl:hover .dl-box { box-shadow: 0 0 0 3px currentColor@12% }`；
running 态 hover 加速旋转；原 idle 外层呼吸与 hover 放大不冲突（层级不同）。
