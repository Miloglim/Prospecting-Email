import { Layout, Menu } from "antd";
import {
  DashboardOutlined,
  UserOutlined,
  SendOutlined,
  InboxOutlined,
  PartitionOutlined,
  FileTextOutlined,
  SettingOutlined,
  ExportOutlined,
} from "@ant-design/icons";
import { useAppContext } from "../../AppContext";

const { Sider } = Layout;

const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: "仪表盘" },
  { key: "/contacts", icon: <UserOutlined />, label: "联系人" },
  { key: "/campaigns", icon: <SendOutlined />, label: "发送" },
  { key: "/inbox", icon: <InboxOutlined />, label: "收件箱" },
  { key: "/crm", icon: <PartitionOutlined />, label: "CRM" },
  { key: "/templates", icon: <FileTextOutlined />, label: "模板" },
  { key: "/export", icon: <ExportOutlined />, label: "导出" },
  { key: "/settings", icon: <SettingOutlined />, label: "设置" },
];

export function Sidebar() {
  const { sidebarCollapsed } = useAppContext();

  return (
    <Sider
      collapsible
      collapsed={sidebarCollapsed}
      trigger={null}
      width={200}
      style={{ background: "#09090b", borderRight: "1px solid #27272a" }}
    >
      <div className="flex items-center gap-2 px-4 py-4 border-b border-zinc-800">
        <div className="w-6 h-6 rounded bg-violet-500 flex items-center justify-center text-xs font-bold text-white">
          M
        </div>
        {!sidebarCollapsed && (
          <span className="text-sm font-semibold text-zinc-100">Prospector</span>
        )}
      </div>

      <Menu
        mode="inline"
        items={menuItems}
        style={{ background: "transparent", borderRight: 0 }}
        theme="dark"
        defaultSelectedKeys={["/"]}
      />
    </Sider>
  );
}
