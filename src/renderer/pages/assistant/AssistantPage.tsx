import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Tag } from "antd";
import { ExclamationCircleOutlined, PlusOutlined, RobotOutlined, UserOutlined } from "@ant-design/icons";
import { Bubble, Sender, Prompts, Conversations } from "@ant-design/x";
import type { ConversationsProps } from "@ant-design/x";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** IPC 返回的统一包裹形态（结构同 main/errors 的 Result，渲染层本地声明避免跨层 import） */
type IpcResult<T> = { success: boolean; data?: T; error?: string };

interface Msg {
  key: string;
  role: "user" | "ai";
  content: string;
  /** 等待首个增量时显示呼吸点 */
  loading?: boolean;
  /** 正在流式接收 */
  streaming?: boolean;
  error?: boolean;
}

interface ConvMeta { id: string; title: string; createdAt: string; updatedAt: string }

let seq = 0;
const nextKey = () => `m${++seq}`;

const QUICK_PROMPTS = [
  { key: "intro", description: "你能做什么？介绍一下这个工作台里的助手能力" },
  { key: "hello", description: "你好，先随便聊聊" },
  { key: "plan", description: "帮我规划今天的客户跟进节奏" },
];

/** 豆包式时间分组 */
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

/**
 * AI 助手 — Agent 对话工作台（Step 2：会话持久化）。
 * 左列：历史会话（分组/重命名/删除）；右侧：消息流 + 输入。
 * 链路：invoke("agent:chat") 立即拿 ID → 主进程事件流 agent:chunk/done/error 逐字渲染 → 消息落库。
 * 未配置 .env AGENT_API_* 时主进程走 Mock 流，界面链路不变。
 */
export function AssistantPage() {
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [model, setModel] = useState("");
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const convIdRef = useRef<string | undefined>(undefined);

  const refreshConvs = useCallback(async () => {
    const r = await window.api.invoke("agent:listConversations") as IpcResult<ConvMeta[]>;
    if (r?.success && r.data) setConvs(r.data);
  }, []);

  // 模式横幅 + 会话列表
  useEffect(() => {
    (async () => {
      const r = await window.api.invoke("agent:status") as IpcResult<{ mode: "mock" | "live"; model: string }>;
      if (r?.success && r.data) { setMode(r.data.mode); setModel(r.data.model); }
      void refreshConvs();
    })();
  }, [refreshConvs]);

  // 事件订阅：chunk 累积到「最后一条流式中的 ai 消息」；done 后刷新列表（标题/排序可能变化）
  useEffect(() => {
    const offChunk = window.api.on("agent:chunk", (data) => {
      const d = data as { delta?: string };
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
          if (m.role === "ai" && m.streaming) {
            next[i] = { ...m, loading: false, content: m.content + (d.delta ?? "") };
            break;
          }
        }
        return next;
      });
    });
    const offDone = window.api.on("agent:done", () => {
      setMessages(prev => prev.map(m => m.streaming ? { ...m, streaming: false } : m));
      setSending(false);
      void refreshConvs();
    });
    const offError = window.api.on("agent:error", (data) => {
      const d = data as { message?: string };
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
          if (m.role === "ai" && m.streaming) {
            next[i] = { ...m, streaming: false, loading: false, error: true, content: `⚠ ${d.message || "生成失败"}` };
            break;
          }
        }
        return next;
      });
      setSending(false);
    });
    return () => { offChunk(); offDone(); offError(); };
  }, [refreshConvs]);

  /** 切换会话：中断当前生成 + 拉取历史消息 */
  const openConversation = useCallback(async (key: string) => {
    if (sending && convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
    setActiveKey(key);
    convIdRef.current = key;
    const r = await window.api.invoke("agent:getConversation", key) as
      IpcResult<Array<{ role: string; content: string }>>;
    setMessages(r?.success && r.data
      ? r.data.map(m => ({ key: nextKey(), role: m.role === "user" ? "user" as const : "ai" as const, content: m.content }))
      : []);
    setSending(false);
  }, [sending]);

  const handleSend = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const aiKey = nextKey();
    setMessages(prev => [...prev, { key: nextKey(), role: "user", content: t }, { key: aiKey, role: "ai", content: "", loading: true, streaming: true }]);
    const r = await window.api.invoke("agent:chat", { conversationId: convIdRef.current, text: t }) as
      IpcResult<{ conversationId: string; messageId: string }>;
    if (!r?.success) {
      setMessages(prev => prev.map(m => m.key === aiKey ? { ...m, streaming: false, loading: false, error: true, content: `⚠ ${r?.error || "发起失败"}` } : m));
      setSending(false);
    } else if (r.data) {
      convIdRef.current = r.data.conversationId;
      setActiveKey(r.data.conversationId);
      void refreshConvs();  // 新会话立即可见（标题已在主进程生成）
    }
  };

  const handleNew = () => {
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
    setActiveKey(undefined);
    convIdRef.current = undefined;
    setMessages([]);
    setSending(false);
  };

  const handleStop = () => {
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
  };

  const confirmDelete = (c: ConvMeta) => {
    Modal.confirm({
      title: `删除会话「${c.title}」？`,
      content: "该会话的全部消息将被清除，不可恢复。",
      okText: "删除", okType: "danger", cancelText: "取消", icon: <ExclamationCircleOutlined />,
      onOk: async () => {
        await window.api.invoke("agent:deleteConversation", c.id);
        if (activeKey === c.id) handleNew();
        void refreshConvs();
      },
    });
  };

  const convItems: ConversationsProps["items"] = convs.map(c => ({
    key: c.id,
    label: c.title,
    group: groupOf(c.updatedAt),
  }));

  const convMenu: ConversationsProps["menu"] = (item) => ({
    items: [
      { key: "rename", label: "重命名" },
      { key: "delete", label: "删除", danger: true },
    ],
    onClick: ({ key }) => {
      const c = convs.find(x => x.id === item.key);
      if (!c) return;
      if (key === "rename") { setRenaming(c); setRenameVal(c.title); }
      if (key === "delete") confirmDelete(c);
    },
  });

  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return;
    await window.api.invoke("agent:renameConversation", { conversationId: renaming.id, title: renameVal });
    setRenaming(null);
    void refreshConvs();
  };

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 100px)" }}>
      {/* ═══ 左列：历史会话 ═══ */}
      <aside className="w-[232px] shrink-0 bg-white border border-gray-200 rounded-lg flex flex-col overflow-hidden">
        <div className="p-2.5 border-b border-gray-100">
          <Button block type="primary" icon={<PlusOutlined />} onClick={handleNew}>新会话</Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {convItems && convItems.length > 0 ? (
            <Conversations
              items={convItems}
              activeKey={activeKey}
              onActiveChange={(key) => { void openConversation(key); }}
              menu={convMenu}
              groupable
              styles={{ item: { padding: "0 8px" } }}
            />
          ) : (
            <div className="text-[11px] text-gray-300 text-center pt-10">还没有会话<br />开始第一段对话吧</div>
          )}
        </div>
      </aside>

      {/* ═══ 右侧：对话区 ═══ */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between pb-3">
          <Space>
            <h2 className="text-lg font-bold text-gray-800 m-0">AI 助手</h2>
            <Tag color={mode === "live" ? "green" : "orange"}>
              {mode === "live" ? model || "live" : "Mock 模式"}
            </Tag>
          </Space>
        </div>

        {mode === "mock" && (
          <Alert
            type="warning" showIcon closable className="mb-2"
            message="模型接口未配置，当前为 Mock 流"
            description="在项目根目录 .env 配置 AGENT_API_BASE_URL / AGENT_API_KEY / AGENT_MODEL（OpenAI 兼容端点）后重启即可切换真实模型。"
          />
        )}

        {/* 消息流 */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-6">
              <div className="text-center">
                <RobotOutlined style={{ fontSize: 42, color: "#00bfa5" }} />
                <div className="text-base font-semibold text-gray-700 mt-3">Hi，我是 Prospector 助手</div>
                <div className="text-xs text-gray-400 mt-1">对话式客户管理 · 工具能力将逐步开放</div>
              </div>
              <Prompts
                wrap
                title="试试这些"
                items={QUICK_PROMPTS.map(p => ({ key: p.key, description: p.description }))}
                onItemClick={(info) => {
                  const p = QUICK_PROMPTS.find(x => x.key === info.data.key);
                  if (p) void handleSend(p.description);
                }}
                styles={{ item: { width: "100%" } }}
                className="max-w-xl"
              />
            </div>
          ) : (
            <Bubble.List
              autoScroll
              items={messages.map(m => ({
                key: m.key,
                role: m.role,
                content: m.content,
                loading: m.loading,
                className: m.error ? "!bg-transparent [&_.ant-bubble-content]:!bg-red-50 [&_.ant-bubble-content]:!border [&_.ant-bubble-content]:!border-red-200" : undefined,
              }))}
              roles={{
                user: {
                  placement: "end",
                  avatar: { icon: <UserOutlined />, style: { background: "#1a1a1a" } },
                  styles: { content: { background: "#00bfa5", color: "#fff" } },
                },
                ai: {
                  placement: "start",
                  avatar: { icon: <RobotOutlined />, style: { background: "#e6fffb", color: "#00897b" } },
                  messageRender: (content: string) => (
                    <div className="text-[13px] leading-relaxed">
                      <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
                    </div>
                  ),
                },
              }}
            />
          )}
        </div>

        {/* 输入区 */}
        <div className="pt-3">
          <Sender
            placeholder="问我任何关于客户、跟进、发信的事…（Enter 发送 / Shift+Enter 换行）"
            loading={sending}
            onSubmit={(text) => { void handleSend(text); }}
            onCancel={handleStop}
          />
        </div>
      </main>

      {/* 重命名弹窗 */}
      <Modal
        title="重命名会话" open={!!renaming} okText="保存" cancelText="取消"
        onCancel={() => setRenaming(null)}
        onOk={() => { void doRename(); }}
      >
        <Input value={renameVal} onChange={e => setRenameVal(e.target.value)}
          onPressEnter={() => { void doRename(); }}
          maxLength={60} autoFocus />
      </Modal>
    </div>
  );
}
