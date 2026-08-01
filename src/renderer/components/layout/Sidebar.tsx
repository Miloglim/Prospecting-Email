import { Layout, Menu } from "antd";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DashboardOutlined, UserOutlined, SendOutlined,
  InboxOutlined, PartitionOutlined, FileTextOutlined,
  SettingOutlined, ExportOutlined,
} from "@ant-design/icons";
import { useAppContext } from "../../AppContext";

const { Sider } = Layout;

// 分组菜单
const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: "仪表盘", group: "main" },
  { key: "/contacts", icon: <UserOutlined />, label: "联系人", group: "work" },
  { key: "/inbox", icon: <InboxOutlined />, label: "收件箱", group: "work" },
  { key: "/crm", icon: <PartitionOutlined />, label: "CRM 管线", group: "work" },
  { key: "/campaigns", icon: <SendOutlined />, label: "邮件发送", group: "send" },
  { key: "/templates", icon: <FileTextOutlined />, label: "模板", group: "send" },
  { key: "/export", icon: <ExportOutlined />, label: "导出", group: "tools" },
  { key: "/settings", icon: <SettingOutlined />, label: "设置", group: "bottom" },
];

export function Sidebar() {
  const { sidebarCollapsed } = useAppContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: s => s.location.pathname });

  return (
    <Sider
      collapsible
      collapsed={sidebarCollapsed}
      trigger={null}
      width={210}
      style={{
        background: "#1a1a1a",
        borderRight: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Brand */}
      <div
        className="cursor-pointer px-5 py-6 border-b border-white/10"
        onClick={() => navigate({ to: "/" })}
      >
        {sidebarCollapsed ? (
          <div className="w-6 h-6 rounded bg-teal-400 flex items-center justify-center text-xs font-bold text-black">
            M
          </div>
        ) : (
          <>
            <div className="text-white/65 text-xs tracking-wide">Milogin&apos;s</div>
            <div className="text-white text-xl font-bold tracking-wide">
              Prospector<span className="text-teal-400">.</span>
            </div>
          </>
        )}
      </div>

      {/* Nav */}
      <Menu
        mode="inline"
        selectedKeys={[pathname]}
        onClick={({ key }) => navigate({ to: key })}
        items={menuItems}
        style={{
          background: "transparent",
          borderRight: 0,
          color: "#ffffff",
        }}
        theme="dark"
      />

      {/* Footer */}
      <div
        className="absolute bottom-0 left-0 right-0 px-5 py-2 border-t border-white/10"
        style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}
      >
        {!sidebarCollapsed && "Prospector v4.0"}
      </div>
    </Sider>
  );
}
