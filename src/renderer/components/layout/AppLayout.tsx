import { Layout } from "antd";
import { Sidebar } from "./Sidebar";
import { useAppContext } from "../../AppContext";

const { Header, Content } = Layout;

// ponytail: 纯占位组件，Phase 8 替换为真实路由
function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500">
      <div className="text-6xl mb-4">🚧</div>
      <div className="text-xl mb-2">{title}</div>
      <div className="text-sm">此页面正在构建中</div>
    </div>
  );
}

export function AppLayout() {
  const { sidebarCollapsed, toggleSidebar } = useAppContext();

  // ponytail: 简单路由判断 — 后续 Phase 8 替换为 TanStack Router
  const currentPath = "/";

  const pageTitles: Record<string, string> = {
    "/": "仪表盘",
    "/contacts": "联系人管理",
    "/campaigns": "发送管理",
    "/inbox": "收件箱",
    "/crm": "CRM 管线",
    "/templates": "模板管理",
    "/export": "数据导出",
    "/settings": "系统设置",
  };

  return (
    <Layout className="h-screen" hasSider>
      <Sidebar />
      <Layout>
        <Header
          style={{
            background: "#09090b",
            borderBottom: "1px solid #27272a",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            height: 48,
          }}
        >
          <button
            onClick={toggleSidebar}
            className="text-zinc-400 hover:text-zinc-200 text-lg cursor-pointer bg-transparent border-0 mr-4"
          >
            {sidebarCollapsed ? "☰" : "✕"}
          </button>
          <span className="text-sm text-zinc-400">{pageTitles[currentPath] || ""}</span>
        </Header>
        <Content className="p-6 overflow-auto">
          <PlaceholderPage title={pageTitles[currentPath] || "未知页面"} />
        </Content>
      </Layout>
    </Layout>
  );
}
