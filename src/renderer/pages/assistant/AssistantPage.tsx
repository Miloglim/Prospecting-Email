import { useEffect, useRef, useState } from "react";
import { Alert, Avatar, Button, Modal, Skeleton, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import {
  RobotOutlined, UserOutlined, LoadingOutlined, CheckCircleOutlined,
  BulbOutlined, DownOutlined, RightOutlined,
} from "@ant-design/icons";
import { Bubble, Sender } from "@ant-design/x";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CONVS_CHANGED, gotoConversation } from "../../components/layout/Sidebar";

/** IPC 返回的统一包裹形态（结构同 main/errors 的 Result，渲染层本地声明避免跨层 import） */
type IpcResult<T> = { success: boolean; data?: T; error?: string };

interface Msg {
  key: string;
  role: "user" | "ai" | "tool";
  content: string;
  /** 等待首个增量时显示呼吸点 */
  loading?: boolean;
  /** 正在流式接收 */
  streaming?: boolean;
  error?: boolean;
  /** 过程卡结构化字段（role=tool 时） */
  chip?: {
    kind: "calling" | "done" | "reasoning";
    tool?: string;
    args?: string;
    detail?: string;   // 参数摘要 / 结果摘要 / 思考全文
    brief?: string;    // done 卡的「N 条结果」小尾巴
  };
  /** 动作执行后的回执行（role=tool 无 chip 时），带可选跳转 */
  link?: { label: string; href: string };
}

/** 工具 → 人话名（过程卡展示用） */
const TOOL_LABELS: Record<string, string> = {
  quote_search: "查询运价",
  search_contacts: "检索联系人",
  record_followup: "记录跟进",
  inbox_search: "检索邮件",
  email_summarize: "总结邮件",
  company_backcheck: "公司背调",
  generate_draft: "撰写开发信",
  queue_status: "查询发送进度",
  reminders_due: "查询到期提醒",
  accounts_status: "查询账号健康",
  send_queue_add: "加入发信队列",
};
const toolLabel = (name?: string) => (name && TOOL_LABELS[name]) || name || "工具";

/** 过程卡文本格式化：tool_called 带参数摘要，tool_output 带结果规模，reasoning 为思考段 */
function fmtChipArgs(a?: string): string {
  if (!a) return "";
  try {
    const o = JSON.parse(a) as Record<string, unknown>;
    return Object.entries(o).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  } catch { return a.slice(0, 48); }
}
function resultBrief(r?: string): string {
  if (!r) return "";
  try {
    const o = JSON.parse(r) as unknown;
    if (Array.isArray(o)) return `${o.length} 条结果`;
    const obj = o as {
      total?: number; count?: number; quotes?: unknown; data?: { length?: number };
      results?: unknown[]; dueCount?: number; overdueCount?: number; pendingGroups?: number; healthy?: number; enabled?: number;
    };
    if (typeof obj.dueCount === "number") return `到期 ${obj.dueCount} · 逾期 ${obj.overdueCount ?? 0}`;
    if (typeof obj.pendingGroups === "number") return `待发 ${obj.pendingGroups} 组`;
    if (typeof obj.healthy === "number" && typeof obj.enabled === "number") return `${obj.healthy}/${obj.enabled} 健康`;
    if (typeof obj.total === "number") return `共 ${obj.total} 条`;
    if (typeof obj.count === "number") return `${obj.count} 条结果`;
    if (Array.isArray(obj.results)) return `${obj.results.length} 条结果`;
    if (obj.data?.length != null) return `${obj.data.length} 条`;
  } catch { /* 非 JSON 结果不展示摘要 */ }
  return "";
}

/** 工具结果 JSON → 数据行（供「数据表格卡」渲染）：支持数组本体 / {quotes}{messages}{due}{results} */
function asRows(detail?: string): Record<string, unknown>[] | null {
  if (!detail) return null;
  try {
    const o = JSON.parse(detail) as unknown;
    const arr = Array.isArray(o) ? o
      : typeof o === "object" && o !== null
        ? (o as { quotes?: unknown[] }).quotes ?? (o as { messages?: unknown[] }).messages
          ?? (o as { due?: unknown[] }).due ?? (o as { results?: unknown[] }).results
      : null;
    if (arr && Array.isArray(arr) && arr.length && typeof arr[0] === "object") return arr as Record<string, unknown>[];
  } catch { /* 非 JSON 结果不产表格卡 */ }
  return null;
}

/** 常见字段中文表头（未收录键原样显示） */
const COL_LABELS: Record<string, string> = {
  podRaw: "目的港", lane: "航线", carrier: "船司", container: "柜型", oceanUsd: "运费USD",
  validFrom: "有效期起", validTo: "有效期止", validityRaw: "有效期", note: "备注", pol: "起运港",
  name: "姓名", email: "邮箱", company: "公司", country: "国家", stage: "阶段", status: "状态", id: "ID",
  fromName: "发件人", fromEmail: "发件邮箱", from: "发件人", subject: "主题", classification: "分类",
  receivedAt: "时间", isRead: "已读", summary: "总结", nextStep: "下一步", rating: "评分",
  reminderAt: "提醒时间", problems: "问题", healthy: "健康数", enabled: "启用数", total: "总数",
};
const cellText = (v: unknown): string => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 审批人话化：工具+参数 → 一句中文说明（不再展示裸 JSON） */
function describeApproval(tool: string | undefined, argsRaw: unknown): string {
  let a: Record<string, unknown> = {};
  try {
    a = (typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw ?? {}) as Record<string, unknown>;
  } catch { /* 解析失败退回原文展示 */ }
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (tool) {
    case "record_followup": {
      const note = s(a.note);
      return `为联系人 #${s(a.contactId)} 记录一条跟进备注：「${note}」`;
    }
    case "send_queue_add": {
      const ids = Array.isArray(a.contactIds) ? (a.contactIds as unknown[]).map(String).join("、") : s(a.contactIds);
      return `把一封邮件加入发送队列（不会自动发出，之后需到「发送中心」手动启动）：收件人 #${ids}，主题「${s(a.subject)}」`;
    }
    default:
      return `${toolLabel(tool)}：${Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ").slice(0, 200) || "（无参数）"}`;
  }
}

/** 结果行深链类型：联系人（email+stage/company 字段）→ 客户详情；邮件（from+subject）→ 收件箱搜索 */
function rowLink(r: Record<string, unknown>): { label: string; href: string } | null {
  if (typeof r.id === "number" && typeof r.email === "string" && ("stage" in r || "company" in r)) {
    return { label: "查看客户", href: `#/customers?view=table&detail=${r.id}` };
  }
  if (typeof r.id === "number" && typeof r.fromEmail === "string" && "subject" in r) {
    return { label: "在收件箱查看", href: `#/inbox?search=${encodeURIComponent(r.fromEmail)}` };
  }
  return null;
}

// ── 动作卡（工具结果里的 actions）────────────────────────────────
// write   → 弹窗展示 diff → invoke("agent:runAction", id) → 主进程执行留存的闭包
// prompt  → 把预设问题发进对话（产物留在会话里）
// navigate→ 直接换页查看
interface ActionDto {
  kind: "write" | "prompt" | "navigate";
  id?: string;
  label: string;
  confirm?: string;
  detail?: string;
  diff?: Array<{ field: string; label: string; from: string; to: string }>;
  target?: { label: string; href: string };
  text?: string;
  href?: string;
}

/** 工具结果 JSON → 动作列表 / 草稿（generate_draft 的唯一形态：subject+body+actions） */
function parseResult(detail?: string): { actions: ActionDto[]; draft?: { subject: string; body: string } } | null {
  if (!detail) return null;
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    const actions = Array.isArray(o.actions) ? (o.actions as ActionDto[]) : [];
    const draft = typeof o.body === "string" && typeof o.subject === "string"
      ? { subject: o.subject, body: o.body }
      : undefined;
    if (!actions.length && !draft) return null;
    return { actions, ...(draft ? { draft } : {}) };
  } catch { return null; }
}

/** 结果卡下方的动作排：最多 2 个按钮，写入类成功后就地变状态 */
function ActionRow({ actions, done, onAction }: {
  actions: ActionDto[];
  done: Record<string, string>;
  onAction: (a: ActionDto) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {actions.map(a => {
        const stamp = done[a.id ?? a.label];
        if (stamp) {
          return (
            <span key={a.id ?? a.label} className="text-[12px] text-gray-400">
              已{a.label} · {stamp}
            </span>
          );
        }
        return (
          <Button key={a.id ?? a.label} size="small" type={a.kind === "write" ? "primary" : "default"}
            ghost={a.kind === "write"}
            style={{ fontSize: 12 }}
            onClick={() => onAction(a)}>
            {a.label}
          </Button>
        );
      })}
    </div>
  );
}

/** 开发信草稿卡：主题 + 正文 + 一键复制（产物留在对话里，不跳走） */
function DraftCard({ subject, body }: { subject: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-gray-200 rounded-lg bg-white max-w-[640px] overflow-hidden">
      {subject && (
        <div className="px-3 py-2 border-b border-gray-100 text-[12px]">
          <span className="text-gray-400 mr-1">主题</span>
          <span className="font-medium text-gray-800">{subject}</span>
        </div>
      )}
      <div className="px-3 py-2 text-[12px] text-gray-700 whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto selectable">
        {body}
      </div>
      <div className="px-3 py-1.5 border-t border-gray-100 flex items-center gap-2">
        <Button size="small" style={{ fontSize: 12 }}
          onClick={async () => {
            try {
              await window.navigator.clipboard.writeText(`${subject ? `SUBJECT: ${subject}\n\n` : ""}${body}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch { /* 剪贴板不可用时静默 */ }
          }}>
          {copied ? "已复制" : "复制全文"}
        </Button>
      </div>
    </div>
  );
}

/** Markdown 表格容错：GFM 要求表格块前后必须空行，模型常漏——渲染前自动补 */
function mdFixTables(src: string): string {
  if (!src.includes("|")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const ln of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(ln);
    if (isRow) {
      if (!inTable && out.length && out[out.length - 1]!.trim() !== "") out.push("");
      inTable = true;
    } else {
      if (inTable && ln.trim() !== "") out.push("");
      inTable = false;
    }
    out.push(ln);
  }
  return out.join("\n");
}

/** 过程行（无气泡、无边框，灰字细行，豆包/ChatGPT 过程区同款语言）；长内容可展开；结果可带动作卡 */
function ProcessLine({ chip, done, onAction }: {
  chip: NonNullable<Msg["chip"]>;
  done?: Record<string, string>;
  onAction?: (a: ActionDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const full = chip.detail || "";
  const expandable = full.length > 80;
  const parsed = parseResult(chip.detail);
  const actions = parsed?.actions ?? [];

  if (chip.kind === "reasoning") {
    return (
      <div className="text-[12px] text-gray-400 max-w-[600px] py-0.5">
        <span
          className={`inline-flex items-center gap-1.5 ${expandable ? "cursor-pointer" : ""}`}
          onClick={() => expandable && setOpen(o => !o)}
        >
          <BulbOutlined style={{ color: "#bfbfbf" }} />
          <span>已完成思考</span>
          {expandable && (open ? <DownOutlined style={{ fontSize: 8 }} /> : <RightOutlined style={{ fontSize: 8 }} />)}
        </span>
        {open && (
          <div className="mt-1 ml-4 pl-2 border-l border-gray-200 whitespace-pre-wrap leading-relaxed">
            {full}
          </div>
        )}
      </div>
    );
  }

  if (chip.kind === "calling") {
    return (
      <div className="text-[12px] text-gray-400 inline-flex items-center gap-1.5 py-0.5 max-w-[600px]">
        <LoadingOutlined spin style={{ fontSize: 11 }} />
        <span>正在{toolLabel(chip.tool)}{chip.args ? <span className="text-gray-300"> · {chip.args}</span> : ""}…</span>
      </div>
    );
  }

  // done：有结构化数据 → 数据表格卡；否则灰字结果行
  const rows = asRows(chip.detail);
  if (rows) {
    const cols: TableColumnsType<Record<string, unknown>> = Object.keys(rows[0]!).slice(0, 7).map(k => ({
      title: COL_LABELS[k] || k,
      dataIndex: k,
      key: k,
      ellipsis: { showTitle: true } as const,
      render: (v: unknown) => <span className="text-[12px]">{cellText(v)}</span>,
    }));
    // 可回跳的行（联系人/邮件）追加操作列 → 深链到对应页面
    const links = rows.map(rowLink);
    if (links.some(Boolean)) {
      cols.push({
        title: "",
        key: "__go",
        render: (_v: unknown, _r: Record<string, unknown>, i: number) => {
          const lk = links[i];
          return lk
            ? <a className="text-[12px]" onClick={(e) => { e.stopPropagation(); window.location.hash = lk.href; }}>{lk.label}</a>
            : null;
        },
      });
    }
    return (
      <div className="py-1 max-w-[720px]">
        <div className="inline-flex items-center gap-1.5 text-[12px] text-gray-400 mb-1.5">
          <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
          <span>已{toolLabel(chip.tool)} · {chip.brief || `${rows.length} 条结果`}</span>
        </div>
        <Table
          dataSource={rows.slice(0, 10).map((r, i) => ({ ...r, __k: i }))}
          rowKey="__k"
          columns={cols}
          size="small"
          bordered
          pagination={false}
          scroll={{ x: "max-content" }}
        />
        {rows.length > 10 && (
          <div className="text-[11px] text-gray-300 mt-1">仅展示前 10 条，完整 {rows.length} 条可追问细化</div>
        )}
        {actions.length > 0 && onAction && (
          <ActionRow actions={actions.slice(0, 2)} done={done ?? {}} onAction={onAction} />
        )}
      </div>
    );
  }
  // 草稿类结果（generate_draft）→ 专用草稿卡
  if (parsed?.draft && !rows) {
    return (
      <div className="py-1">
        <div className="inline-flex items-center gap-1.5 text-[12px] text-gray-400 mb-1.5">
          <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
          <span>已{toolLabel(chip.tool)}</span>
        </div>
        <DraftCard subject={parsed.draft.subject} body={parsed.draft.body} />
        {actions.length > 0 && onAction && (
          <ActionRow actions={actions.slice(0, 2)} done={done ?? {}} onAction={onAction} />
        )}
      </div>
    );
  }
  return (
    <div className="text-[12px] text-gray-400 py-0.5 max-w-[600px]">
      <span
        className={`inline-flex items-center gap-1.5 ${expandable ? "cursor-pointer" : ""}`}
        onClick={() => expandable && setOpen(o => !o)}
      >
        <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
        <span>
          已{toolLabel(chip.tool)}
          {chip.brief && <span className="text-gray-400"> · {chip.brief}</span>}
        </span>
        {expandable && (open ? <DownOutlined style={{ fontSize: 8 }} /> : <RightOutlined style={{ fontSize: 8 }} />)}
      </span>
      {open && (
        <div className="mt-0.5 ml-5 pl-2 border-l border-gray-200 text-gray-300 whitespace-pre-wrap break-all">
          {full}
        </div>
      )}
      {actions.length > 0 && onAction && (
        <ActionRow actions={actions.slice(0, 2)} done={done ?? {}} onAction={onAction} />
      )}
    </div>
  );
}

/** 过程卡插入在「正在流式的 AI 气泡」之前，保证回答气泡恒在列表末尾（豆包式过程在上、答案在下） */
function insertBeforeStreamingBubble(prev: Msg[], chip: Msg): Msg[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]!;
    if (m.role === "ai" && m.streaming) {
      return [...prev.slice(0, i), chip, ...prev.slice(i)];
    }
  }
  return [...prev, chip];
}

interface ApprovalReq {
  approvalId: string;
  items: Array<{ tool?: string; args?: unknown }>;
}

let seq = 0;
const nextKey = () => `m${++seq}`;

/**
 * 能力面板（空态展示）：把助手真实接入的工具摊开给用户看，点一条即发问。
 * 分组名对应工具，用户不需要记工具名——这里是「能干什么」。
 */
const CAPABILITIES: Array<{ title: string; cap: string; items: string[] }> = [
  {
    title: "查运价", cap: "接入钉钉《海运运价智能台账》本地镜像",
    items: ["santos 的价格怎么样", "加勒比线 40HQ 最便宜到多少", "运价库里现在总共有多少条报价"],
  },
  {
    title: "管邮件", cap: "检索收件箱 + 逐封总结并给下一步建议",
    items: ["我今天有哪些未读邮件", "总结一下 juan@acme.com 发来的询盘邮件"],
  },
  {
    title: "跟进客户", cap: "联系人检索 + 今日到期提醒 + 记跟进（写操作需确认）",
    items: ["我今天该跟进谁", "帮我查公司名带「物流」的联系人", "给 juan@acme.com 记一条跟进：已发送报价，等待回复"],
  },
  {
    title: "准备发信", cap: "写开发信草稿 + 入队（不自动发送，需你在发送中心点开始）",
    items: ["给 ACME 的 Juan 写一封西语开发信", "发送队列现在还有多少没发出去"],
  },
  {
    title: "账号与公司", cap: "发信账号健康检查 + 公司网络背调",
    items: ["我现在有几个发信账号能用", "给 ACME 这家公司做个背调"],
  },
];

/** 本轮调用过的工具 → 「接下来可以问」引导（让能力被连续体验到） */
const FOLLOW_UPS: Record<string, string[]> = {
  quote_search: ["按最便宜的船司给客户写一封开发信", "把这条航线的报价按柜型对比一下"],
  search_contacts: ["给这位联系人记一条跟进", "查一下这个人的往来邮件记录"],
  inbox_search: ["把最值得回复的三封总结一下", "帮我起草一封回复给最新那封询盘"],
  email_summarize: ["按同样标准总结其他未读邮件", "把这条建议对应的跟进记到联系人上"],
  reminders_due: ["给第一位联系人记一条跟进", "逾期最久的那位最近有什么邮件往来"],
  queue_status: ["哪个发信账号在报错，帮我看看", "把待发客户里的第一家背调一下"],
  accounts_status: ["异常的那个账号怎么修", "现在队列里还有多少没发出去"],
  company_backcheck: ["根据背调写一封开发信", "把这个公司的人从客户库里找出来"],
  send_queue_add: ["发送队列现在什么状态", "再给下一家也准备一封"],
};

function readConvFromHash(): string | undefined {
  const raw = window.location.hash;
  const qs = raw.includes("?") ? raw.split("?")[1] : "";
  return new URLSearchParams(qs).get("c") || undefined;
}

function readHashParam(key: string): string | undefined {
  const raw = window.location.hash;
  const qs = raw.includes("?") ? raw.split("?")[1] : "";
  return new URLSearchParams(qs).get(key) || undefined;
}

// ── 斜杠命令（本地解析，不进模型）──
// 命中命令 → 改写成完整问题发给模型；/help 与未知命令 → 就地提示，不发起请求。
interface SlashCmd {
  cmd: string;
  desc: string;
  template?: (arg: string) => string;
  /** 无需参数即可执行（/总结 /今日 /进度） */
  noArg?: boolean;
}
const SLASH_COMMANDS: SlashCmd[] = [
  { cmd: "/运价", desc: "查运价，如「/运价 santos」", template: a => `查一下 ${a} 的海运运价，按船司和柜型汇总，附有效期` },
  { cmd: "/联系人", desc: "查联系人，如「/联系人 logistics」", template: a => `帮我查姓名、邮箱或公司名带「${a}」的联系人` },
  { cmd: "/邮件", desc: "搜收件箱，如「/邮件 quote」", template: a => `帮我在收件箱里搜「${a}」相关的邮件` },
  { cmd: "/总结", desc: "总结最近未读邮件：/总结", noArg: true, template: () => "总结我最近的未读邮件，每封给一句话总结和下一步建议" },
  { cmd: "/今日", desc: "今日待跟进清单：/今日", noArg: true, template: () => "今天我该跟进谁？把到期和逾期的提醒列出来" },
  { cmd: "/进度", desc: "发信队列进度：/进度", noArg: true, template: () => "发送队列现在什么状态，还有多少没发出去" },
  { cmd: "/背调", desc: "公司网络背调，如「/背调 Acme Ltd」", template: a => `帮我背调「${a}」这家公司的背景、进口活跃度和货代契合点` },
  { cmd: "/新对话", desc: "开一个新会话：/新对话" },
  { cmd: "/help", desc: "查看可用命令：/help" },
];
const SLASH_HELP = `可用命令：\n${SLASH_COMMANDS.map(c => `${c.cmd} — ${c.desc}`).join("\n")}`;

/**
 * AI 助手 — 对话工作区（单栏）。
 * 会话历史列表在全局导航栏（豆包式），活动会话经 hash 参数 ?c=<id> 同步：
 * 导航栏点击 → 写 hash → 本页监听加载；本页新建会话 → 回写 hash → 导航栏高亮。
 * 链路：invoke("agent:chat") 立即拿 ID → 事件流 agent:chunk/done/error 逐字渲染 → 消息落库。
 */
export function AssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [approval, setApproval] = useState<ApprovalReq | null>(null);
  /** 页面上下文锚点（#/assistant?ctx=contact:12）：发给模型前由主进程解析成人话注记 */
  const [ctx, setCtx] = useState<string | undefined>(() => readHashParam("ctx"));
  /** 本轮调用过的工具 → 回答结束后生成「接下来可以问」引导 */
  const turnToolsRef = useRef<string[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  /** 动作卡：已执行过的（actionId → 回执短语）+ 待确认的写入动作 */
  const [doneActions, setDoneActions] = useState<Record<string, string>>({});
  const [pendingWrite, setPendingWrite] = useState<ActionDto | null>(null);
  const [writing, setWriting] = useState(false);
  const convIdRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  /** 已自动发送过的 ?q=（防止 hashchange 回环重复发送） */
  const askedRef = useRef<string | null>(null);
  /** hashchange 回调拿不到最新闭包里的 handleSend，用 ref 转发 */
  const sendRef = useRef<((text: string) => void) | null>(null);

  // 模式横幅：设置页可热切端点，所以每次进入/切换会话都重新读一次
  const refreshStatus = async () => {
    const r = await window.api.invoke("agent:status") as
      IpcResult<{ mode: "mock" | "live"; model: string; thinking?: boolean }>;
    if (r?.success && r.data) { setMode(r.data.mode); setModel(r.data.model); setThinking(!!r.data.thinking); }
  };
  useEffect(() => { void refreshStatus(); }, []);

  /** 加载指定会话（undefined = 新会话空态）；切换时中断进行中的生成
   *  （用 ref 而非闭包 sending 判断：hashchange 回调捕获的是首帧闭包，state 已过期；
   *    agent:stop 对无进行中回合幂等成功，多调无害） */
  const loadConversation = async (id: string | undefined) => {
    const token = ++loadTokenRef.current;
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
    convIdRef.current = id;
    setSending(false);
    setApproval(null);
    setCtx(readHashParam("ctx"));   // 会话切换时同步页面上下文 chip（hash 携带才保留）
    setInputVal("");       // 切会话清空未发送的输入，避免串会话
    setFollowUps([]);      // 引导条属于上一轮，切会话即失效
    setDoneActions({});    // 动作卡状态不跨会话
    setPendingWrite(null);
    setMessages([]);        // 立即清空，避免旧会话内容滞留
    void refreshStatus();    // 期间可能在设置页换了端点
    if (!id) { setConvLoading(false); return; }
    setConvLoading(true);
    const r = await window.api.invoke("agent:getConversation", id) as
      IpcResult<Array<{ role: string; content: string }>>;
    if (token !== loadTokenRef.current) return;  // 已切去更新的会话 → 丢弃过期响应
    setMessages(r?.success && r.data
      ? r.data.map(m => ({ key: nextKey(), role: m.role === "user" ? "user" as const : "ai" as const, content: m.content }))
      : []);
    setConvLoading(false);
  };

  // 首屏 + hash 变更（导航栏点击会话 / 其他页「问 AI」深链跳转）
  useEffect(() => {
    void loadConversation(readConvFromHash());
    const onHash = () => {
      const id = readConvFromHash();
      if (id !== convIdRef.current) void loadConversation(id);
      // ?q=…：由「问 AI」入口带来的问题 → 自动发送一次并从 hash 摘掉（刷新不重发）
      const q = readHashParam("q");
      if (q && askedRef.current !== q) {
        askedRef.current = q;
        const c = readHashParam("ctx");
        window.location.hash = c ? `#/assistant?ctx=${encodeURIComponent(c)}` : "#/assistant";
        setTimeout(() => sendRef.current?.(q), 80);
      }
    };
    window.addEventListener("hashchange", onHash);
    onHash();
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
      setMessages(prev => {
        const next = prev.map(m => m.streaming ? { ...m, streaming: false, loading: false } : m);
        return next;
      });
      setSending(false);
      // 用本轮真实调用过的工具生成下一步引导（能力连续可感）
      const used = [...new Set(turnToolsRef.current)];
      setFollowUps(used.length === 0
        ? ["我今天该跟进谁", "总结一下我的未读邮件"]
        : used.slice(0, 2).flatMap(t => FOLLOW_UPS[t] ?? []).slice(0, 3));
      turnToolsRef.current = [];
      window.dispatchEvent(new Event(CONVS_CHANGED));
    });
    const offError = window.api.on("agent:error", (data) => {
      const d = data as { message?: string };
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
          if (m.role === "ai" && m.streaming) {
            next[i] = { ...m, streaming: false, loading: false, error: true, content: d.message || "生成失败" };
            break;
          }
        }
        return next;
      });
      setSending(false);
    });
    // 过程行（结构化数据，渲染交给 ProcessLine）：calling 插入 → done 原地升级；始终插在流式气泡之前
    const offTool = window.api.on("agent:toolCall", (data) => {
      const d = data as { tool?: string; status?: string; args?: string; result?: string };
      setMessages(prev => {
        if (d.status === "reasoning") {
          return insertBeforeStreamingBubble(prev, {
            key: nextKey(), role: "tool", content: "",
            chip: { kind: "reasoning", tool: d.tool, detail: d.result },
          });
        }
        if (d.status === "calling") {
          if (d.tool) turnToolsRef.current.push(d.tool);
          return insertBeforeStreamingBubble(prev, {
            key: nextKey(), role: "tool", content: "",
            chip: { kind: "calling", tool: d.tool, args: fmtChipArgs(d.args) },
          });
        }
        // done：找同名 calling 过程行原地升级为结果行
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
          if (m.role === "tool" && m.chip?.kind === "calling" && m.chip.tool === d.tool) {
            next[i] = { ...m, chip: { kind: "done", tool: d.tool, args: m.chip.args, brief: resultBrief(d.result), detail: d.result } };
            break;
          }
        }
        return next;
      });
    });
    // 写操作审批：弹确认框 + 开一条续跑气泡（续跑增量落到它上面）
    const offApproval = window.api.on("agent:approval", (data) => {
      const d = data as { approvalId?: string; items?: ApprovalReq["items"] };
      setApproval({ approvalId: d.approvalId ?? "", items: d.items ?? [] });
      setMessages(prev => [...prev, { key: nextKey(), role: "ai" as const, content: "", loading: true, streaming: true }]);
    });
    return () => { offChunk(); offDone(); offError(); offTool(); offApproval(); };
  }, []);

  /** 实际发起一轮对话（正文 + ctx 锚点） */
  const doSend = async (text: string) => {
    setSending(true);
    setFollowUps([]);
    turnToolsRef.current = [];
    const aiKey = nextKey();
    setMessages(prev => [...prev, { key: nextKey(), role: "user", content: text }, { key: aiKey, role: "ai", content: "", loading: true, streaming: true }]);
    const r = await window.api.invoke("agent:chat", { conversationId: convIdRef.current, text, context: ctx }) as
      IpcResult<{ conversationId: string; messageId: string }>;
    if (!r?.success) {
      setMessages(prev => prev.map(m => m.key === aiKey ? { ...m, streaming: false, loading: false, error: true, content: r?.error || "发起失败" } : m));
      setSending(false);
      return;
    }
    if (r.data && readConvFromHash() !== r.data.conversationId) {
      convIdRef.current = r.data.conversationId;
      gotoConversation(r.data.conversationId);   // 回写 hash → 导航栏高亮新会话
    }
    window.dispatchEvent(new Event(CONVS_CHANGED)); // 新会话立即可见（标题已在主进程生成）
  };

  /** 入口：斜杠命令本地解析（/help、/新对话 就地处理，不发起请求） */
  const handleSend = (raw: string) => {
    const t = raw.trim();
    if (!t || sending) return;
    if (t.startsWith("/")) {
      const hit = SLASH_COMMANDS.find(c => t === c.cmd || t.startsWith(`${c.cmd} `));
      if (!hit) {
        const unknown = t.split(/\s+/)[0];
        setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: `未知命令 ${unknown}。${SLASH_HELP}` }]);
        return;
      }
      if (hit.cmd === "/help") {
        setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: SLASH_HELP }]);
        return;
      }
      if (hit.cmd === "/新对话") {
        window.location.hash = "#/assistant";
        void loadConversation(undefined);
        return;
      }
      const arg = t.slice(hit.cmd.length).trim();
      if (!arg && !hit.noArg) {
        setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: `用法：${hit.desc}` }]);
        return;
      }
      void doSend(hit.template!(arg));
      return;
    }
    void doSend(t);
  };
  // 每次渲染同步最新版本，供 hashchange 回调（首帧闭包）调用
  useEffect(() => { sendRef.current = handleSend; });

  /** 输入以 / 开头 → 命令菜单候选（纯可发现性，点击填入，Enter 仍走本地解析） */
  const slashCandidates = inputVal.startsWith("/")
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(inputVal.split(/\s+/)[0]!)).slice(0, 6)
    : [];

  const handleStop = () => {
    setApproval(null);
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
  };

  /** 审批结论回传：成功则等续跑流（DONE 收尾）；失败提示并释放输入 */
  const handleApproval = async (approved: boolean) => {
    if (!approval) return;
    const a = approval;
    setApproval(null);
    const r = await window.api.invoke("agent:resolveApproval", { approvalId: a.approvalId, approved }) as
      IpcResult<{ resumed: boolean }>;
    if (!r?.success) {
      setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: `审批失败：${r?.error || "未知错误"}` }]);
      setSending(false);
    }
  };

  /** 结果卡动作：跳转直接走，提示即续问，写入弹确认（显 diff） */
  const handleAction = (a: ActionDto) => {
    if (a.kind === "navigate" && a.href) { window.location.hash = a.href; return; }
    if (a.kind === "prompt" && a.text) { void handleSend(a.text); return; }
    if (a.kind === "write" && a.id) setPendingWrite(a);
  };

  /** 确认写入 → 主进程执行留存的闭包（执行后即从注册表移除，天然防重复提交） */
  const confirmWrite = async () => {
    const a = pendingWrite;
    if (!a?.id) return;
    setWriting(true);
    const r = await window.api.invoke("agent:runAction", a.id) as
      IpcResult<{ label: string; message: string; target?: { label: string; href: string } }>;
    setWriting(false);
    setPendingWrite(null);
    if (!r?.success) {
      setDoneActions(prev => ({ ...prev, [a.id!]: "失败" }));
      setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: `${a.label}失败：${r?.error || "未知错误"}` }]);
      return;
    }
    setDoneActions(prev => ({ ...prev, [a.id!]: "已完成" }));
    setMessages(prev => [...prev, {
      key: nextKey(), role: "tool", content: r.data?.message ?? `已${a.label}`,
      ...(r.data?.target ? { link: r.data.target } : {}),
    }]);
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
          {mode === "live" && (
            <Tooltip title="在「设置 → 模型与端点」切换端点或思考模式，保存即生效，不用重启">
              <Tag color={thinking ? "blue" : "default"}>{thinking ? "思考中" : "直答"}</Tag>
            </Tooltip>
          )}
        </Space>
      </div>

      {mode === "mock" && (
        <Alert
          type="warning" showIcon closable className="mb-2"
          message="还没有可用的模型端点，当前为 Mock 流"
          description="去「设置 → 模型与端点」新增端点（有 Agnes / DeepSeek / 本地 Ollama / 公司中转 模板），填密钥后点「启用」，回到这里立刻生效，不用重启应用。"
        />
      )}

      {/* 消息流 — selectable 豁免全局 user-select:none，允许复制 AI 回复 */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 selectable">
        {convLoading ? (
          /* 会话切换骨架屏：模拟气泡布局 */
          <div className="space-y-5 pt-2 animate-pulse">
            {[
              { me: false, w: "58%", rows: 3 },
              { me: true, w: "34%", rows: 1 },
              { me: false, w: "64%", rows: 2 },
            ].map((r, i) => (
              <div key={i} className={`flex gap-2.5 ${r.me ? "flex-row-reverse" : ""}`}>
                <Avatar
                  icon={r.me ? <UserOutlined /> : <RobotOutlined />}
                  style={{ background: r.me ? "#1a1a1a" : "#e6fffb", color: r.me ? "#fff" : "#00897b", flexShrink: 0 }}
                />
                <div style={{ width: r.w }}>
                  <Skeleton active title={false} paragraph={{ rows: r.rows, width: "100%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-6">
            <div className="text-center">
              <RobotOutlined style={{ fontSize: 42, color: "#00bfa5" }} />
              <div className="text-base font-semibold text-gray-700 mt-3">Hi，我是 Prospector 助手</div>
              <div className="text-xs text-gray-400 mt-1">已接入运价 / 邮件 / 客户 / 跟进 / 发信 11 项能力，写操作一律先弹确认</div>
            </div>
            {/* 能力面板：把已接入的工具摊开成「能干什么」，点一条即发问 */}
            <div className="w-full max-w-2xl grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {CAPABILITIES.map(g => (
                <div key={g.title} className="border border-gray-100 rounded-lg p-3 bg-white">
                  <div className="text-[13px] font-semibold text-gray-800">{g.title}</div>
                  <div className="text-[11px] text-gray-400 mb-1.5 leading-snug">{g.cap}</div>
                  {g.items.map(q => (
                    <div
                      key={q}
                      className="text-[12px] text-teal-700 hover:bg-teal-50 rounded px-1.5 py-1 -mx-1.5 cursor-pointer truncate"
                      title={q}
                      onClick={() => void handleSend(q)}
                    >
                      {q}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="text-[11px] text-gray-400">
              输入 <code>/</code> 唤出快捷命令 · 写操作（记跟进、入队发信）都会先弹确认框
            </div>
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
              // 过程行：结构化 chip 走 ProcessLine（含动作卡）；无 chip 的散件（回执行/审批失败）降级为灰字
              ...(m.role === "tool" ? {
                messageRender: () => (m.chip
                  ? <ProcessLine chip={m.chip} done={doneActions} onAction={handleAction} />
                  : (
                    <div className="text-[12px] text-gray-400 py-0.5">
                      {m.content}
                      {m.link && (
                        <a className="ml-2" onClick={() => { window.location.hash = m.link!.href; }}>{m.link.label}</a>
                      )}
                    </div>
                  )),
              } : {}),
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
                // 等待首包期间（端点延迟可达数秒）用骨架屏代替默认小圆点，观感与会话切换一致
                loadingRender: () => (
                  <div style={{ minWidth: 240, padding: "4px 0" }}>
                    <Skeleton active title={false} paragraph={{ rows: 2, width: ["82%", "56%"] }} />
                  </div>
                ),
                messageRender: (content: string) => (
                  <div className="text-[13px] leading-relaxed md-body">
                    <Markdown remarkPlugins={[remarkGfm]}>{mdFixTables(content)}</Markdown>
                  </div>
                ),
              },
              tool: {
                placement: "start",
                // 过程行去气泡化：无边框无底色，纯灰字细行
                styles: { content: { background: "transparent", padding: 0, border: "none", minWidth: 0 } },
              },
            }}
          />
        )}
      </div>

      {/* 输入区 */}
      <div className="pt-3 relative">
        {/* 「接下来可以问」：按本轮真实用到的工具生成，让能力被连续体验到 */}
        {!sending && followUps.length > 0 && messages.length > 0 && (
          <div className="pb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-400">接下来可以问：</span>
            {followUps.map(f => (
              <Tag
                key={f}
                className="!text-[12px] !border-teal-200 !text-teal-700 !bg-teal-50/60 cursor-pointer hover:!bg-teal-100"
                onClick={() => void handleSend(f)}
              >
                {f}
              </Tag>
            ))}
          </div>
        )}
        {/* 斜杠命令菜单：输入 / 即出现 */}
        {slashCandidates.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 w-80 max-w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-10">
            {slashCandidates.map(c => (
              <div
                key={c.cmd}
                className="px-3 py-2 hover:bg-teal-50 cursor-pointer flex items-baseline gap-2 border-b border-gray-50 last:!border-b-0"
                onClick={() => setInputVal(`${c.cmd} `)}
              >
                <span className="text-[12px] font-medium text-gray-800">{c.cmd}</span>
                <span className="text-[11px] text-gray-400 truncate">{c.desc}</span>
              </div>
            ))}
          </div>
        )}
        {ctx && (
          <div className="pb-2">
            <Tag closable color="cyan" onClose={() => setCtx(undefined)}>
              当前上下文 · {ctxLabel(ctx)}（问题将围绕它回答）
            </Tag>
          </div>
        )}
        <Sender
          value={inputVal}
          onChange={(v) => setInputVal(v)}
          placeholder="问我任何关于运价、邮件、客户、发信的事…（输入 / 看快捷命令）"
          loading={sending}
          onSubmit={(text) => { setInputVal(""); handleSend(text); }}
          onCancel={handleStop}
        />
      </div>

      {/* 写操作审批（harness 中断流的人工确认环节）：人话描述 + 可展开原始参数 */}
      <Modal
        open={!!approval}
        title="确认写操作"
        okText="确认执行"
        cancelText="拒绝"
        maskClosable={false}
        onOk={() => { void handleApproval(true); }}
        onCancel={() => { void handleApproval(false); }}
      >
        {approval?.items.map((it, i) => (
          <ApprovalItem key={i} tool={it.tool} args={it.args} />
        ))}
      </Modal>

      {/* 动作卡写入确认：展示字段 diff，确认后才执行主进程留存的闭包 */}
      <Modal
        open={!!pendingWrite}
        title={pendingWrite?.label ?? "确认写入"}
        okText="确认写入"
        cancelText="取消"
        confirmLoading={writing}
        maskClosable={false}
        onOk={() => { void confirmWrite(); }}
        onCancel={() => setPendingWrite(null)}
      >
        <div className="text-[13px] text-gray-800 leading-relaxed">{pendingWrite?.confirm}</div>
        {pendingWrite?.detail && (
          <div className="text-[11px] text-amber-600 mt-1">{pendingWrite.detail}</div>
        )}
        {!!pendingWrite?.diff?.length && (
          <Table
            className="mt-3"
            dataSource={pendingWrite.diff.map((d, i) => ({ ...d, __k: i }))}
            rowKey="__k"
            size="small"
            bordered
            pagination={false}
            columns={[
              { title: "字段", dataIndex: "label", key: "label", width: 84, render: (v: string) => <span className="text-[12px]">{v}</span> },
              { title: "现在", dataIndex: "from", key: "from", render: (v: string) => <span className="text-[12px] text-gray-400">{v}</span> },
              { title: "写入后", dataIndex: "to", key: "to", render: (v: string) => <span className="text-[12px] text-gray-800">{v}</span> },
            ]}
          />
        )}
      </Modal>
    </div>
  );
}

/** 上下文锚点 → 简短标签（详细人话由主进程解析注入） */
function ctxLabel(c: string): string {
  const m = /^(contact|company|message):(\d+)$/.exec(c);
  if (!m) return c;
  const kind = m[1] === "contact" ? "联系人" : m[1] === "company" ? "公司" : "邮件";
  return `${kind} #${m[2]}`;
}

/** 单条审批项：一句话说明 + 可展开的原始参数 */
function ApprovalItem({ tool, args }: { tool?: string; args?: unknown }) {
  const [open, setOpen] = useState(false);
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 2);
  return (
    <div className="mb-3">
      <div className="text-[13px] text-gray-800 leading-relaxed">{describeApproval(tool, args)}</div>
      <div
        className="text-[11px] text-gray-400 mt-1 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        {open ? "收起参数" : "查看原始参数"}
      </div>
      {open && (
        <pre className="text-xs bg-gray-50 p-2 mt-1 mb-0 overflow-auto max-h-48 whitespace-pre-wrap break-all">{raw}</pre>
      )}
    </div>
  );
}
