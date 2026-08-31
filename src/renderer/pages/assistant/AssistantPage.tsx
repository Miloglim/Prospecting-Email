import { useEffect, useRef, useState } from "react";
import { Alert, Space, Tag } from "antd";
import { RobotOutlined, UserOutlined } from "@ant-design/icons";
import { Bubble, Sender, Prompts } from "@ant-design/x";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CONVS_CHANGED, gotoConversation } from "../../components/layout/Sidebar";

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

let seq = 0;
const nextKey = () => `m${++seq}`;

const QUICK_PROMPTS = [
  { key: "intro", description: "你能做什么？介绍一下这个工作台里的助手能力" },
  { key: "hello", description: "你好，先随便聊聊" },
  { key: "plan", description: "帮我规划今天的客户跟进节奏" },
];

function readConvFromHash(): string | undefined {
  const raw = window.location.hash;
  const qs = raw.includes("?") ? raw.split("?")[1] : "";
  return new URLSearchParams(qs).get("c") || undefined;
}

/**
 * AI 助手 — 对话工作区（单栏）。
 * 会话历史列表在全局导航栏（豆包式），活动会话经 hash 参数 ?c=<id> 同步：
 * 导航栏点击 → 写 hash → 本页监听加载；本页新建会话 → 回写 hash → 导航栏高亮。
 * 链路：invoke("agent:chat") 立即拿 ID → 事件流 agent:chunk/done/error 逐字渲染 → 消息落库。
 */
export function AssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [model, setModel] = useState("");
  const convIdRef = useRef<string | undefined>(undefined);

  // 模式横幅
  useEffect(() => {
    (async () => {
      const r = await window.api.invoke("agent:status") as IpcResult<{ mode: "mock" | "live"; model: string }>;
      if (r?.success && r.data) { setMode(r.data.mode); setModel(r.data.model); }
    })();
  }, []);

  /** 加载指定会话（undefined = 新会话空态）；切换时中断进行中的生成
   *  （用 ref 而非闭包 sending 判断：hashchange 回调捕获的是首帧闭包，state 已过期；
   *    agent:stop 对无进行中回合幂等成功，多调无害） */
  const loadConversation = async (id: string | undefined) => {
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
    convIdRef.current = id;
    setSending(false);
    if (!id) { setMessages([]); return; }
    const r = await window.api.invoke("agent:getConversation", id) as
      IpcResult<Array<{ role: string; content: string }>>;
    setMessages(r?.success && r.data
      ? r.data.map(m => ({ key: nextKey(), role: m.role === "user" ? "user" as const : "ai" as const, content: m.content }))
      : []);
  };

  // 首屏 + hash 变更（导航栏点击会话）
  useEffect(() => {
    void loadConversation(readConvFromHash());
    const onHash = () => {
      const id = readConvFromHash();
      if (id !== convIdRef.current) void loadConversation(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 事件订阅：chunk 累积到「最后一条流式中的 ai 消息」；done 通知导航栏刷新（标题/排序）
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
      window.dispatchEvent(new Event(CONVS_CHANGED));
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
  }, []);

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
      return;
    }
    if (r.data && readConvFromHash() !== r.data.conversationId) {
      convIdRef.current = r.data.conversationId;
      gotoConversation(r.data.conversationId);   // 回写 hash → 导航栏高亮新会话
    }
    window.dispatchEvent(new Event(CONVS_CHANGED)); // 新会话立即可见（标题已在主进程生成）
  };

  const handleStop = () => {
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
  };

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 100px)" }}>
      {/* 页头 */}
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
          description="在项目根目录 .env 配置 AGENT_API_BASE_URL / AGENT_API_KEY / AGENT_MODEL（OpenAI 兼容端点）。已配置却仍显示 Mock？.env 只在应用启动时读取 — 请完全退出并重启应用（开发模式下即重启 npm run dev）。"
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
    </div>
  );
}
