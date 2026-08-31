import { useState, useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DashboardOutlined, UserOutlined, SendOutlined,
  InboxOutlined, FileTextOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useAppContext } from "../../AppContext";

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  dot?: boolean;
}

const navGroups: { items: NavItem[] }[] = [
  {
    items: [
      { key: "/", icon: <DashboardOutlined />, label: "仪表盘" },
    ],
  },
  {
    items: [
      { key: "/inbox", icon: <InboxOutlined />, label: "收件箱", dot: true },
      { key: "/customers", icon: <UserOutlined />, label: "客户", dot: true },
    ],
  },
  {
    items: [
      { key: "/campaigns", icon: <SendOutlined />, label: "发送中心" },
      { key: "/templates", icon: <FileTextOutlined />, label: "素材库" },
    ],
  },
];

const bottomItems: NavItem[] = [
  { key: "/settings", icon: <SettingOutlined />, label: "设置" },
];

// 共用的导航项样式
const navItemStyle = (active: boolean): React.CSSProperties => ({
  padding: "12px 20px",
  cursor: "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  gap: 10,
  borderLeft: `3px solid ${active ? "#00bfa5" : "transparent"}`,
  background: active ? "rgba(255,255,255,0.14)" : "transparent",
  fontWeight: active ? 600 : 400,
  transition: "background 0.15s, border-color 0.15s",
  color: "#fff",
});

export function Sidebar() {
  const { sidebarCollapsed } = useAppContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: s => s.location.pathname });
  const [version, setVersion] = useState("");

  useEffect(() => {
    window.api.invoke("system:appVersion").then((r) => {
      if (r && typeof r === "object" && "success" in r && r.success && "data" in r) {
        setVersion(String(r.data));
      }
    }).catch((err) => {
      console.error("[Sidebar] appVersion failed:", err);
    });
  }, []);

  const isActive = (key: string) =>
    pathname === key || (key !== "/" && pathname.startsWith(key));

  const width = sidebarCollapsed ? 64 : 210;

  const renderItem = (item: NavItem) => (
    <li
      key={item.key}
      onClick={() => navigate({ to: item.key })}
      style={navItemStyle(isActive(item.key))}
      onMouseEnter={(e) => {
        if (!isActive(item.key))
          e.currentTarget.style.background = "rgba(255,255,255,0.08)";
      }}
      onMouseLeave={(e) => {
        if (!isActive(item.key))
          e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{
        width: 20, height: 20, textAlign: "center",
        flexShrink: 0, display: "inline-flex",
        alignItems: "center", justifyContent: "center",
      }}>
        {item.icon}
      </span>
      {!sidebarCollapsed && (
        <>
          {item.label}
          {item.dot && (
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "#e5484d", marginLeft: 4, flexShrink: 0,
              opacity: 0,
            }} />
          )}
        </>
      )}
    </li>
  );

  return (
    <aside
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        background: "#1a1a1a",
        borderRight: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: "width 0.2s, min-width 0.2s, max-width 0.2s",
      }}
    >
      {/* Brand */}
      <div
        style={{ padding: sidebarCollapsed ? "16px 0" : "24px 20px 20px", cursor: "pointer", textAlign: sidebarCollapsed ? "center" : "left" }}
        onClick={() => navigate({ to: "/" })}
      >
        {sidebarCollapsed ? (
          <div style={{
            width: 24, height: 24, borderRadius: 4,
            background: "#00bfa5", display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, color: "#000",
          }}>
            M
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, opacity: 0.5, display: "block", color: "#999" }}>
              Milogin&apos;s
            </div>
            <h1 style={{
              fontSize: 20, fontWeight: 700, letterSpacing: "0.5px",
              margin: 0, color: "#fff",
            }}>
              Prospector<span style={{ color: "#00bfa5" }}>.</span>
            </h1>
          </>
        )}
      </div>

      {/* Nav — 匹配旧 PE: 分组 + 底部设置 */}
      <nav style={{ flex: 1, overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flexShrink: 0 }}>
          {navGroups.map((group, gi) => (
            <ul
              key={gi}
              style={{
                listStyle: "none", padding: 0,
                marginBottom: gi === 0 ? 12 : 18,
                marginTop: 0,
              }}
            >
              {group.items.map(renderItem)}
            </ul>
          ))}
        </div>

        {/* 设置 — 横线分隔，匹配旧 PE nav-bottom */}
        <ul style={{
          listStyle: "none", padding: 0, margin: 0,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          marginTop: "auto",
        }}>
          {bottomItems.map(renderItem)}
        </ul>
      </nav>

      {/* 版本号 — 固定在侧边栏底部 */}
      {!sidebarCollapsed && (
        <div style={{
          padding: "10px 20px 10px 20px",
          borderTop: "1px solid rgba(255,255,255,0.12)",
          fontSize: 11, color: "rgba(255,255,255,0.45)",
          flexShrink: 0,
        }}>
          v{version || "4.0"}
        </div>
      )}
    </aside>
  );
}
