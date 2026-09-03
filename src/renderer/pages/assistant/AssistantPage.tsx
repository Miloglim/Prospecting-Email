import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Avatar, Button, Checkbox, Modal, Skeleton, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import {
  UserOutlined, LoadingOutlined, CheckCircleOutlined,
  BulbOutlined, DownOutlined, RightOutlined, FileTextOutlined, CloseCircleOutlined, CopyOutlined,
} from "@ant-design/icons";
import { Bubble, Sender, ThoughtChain } from "@ant-design/x";
import type { ThoughtChainItem } from "@ant-design/x";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import remarkGfm from "remark-gfm";
import { DiamondLogo } from "../../components/DiamondLogo";
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
  /** 产生时刻（过程行折叠后据此算「用时 Xs」；历史消息可缺省） */
  ts?: number;
  /** 过程卡结构化字段（role=tool 时） */
  chip?: {
    kind: "calling" | "done" | "reasoning";
    tool?: string;
    /** 工具调用 id：calling → done 原地升级按它配对，同名连发不会错配 */
    callId?: string;
    args?: string;
    detail?: string;   // 参数摘要 / 结果摘要 / 思考全文
    brief?: string;    // done 卡的「N 条结果」小尾巴
  };
  /** 任务清单快照（role=tool，由 agent:plan 全量覆盖、原地刷新） */
  plan?: PlanStep[];
  /** 后台任务卡引用（工具结果里的 task 字段，进度走 agent:task 事件） */
  task?: { taskId: string };
  /** 本轮 token 结算（挂在收尾的 AI 气泡上；端点没回 usage 就不显示） */
  usage?: { requests?: number; input?: number; output?: number; cached?: number };
  /** 动作执行后的回执行（role=tool 无 chip 时），带可选跳转 */
  link?: { label: string; href: string };
}

/** 任务清单里的一步（与主进程 update_plan 归一后的形状一致） */
interface PlanStep { text: string; state: "pending" | "doing" | "done" }

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
  update_plan: "更新任务清单",
  export_artifact: "导出文件",
  start_batch_task: "启动后台任务",
  report_gap: "登记能力缺口",
  reasoning: "思考",
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
    const p2 = o as { artifact?: { name?: unknown }; task?: { total?: unknown } };
    if (p2.artifact && typeof p2.artifact.name === "string") return `已生成 ${p2.artifact.name}`;
    if (p2.task && typeof p2.task.total === "number") return `共 ${p2.task.total} 家`;
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

/** 导出文件卡（export_artifact 的唯一形态：主进程落盘后回传元信息） */
interface ArtifactDto { name: string; path: string; sizeBytes?: number; format?: string }

/** 工具结果 JSON → 动作列表 / 草稿 / 文件卡 / 后台任务卡引用 */
function parseResult(detail?: string): {
  actions: ActionDto[];
  draft?: { subject: string; body: string };
  artifact?: ArtifactDto;
  task?: { taskId: string };
} | null {
  if (!detail) return null;
  try {
    const o = JSON.parse(detail) as Record<string, unknown>;
    const actions = Array.isArray(o.actions) ? (o.actions as ActionDto[]) : [];
    const draft = typeof o.body === "string" && typeof o.subject === "string"
      ? { subject: o.subject, body: o.body }
      : undefined;
    const rawArt = o.artifact as { name?: unknown; path?: unknown; sizeBytes?: unknown; format?: unknown } | undefined;
    const artifact = rawArt && typeof rawArt.path === "string" && typeof rawArt.name === "string"
      ? { name: rawArt.name, path: rawArt.path, sizeBytes: typeof rawArt.sizeBytes === "number" ? rawArt.sizeBytes : undefined, format: typeof rawArt.format === "string" ? rawArt.format : undefined }
      : undefined;
    const rawTask = o.task as { taskId?: unknown } | undefined;
    const task = rawTask && typeof rawTask.taskId === "string" ? { taskId: rawTask.taskId } : undefined;
    if (!actions.length && !draft && !artifact && !task) return null;
    return { actions, ...(draft ? { draft } : {}), ...(artifact ? { artifact } : {}), ...(task ? { task } : {}) };
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

/** 导出文件卡：文件名 + 格式/大小 + 打开位置/复制路径 */
function FileCard({ artifact }: { artifact: ArtifactDto }) {
  const [copied, setCopied] = useState(false);
  const [openErr, setOpenErr] = useState("");
  const size = artifact.sizeBytes != null
    ? (artifact.sizeBytes >= 1024 ? `${(artifact.sizeBytes / 1024).toFixed(1)} KB` : `${artifact.sizeBytes} B`)
    : "";
  return (
    <div className="border border-gray-200 rounded-lg bg-white max-w-[520px] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <FileTextOutlined style={{ fontSize: 18, color: "#00897b" }} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-gray-800 truncate" title={artifact.path}>{artifact.name}</div>
          <div className="text-[11px] text-gray-400">
            {(artifact.format ?? "").toUpperCase()}{size && ` · ${size}`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <Button type="primary" ghost size="small" style={{ fontSize: 12 }}
          onClick={async () => {
            const r = await window.api.invoke("agent:openPath", { path: artifact.path }) as IpcResult<void>;
            setOpenErr(r?.success ? "" : (r?.error || "打开失败"));
          }}>
          打开位置
        </Button>
        <Button size="small" style={{ fontSize: 12 }}
          onClick={async () => {
            try {
              await window.navigator.clipboard.writeText(artifact.path);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch { /* 剪贴板不可用时静默 */ }
          }}>
          {copied ? "已复制" : "复制路径"}
        </Button>
        {openErr && <span className="text-[11px] text-red-400">{openErr}</span>}
      </div>
    </div>
  );
}

/** 后台任务快照（与主进程 bg-task.service 同形，渲染层本地声明避免跨层 import） */
interface TaskSnapshot {
  id: string;
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  items: Array<{ label: string; state: "pending" | "running" | "done" | "failed"; note?: string }>;
  artifact?: ArtifactDto;
}

/** 后台任务卡：挂载取快照 + 订阅 agent:task 原地刷新；可取消，完成后产物一键打开 */
function TaskCard({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await window.api.invoke("agent:getTask", { taskId }) as IpcResult<TaskSnapshot>;
      if (!alive) return;
      if (r?.success && r.data) setTask(r.data); else setGone(true);
    })();
    const off = window.api.on("agent:task", (data) => {
      const d = data as { taskId?: string; task?: TaskSnapshot };
      if (d.taskId === taskId && d.task) setTask(d.task);
    });
    return () => { alive = false; off(); };
  }, [taskId]);

  if (gone) return <div className="text-[12px] text-gray-400 py-1">后台任务已中断（应用重启后失效）</div>;
  if (!task) {
    return (
      <div className="text-[12px] text-gray-400 py-1">
        <LoadingOutlined spin className="mr-1" />正在读取任务进度…
      </div>
    );
  }

  const done = task.items.filter(i => i.state === "done").length;
  const failed = task.items.filter(i => i.state === "failed").length;
  const running = task.state === "running";
  return (
    <div className="my-1.5 max-w-[600px] border border-gray-200 rounded-lg bg-white px-3 py-2.5">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-gray-700">
          {running && <LoadingOutlined spin style={{ color: "#00bfa5" }} className="mr-1.5" />}
          {task.title}
        </span>
        <span className="text-[11px] text-gray-400 shrink-0 ml-2">
          {done}{failed ? ` + ${failed} 失败` : ""}/{task.items.length}
        </span>
      </div>
      <ol className="m-0 p-0 list-none space-y-1">
        {task.items.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
            <span className="mt-0.5 shrink-0 w-3.5 text-center">
              {s.state === "done"
                ? <CheckCircleOutlined style={{ fontSize: 12, color: "#52c41a" }} />
                : s.state === "running"
                  ? <LoadingOutlined spin style={{ fontSize: 12, color: "#00bfa5" }} />
                  : s.state === "failed"
                    ? <CloseCircleOutlined style={{ fontSize: 12, color: "#ff4d4f" }} />
                    : <span className="inline-block w-2 h-2 rounded-full border border-gray-300" />}
            </span>
            <span className={s.state === "failed" ? "text-red-400" : s.state === "running" ? "text-gray-800" : "text-gray-500"}>
              {s.label}{s.state === "failed" && s.note ? ` · ${s.note}` : ""}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 mt-2">
        {running && (
          <Button size="small" style={{ fontSize: 12 }}
            onClick={() => { void window.api.invoke("agent:cancelTask", { taskId }); }}>
            取消
          </Button>
        )}
        {!running && task.artifact && <FileCard artifact={task.artifact} />}
        {task.state === "cancelled" && (
          <span className="text-[11px] text-gray-400">已取消 · 完成 {done} 项</span>
        )}
        {task.state === "failed" && !task.artifact && (
          <span className="text-[11px] text-gray-400">没有一家成功，未生成汇总文件</span>
        )}
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

/** 表格右上角复制按钮（绝对定位，父级需 relative）：整表以 TSV 进剪贴板，可直接粘进 Excel / 谷歌表格 */
function CopyTableButton({ rows, cols }: {
  rows: Record<string, unknown>[];
  cols: Array<{ key: string; label: string }>;
}) {
  const [copied, setCopied] = useState(false);
  // 制表符/换行会破坏列对齐，压成空格；对象值序列化，空值给空串（比 "—" 更适合粘贴）
  const clean = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))
    .replace(/[\t\r\n]+/g, " ");
  return (
    <Tooltip title={rows.length > 10 ? `复制全部 ${rows.length} 行` : "复制表格"}>
      <Button size="small"
        className="!absolute top-1.5 right-1.5 z-10"
        style={{ fontSize: 12, background: "rgba(255, 255, 255, 0.92)" }}
        icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
        onClick={async () => {
          const tsv = [
            cols.map(c => clean(c.label)).join("\t"),
            ...rows.map(r => cols.map(c => clean(r[c.key])).join("\t")),
          ].join("\n");
          try {
            await window.navigator.clipboard.writeText(tsv);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch { /* 剪贴板不可用时静默 */ }
        }}>
        {copied ? "已复制" : "复制"}
      </Button>
    </Tooltip>
  );
}

/** 正文 Markdown 表格的产品化：套同款白底灰线+阴影卡片，右上角浮动复制按钮（点按时从 DOM 提取 TSV） */
function MDTableBlock({ children }: { children?: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div ref={boxRef} className="chat-table-card relative">
      <Tooltip title="复制表格">
        <Button size="small"
          className="!absolute top-1.5 right-1.5 z-10"
          style={{ fontSize: 12, background: "rgba(255, 255, 255, 0.92)" }}
          icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
          onClick={async () => {
            const trs = Array.from(boxRef.current?.querySelectorAll("tr") ?? []);
            const tsv = trs
              .map(tr => Array.from(tr.querySelectorAll("th,td"))
                .map(c => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join("\t"))
              .join("\n");
            try {
              await window.navigator.clipboard.writeText(tsv);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch { /* 剪贴板不可用时静默 */ }
          }}>
          {copied ? "已复制" : "复制"}
        </Button>
      </Tooltip>
      {children}
    </div>
  );
}

/** 产物卡：done 过程行里带数据表格 / 草稿 / 动作时独立摊开（不参与折叠）；纯状态行交给 ProcessChain */
function ArtifactBlock({ chip, done, onAction }: {
  chip: NonNullable<Msg["chip"]>;
  done: Record<string, string>;
  onAction: (a: ActionDto) => void;
}) {
  const parsed = parseResult(chip.detail);
  const actions = parsed?.actions ?? [];
  const rows = asRows(chip.detail);
  const brief = chip.brief || (rows ? `${rows.length} 条结果` : "");
  const header = (
    <div className="inline-flex items-center gap-1.5 text-[12px] text-gray-400 mb-1.5">
      <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
      <span>已{toolLabel(chip.tool)}{brief && <span className="text-gray-400"> · {brief}</span>}</span>
    </div>
  );

  if (parsed?.artifact) {
    return (
      <div className="py-1">
        {header}
        <FileCard artifact={parsed.artifact} />
      </div>
    );
  }

  if (parsed?.task) {
    return (
      <div className="py-1">
        {header}
        <TaskCard taskId={parsed.task.taskId} />
      </div>
    );
  }

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
    const copyCols = Object.keys(rows[0]!).slice(0, 7).map(k => ({ key: k, label: COL_LABELS[k] || k }));
    return (
      <div className="py-1 max-w-[720px]">
        {header}
        <div className="chat-table-card relative">
          <CopyTableButton rows={rows} cols={copyCols} />
          <Table
            dataSource={rows.slice(0, 10).map((r, i) => ({ ...r, __k: i }))}
            rowKey="__k"
            columns={cols}
            size="small"
            bordered
            pagination={false}
            scroll={{ x: "max-content" }}
          />
        </div>
        {rows.length > 10 && (
          <div className="text-[11px] text-gray-300 mt-1">仅展示前 10 条，完整 {rows.length} 条可追问细化</div>
        )}
        {actions.length > 0 && <ActionRow actions={actions.slice(0, 2)} done={done} onAction={onAction} />}
      </div>
    );
  }

  if (parsed?.draft) {
    return (
      <div className="py-1">
        {header}
        <DraftCard subject={parsed.draft.subject} body={parsed.draft.body} />
        {actions.length > 0 && <ActionRow actions={actions.slice(0, 2)} done={done} onAction={onAction} />}
      </div>
    );
  }

  if (actions.length) {
    return (
      <div className="py-1 max-w-[720px]">
        {header}
        <ActionRow actions={actions.slice(0, 2)} done={done} onAction={onAction} />
      </div>
    );
  }
  return null;
}

/** done 过程行是否承载「产物」（数据表格 / 草稿 / 动作卡 / 文件卡 / 任务卡）：产物不折，纯状态行才折进过程里 */
function chipHasArtifact(chip: NonNullable<Msg["chip"]>): boolean {
  if (chip.kind !== "done") return false;
  const parsed = parseResult(chip.detail);
  return !!asRows(chip.detail) || !!parsed?.draft || !!parsed?.actions?.length
    || !!parsed?.artifact || !!parsed?.task;
}

/** 消息流 → 渲染段：一整轮的纯过程行折成一段（停在首条位置），产物/清单/气泡各自独立 */
type Segment =
  | { type: "msg"; key: string; m: Msg }
  | { type: "chain"; key: string; items: Msg[] };

function segmentMessages(list: Msg[]): Segment[] {
  const segs: Segment[] = [];
  let open: { type: "chain"; key: string; items: Msg[] } | null = null;
  for (const m of list) {
    if (m.role === "user") { open = null; segs.push({ type: "msg", key: m.key, m }); continue; }
    if (m.role === "tool" && m.chip && !chipHasArtifact(m.chip)) {
      if (!open) { open = { type: "chain", key: m.key, items: [] }; segs.push(open); }
      open.items.push(m);
      continue;
    }
    segs.push({ type: "msg", key: m.key, m });
  }
  return segs;
}

/** 秒数 → 「12s」/「2分05秒」；无时间戳时返回空串（历史消息不参与计时） */
function fmtSec(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}
/** token 数 → 1.2k（够读即可，不做小数位考究） */
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/**
 * 过程折叠：跑的时候摊开（ThoughtChain 逐步点亮，耗时每秒一跳），回合一结束收成一行
 * 「已处理 N 步 · 用时 Xs」。想回看细节点开头部即可 —— 答案不再被过程挤出屏幕。
 */
function ProcessChain({ items, live, now }: { items: Msg[]; live: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const toolSteps = items.filter(m => m.chip?.kind !== "reasoning").length;
  const thinkSteps = items.length - toolSteps;
  const start = items[0]?.ts;
  const end = live ? now : items.reduce((n, m) => Math.max(n, m.ts ?? 0), 0);
  const spent = start ? fmtSec(end - start) : "";
  const expanded = live || open;

  const label = toolSteps === 0
    ? (thinkSteps ? `已思考 ${spent}`.trim() : "已完成一步")
    : `${live ? "正在处理" : "已处理"} ${toolSteps} 步${spent ? ` · ${spent}` : ""}${thinkSteps ? ` · 含 ${thinkSteps} 次思考` : ""}`;

  const chainItems: ThoughtChainItem[] = items.map(m => {
    const c = m.chip!;
    const brief = (s?: string, n = 90) => (s && s.length > n ? `${s.slice(0, n)}…` : s) ?? "";
    if (c.kind === "reasoning") {
      return {
        key: m.key, icon: <BulbOutlined style={{ fontSize: 10, color: "#bfbfbf" }} />,
        title: <span className="text-[12px] text-gray-500">思考</span>,
        content: (
          <div className="text-[12px] text-gray-400 pl-2 border-l border-gray-200 whitespace-pre-wrap leading-relaxed">
            {brief(c.detail, 400)}
          </div>
        ),
        status: "success",
      };
    }
    if (c.kind === "calling") {
      return {
        key: m.key, icon: <LoadingOutlined spin style={{ fontSize: 10, color: "#8c8c8c" }} />,
        title: <span className="text-[12px] text-gray-500">正在{toolLabel(c.tool)}</span>,
        description: c.args ? <span className="text-[11px]">{brief(c.args, 60)}</span> : undefined,
        status: "pending",
      };
    }
    return {
      key: m.key, icon: <CheckCircleOutlined style={{ fontSize: 10, color: "#52c41a" }} />,
      title: <span className="text-[12px] text-gray-500">已{toolLabel(c.tool)}</span>,
      description: (c.brief || c.args)
        ? <span className="text-[11px]">{brief(c.brief || c.args, 60)}</span>
        : undefined,
      footer: c.detail
        ? (
          <div className="text-[11px] text-gray-300 whitespace-pre-wrap break-all">
            {brief(c.detail, 240)}
          </div>
        )
        : undefined,
      status: "success",
    };
  });

  return (
    <div className="py-0.5 max-w-[720px]">
      <div
        className={`inline-flex items-center gap-1.5 text-[12px] text-gray-400 ${live ? "" : "cursor-pointer select-none"}`}
        onClick={() => !live && setOpen(o => !o)}
      >
        {live ? <LoadingOutlined spin style={{ fontSize: 11 }} /> : <CheckCircleOutlined style={{ fontSize: 11, color: "#52c41a" }} />}
        <span>{label}</span>
        {!live && (open ? <DownOutlined style={{ fontSize: 8 }} /> : <RightOutlined style={{ fontSize: 8 }} />)}
      </div>
      {expanded && (
        <div className="agent-chain mt-1 ml-0.5">
          <ThoughtChain size="small" items={chainItems} />
        </div>
      )}
    </div>
  );
}

/** 任务清单卡：多步任务的进度可视化，随 update_plan 全量快照原地刷新 */
function PlanCard({ items }: { items: PlanStep[] }) {
  const done = items.filter(i => i.state === "done").length;
  return (
    <div className="my-1.5 max-w-[600px] border border-gray-200 rounded-lg bg-white px-3 py-2.5">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-gray-700">任务清单</span>
        <span className="text-[11px] text-gray-400">{done}/{items.length}</span>
      </div>
      <ol className="m-0 p-0 list-none space-y-1">
        {items.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
            <span className="mt-0.5 shrink-0 w-3.5 text-center">
              {s.state === "done"
                ? <CheckCircleOutlined style={{ fontSize: 12, color: "#52c41a" }} />
                : s.state === "doing"
                  ? <LoadingOutlined spin style={{ fontSize: 12, color: "#00bfa5" }} />
                  : <span className="inline-block w-2 h-2 rounded-full border border-gray-300" />}
            </span>
            <span className={s.state === "done" ? "text-gray-400 line-through" : s.state === "doing" ? "text-gray-800" : "text-gray-500"}>
              {s.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 过程卡插入在「正在流式的 AI 气泡」之前，保证回答气泡恒在列表末尾（豆包式过程在上、答案在下） */
function insertBeforeStreamingBubble(prev: Msg[], chip: Msg): Msg[] {
  const stamped = { ...chip, ts: chip.ts ?? Date.now() };
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]!;
    if (m.role === "ai" && m.streaming) {
      return [...prev.slice(0, i), stamped, ...prev.slice(i)];
    }
  }
  return [...prev, stamped];
}

interface ApprovalReq {
  approvalId: string;
  conversationId?: string;
  /** autoApprovable 由主进程按 policy 下发：只有低风险写工具才允许「本会话内不再询问」 */
  items: Array<{ tool?: string; args?: unknown; autoApprovable?: boolean }>;
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
    items: ["我今天有哪些未读邮件", "总结一下 juan@acme.com 发来的询盘邮件", "把未读邮件都总结一下，导出成文件"],
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
    items: ["我现在有几个发信账号能用", "给 ACME 这家公司做个背调", "把 Acme、Beta、Gamma 这三家都背调一遍"],
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
  export_artifact: ["把刚才的内容再导出一份 csv", "继续总结剩下的未读邮件"],
  start_batch_task: ["等结果出来后，给评级最高的那家写封开发信", "发送队列现在什么状态"],
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
  { cmd: "/缺口", desc: "查看助手登记过的能力缺口：/缺口" },
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
  const [configured, setConfigured] = useState(false);
  /** 我方身份是否填全（缺了 AI 只能留 {{占位符}}） */
  const [identityOk, setIdentityOk] = useState(true);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [approval, setApproval] = useState<ApprovalReq | null>(null);
  /** 审批卡上的「本会话内不再询问」勾选（仅低风险写工具可选，外发类永不出现该勾选项） */
  const [rememberApproval, setRememberApproval] = useState(false);
  /** 本会话累计 token（端点回了 usage 才计；没回就整块不显示，不显示 0） */
  const [sessionUsage, setSessionUsage] = useState<{ input: number; output: number } | null>(null);
  /** 回合进行中每秒跳一次，让折叠头的「正在处理 · Xs」动起 */
  const [, setTick] = useState(0);
  /** 排队输入（单槽）：运行中敲的下一条，等本轮 done 后自动发出 */
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  /** 自动发送的竞态守卫：停止/切会话自增，120ms 兑现时发现代数变了就放弃 */
  const flushGenRef = useRef(0);
  /** 页面上下文锚点（#/assistant?ctx=contact:12）：发给模型前由主进程解析成人话注记 */
  const [ctx, setCtx] = useState<string | undefined>(() => readHashParam("ctx"));
  /** 本轮调用过的工具 → 回答结束后生成「接下来可以问」引导 */
  const turnToolsRef = useRef<string[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const turnUserRef = useRef("");
  const turnTextRef = useRef("");
  const followGenRef = useRef(0);
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

  // ── 上翻时给「回到底部」按钮（流式回答期间不打断阅读）──
  /** 真正的滚动元素（Bubble.List 内部列表，也可能是外层容器），谁先报 scroll 就用谁 */
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** 停在上方期间又有新内容长出来 → 按钮加个「新内容」提醒点 */
  const [pendingBelow, setPendingBelow] = useState(false);
  const contentLenRef = useRef(0);

  const trackScroll = (el: HTMLElement | null) => {
    if (!el) return;
    scrollerRef.current = el;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance <= 24;
    setAtBottom(bottom);
    if (bottom) setPendingBelow(false);
  };

  /** 回答在长、但用户不在底部 → 标记有新内容在下方 */
  useEffect(() => {
    const len = messages.reduce((n, m) => n + m.content.length, 0);
    if (!atBottom && len > contentLenRef.current) setPendingBelow(true);
    contentLenRef.current = len;
  }, [messages, atBottom]);

  /** 输入区高度会变（上下文 chip、引导条、命令菜单），按钮位置跟着让位 */
  const inputBoxRef = useRef<HTMLDivElement | null>(null);
  const [jumpBottom, setJumpBottom] = useState(96);
  useEffect(() => {
    const el = inputBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setJumpBottom(el.offsetHeight + 12));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const jumpToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
    setPendingBelow(false);
  };

  // 模式横幅：设置页可热切端点，所以每次进入/切换会话都重新读一次
  const refreshStatus = async () => {
    const r = await window.api.invoke("agent:status") as
      IpcResult<{ configured: boolean; model: string; thinking?: boolean; identityOk?: boolean }>;
    if (r?.success && r.data) {
      setConfigured(r.data.configured); setModel(r.data.model); setThinking(!!r.data.thinking);
      setIdentityOk(r.data.identityOk !== false);
    }
  };
  useEffect(() => { void refreshStatus(); }, []);

  // 心跳只在回合进行中挂着：折叠头的「正在处理 · Xs」靠它一秒一跳
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [sending]);

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
    queuedRef.current = null;   // 排队消息属于上一会话
    setQueued(null);
    flushGenRef.current++;      // 作废可能仍在倒计时的自动发送
    setFollowUps([]);      // 引导条属于上一轮，切会话即失效
    setDoneActions({});    // 动作卡状态不跨会话
    setSessionUsage(null); // token 累计按会话算，切走即清零
    setRememberApproval(false);
    setPendingWrite(null);
    setMessages([]);        // 立即清空，避免旧会话内容滞留
    void refreshStatus();    // 期间可能在设置页换了端点
    if (!id) { setConvLoading(false); return; }
    setConvLoading(true);
    const r = await window.api.invoke("agent:getConversation", id) as
      IpcResult<Array<{ role: string; content: string; toolName?: string; argsJson?: string; resultJson?: string; createdAt?: string }>>;
    if (token !== loadTokenRef.current) return;  // 已切去更新的会话 → 丢弃过期响应
    setMessages(r?.success && r.data
      ? r.data.map(m => {
          if (m.role === "user") return { key: nextKey(), role: "user" as const, content: m.content };
          if (m.role === "error") return { key: nextKey(), role: "ai" as const, content: m.content, error: true };
          if (m.role === "tool") {
            // 审计回放：重建为已完成的工具过程卡（产物/表格/草稿卡由 detail 复活）
            return {
              key: nextKey(), role: "tool" as const, content: "",
              ts: m.createdAt ? Date.parse(m.createdAt.includes("T") ? m.createdAt : `${m.createdAt.replace(" ", "T")}Z`) : undefined,
              chip: {
                kind: "done" as const, tool: m.toolName,
                args: fmtChipArgs(m.argsJson), brief: resultBrief(m.resultJson),
                detail: m.resultJson,
              },
            };
          }
          return { key: nextKey(), role: "ai" as const, content: m.content };
        })
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
      turnTextRef.current += (d.delta ?? "");
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
    const offDone = window.api.on("agent:done", (data) => {
      const u = (data as { usage?: Msg["usage"] } | undefined)?.usage;
      setMessages(prev => {
        const next = prev.map(m => m.streaming ? { ...m, streaming: false, loading: false } : m);
        if (u) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]!.role === "ai") { next[i] = { ...next[i]!, usage: u }; break; }
          }
        }
        return next;
      });
      if (u) {
        setSessionUsage(p => ({
          input: (p?.input ?? 0) + (u.input ?? 0),
          output: (p?.output ?? 0) + (u.output ?? 0),
        }));
      }
      setSending(false);
      // 排队输入：本轮收尾后立即发出下一条（走 sendRef 复用完整入口，稍等 sending 落定）
      const q = queuedRef.current;
      if (q) {
        queuedRef.current = null;
        setQueued(null);
        const gen = flushGenRef.current;
        setTimeout(() => {
          if (gen !== flushGenRef.current) return;   // 期间停止/切会话 → 放弃
          sendRef.current?.(q);
        }, 120);
      }
      // 用本轮真实调用过的工具生成下一步引导（能力连续可感）——规则兜底先出，不空窗
      const used = [...new Set(turnToolsRef.current)];
      setFollowUps(used.length === 0
        ? ["我今天该跟进谁", "总结一下我的未读邮件"]
        : used.slice(0, 2).flatMap(t => FOLLOW_UPS[t] ?? []).slice(0, 3));
      turnToolsRef.current = [];
      // 再异步用 AI 生成「追问」覆盖规则建议（带代数守卫，迟到结果不盖新一轮）
      const gen = followGenRef.current;
      const uText = turnUserRef.current, aText = turnTextRef.current;
      void (async () => {
        if (!aText.trim()) return;
        const r = await window.api.invoke("ai:followUps", { userText: uText, aiText: aText }) as
          { success: boolean; data?: string[] };
        if (gen !== followGenRef.current) return;
        if (r?.success && Array.isArray(r.data) && r.data.length) setFollowUps(r.data.slice(0, 3));
      })();
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
      // 出错不自动发排队消息：让用户看到错误后自己决定下一步
      queuedRef.current = null;
      setQueued(null);
    });
    // 过程行（结构化数据，纯状态行折进 ProcessChain，产物留在 ArtifactBlock）：calling 插入 → done 原地升级
    const offTool = window.api.on("agent:toolCall", (data) => {
      const d = data as { tool?: string; status?: string; args?: string; result?: string; callId?: string };
      setMessages(prev => {
        if (d.status === "reasoning") {
          return insertBeforeStreamingBubble(prev, {
            key: nextKey(), role: "tool", content: "",
            chip: { kind: "reasoning", tool: d.tool, callId: d.callId, detail: d.result },
          });
        }
        if (d.status === "calling") {
          if (d.tool) turnToolsRef.current.push(d.tool);
          return insertBeforeStreamingBubble(prev, {
            key: nextKey(), role: "tool", content: "",
            chip: { kind: "calling", tool: d.tool, callId: d.callId, args: fmtChipArgs(d.args) },
          });
        }
        // done：先按 callId 精确配对（同名连发/并行不会错配），端点没给 callId 时退回同名倒找
        const next = [...prev];
        let idx = d.callId
          ? next.findIndex(m => m.role === "tool" && m.chip?.kind === "calling" && m.chip.callId === d.callId)
          : -1;
        if (idx < 0) {
          for (let i = next.length - 1; i >= 0; i--) {
            const m = next[i]!;
            if (m.role === "tool" && m.chip?.kind === "calling" && m.chip.tool === d.tool) { idx = i; break; }
          }
        }
        if (idx >= 0) {
          const prevChip = next[idx]!.chip!;
          next[idx] = {
            ...next[idx]!, ts: Date.now(),
            chip: { kind: "done", tool: d.tool, callId: d.callId ?? prevChip.callId, args: prevChip.args, brief: resultBrief(d.result), detail: d.result },
          };
        }
        return next;
      });
    });
    // 任务清单快照：一整轮只有一张卡，原地覆盖（切到新一轮才另起一张）
    const offPlan = window.api.on("agent:plan", (data) => {
      const items = (data as { items?: PlanStep[] } | undefined)?.items;
      const steps = Array.isArray(items) ? items : [];
      setMessages(prev => {
        let turnStart = 0;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i]!.role === "user") { turnStart = i + 1; break; }
        }
        let idx = -1;
        for (let i = prev.length - 1; i >= turnStart; i--) {
          if (prev[i]!.plan) { idx = i; break; }
        }
        if (idx < 0) {
          return steps.length
            ? insertBeforeStreamingBubble(prev, { key: nextKey(), role: "tool", content: "", plan: steps })
            : prev;
        }
        if (!steps.length) return prev.filter((_, i) => i !== idx);   // 空快照 → 清单收起
        const next = [...prev];
        next[idx] = { ...next[idx]!, plan: steps };
        return next;
      });
    });
    // 写操作审批：出就地确认卡 + 开一条续跑气泡（续跑增量落到它上面）
    const offApproval = window.api.on("agent:approval", (data) => {
      const d = data as { approvalId?: string; conversationId?: string; items?: ApprovalReq["items"] };
      setApproval({ approvalId: d.approvalId ?? "", conversationId: d.conversationId, items: d.items ?? [] });
      setRememberApproval(false);
      setMessages(prev => [...prev, { key: nextKey(), role: "ai" as const, content: "", loading: true, streaming: true }]);
    });
    return () => { offChunk(); offDone(); offError(); offTool(); offPlan(); offApproval(); };
  }, []);

  /** 实际发起一轮对话（正文 + ctx 锚点） */
  const doSend = async (text: string) => {
    setSending(true);
    setFollowUps([]);
    turnUserRef.current = text;
    turnTextRef.current = "";
    followGenRef.current++;
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

  /** 入口：斜杠命令本地解析（/help、/新对话、/缺口 就地处理，不发起请求） */
  const handleSend = async (raw: string): Promise<void> => {
    const t = raw.trim();
    if (!t) return;
    if (sending) {
      // 排队输入：斜杠命令不排队（语义依赖空闲输入），普通问题单槽排队等本轮结束
      if (t.startsWith("/")) {
        setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: "等这轮回答结束后再使用快捷命令。" }]);
        return;
      }
      queuedRef.current = t;
      setQueued(t);
      return;
    }
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
      if (hit.cmd === "/缺口") {
        const r = await window.api.invoke("agent:listGaps", 20) as IpcResult<
          Array<{ wanted: string; workaround?: string | null; hits: number; lastSeenAt: string }>
        >;
        if (!r?.success) {
          setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: `读取能力缺口失败：${r?.error || "未知错误"}`, error: true }]);
          return;
        }
        const gaps = r.data ?? [];
        const text = gaps.length === 0
          ? "还没有登记过能力缺口 —— 助手碰到做不到的诉求时会自动记在这里，被提到越多的越该优先补。"
          : "已登记的能力缺口（按被抱怨次数）：\n"
            + gaps.map((g, i) => `${i + 1}. ${g.wanted}  ×${g.hits}  ${g.workaround ? `（绕行：${g.workaround}）` : ""}`).join("\n");
        setMessages(prev => [...prev, { key: nextKey(), role: "tool", content: text }]);
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
    setRememberApproval(false);
    queuedRef.current = null;
    setQueued(null);
    if (convIdRef.current) void window.api.invoke("agent:stop", convIdRef.current);
  };

  /** 审批结论回传：成功则等续跑流（DONE 收尾）；失败提示并释放输入 */
  const handleApproval = async (approved: boolean) => {
    if (!approval) return;
    const a = approval;
    setApproval(null);
    // 「不再询问」只在整批同工具且 policy 允许豁免时生效（外发类永不满足条件）
    const tools = [...new Set(a.items.map(i => i.tool ?? ""))];
    const rememberTool = approved && rememberApproval
      && tools.length === 1 && !!tools[0] && a.items.every(i => i.autoApprovable)
      ? tools[0] : undefined;
    setRememberApproval(false);
    const r = await window.api.invoke("agent:resolveApproval", { approvalId: a.approvalId, approved, rememberTool }) as
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

  // ── 渲染派生数据：消息流 → 段（过程折一段、产物与清单各自独立）──────
  const segs = segmentMessages(messages);
  const now = Date.now();
  let lastUserSeg = -1;
  segs.forEach((s, i) => { if (s.type === "msg" && s.m.role === "user") lastUserSeg = i; });
  let liveChainKey: string | null = null;
  if (sending) {
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!;
      if (s.type === "chain" && i > lastUserSeg) { liveChainKey = s.key; break; }
    }
  }
  // 菱形头像只出现在最后一条 AI 消息上（流式期间即正在输出的那条），历史气泡一律无头像
  const tailSeg = segs[segs.length - 1];
  const lastAiKey = tailSeg && tailSeg.type === "msg" && tailSeg.m.role === "ai" ? tailSeg.key : null;

  // 「本会话内不再询问」只对低风险写工具开放（判据由主进程随审批事件下发，前端不复制白名单）
  const approvalTools = [...new Set((approval?.items ?? []).map(i => i.tool ?? ""))];
  const rememberToolName = approvalTools.length === 1 ? approvalTools[0] ?? "" : "";
  const canRememberApproval = !!approval && approval.items.length > 0
    && !!rememberToolName && approval.items.every(i => i.autoApprovable);

  /** 段 → 气泡条目：折叠过程 / 产物卡 / 清单卡 / 回执行 / 带 token 页脚的回答 */
  const toBubbleItem = (seg: Segment) => {
    if (seg.type === "chain") {
      return {
        key: seg.key, role: "tool" as const, content: "",
        messageRender: () => (
          <ProcessChain items={seg.items} live={seg.key === liveChainKey} now={now} />
        ),
      };
    }
    const m = seg.m;
    const base = {
      key: m.key, role: m.role, content: m.content, loading: m.loading,
      className: m.error ? "!bg-transparent [&_.ant-bubble-content]:!bg-red-50 [&_.ant-bubble-content]:!border [&_.ant-bubble-content]:!border-red-200" : undefined,
    };
    if (m.role === "ai") {
      return {
        ...base,
        ...(m.key === lastAiKey ? {
          avatar: {
            icon: <DiamondLogo size={22} state={sending ? "running" : "idle"} />,
            style: { background: "transparent", color: "#1a1a1a", boxShadow: "none" },
          },
        } : {}),
        messageRender: (content: string) => (
          <div>
            <div className="text-[13px] leading-relaxed md-body">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ table: MDTableBlock }}>{mdFixTables(content)}</Markdown>
            </div>
            {m.usage && ((m.usage.input ?? 0) > 0 || (m.usage.output ?? 0) > 0) && (
              <div className="text-[11px] text-gray-300 mt-1">
                本轮 {fmtTokens(m.usage.input ?? 0)} 入 · {fmtTokens(m.usage.output ?? 0)} 出
                {(m.usage.cached ?? 0) > 0 && ` · 缓存命中 ${fmtTokens(m.usage.cached ?? 0)}`}
                {(m.usage.requests ?? 0) > 1 && ` · ${m.usage.requests} 次模型调用`}
              </div>
            )}
          </div>
        ),
      };
    }
    if (m.role === "tool") {
      return {
        ...base,
        messageRender: () => (m.chip
          ? <ArtifactBlock chip={m.chip} done={doneActions} onAction={handleAction} />
          : m.plan
            ? <PlanCard items={m.plan} />
            : (
              <div className="text-[12px] text-gray-400 py-0.5 whitespace-pre-line">
                {m.content}
                {m.link && (
                  <a className="ml-2" onClick={() => { window.location.hash = m.link!.href; }}>{m.link.label}</a>
                )}
              </div>
            )),
      };
    }
    return base;
  };

  return (
    <div className="relative flex flex-col" style={{ height: "calc(100vh - 100px)" }}>
      {/* 页头 */}
      <div className="flex items-center justify-between pb-3">
        <Space>
          <h2 className="text-lg font-bold text-gray-800 m-0">AI 助手</h2>
          <Tag color={configured ? "green" : "red"}>{configured ? (model || "已接入") : "未配置端点"}</Tag>
          {configured && (
            <Tooltip title="在「设置 → 模型与端点」切换端点或思考模式，保存即生效，不用重启">
              <Tag color={thinking ? "blue" : "default"}>{thinking ? "思考中" : "直答"}</Tag>
            </Tooltip>
          )}
          {sessionUsage && ((sessionUsage.input ?? 0) > 0 || (sessionUsage.output ?? 0) > 0) && (
            <Tooltip title="本会话累计 token（端点实测回报值，切会话清零；设置页可看全应用累计）">
              <Tag color="default" className="!text-gray-400">
                {fmtTokens(sessionUsage.input)} 入 · {fmtTokens(sessionUsage.output)} 出
              </Tag>
            </Tooltip>
          )}
        </Space>
      </div>

      {!configured && (
        <Alert
          type="error" showIcon className="mb-2"
          message="未配置模型端点，助手无法回答"
          description="到「设置 → 模型与端点」新增端点（Agnes / DeepSeek / 本地 Ollama / 公司中转 都有模板），填好密钥后点「启用」——保存即生效，不用重启应用。"
          action={
            <Button size="small" onClick={() => { window.location.hash = "#/settings"; }}>
              去设置
            </Button>
          }
        />
      )}

      {configured && !identityOk && (
        <Alert
          type="info" showIcon closable className="mb-2"
          message="助手还不知道你是谁"
          description="「设置 → 发信人身份」里补上自称、我方公司与署名后，它写的邮件就会直接用它落款，而不是留 {{firstName}} {{company}} 这类占位符。"
          action={<Button size="small" onClick={() => { window.location.hash = "#/settings"; }}>去填写</Button>}
        />
      )}

      {/* 消息流 — selectable 豁免全局 user-select:none，允许复制 AI 回复 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto pr-1 selectable"
           onScrollCapture={(e) => trackScroll(e.currentTarget)}>
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
                  icon={r.me ? <UserOutlined /> : <DiamondLogo size={15} state="static" />}
                  style={{ background: r.me ? "#1a1a1a" : "transparent", color: r.me ? "#fff" : "#1a1a1a", flexShrink: 0 }}
                />
                <div style={{ width: r.w }}>
                  <Skeleton active title={false} paragraph={{ rows: r.rows, width: "100%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          // min-h-full 而非 h-full：窗口矮时内容可滚动不裁切，有余量时仍垂直居中
          <div className="min-h-full flex flex-col items-center justify-center gap-5 py-6">
            <div className="text-center">
              <DiamondLogo size={44} state={sending ? "running" : "idle"} className="text-gray-900" />
              <div className="text-base font-semibold text-gray-700 mt-3">Hi，我是 Prospector 助手</div>
              <div className="text-xs text-gray-400 mt-1">已接入运价 / 邮件 / 客户 / 跟进 / 发信 11 项能力，写操作一律先弹确认</div>
            </div>
            {/* 能力面板：把已接入的工具摊开成「能干什么」，点一条即发问 */}
            {/* 窄窗口自动降为单列；宽度富余时三列，字号随视口线性缩放 */}
            <div className="w-full max-w-[min(64rem,92%)] grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {CAPABILITIES.map(g => (
                <div key={g.title} className="border border-gray-100 rounded-lg p-3 bg-white">
                  <div className="text-[clamp(12px,0.55vw+9px,14px)] font-semibold text-gray-800">{g.title}</div>
                  <div className="text-[clamp(10px,0.4vw+8px,12px)] text-gray-400 mb-1.5 leading-snug">{g.cap}</div>
                  {g.items.map(q => (
                    <div
                      key={q}
                      className="text-[clamp(11px,0.45vw+9px,13px)] text-teal-700 hover:bg-teal-50 rounded px-1.5 py-1 -mx-1.5 cursor-pointer truncate"
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
              输入 <code>/</code> 唤出快捷命令 · 多步任务会亮出任务清单 · 写操作先在对话里请你就地确认
            </div>
          </div>
        ) : (
          <Bubble.List
            autoScroll
            onScroll={(e) => trackScroll(e.currentTarget)}
            items={segs.map(toBubbleItem)}
            roles={{
              user: {
                placement: "end",
                avatar: { icon: <UserOutlined />, style: { background: "#1a1a1a" } },
                styles: { content: { background: "#00bfa5", color: "#fff" } },
              },
              ai: {
                placement: "start",
                // 去气泡化：无边框无底色、全宽左对齐（正文由 toBubbleItem 的 md-body 控制排版）
                styles: { content: { background: "transparent", padding: 0, border: "none", maxWidth: "100%", boxShadow: "none", minWidth: 0 } },
                // 头像不放这里（否则每条都挂）：由 toBubbleItem 只给最后一条 AI 消息带 DiamondLogo
                // 等待首包期间（端点延迟可达数秒）用骨架屏代替默认小圆点，观感与会话切换一致
                loadingRender: () => (
                  <div style={{ minWidth: 240, padding: "4px 0" }}>
                    <Skeleton active title={false} paragraph={{ rows: 2, width: ["82%", "56%"] }} />
                  </div>
                ),
                // 正文渲染与本轮 token 页脚由 toBubbleItem 逐条提供（那里能拿到消息级 usage）
              },
              tool: {
                placement: "start",
                // 过程折叠/产物卡/清单卡去气泡化：无边框无底色
                styles: { content: { background: "transparent", padding: 0, border: "none", minWidth: 0 } },
              },
            }}
          />
        )}
        {/* AI 追问：贴在回答内容下方，随对话滚动；无标题，仿 ChatGPT 建议卡片 */}
        {!sending && followUps.length > 0 && messages.length > 0 && (
          <div className="max-w-[720px] flex flex-wrap gap-2 pt-1">
            {followUps.map(f => (
              <button
                key={f}
                type="button"
                onClick={() => void handleSend(f)}
                className="group inline-flex items-center gap-1.5 max-w-full rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-600 hover:border-teal-300 hover:text-teal-700 hover:bg-teal-50/60 transition-colors"
              >
                <span className="truncate">{f}</span>
                <RightOutlined className="!text-[10px] text-gray-300 group-hover:text-teal-500" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 回到底部：仅在上翻时出现；下方还在长内容时带个提醒点 */}
      {!atBottom && (
        <Tooltip title="回到对话底部">
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute right-4 z-10 flex items-center gap-1.5 rounded-full bg-white border border-gray-200 shadow-md px-2.5 text-gray-500 hover:text-teal-600 hover:border-teal-200 transition-colors"
            style={{ bottom: jumpBottom }}
            aria-label="回到对话底部"
          >
            <DownOutlined style={{ fontSize: 11 }} />
            {pendingBelow && <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />}
          </button>
        </Tooltip>
      )}

      {/* 输入区 */}
      <div className="pt-3 relative" ref={inputBoxRef}>
        {/* 写操作就地确认卡（不再用居中弹窗遮挡正在流出的回答） */}
        {approval && (
          <div className="mb-2 max-w-[720px] border border-amber-200 bg-amber-50/70 rounded-lg px-3 py-2.5">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[12.5px] font-medium text-gray-800">
                <LoadingOutlined spin style={{ color: "#faad14" }} className="mr-1.5" />
                助手要执行下面这个写操作
              </span>
              <span className="text-[11px] text-gray-400">确认后才写入</span>
            </div>
            {approval.items.map((it, i) => (
              <ApprovalItem key={i} tool={it.tool} args={it.args} />
            ))}
            {canRememberApproval && (
              <Checkbox
                checked={rememberApproval} onChange={e => setRememberApproval(e.target.checked)}
                className="!text-[12px] !text-gray-500 mt-1"
              >
                本会话内不再询问「{toolLabel(rememberToolName)}」
              </Checkbox>
            )}
            <div className="flex items-center gap-2 mt-2">
              <Button type="primary" size="small" style={{ fontSize: 12 }}
                onClick={() => { void handleApproval(true); }}>确认执行</Button>
              <Button size="small" style={{ fontSize: 12 }}
                onClick={() => { void handleApproval(false); }}>拒绝</Button>
            </div>
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
        {queued && (
          <div className="pb-2">
            <Tag closable color="blue" onClose={() => { queuedRef.current = null; setQueued(null); }}>
              已排队 · {queued.length > 24 ? `${queued.slice(0, 24)}…` : queued} · 回答结束后自动发出
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
          onKeyDown={(e) => {
            // loading 下 Sender 的提交键变停止键；回车改由这里入队排队输入
            if (sending && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const t = inputVal.trim();
              if (t) { setInputVal(""); handleSend(t); }
            }
          }}
        />
      </div>

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
