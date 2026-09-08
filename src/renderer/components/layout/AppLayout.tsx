import { useLayoutEffect, useRef } from "react";
import { Layout } from "antd";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { OnboardingWizard } from "../OnboardingWizard";
import { KEEPALIVE_ROUTE_COMPONENTS } from "../../router";

const { Content } = Layout;

/** 路由级 keep-alive：登记过的页面切走只隐藏不卸载，切回来零重挂、零 loading 闪变。
 *  · 缓存键 = pathname；从别的页面带着新 query 深链进来时换新实例（页面挂载时读 query 的语义不变）；
 *  · 同页 query 变化保持挂载，由页面自行响应（与 TanStack 默认一致）；
 *  · 未登记的路由照常走 <Outlet />，行为与从前完全相同。
 *  隐藏期间轻量轮询照跑（send:status 等），send:progress 持续入缓存 —— 回来即实况。 */
function KeepAliveOutlet() {
  const { pathname, searchStr } = useRouterState({ select: s => ({ pathname: s.location.pathname, searchStr: s.location.searchStr }) });
  const cacheRef = useRef<Map<string, { el: React.ReactNode; searchStr: string }>>(new Map());
  const prevPathRef = useRef<string>(pathname);

  const Comp = KEEPALIVE_ROUTE_COMPONENTS[pathname];
  if (Comp) {
    const cache = cacheRef.current;
    const entry = cache.get(pathname);
    if (!entry) {
      cache.set(pathname, { el: <Comp />, searchStr });
    } else if (prevPathRef.current !== pathname && entry.searchStr !== searchStr) {
      cache.set(pathname, { el: <Comp key={searchStr} />, searchStr });
    }
  }
  prevPathRef.current = pathname;

  return (
    <>
      {[...cacheRef.current.entries()].map(([p, e]) => (
        <div key={p} hidden={p !== pathname} style={p === pathname ? undefined : { height: "100%" }}>{e.el}</div>
      ))}
      {!Comp && <Outlet />}
    </>
  );
}

const btn: React.CSSProperties = {
  width: 46, height: 36, border: "none", background: "transparent",
  color: "#999", cursor: "pointer", display: "inline-flex",
  alignItems: "center", justifyContent: "center", borderRadius: 0,
};

// ponytail: 无边框窗口自定义标题栏 — 匹配旧 PE 布局
function TitleBar() {
  return (
    <div
      style={{
        height: 36, background: "#1a1a1a", display: "flex",
        alignItems: "center", justifyContent: "space-between",
        flexShrink: 0, userSelect: "none",
        borderBottom: "1px solid rgba(128,128,128,0.25)",
      }}
      className="titlebar-drag"
    >
      <div />

      <div className="titlebar-nodrag" style={{ display: "flex" }}>
        <button onClick={() => window.api.send("window:minimize")} style={btn}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          title="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4" width="10" height="1.5" fill="currentColor"/></svg>
        </button>
        <button onClick={() => window.api.send("window:maximize")} style={btn}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          title="最大化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" rx="1"/></svg>
        </button>
        <button onClick={() => window.api.send("window:close")} style={btn}
          onMouseEnter={e => { e.currentTarget.style.background = "#e81123"; e.currentTarget.style.color = "#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#999"; }}
          title="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </div>
    </div>
  );
}

/** 内容区滚动容器：每个路由记住自己的 scrollTop，切页互不串位置（keep-alive 后必需）。 */
function ScrollArea({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const posMap = useRef<Map<string, number>>(new Map());
  const activePath = useRef<string>(pathname);

  useLayoutEffect(() => {
    activePath.current = pathname;
    if (scrollRef.current) scrollRef.current.scrollTop = posMap.current.get(pathname) ?? 0;
  }, [pathname]);

  return (
    <div
      ref={scrollRef}
      onScroll={e => posMap.current.set(activePath.current, e.currentTarget.scrollTop)}
      style={{ height: "100%", overflow: "auto", padding: "28px 36px" }}
    >
      {children}
    </div>
  );
}

export function AppLayout() {
  const pathname = useRouterState({ select: s => s.location.pathname });
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TitleBar />
      <Layout style={{ flex: 1, minHeight: 0 }} hasSider>
        <Sidebar />
        <Layout>
          <Content style={{ background: "#f5f5f5", minHeight: 0, overflow: "hidden" }}>
            <ScrollArea pathname={pathname}>
              <KeepAliveOutlet />
            </ScrollArea>
          </Content>
        </Layout>
      </Layout>
      <OnboardingWizard />
    </div>
  );
}
