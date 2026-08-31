import { useState, useEffect, useCallback } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DashboardOutlined, UserOutlined, SendOutlined,
  InboxOutlined, FileTextOutlined, RobotOutlined,
  SettingOutlined, PlusOutlined, MoreOutlined,
} from "@ant-design/icons";
import { Dropdown, Input, Modal } from "antd";
import { useAppContext } from "../../AppContext";

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  dot?: boolean;
}

const navItems: NavItem[] = [
  { key: "/assistant", icon: <RobotOutlined />, label: "AI 助手" },
  { key: "/", icon: <DashboardOutlined />, label: "仪表盘" },
  { key: "/inbox", icon: <InboxOutlined />, label: "收件箱", dot: true },
  { key: "/customers", icon: <UserOutlined />, label: "客户", dot: true },
  { key: "/campaigns", icon: <SendOutlined />, label: "发送中心" },
  { key: "/templates", icon: <FileTextOutlined />, label: "素材库" },
];

const bottomItems: NavItem[] = [
  { key: "/settings", icon: <SettingOutlined />, label: "设置" },
];

// ── 会话历史面板（豆包式：嵌在全局导航栏内，仅 AI 助手页显示） ──

interface ConvMeta { id: string; title: string; createdAt: string; updatedAt: string }

/** AssistantPage 数据变更后广播，导航栏监听刷新 */
export const CONVS_CHANGED = "agent:convs-changed";

/** 活动会话由 hash 参数驱动：#/assistant?c=<id>（与全项目 hash 深链惯例一致），
 *  导航栏与页面各读各的，天然同步、零共享状态 */
function readActiveConv(): string | undefined {
  const raw = window.location.hash;
  const qs = raw.includes("?") ? raw.split("?")[1] : "";
  return new URLSearchParams(qs).get("c") || undefined;
}

export function gotoConversation(id: string | undefined): void {
  window.location.hash = id ? `#/assistant?c=${id}` : "#/assistant";
}

function groupOf(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return "今天";
  const yest = new Date(now.getTime() - 86400_000);
  if (day(d) === day(yest)) return "昨天";
  if (now.getTime() - d.getTime() < 7 * 86400_000) return "7 天内";
  return "更早";
}

const convRowStyle = (active: boolean): React.CSSProperties => ({
  padding: "4px 4px 4px 10px",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: "18px",
  display: "flex",
  alignItems: "center",
  gap: 2,
  borderRadius: 5,
  color: active ? "#fff" : "rgba(255,255,255,0.72)",
  background: active ? "rgba(255,255,255,0.12)" : "transparent",
  transition: "background 0.12s",
});

function ConversationsPanel({ collapsed }: { collapsed: boolean }) {
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(() => readActiveConv());
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const refresh = useCallback(async () => {
    type IpcResult<T> = { success: boolean; data?: T; error?: string };
    const r = await window.api.invoke("agent:listConversations") as IpcResult<ConvMeta[]>;
    if (r?.success && r.data) setConvs(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    const sync = () => setActiveId(readActiveConv());
    const onChanged = () => void refresh();
    window.addEventListener("hashchange", sync);
    window.addEventListener(CONVS_CHANGED, onChanged);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(CONVS_CHANGED, onChanged);
    };
  }, [refresh]);

  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return;
    await window.api.invoke("agent:renameConversation", { conversationId: renaming.id, title: renameVal });
    setRenaming(null);
    void refresh();
  };

  const confirmDelete = (c: ConvMeta) => {
    Modal.confirm({
      title: `删除会话「${c.title}」？`,
      content: "该会话的全部消息将被清除，不可恢复。",
      okText: "删除", okType: "danger", cancelText: "取消",
      onOk: async () => {
        await window.api.invoke("agent:deleteConversation", c.id);
        if (readActiveConv() === c.id) gotoConversation(undefined);
        window.dispatchEvent(new Event(CONVS_CHANGED));
      },
    });
  };

  if (collapsed) {
    return (
      <div style={{ padding: "2px 0 6px", textAlign: "center", flexShrink: 0 }}>
        <button
          title="新会话"
          onClick={() => gotoConversation(undefined)}
          style={{
            width: 26, height: 26, borderRadius: 5, border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent", color: "#00bfa5", cursor: "pointer",
          }}
        >
          <PlusOutlined style={{ fontSize: 11 }} />
        </button>
      </div>
    );
  }

  // 服务端已按 updatedAt 倒序，按出现顺序聚组即为从新到旧
  const groups: { name: string; items: ConvMeta[] }[] = [];
  for (const c of convs) {
    const g = groupOf(c.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.name === g) last.items.push(c);
    else groups.push({ name: g, items: [c] });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "3px 10px 5px", flexShrink: 0 }}>
        <button
          onClick={() => gotoConversation(undefined)}
          style={{
            width: "100%", padding: "4px 0", borderRadius: 5,
            border: "1px solid rgba(255,255,255,0.22)", background: "transparent",
            color: "#fff", fontSize: 12, cursor: "pointer", display: "flex",
            alignItems: "center", justifyContent: "center", gap: 5,
          }}
        >
          <PlusOutlined style={{ fontSize: 10, color: "#00bfa5" }} /> 新会话
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 8px 6px" }}>
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "center", paddingTop: 12 }}>
            还没有会话，开始第一段对话吧
          </div>
        )}
        {groups.map(g => (
          <div key={g.name}>
            <div style={{
              fontSize: 9, color: "rgba(255,255,255,0.35)", fontWeight: 600,
              padding: "8px 6px 2px", letterSpacing: 0.5,
            }}>{g.name}</div>
            {g.items.map(c => (
              <div
                key={c.id}
                style={convRowStyle(activeId === c.id)}
                onClick={() => gotoConversation(c.id)}
                onMouseEnter={e => { if (activeId !== c.id) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={e => { if (activeId !== c.id) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.title}
                </span>
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "rename", label: "重命名" },
                      { key: "delete", label: "删除", danger: true },
                    ],
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation();
                      if (key === "rename") { setRenaming(c); setRenameVal(c.title); }
                      if (key === "delete") confirmDelete(c);
                    },
                  }}
                >
                  <button
                    onClick={e => e.stopPropagation()}
                    style={{
                      width: 18, height: 18, border: "none", background: "transparent",
                      color: "rgba(255,255,255,0.4)", cursor: "pointer", flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4,
                    }}
                  >
                    <MoreOutlined style={{ fontSize: 12 }} />
                  </button>
                </Dropdown>
              </div>
            ))}
          </div>
        ))}
      </div>

      <Modal title="重命名会话" open={!!renaming} okText="保存" cancelText="取消"
        onCancel={() => setRenaming(null)} onOk={() => { void doRename(); }}
      >
        <Input value={renameVal} onChange={e => setRenameVal(e.target.value)}
          onPressEnter={() => { void doRename(); }} maxLength={60} autoFocus />
      </Modal>
    </div>
  );
}

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

      {/* Nav — 平铺列表；会话历史常驻导航项下方（豆包式：任何页面都可直切会话） */}
      <nav style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, flexShrink: 0 }}>
          {navItems.map(renderItem)}
        </ul>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", margin: "8px 12px 0", flexShrink: 0 }} />
        <ConversationsPanel collapsed={sidebarCollapsed} />

        {/* 设置 — 横线分隔，贴底 */}
        <ul style={{
          listStyle: "none", padding: 0, margin: 0,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          marginTop: "auto", flexShrink: 0,
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
