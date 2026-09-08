import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Avatar, Button, Dropdown, Modal, message, Skeleton, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import {
  UserOutlined, LoadingOutlined, CheckCircleOutlined, ArrowUpOutlined,
  BulbOutlined, DownOutlined, RightOutlined, FileTextOutlined, CloseCircleOutlined, CopyOutlined,
} from "@ant-design/icons";
import { Bubble, Sender, ThoughtChain } from "@ant-design/x";
import type { ThoughtChainItem } from "@ant-design/x";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import remarkGfm from "remark-gfm";
import { DiamondLogo } from "../../components/DiamondLogo";
import {
  markAction, navigate as openConversation,
  nextKey, pushLocal, pushLocalText, resetDraft, resolveApproval as submitApproval, send as sendTurn,
  setBudgetAsk, setCtx as setConvCtx, stop as stopTurn, useActiveConvKey, useConvState, whenIdle,
} from "../../hooks/useAgentTranscript";
import type { ApprovalReq, Msg, PlanStep } from "../../hooks/useAgentTranscript";
import { ensureToolMeta, toolLabelText, useToolMetaVersion } from "../../lib/tool-meta";

// 工具元数据（注册表派生的中文名/追问引导）：模块加载即取，到达后订阅处统一刷新
void ensureToolMeta();

/** IPC 返回的统一包裹形态（结构同 main/errors 的 Result，渲染层本地声明避免跨层 import） */
type IpcResult<T> = { success: boolean; data?: T; error?: string };

/** 工具 → 人话名（过程卡展示用）：唯一事实源在主进程注册表（agent/manifest.ts），
 *  经 agent:toolMeta 取回缓存在 tool-meta；reasoning 是思考伪通道，本地特判即可 */
const toolLabel = (name?: string) => (name === "reasoning" ? "思考" : toolLabelText(name));

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

/** 中间检索类工具：结果卡静默（表格不上屏，只留状态行）——它们是给模型的中间依据，不是回答。
 *  运价/邮件的检索结果一律由模型按规范整理后自己呈现（运价表带来源/发送人/入库时间），
 *  工具原样吐的镜像行上屏只会跟答案打架（实测：模型还会在卡旁边编一版错的汇总表）。 */
const QUIET_TOOLS = new Set(["search_contacts", "quote_search", "inbox_search", "email_read_full", "email_summarize"]);

/** 常见字段中文表头（未收录键原样显示） */
const COL_LABELS: Record<string, string> = {
  podRaw: "目的港", lane: "航线", carrier: "船司", container: "柜型", oceanUsd: "运费USD",
  validFrom: "有效期起", validTo: "有效期止", validityRaw: "有效期", note: "备注", pol: "起运港",
  name: "姓名", email: "邮箱", company: "公司", country: "国家", stage: "阶段", status: "状态", id: "ID",
  fromName: "发件人", fromEmail: "发件邮箱", from: "发件人", subject: "主题", classification: "分类",
  receivedAt: "时间", isRead: "已读", summary: "总结", nextStep: "下一步", rating: "评分",
  reminderAt: "提醒时间", problems: "问题", healthy: "健康数", enabled: "启用数", total: "总数",
  // 公开行情调研明细表（来源 | 数据 | 口径 | 发布/更新 | 可信度 | 链接）
  source: "来源", value: "数据", scope: "口径", published: "发布/更新", credibility: "可信度", url: "链接", info: "船期信息",
};
/** 表格卡里的 ISO 时间转北京时间（存的是 UTC，用户看 +8 的钟点；不转就得自己算） */
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
export function fmtCellTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const day = d.toISOString().slice(0, 10);
  return day === today ? `今天 ${stamp}` : `${day.slice(5)} ${stamp}`;
}
const cellText = (v: unknown): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  const str = String(v);
  return ISO_TS.test(str) ? fmtCellTime(str) : str;
};

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
    <div className="flex w-fit items-center gap-1.5 text-[12px] text-gray-400 mb-1.5">
      <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 11 }} />
      <span>已{toolLabel(chip.tool)}{brief && <span className="text-gray-400"> · {brief}</span>}</span>
    </div>
  );
  // 中间检索类工具（联系人检索等）：结果表不上屏——它们是给模型看的中间依据，
  // 直接渲染成表格会让用户误以为是回答（实测翻车）。过程折叠区内只留状态行。
  if (QUIET_TOOLS.has(chip.tool ?? "")) {
    // 表格静默，但一键入口不能跟着没：「做成客户报价表」「建联系人」「记跟进」这些动作卡保留
    return (
      <div className="py-1">
        {header}
        {actions.length > 0 && <ActionRow actions={actions.slice(0, 2)} done={done} onAction={onAction} />}
      </div>
    );
  }

  if (parsed?.artifact && !rows) {
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
        {parsed?.artifact && <FileCard artifact={parsed.artifact} />}
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
function ProcessChain({ items, live }: { items: Msg[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  // 自跳秒：live 时只重渲染本组件（每秒一次）。此前由页面级 setTick 每秒重渲染整个消息列表，
  // 主线程周期性卡顿把转圈动画拖成掉帧（输入框加载按钮"不丝滑"的根因）。
  const [, setSelfTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setSelfTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const toolSteps = items.filter(m => m.chip?.kind !== "reasoning").length;
  const thinkSteps = items.length - toolSteps;
  const start = items[0]?.ts;
  const end = live ? Date.now() : items.reduce((n, m) => Math.max(n, m.ts ?? 0), 0);
  const spent = start ? fmtSec(end - start) : "";
  const expanded = live || open;

  const label = toolSteps === 0
    ? (thinkSteps ? `已思考 ${spent}`.trim() : "已完成一步")
    : `${live ? "正在处理" : "已处理"} ${toolSteps} 步${spent ? ` · ${spent}` : ""}${thinkSteps ? ` · 含 ${thinkSteps} 次思考` : ""}`;

  const chainItems: ThoughtChainItem[] = items.map(m => {
    const c = m.chip!;
    const brief = (s?: string, n = 90) => (s && s.length > n ? `${s.slice(0, n)}…` : s) ?? "";
    // 长思考只显示尾部：最新一句才是在想的这件事，头部留白没有阅读价值
    const tail = (s?: string, n = 400) => (s && s.length > n ? `…${s.slice(-n)}` : s) ?? "";
    if (c.kind === "reasoning") {
      const growing = !!c.live;
      return {
        key: m.key,
        icon: growing
          ? <LoadingOutlined spin style={{ fontSize: 10, color: "#8c8c8c" }} />
          : <BulbOutlined style={{ fontSize: 10, color: "#bfbfbf" }} />,
        title: <span className="text-[12px] text-gray-500">{growing ? "正在思考" : "思考"}</span>,
        content: (
          <div className="text-[12px] text-gray-400 pl-2 border-l border-gray-200 whitespace-pre-wrap leading-relaxed">
            {growing ? tail(c.detail) : brief(c.detail, 400)}
            {growing && <span className="agent-caret">▍</span>}
          </div>
        ),
        status: growing ? "pending" : "success",
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
    const failed = !!c.failed;
    return {
      key: m.key,
      icon: failed
        ? <CloseCircleOutlined style={{ fontSize: 10, color: "#ff4d4f" }} />
        : <CheckCircleOutlined style={{ fontSize: 10, color: "#52c41a" }} />,
      title: <span className="text-[12px] text-gray-500">{failed ? `${toolLabel(c.tool)}失败` : `已${toolLabel(c.tool)}`}</span>,
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
      status: failed ? "error" : "success",
    };
  });

  return (
    <div className="py-0.5 max-w-[720px]">
      <div
        className={`flex w-fit items-center gap-1.5 text-[12px] text-gray-400 ${live ? "" : "cursor-pointer select-none"}`}
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

/**
 * 新对话「行动建议」流（docs/suggestion-feed-spec.md）：布局与旧版一致（居中大 Logo+标题），
 * 建议区为豆包式「想法气泡」——自然宽度、居中流式排布、3–4 个可点。
 * feed 由主进程本地实时拼装（零模型调用，真实候选不足 3 条时从预备库补齐），
 * 数据事件驱动 suggestions:changed 热更新；每次切换会话回骨架态重新拉（本地毫秒级）。
 * 渲染端只做展示与点击。IPC 失败时用下面这份极简兜底（正常路径主进程自带预备库降级，
 * 这里只防「连 IPC 都不通」的极端情况，不重复维护方法论前缀）。
 */
interface FeedItemDto {
  key: string; text: string; prompt: string;
  tone: "urgent" | "mail" | "intel" | "neutral";
  bucket: "followup" | "mail" | "intel" | "static" | "action";
  href?: string; contactId?: number;
  /** 一键采纳型：点击直接落库（不经模型），规范 docs/mail-action-suggestion-spec.md §4 */
  action?: {
    kind: "addContact" | "markReached"; email: string;
    firstName?: string | null; lastName?: string | null; contactId?: number | null;
  };
}
interface FeedDto { greeting: string; items: FeedItemDto[] }

const FEED_FALLBACK: FeedDto = {
  greeting: "你好。有什么要办的，直接说。",
  items: [
    { key: "fb-rates", text: "查一下运价台账现在覆盖了哪些航线", prompt: "查一下运价台账现在覆盖了哪些航线", tone: "neutral", bucket: "static" },
    { key: "fb-mail", text: "总结一下我的未读邮件", prompt: "总结一下我的未读邮件", tone: "neutral", bucket: "static" },
  ],
};

/** 气泡内的 tone 小圆点（状态色：红=紧急 蓝=邮件 绿=资讯 灰=常规/预备库） */
const TONE_DOT: Record<FeedItemDto["tone"], string> = {
  urgent: "bg-red-400", mail: "bg-sky-400", intel: "bg-emerald-400", neutral: "bg-gray-300",
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
  { cmd: "/调研", desc: "联网调研航线市场行情，如「/调研 上海到桑托斯」", template: a => `调研 ${a || "一条航线"} 的公开市场运价和船期行情，多源核实后给结论并附来源链接和日期` },
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
  /**
   * 回合现场（消息流水 + 回合态）存在模块级 store 里，本组件只是它的一个视图：
   * 换页、切会话、深链跳转都不会把在途气泡弄丢（规范 docs/agent-live-transcript-spec.md）。
   */
  const key = useActiveConvKey();
  const {
    messages, sending, loading: convLoading, approval, budgetAsk,
    sessionUsage, followUps, doneActions, ctx,
  } = useConvState(key);
  // 工具中文名来自注册表（经 agent:toolMeta）：到达后本组件批量刷新一次
  useToolMetaVersion();
  /** 端点是否配好：null = 还没读到（异步 IPC 在路上），此时什么都不提示，避免第一帧闪一条红条 */
  const [configured, setConfigured] = useState<boolean | null>(null);
  /** 我方身份是否填全（缺了 AI 只能留 {{占位符}}） */
  const [identityOk, setIdentityOk] = useState(true);
  const [model, setModel] = useState("");
  /** 已配好的端点清单（模型胶囊点开就地换；只有一份时胶囊退化成纯标签） */
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [inputVal, setInputVal] = useState("");
  /** 动作卡：待确认的写入动作（确认弹窗属于「这一屏」，不进现场） */
  const [pendingWrite, setPendingWrite] = useState<ActionDto | null>(null);
  const [writing, setWriting] = useState(false);
  /**
   * 新对话「行动建议」流。null = 还没拿到（先显示骨架 chip，初值不写死兜底防闪——UI 铁律）；
   * feed 由主进程本地实时拼装，suggestions:changed 事件驱动热更新（规范 docs/suggestion-feed-spec.md）。
   */
  const [feed, setFeed] = useState<FeedDto | null>(null);
  /** 「换一批」页码：数据热更新时归零（新数据来了就重新给最优的一组） */
  const [rotate, setRotate] = useState(0);
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

  /** 用户最近一次手动滚动的时间戳；2 秒内发消息不抢滚动条（正在阅读） */
  const lastUserScrollAtRef = useRef(0);
  /** 程序化滚动豁免窗口：窗口内的 scroll 事件不记为用户手动滚动 */
  const programmaticUntilRef = useRef(0);

  const trackScroll = (el: HTMLElement | null) => {
    if (!el) return;
    scrollerRef.current = el;
    // 程序化滚动（发送跳底/底部跟随/点按钮回底）触发的 scroll 事件不算用户手动滚动，
    // 否则流式跟随的每一帧都会被误记成「用户在滚动」，2 秒免打扰窗口就永远清不掉
    if (Date.now() >= programmaticUntilRef.current) lastUserScrollAtRef.current = Date.now();
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance <= 24;
    setAtBottom(bottom);
    if (bottom) setPendingBelow(false);
  };

  /** 贴底滚动（instant）：先登记程序化窗口再动 scrollTop */
  const stickBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    programmaticUntilRef.current = Date.now() + 80;
    el.scrollTop = el.scrollHeight;
  };

  /** 回答在长、但用户不在底部 → 标记有新内容在下方 */
  useEffect(() => {
    const len = messages.reduce((n, m) => n + m.content.length, 0);
    if (!atBottom && len > contentLenRef.current) setPendingBelow(true);
    contentLenRef.current = len;
  }, [messages, atBottom]);

  /** 底部跟随：人贴着底时内容怎么长都贴着底走；人上翻了就完全不碰滚动条 */
  useEffect(() => {
    if (atBottom) stickBottom();
  }, [messages]);

  /** 切换/回到会话：载入完成后默认落到页面底部（上一屏停在哪不重要，每个会话都从最新消息看起） */
  const jumpedConvRef = useRef<string | null>(null);
  useEffect(() => {
    if (jumpedConvRef.current === key) return;
    if (convLoading || messages.length === 0) return;   // 等载入完成、有内容可滚
    jumpedConvRef.current = key;
    setAtBottom(true);
    stickBottom();
    requestAnimationFrame(stickBottom);                 // 气泡渲染完后再兜一次
    const t = setTimeout(stickBottom, 150);             // 表格/异步气泡撑高后最终归位
    return () => clearTimeout(t);
  }, [key, convLoading, messages]);

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
    // instant：流式输出时内容每帧都在长，smooth 动画追不上增长 → 永远到不了底、跟随接不回来
    programmaticUntilRef.current = Date.now() + 120;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setPendingBelow(false);
  };

  /** 回合结束自动回底：输出期间用户上翻即解除跟随（尊重阅读）；回答收尾后把视图带回最新。
   *  最近 3 秒还在手动滚动 = 正在读别处，不抢（复用免打扰窗口语义）。 */
  useEffect(() => {
    if (sending) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (Date.now() - lastUserScrollAtRef.current < 3000) return;
    programmaticUntilRef.current = Date.now() + 120;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setPendingBelow(false);
  }, [sending]);

  /** 发送时回底：不在底部且最近 2 秒没手动滚过 → 跳到底部等结果（instant，smooth 追不上）；
   *  用户刚滚过（<2s）= 正在阅读，不抢滚动条，只标「下方有新内容」。
   *  此刻用户消息/骨架还没渲染（send 在 store 里 patch），滚一次；
   *  下一帧内容上屏后再滚一次兜底；atBottom 复位后跟随 effect 继续贴底。 */
  const jumpToBottomNow = () => {
    if (Date.now() - lastUserScrollAtRef.current < 2000) return;
    stickBottom();
    setAtBottom(true);
    setPendingBelow(false);
    requestAnimationFrame(stickBottom);
  };

  // 模式横幅：设置页可热切端点，所以每次进入/切换会话都重新读一次。
  // 两条查询并发发出去 —— 串行 await 会把「状态还不知道」的窗口拉长一倍，那段时间够闪一次红条。
  const refreshStatus = async () => {
    const [r, s] = await Promise.all([
      window.api.invoke("agent:status") as Promise<
        IpcResult<{ configured: boolean; model: string; identityOk?: boolean }>>,
      window.api.invoke("ai:endpointStatus") as Promise<IpcResult<{
        activeId: string | null;
        profiles: Array<{ id: string; name: string; baseUrl: string; model: string }>;
        endpoint: { baseUrl: string; model: string };
      }>>,
    ]);
    if (r?.success && r.data) {
      setConfigured(r.data.configured); setModel(r.data.model);
      setIdentityOk(r.data.identityOk !== false);
    } else {
      setConfigured(false);   // 读失败也要落到「未配置」，不能永远停在未知态不提示
    }
    // 生效档案与可选清单：模型胶囊点开用来就地换端点，并标出当前生效那一份
    if (s?.success && s.data) {
      const cut = (u: string) => u.replace(/\/+$/, "");
      const d = s.data;
      const eff = d.activeId
        ?? d.profiles.find(p => cut(p.baseUrl) === cut(d.endpoint.baseUrl) && p.model === d.endpoint.model)?.id
        ?? null;
      setProfiles(d.profiles.map(p => ({ id: p.id, name: p.name, active: p.id === eff })));
    }
  };
  /** 就地换端点：激活即写生效参数并同步进程环境，下一轮对话就用它（不用重启） */
  const switchProfile = async (id: string) => {
    if (profiles.some(p => p.active && p.id === id)) return;
    const r = await window.api.invoke("ai:profileActivate", id) as
      IpcResult<{ configured: boolean; model: string; name: string }>;
    if (!r?.success) { message.error(r?.error || "切换失败"); return; }
    message.success(`已切到「${r.data?.name ?? id}」，立即生效`);
    void refreshStatus();
  };
  useEffect(() => { void refreshStatus(); }, []);

  // 挂载 / hash 变更：把视图指向对应会话的现场（现场本身在 store 里，切页切会话都不丢）
  useEffect(() => {
    const onHash = () => {
      openConversation(readConvFromHash(), readHashParam("ctx"));
      // ?q=…：由「问 AI」入口带来的问题 → 自动发送一次并从 hash 摘掉（刷新不重发）
      const q = readHashParam("q");
      if (q && askedRef.current !== q) {
        askedRef.current = q;
        const c = readHashParam("ctx");
        window.location.hash = c ? `#/assistant?ctx=${encodeURIComponent(c)}` : "#/assistant";
        setTimeout(() => sendRef.current?.(q), 80);
      }
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** 换会话即换一屏：未发送的输入、写入确认弹窗、建议流都不跨会话（回合现场留在 store 里） */
  const viewKeyRef = useRef(key);
  useEffect(() => {
    if (viewKeyRef.current === key) return;
    viewKeyRef.current = key;
    setInputVal("");
    setPendingWrite(null);
    setFeed(null);      // 建议流回骨架态：每次切换都重新拉，本地毫秒级但骨架要在（用户明确要求）
    setRotate(0);
    void refreshStatus();   // 期间可能在设置页换了端点
  }, [key]);

  // 建议流：进空态拉一次（带 ctx 锚点与「换一批」页码）；数据事件驱动 suggestions:changed 就地热更新。
  // 只在真要显示开场气泡时订阅，带历史的会话不该白跑一趟
  const showCards = messages.length === 0 && !convLoading;
  useEffect(() => {
    if (!showCards) return;
    let alive = true;
    const pull = async (rot: number) => {
      const r = await window.api.invoke("agent:suggestions", ctx, rot) as IpcResult<FeedDto>;
      if (alive) setFeed(r?.success && r.data && Array.isArray(r.data.items) ? r.data : FEED_FALLBACK);
    };
    void pull(rotate);
    // 推送是 ctx-less 全局 feed；带锚点的会话收到事件后重拉（置顶在服务端算）
    const off = window.api.on("suggestions:changed", (data) => {
      if (!alive) return;
      setRotate(0);
      if (ctx) { void pull(0); return; }
      if (data && typeof data === "object" && Array.isArray((data as FeedDto).items)) setFeed(data as FeedDto);
    });
    return () => { alive = false; off(); };
  }, [showCards, ctx, rotate]);

  /** 入口：斜杠命令本地解析（/help、/新对话、/缺口 就地处理，不发起请求），其余交给 store 发起回合 */
  const handleSend = async (raw: string): Promise<void> => {
    const t = raw.trim();
    if (!t) return;
    if (sending) {
      // 豆包式插队：生成中来新消息 → 立即打断当前回答（已生成内容保留），紧接着处理新消息。
      // 快捷命令语义依赖空闲输入，不随打断执行。
      if (t.startsWith("/")) { pushLocalText(key, "生成中的回答不被快捷命令打断——等回答结束后再用。"); return; }
      stopTurn(key);
      void (async () => {
        if (!(await whenIdle(key, 3000))) { pushLocalText(key, "上一轮收尾超时，请重发这条消息。"); return; }
        jumpToBottomNow();
        void sendTurn(key, t);
      })();
      return;
    }
    if (t.startsWith("/")) {
      const hit = SLASH_COMMANDS.find(c => t === c.cmd || t.startsWith(`${c.cmd} `));
      if (!hit) { pushLocalText(key, `未知命令 ${t.split(/\s+/)[0]}。${SLASH_HELP}`); return; }
      if (hit.cmd === "/help") { pushLocalText(key, SLASH_HELP); return; }
      if (hit.cmd === "/新对话") { window.location.hash = "#/assistant"; resetDraft(); return; }
      if (hit.cmd === "/缺口") {
        const r = await window.api.invoke("agent:listGaps", 20) as IpcResult<
          Array<{ wanted: string; workaround?: string | null; hits: number; lastSeenAt: string }>
        >;
        if (!r?.success) {
          pushLocal(key, { key: nextKey(), role: "tool", content: `读取能力缺口失败：${r?.error || "未知错误"}`, error: true });
          return;
        }
        const gaps = r.data ?? [];
        pushLocal(key, {
          key: nextKey(), role: "tool",
          content: gaps.length === 0
            ? "还没有登记过能力缺口 —— 助手碰到做不到的诉求时会自动记在这里，被提到越多的越该优先补。"
            : "已登记的能力缺口（按被抱怨次数）：\n"
              + gaps.map((g, i) => `${i + 1}. ${g.wanted}  ×${g.hits}  ${g.workaround ? `（绕行：${g.workaround}）` : ""}`).join("\n"),
        });
        return;
      }
      const arg = t.slice(hit.cmd.length).trim();
      if (!arg && !hit.noArg) { pushLocalText(key, `用法：${hit.desc}`); return; }
      jumpToBottomNow();
      void sendTurn(key, hit.template!(arg));
      return;
    }
    jumpToBottomNow();
    void sendTurn(key, t);
  };
  // 每次渲染同步最新版本，供 hashchange 回调（首帧闭包）调用
  useEffect(() => { sendRef.current = handleSend; });

  /** 输入以 / 开头 → 命令菜单候选（纯可发现性，点击填入，Enter 仍走本地解析） */
  const slashCandidates = inputVal.startsWith("/")
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(inputVal.split(/\s+/)[0]!)).slice(0, 6)
    : [];

  /** 停止只管当前会话：审批卡、请示卡一并收掉（现场本身不动，已生成的内容留着） */
  const handleStop = () => {
    stopTurn(key);
  };

  /** 一键采纳型建议：点击直接落库，不经模型也不再叠确认框（点这一下就是显式授权）。
   *  成功才 dismiss（当天不再提）；失败保留在原位，用户还能再点。
   *  执行后联系人服务会 nudge() → 服务端重算并推 suggestions:changed，气泡就地消失。 */
  const [actionBusy, setActionBusy] = useState<Set<string>>(new Set());
  const applyFeedAction = async (it: FeedItemDto) => {
    const a = it.action;
    if (!a || actionBusy.has(it.key)) return;
    setActionBusy(s => new Set(s).add(it.key));
    try {
      const r = await window.api.invoke("contacts:upsert", {
        email: a.email,
        firstName: a.firstName ?? undefined,
        lastName: a.lastName ?? undefined,
        status: "reached",          // 已触达 = 进跟进列表的开关（crm listPipeline 只筛 status='reached'）
      }) as IpcResult<{ id?: number }>;
      if (!r?.success) { message.error(`没办成：${r?.error || "未知错误"}`); return; }
      await window.api.invoke("agent:dismissSuggestion", it.key);
      const who = [a.firstName, a.lastName].filter(Boolean).join(" ") || a.email;
      message.success(a.kind === "addContact" ? `已把 ${who} 加入联系人，并标为已触达` : `已把 ${who} 标为已触达，在跟进列表里了`);
    } catch (err) {
      message.error(`没办成：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(s => { const n = new Set(s); n.delete(it.key); return n; });
    }
  };

  /** 审批结论交给 store：确认后续跑的增量落到新开的骨架气泡上，done 收尾 */
  const handleApproval = async (approved: boolean) => {
    if (!approval) return;
    await submitApproval(key, approved);
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
      markAction(key, a.id, "失败");
      pushLocalText(key, `${a.label}失败：${r?.error || "未知错误"}`);
      return;
    }
    markAction(key, a.id, "已完成");
    pushLocal(key, {
      key: nextKey(), role: "tool", content: r.data?.message ?? `已${a.label}`,
      ...(r.data?.target ? { link: r.data.target } : {}),
    });
  };

  // ── 渲染派生数据：消息流 → 段（过程折一段、产物与清单各自独立）──────
  const segs = segmentMessages(messages);
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

  /** 段 → 气泡条目：折叠过程 / 产物卡 / 清单卡 / 回执行 / 带 token 页脚的回答 */
  const toBubbleItem = (seg: Segment) => {
    if (seg.type === "chain") {
      return {
        key: seg.key, role: "tool" as const, content: "",
        messageRender: () => (
          <ProcessChain items={seg.items} live={seg.key === liveChainKey} />
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

  /** 复制当前会话为 Markdown 到剪贴板：排查/记录优化期问题用（右上角按钮显式触发，不落盘）。
   *  用户与助手全文 + 工具调用的参数与返回摘要（截断），思考过程不进导出。 */
  const exportChat = async () => {
    const lines: string[] = [];
    const title = (messages.find(m => m.role === "user")?.content || "会话").slice(0, 40).replace(/\s+/g, " ");
    lines.push(`# 会话导出：${title}`, "", `- 导出时间：${new Date().toLocaleString("zh-CN")}`);
    if (model) lines.push(`- 模型：${model}`);
    if (sessionUsage && ((sessionUsage.input ?? 0) > 0 || (sessionUsage.output ?? 0) > 0)) {
      lines.push(`- 会话累计：${sessionUsage.input ?? 0} 入 · ${sessionUsage.output ?? 0} 出`);
    }
    lines.push("");
    for (const m of messages) {
      if (m.role === "user") { lines.push(`## 用户`, "", m.content, ""); continue; }
      if (m.role === "ai") {
        lines.push(`## 助手`, "", m.content, "");
        if (m.usage && ((m.usage.input ?? 0) > 0 || (m.usage.output ?? 0) > 0)) {
          const parts = [`本轮 ${m.usage.input ?? 0} 入 · ${m.usage.output ?? 0} 出`];
          if ((m.usage.cached ?? 0) > 0) parts.push(`缓存命中 ${m.usage.cached}`);
          if ((m.usage.requests ?? 1) > 1) parts.push(`${m.usage.requests} 次模型调用`);
          lines.push(`> ${parts.join(" · ")}`, "");
        }
        continue;
      }
      if (m.chip?.kind === "reasoning" || m.chip?.kind === "calling") continue;
      if (m.chip) {
        const brief = m.chip.brief ? ` · ${m.chip.brief}` : "";
        lines.push(`> 工具${m.chip.failed ? "失败" : "调用"}：${m.chip.tool ?? "?"}${brief}`, "");
        if (m.chip.args) lines.push("<details><summary>参数</summary>", "", "```json", m.chip.args.slice(0, 800), "```", "", "</details>", "");
        if (m.chip.detail) lines.push("<details><summary>返回摘要（截断 3000 字）</summary>", "", "```json", m.chip.detail.slice(0, 3000), "```", "", "</details>", "");
        continue;
      }
      if (m.plan?.length) {
        lines.push(`> 任务清单：${m.plan.map(p => `${p.state === "done" ? "✔" : p.state === "doing" ? "▶" : "○"} ${p.text}`).join("；")}`, "");
        continue;
      }
      lines.push(`> ${m.content}${m.link ? `（${m.link.label}）` : ""}`, "");
    }
    try {
      await window.navigator.clipboard.writeText(lines.join("\n"));
      message.success("聊天记录已复制到剪贴板（Markdown）");
    } catch {
      message.error("复制失败，请重试");
    }
  };

  return (
    <div className="relative group/chat flex flex-col" style={{ height: "calc(100vh - 100px)" }}>
      {/* 右上角导出：hover 才现形（次要操作不常驻）；点击复制到剪贴板，不落盘 */}
      <div className="absolute top-1.5 right-3 z-10 opacity-0 group-hover/chat:opacity-100 hover:!opacity-100 transition-opacity pointer-events-none group-hover/chat:pointer-events-auto">
        <Tooltip title="复制聊天记录到剪贴板（Markdown，含工具调用摘要）">
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={exportChat}
            className="!text-gray-300 hover:!text-gray-600" />
        </Tooltip>
      </div>
      {configured === false && (
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

      {/* 消息流 — selectable 豁免全局 user-select:none，允许复制 AI 回复。
          overflow-x-hidden：会话页禁横向滚动条，宽内容一律在表格卡内横滚（见 global.css 的收缩规则）。
          ref 常驻：此前 scrollerRef 只在首次滚动事件才有值，进会话落底时是 null → 落底空转停在顶头。 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-1 selectable"
           ref={(el) => { if (el) scrollerRef.current = el; }}
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
          // 布局与旧版一致：居中大 Logo + 标题 + 副标题 + 底部提示；
          // 建议区从卡片栅格换成豆包式「想法气泡」：自然宽度、居中流式排布、不排整齐
          // min-h-full 而非 h-full：窗口矮时内容可滚动不裁切，有余量时仍垂直居中
          <div className="min-h-full flex flex-col items-center justify-center gap-5 py-6">
            <div className="text-center">
              <DiamondLogo size={44} state={sending ? "running" : "idle"} className="text-gray-900" />
              <div className="text-base font-semibold text-gray-700 mt-3">Hi，我是 Prospector 助手</div>
              <div className="text-xs text-gray-400 mt-1">已接入运价 / 邮件 / 客户 / 跟进 / 发信 11 项能力，写操作一律先弹确认</div>
            </div>
            <div className="w-full max-w-[min(56rem,92%)] flex flex-col items-center gap-3">
              {feed === null ? (
                // 骨架气泡：每次切换会话都出现（feed 在 [key] effect 里清空），宽度错落与真气泡同款
                <div className="flex flex-wrap justify-center gap-2.5">
                  {[220, 168, 264, 190].map((w, i) => (
                    <div key={i} className="h-[34px] rounded-full border border-gray-100 px-4 flex items-center" style={{ width: w }}>
                      <Skeleton active title={false} paragraph={{ rows: 1, width: "100%" }} />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="text-[13px] text-gray-500 text-center leading-relaxed">{feed.greeting}</div>
                  <div className="group/feed flex flex-wrap justify-center gap-2.5">
                    {feed.items.map((it, i) => (
                      <div
                        key={it.key}
                        className="group/bubble chip-in inline-flex items-center gap-2 max-w-[420px] rounded-full border border-gray-200/80 bg-white pl-3 pr-3.5 py-1.5 cursor-pointer hover:border-teal-300 hover:bg-teal-50/40 transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                        style={{ animationDelay: `${i * 45}ms` }}
                        title={it.text}
                        onClick={() => {
                          if (it.action) { void applyFeedAction(it); return; }   // 一键采纳：直接办，不发起对话
                          void window.api.invoke("agent:dismissSuggestion", it.key);   // 当天不再推荐同一条
                          void handleSend(it.prompt);
                        }}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[it.tone]}${it.tone === "urgent" ? " breathe" : ""}`} />
                        <span className="text-[13px] text-gray-700 truncate">{it.text}</span>
                        {it.action && (
                          <span className="shrink-0 text-[11px] text-teal-600">{actionBusy.has(it.key) ? "处理中…" : "点一下办"}</span>
                        )}
                        {it.href && (
                          <a
                            className="shrink-0 text-[11px] text-gray-400 hover:text-teal-600 opacity-0 group-hover/bubble:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); window.location.hash = it.href!; }}
                          >查看</a>
                        )}
                      </div>
                    ))}
                  </div>
                  {feed.items.length >= 3 && (
                    <button
                      type="button"
                      className="text-[12px] text-gray-400 hover:text-teal-600 opacity-0 group-hover/feed:opacity-100 transition-opacity"
                      onClick={() => setRotate(r => r + 1)}
                    >换一批</button>
                  )}
                </>
              )}
            </div>
            <div className="text-[11px] text-gray-400">
              输入 <code>/</code> 唤出快捷命令 · 多步任务会亮出任务清单 · 写操作先在对话里请你就地确认
            </div>
          </div>
        ) : (
          <Bubble.List
            // autoScroll 不用 antd-x 的：它不认「用户是否在底部」，会跟人抢滚动条；
            // 跟随/跳转统一走上面的 stickBottom + 跟随 effect
            onScroll={(e) => trackScroll(e.currentTarget)}
            items={segs.map(toBubbleItem)}
            roles={{
              user: {
                placement: "end",
                // 无头像（装饰最小化）；气泡用极淡主色底 + 深青字，不再重底白字
                styles: { content: { background: "rgba(0, 191, 165, 0.08)", color: "#0f766e" } },
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
            <Tag closable color="cyan" onClose={() => setConvCtx(key, undefined)}>
              当前上下文 · {ctxLabel(ctx)}（问题将围绕它回答）
            </Tag>
          </div>
        )}
        {budgetAsk && !sending && (
          <div className="mb-2 flex items-center gap-3 max-w-[720px] border border-teal-200 bg-teal-50/60 rounded-lg px-3 py-2">
            <span className="text-[12.5px] text-gray-700 flex-1">这轮先告一段落 — 要接着做的话我随时继续。</span>
            <Button type="primary" size="small" style={{ fontSize: 12 }}
              onClick={() => handleSend("接着把上一条没做完的做完，基于已查到的数据即可，别重复查。")}>接着做</Button>
            <Button size="small" style={{ fontSize: 12 }} onClick={() => setBudgetAsk(key, false)}>先这样</Button>
          </div>
        )}
        <Sender
          value={inputVal}
          onChange={(v) => setInputVal(v)}
          placeholder="问我任何关于运价、邮件、客户、发信的事…（输入 / 看快捷命令）"
          loading={sending}
          onSubmit={(text) => { setInputVal(""); handleSend(text); }}
          onCancel={handleStop}
          actions={(ori, { components }) => {
            // 运行中：上箭头=豆包式插队（立即打断当前回答并处理新消息，与回车同路），
            // 停止独立成键；空闲交还默认按钮
            if (!sending) return ori;
            const { LoadingButton } = components;
            return (
              <div className="flex items-center gap-1.5">
                <Tooltip title="打断当前回答，立即回复这条">
                  <Button type="primary" shape="circle" icon={<ArrowUpOutlined />}
                    disabled={!inputVal.trim()}
                    onClick={() => { const t = inputVal.trim(); if (t) { setInputVal(""); handleSend(t); } }} />
                </Tooltip>
                <Tooltip title="停止本轮">
                  <LoadingButton />
                </Tooltip>
              </div>
            );
          }}
          onKeyDown={(e) => {
            // loading 下 Sender 的提交键变停止键；回车改由这里入队排队输入
            if (sending && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const t = inputVal.trim();
              if (t) { setInputVal(""); handleSend(t); }
            }
          }}
        />
        {/* 聊天框的延伸标签：模型胶囊骑在输入框下沿（白底压住那一小段边线），点一下就切端点 */}
        {/* 容器常驻并占好行高，胶囊本身等状态读到再出现 —— 否则它"从无到有"会把输入区顶一下 */}
        <div className="relative z-10 -mt-1.5 pb-0.5 min-h-[19px] flex items-center gap-1.5 pl-2.5">
          {configured && model && (profiles.length > 1 ? (
            <Dropdown trigger={["click"]} menu={{
              items: profiles.map(p => ({
                key: p.id,
                label: <span>{p.name}{p.active && <span className="text-teal-600 ml-1.5">●</span>}</span>,
              })),
              onClick: ({ key }) => { void switchProfile(String(key)); },
            }}>
              <span className="flex items-center gap-1 h-[19px] px-2 rounded-full border border-gray-200 bg-white text-[11px] leading-none text-gray-500 cursor-pointer transition-colors hover:border-teal-200 hover:text-teal-600 shadow-[0_1px_2px_rgba(0,0,0,0.04)] max-w-[240px]">
                <span className="font-mono truncate" title={model}>{model}</span>
                <DownOutlined style={{ fontSize: 7 }} />
              </span>
            </Dropdown>
          ) : (
            <Tooltip title="当前生效的模型；要多配几个端点就能在这里就地切换">
              <span className="flex items-center h-[19px] px-2 rounded-full border border-gray-200 bg-white text-[11px] leading-none text-gray-400 max-w-[240px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <span className="font-mono truncate" title={model}>{model}</span>
              </span>
            </Tooltip>
          ))}
          {sessionUsage && ((sessionUsage.input ?? 0) > 0 || (sessionUsage.output ?? 0) > 0) && (
            <Tooltip title="本会话累计 token（端点实测回报值；切页切会话都留着，设置页可看全应用累计）">
              <span className="ml-auto shrink-0 font-normal text-[10.5px] text-gray-300 tabular-nums">
                {fmtTokens(sessionUsage.input)} 入 · {fmtTokens(sessionUsage.output)} 出
              </span>
            </Tooltip>
          )}
        </div>
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
