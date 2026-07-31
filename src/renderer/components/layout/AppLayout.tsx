import { Layout } from "antd";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { useAppContext } from "../../AppContext";

const { Header, Content } = Layout;

const pageTitles: Record<string, string> = {
  "/": "仪表盘",
  "/contacts": "联系人管理",
  "/companies": "公司管理",
  "/campaigns": "发送管理",
  "/inbox": "收件箱",
  "/crm": "CRM 管线",
  "/templates": "模板管理",
  "/export": "数据导出",
  "/settings": "系统设置",
};

export function AppLayout() {
  const { sidebarCollapsed, toggleSidebar } = useAppContext();
  const pathname = useRouterState({ select: s => s.location.pathname });
  const title = pageTitles[pathname] || "";

  return (
    <Layout className="h-screen" hasSider>
      <Sidebar />
      <Layout>
        {/* Titlebar */}
        <Header
          style={{
            background: "#1a1a1a",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            height: 36,
            flexShrink: 0,
          }}
        >
          <span className="text-xs text-white/60 tracking-wide">{title}</span>
        </Header>

        {/* Content */}
        <Content style={{
          padding: "28px 36px",
          overflow: "auto",
          background: "#f5f5f5",
          minHeight: 0,
        }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
