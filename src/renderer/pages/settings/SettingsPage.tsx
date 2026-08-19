import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, Input, InputNumber, Button, message, Table, Modal, Form, Tag, Space,
  Switch, TimePicker, Tooltip, Badge,
} from "antd";
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, RobotOutlined, EditOutlined, DownloadOutlined, SyncOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { RichTextEditor } from "../../components/RichTextEditor";

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
}

interface SendSchedule {
  timeWindowEnabled: boolean; startHour: number; endHour: number;
  companyDelayMinMinutes: number; companyDelayMaxMinutes: number;
  singleRecipDelayMinSeconds: number; singleRecipDelayMaxSeconds: number;
  templateRotateGroups: number; batchSize: number;
  batchPauseMinSeconds: number; batchPauseMaxSeconds: number;
}

interface RuntimeConfig {
  fromName: string;
  bodyName: string;
  signature: string;
  schedule: SendSchedule;
  test: { email: string; company: string; enabled: boolean; dryRun: boolean };
  crm: { followupDays: Record<string, number>; todoAdvanceDays: number; autoArchiveDays: number };
}

// ── 右侧浮动导航分区 ──
const SECTIONS = [
  { id: "sec-general", label: "通用" },
  { id: "sec-mail", label: "邮件发送" },
  { id: "sec-api", label: "API 与服务" },
  { id: "sec-crm", label: "客户跟进" },
  { id: "sec-advanced", label: "高级" },
];

// ── 内联编辑行（点击变输入，自动保存）──
function SettingRow({ label, value, onSave, type = "text", placeholder, required, hint, disabled }: {
  label: string; value: string | number; onSave: (v: string | number) => void;
  type?: "text" | "number"; placeholder?: string; required?: boolean; hint?: string; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (val === String(value ?? "")) return;
    setSaving("saving");
    try {
      await onSave(type === "number" ? Number(val) : val);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 2000);
    } catch { setSaving("error"); setTimeout(() => setSaving("idle"), 2000); }
  };

  return (
    <div className="flex items-center gap-2.5 py-1.5 min-h-[30px] group">
      <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">
        {label}{required && <span className="text-red-500 ml-0.5">·</span>}
      </label>
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          type={type === "number" ? "number" : "text"}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setVal(String(value ?? "")); setEditing(false); }
          }}
          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded outline-none focus:border-teal-400"
        />
      ) : disabled ? (
        <span className="flex-1 text-xs text-gray-300 truncate cursor-not-allowed">
          {value !== null && value !== undefined && value !== "" ? String(value) : "未启用"}
        </span>
      ) : (
        <span
          className="flex-1 text-xs text-gray-700 cursor-pointer px-1 py-0.5 rounded hover:bg-gray-50 truncate"
          onClick={() => setEditing(true)}
        >
          {value !== null && value !== undefined && value !== "" ? String(value) : placeholder || "未设置"}
        </span>
      )}
      {hint && <span className="text-[10px] text-gray-400 whitespace-nowrap">{hint}</span>}
      {saving === "saving" && <span className="text-[11px] text-amber-500 w-4">…</span>}
      {saving === "saved" && <span className="text-[11px] text-green-500 w-4">✓</span>}
      {saving === "error" && <span className="text-[11px] text-red-500 w-4">✗</span>}
    </div>
  );
}

// ── API 密钥行（显示配置状态，点击填新值，写入 .env）──
function ApiKeyRow({ label, name, hint }: { label: string; name: string; hint?: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["ai", "keys"],
    queryFn: () => window.api.invoke("ai:getKeys") as Promise<{
      success: boolean; data?: Record<string, boolean>;
    }>,
  });
  const configured = data?.success ? !!data.data?.[name] : false;

  const save = async () => {
    setSaving("saving");
    try {
      const r = await window.api.invoke("ai:setKey", { name, value: val }) as { success: boolean; error?: string };
      if (r?.success) {
        setSaving("saved");
        setTimeout(() => setSaving("idle"), 1500);
        setEditing(false);
        setVal("");
        qc.invalidateQueries({ queryKey: ["ai", "keys"] });
        message.success(`${label} 已保存`);
      } else {
        message.error(r?.error || "保存失败");
        setSaving("idle");
      }
    } catch { message.error("保存失败"); setSaving("idle"); }
  };

  return (
    <div className="flex items-center gap-2.5 py-1.5 min-h-[30px] group">
      <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">{label}</label>
      {editing ? (
        <>
          <Input.Password size="small" placeholder="粘贴 API Key" value={val}
            onChange={e => setVal(e.target.value)} autoFocus className="flex-1"
            onPressEnter={save}
          />
          <Button size="small" type="primary" loading={saving === "saving"} onClick={save}>保存</Button>
          <Button size="small" onClick={() => { setEditing(false); setVal(""); }}>取消</Button>
        </>
      ) : (
        <>
          <span className="flex-1 text-xs cursor-pointer px-1 py-0.5 rounded hover:bg-gray-50"
            onClick={() => setEditing(true)}
          >
            {configured
              ? <span className="text-green-600">● 已配置</span>
              : <span className="text-gray-400">未配置 — 点击填写</span>}
          </span>
          {hint && <span className="text-[10px] text-gray-400 whitespace-nowrap">{hint}</span>}
          {configured && saving === "saved" && <span className="text-[11px] text-green-500">✓</span>}
        </>
      )}
    </div>
  );
}

// ── 范围输入（min~max 双框，自动保存）──
function RangeRow({ label, min, max, onSaveMin, onSaveMax, hint }: {
  label: string; min: number; max: number;
  onSaveMin: (v: number) => void; onSaveMax: (v: number) => void;
  hint: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editingField, setEditingField] = useState<"min" | "max" | null>(null);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState<"idle" | "saved">("idle");

  const startEdit = (field: "min" | "max") => {
    setEditing(true);
    setEditingField(field);
    setVal(String(field === "min" ? min : max));
  };

  const commit = async () => {
    if (!editingField) return;
    const n = Number(val);
    if (!isNaN(n) && n >= 0) {
      if (editingField === "min") onSaveMin(n);
      else onSaveMax(n);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1500);
    }
    setEditing(false);
    setEditingField(null);
  };

  const displayVal = (v: number) => (editing && editingField === "min" ? val : String(v));

  return (
    <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
      <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">{label}</label>
      <div className="flex-1 flex items-center gap-1 text-xs">
        <input
          value={editingField === "min" ? val : String(min)}
          onChange={e => { if (editingField === "min") setVal(e.target.value); }}
          onFocus={() => startEdit("min")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
        <span className="text-gray-400">~</span>
        <input
          value={editingField === "max" ? val : String(max)}
          onChange={e => { if (editingField === "max") setVal(e.target.value); }}
          onFocus={() => startEdit("max")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
      </div>
      <span className="text-[10px] text-gray-400 whitespace-nowrap">{hint}</span>
      {saving === "saved" && <span className="text-[11px] text-green-500 w-4">✓</span>}
    </div>
  );
}

// ── 分区卡片 ──
function SettingCard({ icon, title, required, children, status }: {
  icon: React.ReactNode; title: string; required?: boolean; children: React.ReactNode; status?: React.ReactNode;
}) {
  return (
    <div className={`border border-gray-200 bg-white ${required ? "border-l-2 border-l-teal-400" : ""}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 flex items-center gap-1.5">
          <span className="opacity-50">{icon}</span> {title}
        </h3>
        <span className="text-[11px]">{status}</span>
      </div>
      <div className="px-4 pt-1 pb-3">{children}</div>
    </div>
  );
}

// ── 版本管理器 ──
interface ReleaseInfo {
  version: string; name: string; publishedAt: string;
  prerelease: boolean; htmlUrl: string; body: string; isCurrent: boolean;
}

interface VersionListData {
  currentVersion: string;
  channel: "stable" | "prerelease";
  releases: ReleaseInfo[];
}

function UpdateChecker() {
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingVersion, setPendingVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [speedInfo, setSpeedInfo] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // 版本列表
  const [versionData, setVersionData] = useState<VersionListData | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [channel, setChannel] = useState<"stable" | "prerelease">("stable");

  // 加载版本列表
  const loadVersions = async () => {
    setLoadingVersions(true);
    try {
      const r = await window.api.invoke("update:listVersions") as {
        success: boolean; data?: VersionListData; error?: string;
      };
      if (r?.success && r.data) {
        setVersionData(r.data);
        setChannel(r.data.channel);
      }
    } catch { /* 静默 */ }
    setLoadingVersions(false);
  };

  // 切换通道
  const handleChannelChange = async (ch: "stable" | "prerelease") => {
    await window.api.invoke("update:setChannel", ch);
    setChannel(ch);
    await loadVersions();
    message.info(`已切换到${ch === "stable" ? "正式版" : "预览版"}通道`);
  };

  useEffect(() => {
    loadVersions();

    // 监听主进程推送的自动更新事件
    const unsub1 = window.api.on("update:available", (data: any) => {
      setPendingVersion(data?.version || "");
      setStatusMsg(`发现新版本 v${data?.version}`);
      loadVersions(); // 刷新列表
    });
    const unsub2 = window.api.on("update:download-progress", (data: any) => {
      setProgress(data?.percent || 0);
      const sizeInfo = data?.total ? `${data.transferred}/${data.total} MB` : `${data.transferred} MB`;
      setSpeedInfo(`${data.percent}% · ${data.speedMB} MB/s · ${sizeInfo}`);
    });
    const unsub3 = window.api.on("update:downloaded", (data: any) => {
      setDownloaded(true);
      setStatusMsg(`v${data?.version} 已下载，重启后生效`);
    });
    const unsub4 = window.api.on("update:error", (data: any) => {
      setStatusMsg(data?.message || "检查失败");
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); unsub4?.(); };
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setStatusMsg("检查中…");
    try {
      const r = await window.api.invoke("update:check") as {
        success: boolean; data?: { version: string; available: boolean } | null; error?: string;
      };
      if (r?.success && r.data?.version) {
        setPendingVersion(r.data.version);
        setStatusMsg(`发现新版本 v${r.data.version}`);
      } else if (r?.success) {
        setStatusMsg("已是最新版本");
        setTimeout(() => setStatusMsg(""), 3000);
      } else {
        setStatusMsg(r?.error || "检查失败");
      }
    } catch (e: any) {
      setStatusMsg(e?.message || "检查失败");
    } finally {
      setChecking(false);
      await loadVersions();
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloaded(false);
    try { await window.api.invoke("update:download"); }
    catch { setStatusMsg("下载失败"); }
    setDownloading(false);
  };

  const handleInstall = async () => {
    await window.api.invoke("update:install");
  };

  const handleDownloadVersion = async (version: string) => {
    setPendingVersion(version);
    await handleDownload();
  };

  const releases = versionData?.releases || [];
  const hasUpdate = pendingVersion && !downloaded;
  const isLatest = !hasUpdate && !downloaded && !!versionData;

  return (
    <div className="space-y-3">
      {/* 当前版本 + 通道切换 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] text-gray-500">
          当前 <strong className="text-gray-800">{versionData?.currentVersion || "—"}</strong>
        </span>
        <span className="text-[10px] text-gray-300">|</span>
        <div className="flex bg-gray-100 rounded p-px">
          <button
            onClick={() => handleChannelChange("stable")}
            className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${channel === "stable" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
          >正式版</button>
          <button
            onClick={() => handleChannelChange("prerelease")}
            className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${channel === "prerelease" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
          >预览版</button>
        </div>
      </div>

      {/* 操作按钮 + 状态 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="small" icon={<SyncOutlined spin={checking} />} loading={checking} onClick={handleCheck}>
          检查更新
        </Button>
        {statusMsg && (
          <span className={`text-xs ${
            statusMsg.includes("发现") || statusMsg.includes("下载")
              ? "text-teal-600"
              : statusMsg.includes("最新") ? "text-green-600"
              : statusMsg.includes("失败") ? "text-red-500"
              : "text-gray-400"
          }`}>{statusMsg}</span>
        )}
        {hasUpdate && (
          <Button size="small" type="primary" loading={downloading} onClick={handleDownload}>
            {downloading ? "下载中…" : `下载 v${pendingVersion}`}
          </Button>
        )}
        {downloaded && (
          <Button size="small" danger onClick={handleInstall}>立即重启安装</Button>
        )}
      </div>

      {/* 进度条 */}
      {downloading && (
        <div className="space-y-1">
          <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
            <div className="h-full bg-teal-500 transition-all duration-300 rounded"
              style={{ width: `${progress || 5}%` }} />
          </div>
          <div className="text-[10px] text-gray-400">{speedInfo || "准备下载…"}</div>
        </div>
      )}

      {/* 版本列表 */}
      <div className="border-t border-gray-100 pt-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            版本历史
          </span>
          <button
            onClick={() => { setExpanded(!expanded); if (!expanded) loadVersions(); }}
            className="text-[10px] text-gray-400 hover:text-gray-600"
          >
            {expanded ? "收起" : `展开 (${releases.length || "…"})`}
          </button>
        </div>

        {expanded && (
          loadingVersions ? (
            <div className="text-[11px] text-gray-400 py-2">加载中…</div>
          ) : releases.length === 0 ? (
            <div className="text-[11px] text-gray-400 py-2">无法获取版本列表</div>
          ) : (
            <div className="space-y-1 max-h-[280px] overflow-y-auto">
              {releases.map((rel, i) => (
                <div key={rel.version}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-[11px] ${
                    rel.isCurrent
                      ? "bg-teal-50 border border-teal-200"
                      : i % 2 === 0 ? "bg-gray-50/50" : ""
                  }`}
                >
                  <span className={`font-mono font-medium w-16 flex-shrink-0 ${rel.isCurrent ? "text-teal-700" : "text-gray-800"}`}>
                    v{rel.version}
                  </span>
                  <Tag color={rel.prerelease ? "orange" : "blue"} className="!m-0 !text-[9px] !leading-none !py-px">
                    {rel.prerelease ? "pre" : "stable"}
                  </Tag>
                  <span className="text-gray-400 flex-1 truncate">
                    {rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString("zh-CN") : ""}
                  </span>
                  {rel.isCurrent ? (
                    <span className="text-[10px] text-teal-600 font-medium">当前</span>
                  ) : (
                    <Button size="small" type="link" className="!text-[10px] !px-1 !py-0"
                      onClick={() => handleDownloadVersion(rel.version)}
                    >下载</Button>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* 自动更新说明 */}
      <div className="text-[10px] text-gray-400 pt-1 border-t border-gray-100">
        启动 10 秒后自动检查，之后每 4 小时轮询 · 有新版本时自动提示
      </div>
    </div>
  );
}

// ── 设置页主组件 ──
export function SettingsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const [activeSection, setActiveSection] = useState("sec-general");

  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: EmailAccount[] }>,
  });

  const { data: configData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{ success: boolean; data?: RuntimeConfig }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("accounts:upsert", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("accounts:delete", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const saveConfigMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); message.success("已保存"); },
  });

  const accounts = accountData?.success ? accountData.data || [] : [];
  const config = configData?.success ? configData.data : null;
  const sched = config?.schedule;

  // 保存 schedule 单个字段
  const saveSched = (patch: Partial<SendSchedule>) => {
    saveConfigMut.mutate({ schedule: { ...sched, ...patch } });
  };

  // 账号熔断状态变化 → 即时刷新账号列表
  useEffect(() => {
    const off = window.api.on("accounts:circuitChanged", () => qc.invalidateQueries({ queryKey: ["accounts"] }));
    return off;
  }, [qc]);

  // 滚动高亮分区 — 找距离视口顶部最近的可见 section
  useEffect(() => {
    const handle = () => {
      let bestId = SECTIONS[0]!.id;
      let bestDist = Infinity;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        // 只考虑顶部在视口内的（上方为负），取绝对值最小的
        const dist = Math.abs(top);
        if (top < window.innerHeight * 0.6 && dist < bestDist) {
          bestDist = dist;
          bestId = s.id;
        }
      }
      setActiveSection(bestId);
    };
    window.addEventListener("scroll", handle, { passive: true });
    handle(); // 初始执行
    return () => window.removeEventListener("scroll", handle);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const accountColumns = [
    { title: "邮箱", dataIndex: "email", key: "email", render: (v: string) => <span className="font-mono text-xs">{v}</span> },
    { title: "SMTP", key: "smtp", render: (_: unknown, r: EmailAccount) => <span className="text-[11px] text-gray-500">{r.smtpHost}:{r.smtpPort}</span> },
    { title: "状态", key: "status", width: 70, render: (_: unknown, r: EmailAccount) => r.consecutiveFails > 0 ? <Tag color="orange">异常</Tag> : <Tag color="green">正常</Tag> },
    {
      title: "操作", key: "actions", width: 120,
      render: (_: unknown, r: EmailAccount) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditingAccount(r);
            form.setFieldsValue({
              displayName: r.displayName,
              smtpHost: r.smtpHost,
              smtpPort: r.smtpPort,
              email: r.email,
              imapHost: r.imapHost,
              imapPort: r.imapPort,
              signature: r.signature,
            });
            setAddOpen(true);
          }}>编辑</Button>
          <Button size="small" icon={<CheckCircleOutlined />} onClick={async () => {
            const res = await window.api.invoke("accounts:validate", r.id) as { success: boolean; data?: { smtpOk: boolean; imapOk: boolean }; error?: string };
            res?.success ? message.info(`SMTP: ${res.data?.smtpOk ? "✓" : "✗"} IMAP: ${res.data?.imapOk ? "✓" : "✗"}`) : message.error(res?.error || "失败");
          }}>测试</Button>
          <Button danger size="small" icon={<DeleteOutlined />} onClick={async () => {
            const res = await deleteMut.mutateAsync(r.id);
            res?.success ? message.success("已删除") : message.error(res?.error || "失败");
          }} />
        </Space>
      ),
    },
  ];

  return (
    <div className="flex gap-8 max-w-2xl mx-auto">
      {/* 主内容 */}
      <div className="flex-1 space-y-8">
        {/* ═══ 通用 ═══ */}
        <div id="sec-general" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">通用</div>
          <SettingCard icon="" title="启动与关闭">
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">关闭窗口时</label>
              <div className="flex bg-gray-100 rounded p-px">
                <button
                  onClick={() => saveConfigMut.mutate({ general: { closeAction: "tray" } })}
                  className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${(config as any)?.general?.closeAction !== "quit" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
                >最小化托盘</button>
                <button
                  onClick={() => saveConfigMut.mutate({ general: { closeAction: "quit" } })}
                  className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${(config as any)?.general?.closeAction === "quit" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
                >直接退出</button>
              </div>
            </div>
          </SettingCard>
          <SettingCard icon="" title="检查更新">
            <UpdateChecker />
          </SettingCard>
        </div>

        {/* ═══ 邮件发送 ═══ */}
        <div id="sec-mail" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">邮件发送</div>

          {/* 发信账号 */}
          <SettingCard icon="" title="发信账号"
            status={<Button size="small" icon={<PlusOutlined />} onClick={() => { setEditingAccount(null); form.resetFields(); setAddOpen(true); }}>+ 添加账号</Button>}
          >
            <Table dataSource={accounts} columns={accountColumns} rowKey="id"
              size="small" pagination={false} locale={{ emptyText: "还没有发信账号" }}
              className="mb-2" />
          </SettingCard>

          {/* 发信限额 */}
          <SettingCard icon="" title="发信限额">
            <div className="text-[10px] text-gray-400 mb-2">
              全局日限额，从首次发送起计时 24h 后自动重置，0=不限制
            </div>
            <SettingRow label="每日上限" value={(config as any)?.sendQuota?.dailyLimit || 0} type="number"
              onSave={v => { const cur = (config as any)?.sendQuota || {}; saveConfigMut.mutate({ sendQuota: { ...cur, dailyLimit: Number(v) } }); }}
              hint="封" />
            {((config as any)?.sendQuota?.firstSendAt) && (
              <div className="text-[10px] text-gray-400 mt-1">
                首次发送: {new Date((config as any).sendQuota.firstSendAt).toLocaleString("zh-CN")} ·
                已发: {(config as any).sendQuota.sentToday || 0} 封 ·
                重置: {new Date(new Date((config as any).sendQuota.firstSendAt).getTime() + 86400000).toLocaleTimeString("zh-CN")}
              </div>
            )}
          </SettingCard>

          {/* 发信人信息 */}
          <SettingCard icon="" title="发信人信息">
            <SettingRow label="发件人名称" value={config?.fromName || ""}
              onSave={v => saveConfigMut.mutate({ fromName: String(v) })}
              placeholder="收件人看到的发件人名称" hint="账号名优先" />
            <SettingRow label="自称" value={config?.bodyName || ""}
              onSave={v => saveConfigMut.mutate({ bodyName: String(v) })}
              placeholder="正文中的自称，如 Zayne" hint="用于正文落款" />
            <SettingRow label="正文署名" value={config?.signature || ""}
              onSave={v => saveConfigMut.mutate({ signature: String(v) })}
              placeholder="邮件正文末尾的署名" />
          </SettingCard>

          {/* 发送规则 — 模拟人工 */}
          <SettingCard icon="" title="发送规则 — 模拟人工">
            {/* 发送时段 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-2 mb-1">发送时段</div>
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">限时发送</label>
              <Switch size="small" checked={sched?.timeWindowEnabled ?? true}
                onChange={v => saveSched({ timeWindowEnabled: v })}
              />
              <span className="text-[10px] text-gray-400">开启后仅在设定时段内发信</span>
            </div>
            <SettingRow label="开始时段" value={sched ? `${String(sched.startHour).padStart(2, "0")}:00` : "09:00"} type="text"
              onSave={v => {
                const h = parseInt(String(v).slice(0, 2), 10);
                if (!isNaN(h) && h >= 0 && h <= 23) saveSched({ startHour: h });
              }} placeholder="北京时，如 09" />
            <SettingRow label="结束时段" value={sched ? `${String(sched.endHour).padStart(2, "0")}:00` : "08:00"} type="text"
              onSave={v => {
                const h = parseInt(String(v).slice(0, 2), 10);
                if (!isNaN(h) && h >= 0 && h <= 23) saveSched({ endHour: h });
              }} placeholder="北京时，次日结束如 08" hint="跨天" />

            {/* 模板引擎 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1">模板引擎</div>
            <SettingRow label="组间轮换" value={sched?.templateRotateGroups ?? 3} type="number"
              onSave={v => saveSched({ templateRotateGroups: Number(v) })} hint="组/换" />

            {/* 发送参数 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1">发送参数</div>
            <SettingRow label="每组人数" value={sched?.batchSize ?? 12} type="number"
              onSave={v => saveSched({ batchSize: Number(v) })} hint="人/组" />
            {sched && (
              <>
                <RangeRow label="公司组间隔" min={sched.companyDelayMinMinutes} max={sched.companyDelayMaxMinutes}
                  onSaveMin={v => saveSched({ companyDelayMinMinutes: v })} onSaveMax={v => saveSched({ companyDelayMaxMinutes: v })}
                  hint="分钟" />
                <RangeRow label="单联系人" min={sched.singleRecipDelayMinSeconds} max={sched.singleRecipDelayMaxSeconds}
                  onSaveMin={v => saveSched({ singleRecipDelayMinSeconds: v })} onSaveMax={v => saveSched({ singleRecipDelayMaxSeconds: v })}
                  hint="秒" />
                <RangeRow label="批间暂停" min={sched.batchPauseMinSeconds} max={sched.batchPauseMaxSeconds}
                  onSaveMin={v => saveSched({ batchPauseMinSeconds: v })} onSaveMax={v => saveSched({ batchPauseMaxSeconds: v })}
                  hint="秒" />
              </>
            )}
          </SettingCard>
        </div>

        {/* ═══ API 与服务 ═══ */}
        <div id="sec-api" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">API 与服务</div>
          <SettingCard icon="" title="API 密钥">
            <ApiKeyRow label="DeepSeek" name="DEEPSEEK_API_KEY" hint="背调 / AI 开发信 / 邮件总结" />
            <ApiKeyRow label="Exa AI" name="EXA_API_KEY" hint="背调搜索源" />
            <ApiKeyRow label="Tavily" name="TAVILY_API_KEY" hint="背调搜索源（备用）" />
            <div className="text-[10px] text-gray-400 pt-1">
              密钥写入项目 <code>.env</code>（已 gitignore），保存后立即生效。
            </div>
          </SettingCard>
          <SettingCard icon="" title="网络代理">
            <SettingRow label="HTTP 代理" value="" onSave={() => {}} type="text" disabled />
          </SettingCard>
        </div>

        {/* ═══ 客户跟进 ═══ */}
        <div id="sec-crm" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">客户跟进</div>
          <SettingCard icon="" title="默认跟进间隔">
            <div className="text-[11px] text-gray-400 mb-2">
              切换阶段后的默认提醒天数，可在 CRM 管线中单独覆盖
            </div>
            {[
              { key: "reaching", label: "触达中" },
              { key: "quoting", label: "报价中" },
              { key: "trial", label: "试单" },
              { key: "cooperating", label: "合作中" },
              { key: "lost", label: "已流失" },
              { key: "other", label: "其他" },
            ].map(stage => (
              <SettingRow key={stage.key}
                label={stage.label}
                value={config?.crm?.followupDays?.[stage.key] ?? 3}
                type="number"
                onSave={v => saveConfigMut.mutate({
                  crm: { ...config?.crm, followupDays: { ...config?.crm?.followupDays, [stage.key]: Number(v) } },
                })}
                hint="天" />
            ))}
          </SettingCard>
          <SettingCard icon="" title="Dashboard 待办">
            <SettingRow label="提前提醒" value={config?.crm?.todoAdvanceDays ?? 2} type="number"
              onSave={v => saveConfigMut.mutate({
                crm: { ...config?.crm, todoAdvanceDays: Number(v) },
              })}
              hint="天" />
            <div className="text-[10px] text-gray-400 mt-1">
              跟进提醒到期前 N 天开始在仪表盘显示
            </div>
          </SettingCard>
          <SettingCard icon="" title="自动归档">
            <SettingRow label="无回复归档" value={config?.crm?.autoArchiveDays ?? 30} type="number"
              onSave={v => saveConfigMut.mutate({
                crm: { ...config?.crm, autoArchiveDays: Number(v) },
              })}
              hint="天" />
            <div className="text-[10px] text-gray-400 mt-1">
              发信后 N 天无回复自动标记为「已流失」，0=禁用
            </div>
          </SettingCard>
        </div>

        {/* ═══ 数据 ═══ */}
        <div className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">数据</div>
          <SettingCard icon="" title="导出数据库">
            <div className="text-[11px] text-gray-400 mb-3">将联系人数据和跟进记录导出为 CSV 文件，可用 Excel 打开。</div>
            <Space>
              <Button size="small" icon={<DownloadOutlined />}
                onClick={async () => {
                  const r = await window.api.invoke("export:contactsToExcel") as { success: boolean; data?: string; error?: string };
                  if (r?.success && r.data) {
                    const blob = new Blob([r.data], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    message.success("导出完成");
                  } else { message.error(r?.error || "导出失败"); }
                }}
              >导出联系人</Button>
              <Button size="small"
                onClick={async () => {
                  const r = await window.api.invoke("export:notesToCsv") as { success: boolean; data?: string; error?: string };
                  if (r?.success && r.data) {
                    const blob = new Blob([r.data], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `跟进记录_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    message.success("导出完成");
                  } else { message.error(r?.error || "导出失败"); }
                }}
              >导出跟进记录</Button>
            </Space>
          </SettingCard>
          <SettingCard icon="" title="数据文件夹">
            <div className="text-[11px] text-gray-400 mb-3">邮件数据库、正文和归档备份都存放在本机数据目录。</div>
            <Space>
              <Button size="small" icon={<FolderOpenOutlined />}
                onClick={async () => {
                  const r = await window.api.invoke("system:openPath", "data") as { success: boolean; error?: string };
                  if (!r?.success) message.error(r?.error || "打开失败");
                }}
              >打开数据目录</Button>
              <Button size="small"
                onClick={async () => {
                  const r = await window.api.invoke("system:openPath", "archive") as { success: boolean; error?: string };
                  if (!r?.success) message.error(r?.error || "打开失败");
                }}
              >定位归档文件</Button>
            </Space>
          </SettingCard>
        </div>

        {/* ═══ 高级 ═══ */}
        <div id="sec-advanced" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">高级</div>
          <SettingCard icon="" title="测试模式">
            <SettingRow label="测试邮箱" value={config?.test?.email || ""}
              onSave={v => saveConfigMut.mutate({ test: { ...config?.test, email: String(v) } })}
              placeholder="test@example.com" />
            <SettingRow label="测试公司" value={config?.test?.company || ""}
              onSave={v => saveConfigMut.mutate({ test: { ...config?.test, company: String(v) } })}
              placeholder="用于测试邮件的公司名" />
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">启用测试</label>
              <Switch size="small" checked={config?.test?.enabled ?? false}
                onChange={v => saveConfigMut.mutate({ test: { ...config?.test, enabled: v } })}
              />
              <span className="text-[10px] text-gray-400">跳过发送时段限制</span>
            </div>
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">发信阻隔</label>
              <Switch size="small" checked={config?.test?.dryRun ?? false}
                onChange={v => saveConfigMut.mutate({ test: { ...config?.test, dryRun: v } })}
              />
              <span className="text-[10px] text-gray-400">流程完整但不实际发送</span>
            </div>
          </SettingCard>
        </div>
      </div>

      {/* 右侧浮动导航轨道 */}
      <nav className="settings-rail hidden lg:block">
        {SECTIONS.map(s => (
          <div key={s.id}
            className={`settings-rail-item ${activeSection === s.id ? "active" : ""}`}
            onClick={() => scrollTo(s.id)}
          >
            <span className="settings-rail-label">{s.label}</span>
            <span className="settings-rail-dot" />
          </div>
        ))}
      </nav>

      {/* 新增/编辑账号弹窗 */}
      <Modal title={editingAccount ? "编辑发信账号" : "发信账号"} open={addOpen} width={460}
        onCancel={() => { setAddOpen(false); setEditingAccount(null); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const payload: Record<string, unknown> = { ...values };
          if (editingAccount) payload.id = editingAccount.id;
          if (!values.password) delete payload.password;
          const result = await upsertMut.mutateAsync(payload);
          if (result && typeof result === "object" && "success" in result) {
            const r = result as { success: boolean; error?: string };
            r.success ? (setAddOpen(false), setEditingAccount(null), form.resetFields(), message.success(editingAccount ? "已更新" : "账号已保存，连接验证通过"))
              : message.error(r.error || "保存失败");
          }
        }}
        confirmLoading={upsertMut.isPending}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="displayName" label="账号名称"><Input placeholder="主账号、备用" /></Form.Item>
          <Form.Item name="smtpHost" label="服务器地址" rules={[{ required: true }]}><Input placeholder="smtp.example.com" /></Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="smtpPort" label="端口" rules={[{ required: true }]} initialValue={465}><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item>
            <Form.Item name="email" label="邮箱地址" rules={[{ required: true, type: "email" }]}><Input placeholder="your@email.com" /></Form.Item>
          </div>
          <Form.Item name="password" label="密码 / 授权码"
            rules={editingAccount ? [] : [{ required: true, message: "新增时密码必填" }]}>
            <Input.Password placeholder={editingAccount ? "留空则不变" : ""} />
          </Form.Item>
          <Form.Item name="imapHost" label="IMAP 服务器"><Input placeholder="自动推导" /></Form.Item>
          <Form.Item name="imapPort" label="IMAP 端口"><InputNumber min={1} max={65535} style={{ width: "100%" }} placeholder="993" /></Form.Item>
          <Form.Item name="signature" label="HTML 签名">
            <RichTextEditor
              placeholder="粘贴签名（支持富文本格式与图片）"
              style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
