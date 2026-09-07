import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Avatar, Button, Checkbox, Dropdown, Modal, message, Skeleton, Table, Tag, Tooltip } from "antd";
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
import {
  clearQueued, enqueue, markAction, navigate as openConversation,
  nextKey, pushLocal, pushLocalText, resetDraft, resolveApproval as submitApproval, send as sendTurn,
  setBudgetAsk, setCtx as setConvCtx, stop as stopTurn, useActiveConvKey, useConvState,
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

/** 中间检索类工具：结果卡静默（表格不上屏，只留状态行）——它们是给模型的中间依据，不是回答 */
const QUIET_TOOLS = new Set(["search_contacts"]);

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
    return <div className="py-1">{header}</div>;
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
 * 能力面板兜底版：主进程的建议还没回来（或没配端点）时显示这份。
 * 六个 title 必须与主进程 suggestion.service 的 GROUP_TITLES 一字不差，
 * prompt 前缀必须与 GROUP_PROMPT 一字不差 —— 卡上显示 text，点击发送 prompt。
 */
const CAPABILITIES: Array<{ title: string; cap: string; items: Array<{ text: string; prompt: string }> }> = [
  {
    title: "查运价", cap: "接入钉钉《海运运价智能台账》本地镜像",
    items: [
      { text: "santos 的价格怎么样", prompt: "在本地运价台账镜像中检索，按目的港、船司、柜型汇总报价并注明有效期；只报台账里真实存在的条目，查不到就明说，不要用市场价或记忆补数。\n检索目标：santos 的价格怎么样" },
      { text: "加勒比线 40HQ 最便宜到多少", prompt: "在本地运价台账镜像中检索，按目的港、船司、柜型汇总报价并注明有效期；只报台账里真实存在的条目，查不到就明说，不要用市场价或记忆补数。\n检索目标：加勒比线 40HQ 最便宜到多少" },
    ],
  },
  {
    title: "看市场行情", cap: "联网多源调研公开运价与船期，逐页核实并标注可信度，出带来源链接的报告",
    items: [
      { text: "上海到桑托斯现在公开市场报多少", prompt: "围绕指定业务目标检索多个可信公开来源，交叉核对信息，整理可用资源、关键结论、发布日期和来源链接。明确标注无法核实或可能过期的信息。\n检索目标：上海到桑托斯现在公开市场报多少" },
      { text: "我们台账上 santos 的价在市场算什么水平", prompt: "围绕指定业务目标检索多个可信公开来源，交叉核对信息，整理可用资源、关键结论、发布日期和来源链接。明确标注无法核实或可能过期的信息。\n检索目标：我们台账上 santos 的价在市场算什么水平" },
    ],
  },
  {
    title: "管邮件", cap: "检索收件箱 + 逐封总结并给下一步建议",
    items: [
      { text: "我今天有哪些未读邮件", prompt: "检索本地收件箱，逐封给出发件人、主题、一句话摘要和下一步建议；需要回复或导出时先给草稿或清单等我确认，不要编造邮件里没有的内容。\n检索目标：我今天有哪些未读邮件" },
      { text: "把未读邮件都总结一下，导出成文件", prompt: "检索本地收件箱，逐封给出发件人、主题、一句话摘要和下一步建议；需要回复或导出时先给草稿或清单等我确认，不要编造邮件里没有的内容。\n检索目标：把未读邮件都总结一下，导出成文件" },
    ],
  },
  {
    title: "跟进客户", cap: "联系人检索 + 今日到期提醒 + 记跟进（写操作需确认）",
    items: [
      { text: "我今天该跟进谁", prompt: "在联系人库与跟进记录里检索，给出匹配对象、最近跟进时间与状态；要写入跟进记录时先把内容给我确认。查不到就明说，不要猜测或张冠李戴。\n检索目标：我今天该跟进谁" },
      { text: "帮我查公司名带「物流」的联系人", prompt: "在联系人库与跟进记录里检索，给出匹配对象、最近跟进时间与状态；要写入跟进记录时先把内容给我确认。查不到就明说，不要猜测或张冠李戴。\n检索目标：帮我查公司名带「物流」的联系人" },
    ],
  },
  {
    title: "准备发信", cap: "写开发信草稿 + 入队（不自动发送，需你在发送中心点开始）",
    items: [
      { text: "给 ACME 的 Juan 写一封西语开发信", prompt: "撰写开发信草稿或查看发送队列状态；草稿先给我过目，只能入队不能自动发送，开始发送必须我自己在发送中心确认。写内容前先查库里的联系人与公司信息。\n检索目标：给 ACME 的 Juan 写一封西语开发信" },
      { text: "发送队列现在还有多少没发出去", prompt: "撰写开发信草稿或查看发送队列状态；草稿先给我过目，只能入队不能自动发送，开始发送必须我自己在发送中心确认。写内容前先查库里的联系人与公司信息。\n检索目标：发送队列现在还有多少没发出去" },
    ],
  },
  {
    title: "账号与公司", cap: "发信账号健康检查 + 公司网络背调",
    items: [
      { text: "我现在有几个发信账号能用", prompt: "检查发信账号的健康状态，或对指定公司做公开网络背调；账号问题给出原因与修复建议，背调只依据可查到的公开信息并标注可信度，查不到的部分明确说查不到。\n检索目标：我现在有几个发信账号能用" },
      { text: "给 ACME 这家公司做个背调", prompt: "检查发信账号的健康状态，或对指定公司做公开网络背调；账号问题给出原因与修复建议，背调只依据可查到的公开信息并标注可信度，查不到的部分明确说查不到。\n检索目标：给 ACME 这家公司做个背调" },
    ],
  },
];

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
    messages, sending, loading: convLoading, approval, budgetAsk, queued,
    sessionUsage, followUps, doneActions, ctx,
  } = useConvState(key);
  // 工具中文名来自注册表（经 agent:toolMeta）：到达后本组件批量刷新一次
  useToolMetaVersion();
  /** 端点是否配好：null = 还没读到（异步 IPC 在路上），此时什么都不提示，避免第一帧闪一条红条 */
  const [configured, setConfigured] = useState<boolean | null>(null);
  /** 我方身份是否填全（缺了 AI 只能留 {{占位符}}） */
  const [identityOk, setIdentityOk] = useState(true);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState(false);
  /** 当前生效的端点档案 id：解析不出（纯手写 .env 且无同名档案）就不给开关，免得按了没反应 */
  const [thinkingProfile, setThinkingProfile] = useState<string | null>(null);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  /** 已配好的端点清单（模型胶囊点开就地换；只有一份时胶囊退化成纯标签） */
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [inputVal, setInputVal] = useState("");
  /** 审批卡上的「本会话内不再询问」勾选（仅低风险写工具可选，外发类永不出现该勾选项） */
  const [rememberApproval, setRememberApproval] = useState(false);
  /** 回合进行中每秒跳一次，让折叠头的「正在处理 · Xs」动起 */
  const [, setTick] = useState(0);
  /** 动作卡：待确认的写入动作（确认弹窗属于「这一屏」，不进现场） */
  const [pendingWrite, setPendingWrite] = useState<ActionDto | null>(null);
  const [writing, setWriting] = useState(false);
  /**
   * 首页「建议行动」六张卡。null = 还没拿到（先显示骨架）；
   * 拿到的是主进程读当天批次、按今天的数字填好槽的结果（纯本地，不等模型）；
   * 万一取失败才落到下面那份写死的兜底 —— 宁可笼统，不空着。
   */
  const [cards, setCards] = useState<typeof CAPABILITIES | null>(null);
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

  /** 发送即回底：不管用户当时停在哪，都跳到底部等结果（instant，smooth 会让人感觉追不上）。
   *  此刻用户消息/骨架还没渲染（send 在 store 里 patch），滚一次；
   *  下一帧内容上屏后再滚一次兜底；atBottom 复位后 autoScroll 继续跟随流式增量。 */
  const jumpToBottomNow = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setPendingBelow(false);
    requestAnimationFrame(() => {
      const el2 = scrollerRef.current;
      if (el2) el2.scrollTop = el2.scrollHeight;
    });
  };

  // 模式横幅：设置页可热切端点，所以每次进入/切换会话都重新读一次。
  // 两条查询并发发出去 —— 串行 await 会把「状态还不知道」的窗口拉长一倍，那段时间够闪一次红条。
  const refreshStatus = async () => {
    const [r, s] = await Promise.all([
      window.api.invoke("agent:status") as Promise<
        IpcResult<{ configured: boolean; model: string; thinking?: boolean; identityOk?: boolean }>>,
      window.api.invoke("ai:endpointStatus") as Promise<IpcResult<{
        activeId: string | null;
        profiles: Array<{ id: string; name: string; baseUrl: string; model: string }>;
        endpoint: { baseUrl: string; model: string };
      }>>,
    ]);
    if (r?.success && r.data) {
      setConfigured(r.data.configured); setModel(r.data.model); setThinking(!!r.data.thinking);
      setIdentityOk(r.data.identityOk !== false);
    } else {
      setConfigured(false);   // 读失败也要落到「未配置」，不能永远停在未知态不提示
    }
    // 生效档案与可选清单：思考开关要落到生效那一份，模型胶囊点开则用来就地换端点
    if (s?.success && s.data) {
      const cut = (u: string) => u.replace(/\/+$/, "");
      const d = s.data;
      const eff = d.activeId
        ?? d.profiles.find(p => cut(p.baseUrl) === cut(d.endpoint.baseUrl) && p.model === d.endpoint.model)?.id
        ?? null;
      setThinkingProfile(eff);
      setProfiles(d.profiles.map(p => ({ id: p.id, name: p.name, active: p.id === eff })));
    }
  };
  /** 就地切思考：写档案 + 同步 .env（生效端点每次现读，不用重启） */
  const toggleThinking = async (on: boolean) => {
    if (!thinkingProfile) return;
    setThinkingBusy(true);
    const r = await window.api.invoke("ai:profileThinking", { id: thinkingProfile, thinking: on }) as
      IpcResult<{ thinking?: boolean }>;
    setThinkingBusy(false);
    if (!r?.success) { message.error(r?.error || "切换失败"); return; }
    void refreshStatus();
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

  // 心跳只在回合进行中挂着：折叠头的「正在处理 · Xs」靠它一秒一跳
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [sending]);

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

  /** 换会话即换一屏：未发送的输入、「不再询问」勾选、写入确认弹窗不跨会话（回合现场留在 store 里） */
  const viewKeyRef = useRef(key);
  useEffect(() => {
    if (viewKeyRef.current === key) return;
    viewKeyRef.current = key;
    setInputVal("");
    setRememberApproval(false);
    setPendingWrite(null);
    void refreshStatus();   // 期间可能在设置页换了端点或切了思考
  }, [key]);

  // 首页「建议行动」：进空态时读当天批次并填上今天的数字（纯本地，毫秒级；拿不到就用写死那份兜底）
  // 只在真要显示六张卡时取，带历史的会话不该白跑一趟
  const showCards = messages.length === 0 && !convLoading;
  useEffect(() => {
    if (!showCards) return;
    let alive = true;
    void (async () => {
      const r = await window.api.invoke("agent:suggestions") as
        IpcResult<Array<{ title: string; cap: string; items: Array<{ text: string; prompt: string }> }>>;
      if (alive) setCards(r?.success && Array.isArray(r.data) && r.data.length ? r.data : CAPABILITIES);
    })();
    return () => { alive = false; };
  }, [showCards]);

  /** 入口：斜杠命令本地解析（/help、/新对话、/缺口 就地处理，不发起请求），其余交给 store 发起回合 */
  const handleSend = async (raw: string): Promise<void> => {
    const t = raw.trim();
    if (!t) return;
    if (sending) {
      // 排队输入：斜杠命令不排队（语义依赖空闲输入），普通问题单槽排队等本轮结束
      if (t.startsWith("/")) { pushLocalText(key, "等这轮回答结束后再使用快捷命令。"); return; }
      enqueue(key, t);
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

  /** 停止只管当前会话：审批卡、排队、请示卡一并收掉（现场本身不动，已生成的内容留着） */
  const handleStop = () => {
    setRememberApproval(false);
    stopTurn(key);
  };

  /** 审批结论交给 store：确认后续跑的增量落到新开的骨架气泡上，done 收尾 */
  const handleApproval = async (approved: boolean) => {
    if (!approval) return;
    // 「不再询问」只在整批同工具且 policy 允许豁免时生效（外发类永不满足条件）
    const tools = [...new Set(approval.items.map(i => i.tool ?? ""))];
    const rememberTool = approved && rememberApproval
      && tools.length === 1 && !!tools[0] && approval.items.every(i => i.autoApprovable)
      ? tools[0] : undefined;
    setRememberApproval(false);
    await submitApproval(key, approved, rememberTool);
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
            {/* 能力面板：标题与分组写死，条目按当前数据现算（AI 版到位后再就地换掉），点一条即发问 */}
            {/* 窄窗口自动降为单列；宽度富余时三列，字号随视口线性缩放 */}
            <div className="w-full max-w-[min(64rem,92%)] grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {cards === null && CAPABILITIES.map(g => (
                // 数据还在路上：先占同款骨架，尺寸与真卡一致，填内容时不推版面
                <div key={g.title} className="border border-gray-100 rounded-lg p-3 bg-white">
                  <div className="text-[13px] font-semibold text-gray-300">{g.title}</div>
                  <Skeleton active title={false} className="mt-1.5" paragraph={{ rows: 2, width: ["78%", "54%"] }} />
                </div>
              ))}
              {cards?.map(g => (
                <div key={g.title} className="border border-gray-100 rounded-lg p-3 bg-white">
                  <div className="text-[clamp(12px,0.55vw+9px,14px)] font-semibold text-gray-800">{g.title}</div>
                  <div className="text-[clamp(10px,0.4vw+8px,12px)] text-gray-400 mb-1.5 leading-snug">{g.cap}</div>
                  {g.items.map(q => (
                    <div
                      key={q.text}
                      className="text-[clamp(11px,0.45vw+9px,13px)] text-teal-700 hover:bg-teal-50 rounded px-1.5 py-1 -mx-1.5 cursor-pointer truncate"
                      title={q.text}
                      onClick={() => void handleSend(q.prompt)}
                    >
                      {q.text}
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
            <Tag closable color="cyan" onClose={() => setConvCtx(key, undefined)}>
              当前上下文 · {ctxLabel(ctx)}（问题将围绕它回答）
            </Tag>
          </div>
        )}
        {queued && (
          <div className="pb-2">
            <Tag closable color="blue" onClose={() => clearQueued(key)}>
              已排队 · {queued.length > 24 ? `${queued.slice(0, 24)}…` : queued} · 回答结束后自动发出
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
          onKeyDown={(e) => {
            // loading 下 Sender 的提交键变停止键；回车改由这里入队排队输入
            if (sending && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const t = inputVal.trim();
              if (t) { setInputVal(""); handleSend(t); }
            }
          }}
        />
        {/* 聊天框的延伸标签：两枚胶囊骑在输入框下沿（白底压住那一小段边线），点一下就切 */}
        {/* 容器常驻并占好行高，胶囊本身等状态读到再出现 —— 否则它们"从无到有"会把输入区顶一下 */}
        <div className="relative z-10 -mt-1.5 pb-0.5 min-h-[19px] flex items-center gap-1.5 pl-2.5">
          {configured && thinkingProfile && (
            <Tooltip title="先想再答：对话里能看到它在想什么；代价是更慢、token 更多">
              <button type="button" disabled={thinkingBusy}
                onClick={() => { void toggleThinking(!thinking); }}
                className={`flex items-center gap-1.5 h-[19px] px-2 rounded-full border bg-white text-[11px] leading-none transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.04)]
                  ${thinking ? "border-teal-300 text-teal-700" : "border-gray-200 text-gray-500 hover:border-teal-200 hover:text-teal-600"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${thinking ? "bg-teal-500" : "bg-gray-300"}`} />
                思考
              </button>
            </Tooltip>
          )}
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
