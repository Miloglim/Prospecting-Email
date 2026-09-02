import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DashboardOutlined, UserOutlined, SendOutlined,
  InboxOutlined, FileTextOutlined,
  SettingOutlined, MoreOutlined, DollarOutlined, UpOutlined,
} from "@ant-design/icons";
import { Dropdown, Input, Modal } from "antd";
import { useAppContext } from "../../AppContext";
import { DiamondLogo } from "../DiamondLogo";

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  dot?: boolean;
}

const navItems: NavItem[] = [
  { key: "/assistant", icon: <DiamondLogo size={15} state="idle" />, label: "新对话" },
  { key: "/", icon: <DashboardOutlined />, label: "仪表盘" },
  { key: "/inbox", icon: <InboxOutlined />, label: "收件箱", dot: true },
  { key: "/customers", icon: <UserOutlined />, label: "客户", dot: true },
];

// 豆包式空间让位：会话历史溢出时，这三行折叠进底栏图标，列表向上增高
const collapsibleItems: NavItem[] = [
  { key: "/rates", icon: <DollarOutlined />, label: "运价库" },
  { key: "/campaigns", icon: <SendOutlined />, label: "发送中心" },
  { key: "/templates", icon: <FileTextOutlined />, label: "素材库" },
];
const NAV_ROWS_H = 138; // 三行导航 ≈46px/行，折叠↔恢复的滞回阈值

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

function ConversationsPanel({ collapsed, onMetrics, onTuck }: {
  collapsed: boolean; onMetrics: (scroll: number, view: number) => void; onTuck: (down: boolean) => void;
}) {
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTopRef = useRef(0);
  // 当前会话由 router state 派生：navigate()（pushState）不触发 hashchange，读旧 URL 会亮错行；
  // 这里跟随 router 状态重算，切去设置/仪表盘时 c 自然消失，高亮即灭
  const cParam = useRouterState({ select: s => (s.location.search as { c?: unknown }).c });
  const activeId = typeof cParam === "string" && cParam ? cParam : undefined;
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const refresh = useCallback(async () => {
    type IpcResult<T> = { success: boolean; data?: T; error?: string };
    const r = await window.api.invoke("agent:listConversations") as IpcResult<ConvMeta[]>;
    if (r?.success && r.data) setConvs(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(CONVS_CHANGED, onChanged);
    return () => window.removeEventListener(CONVS_CHANGED, onChanged);
  }, [refresh]);

  // 溢出探测：容器尺寸变化（RO）与会话数变化都上报内容高/可视高，父级做折叠滞回
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const report = () => onMetrics(el.scrollHeight, el.clientHeight);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [onMetrics, convs]);

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

  // 折叠态太窄放不下会话列表；新对话入口由导航项「新对话」承载
  if (collapsed) return null;

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
      <div ref={scrollRef} onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        const t = el.scrollTop;
        if (t - lastTopRef.current > 6) onTuck(true);          // 向下翻记录 → 让位
        else if (t <= 4) onTuck(false);                        // 滚回顶 → 导航回来
        lastTopRef.current = t;
      }} style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 8px 6px" }}>
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
                className={activeId === c.id ? "conv-row active" : "conv-row"}
                style={convRowStyle(activeId === c.id)}
                onClick={() => gotoConversation(c.id)}
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
                    className="conv-more"
                    onClick={e => e.stopPropagation()}
                    style={{
                      width: 18, height: 18, border: "none", background: "transparent",
                      color: "rgba(255,255,255,0.6)", cursor: "pointer", flexShrink: 0,
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
  /** 是否已在某个具体会话里——是则「新对话」不高亮（高亮交给会话列表那一行）；
   *  与列表同源：从 router state 派生而非监听 hashchange（navigate() 不触发后者） */
  const cParam = useRouterState({ select: s => (s.location.search as { c?: unknown }).c });
  const activeConv = typeof cParam === "string" && cParam ? cParam : undefined;
  // agent 输出中：「新对话」导航菱形从呼吸切到旋转（任意页面的全局状态灯）
  const [agentBusy, setAgentBusy] = useState(false);

  useEffect(() => {
    const offChunk = window.api.on("agent:chunk", () => setAgentBusy(true));
    const offDone = window.api.on("agent:done", () => setAgentBusy(false));
    const offErr = window.api.on("agent:error", () => setAgentBusy(false));
    return () => { offChunk(); offDone(); offErr(); };
  }, []);

  // 豆包式空间让位（双条件）：会话列表确实溢出 且 用户开始向下翻记录 → 运价库/发送中心/素材库
  // 折叠进底栏图标，列表向上增高；滚回顶部或空间恢复则自动还原。溢出侧保留滞回防抖。
  const [overflows, setOverflows] = useState(false);
  const [tucked, setTucked] = useState(false);
  const navHidden = overflows && tucked && !sidebarCollapsed;
  const handleMetrics = useCallback((scroll: number, view: number) => {
    setOverflows(prev => (prev ? scroll > view - NAV_ROWS_H - 8 : scroll > view + 4));
  }, []);
  const handleTuck = useCallback((down: boolean) => setTucked(down), []);

  useEffect(() => {
    window.api.invoke("system:appVersion").then((r) => {
      if (r && typeof r === "object" && "success" in r && r.success && "data" in r) {
        setVersion(String(r.data));
      }
    }).catch((err) => {
      console.error("[Sidebar] appVersion failed:", err);
    });
  }, []);

  const isActive = (key: string) => {
    // 「新对话」只代表空态入口：已经在某个会话里就不高亮（高亮交给会话列表那一行）
    if (key === "/assistant") return pathname === "/assistant" && !activeConv;
    return pathname === key || (key !== "/" && pathname.startsWith(key));
  };

  const width = sidebarCollapsed ? 64 : 210;

  const renderItem = (item: NavItem) => (
    <li
      key={item.key}
      onClick={() => {
        // 「新对话」= 清掉会话参数进入空白态；已在该页时 hash 变化仍会触发页面重置
        if (item.key === "/assistant") gotoConversation(undefined);
        else navigate({ to: item.key });
      }}
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
        {item.key === "/assistant"
          ? <DiamondLogo size={15} state={agentBusy ? "running" : "idle"} />
          : item.icon}
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
          {/* 折叠让位只发生在展开态；rail 模式没有会话列表，三项常驻防入口丢失 */}
          {!navHidden && collapsibleItems.map(renderItem)}
        </ul>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", margin: "8px 12px 0", flexShrink: 0 }} />
        <ConversationsPanel collapsed={sidebarCollapsed} onMetrics={handleMetrics} onTuck={handleTuck} />
      </nav>

      {/* 底栏 — 折叠态图标组 + 设置（轻量图标）+ 版本号；Shift+点版本号重开新手向导（沿用旧 PE 调试入口） */}
      <div style={{
        borderTop: "1px solid rgba(255,255,255,0.12)",
        padding: sidebarCollapsed ? "8px 0" : "8px 14px",
        display: "flex", alignItems: "center",
        justifyContent: sidebarCollapsed ? "center" : "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {navHidden && (
            <>
              <span
                title="已收起 3 个入口 · 点击展开（列表滚回顶部也会自动展开）"
                onClick={() => setTucked(false)}
                style={{
                  width: 26, height: 26, borderRadius: 6, fontSize: 13,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", color: "rgba(255,255,255,0.55)",
                  transition: "background 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.55)"; }}
              >
                <UpOutlined />
              </span>
              {collapsibleItems.map(it => (
                <FootIcon key={it.key} icon={it.icon} label={it.label}
                  active={isActive(it.key)} onClick={() => navigate({ to: it.key })} />
              ))}
              <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)", margin: "0 4px 0 2px" }} />
            </>
          )}
          <FootIcon icon={<SettingOutlined />} label="设置"
            active={isActive("/settings")} onClick={() => navigate({ to: "/settings" })} />
        </div>
        {!sidebarCollapsed && (
          <span
            title="Shift+点击：重开新手向导"
            onClick={(e) => { if (e.shiftKey) window.dispatchEvent(new Event("open-onboarding")); }}
            style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", cursor: "pointer", userSelect: "none" }}
          >
            v{version || "4.0"}
          </span>
        )}
      </div>
    </aside>
  );
}

/** 底栏轻量图标按钮（设置 / 折叠进来的导航项共用） */
function FootIcon({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <span
      title={label}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 6, fontSize: 14,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer",
        color: active ? "#fff" : "rgba(255,255,255,0.45)",
        background: active ? "rgba(255,255,255,0.12)" : "transparent",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#fff"; }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "rgba(255,255,255,0.12)" : "transparent";
        e.currentTarget.style.color = active ? "#fff" : "rgba(255,255,255,0.45)";
      }}
    >
      {icon}
    </span>
  );
}
