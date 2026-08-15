import { Layout } from "antd";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";

const { Content } = Layout;

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

export function AppLayout() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TitleBar />
      <Layout style={{ flex: 1, minHeight: 0 }} hasSider>
        <Sidebar />
        <Layout>
          <Content style={{
            padding: "28px 36px", overflow: "auto",
            background: "#f5f5f5", minHeight: 0,
          }}>
            <Outlet />
          </Content>
        </Layout>
      </Layout>
    </div>
  );
}
