import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, Input, InputNumber, Button, message, notification, Table, Modal, Form, Tag, Space,
  Switch, TimePicker, Tooltip, Badge, Popconfirm,
} from "antd";
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, RobotOutlined, EditOutlined, DownloadOutlined, SyncOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { RichTextEditor } from "../../components/RichTextEditor";

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
  lastFetchError: string | null; lastFetchAt: string | null; fetchFailCount: number;
}

interface SendSchedule {
  timeWindowEnabled: boolean; startHour: number; endHour: number;
  groupSize: number;
  groupDelayMinSeconds: number; groupDelayMaxSeconds: number;
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
          {configured && (
            <Button size="small" danger type="text"
              onClick={async () => {
                const r = await window.api.invoke("ai:setKey", { name, value: "" }) as { success: boolean; error?: string };
                if (r?.success) { qc.invalidateQueries({ queryKey: ["ai", "keys"] }); message.success(`${label} 已删除`); }
                else message.error(r?.error || "删除失败");
              }}>删除</Button>
          )}
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

function KbDispatchCard() {
  const qc = useQueryClient();
  const { data: cfg } = useQuery({
    queryKey: ["kb", "config"],
    queryFn: () => window.api.invoke("kb:getConfig") as Promise<{
      baseUrl: string; hasToken: boolean; tokenPreview: string; applicationId: string;
    }>,
  });
  const DEFAULT_BASE_URL = "https://kb.iyunquna.com";
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [appId, setAppId] = useState("");
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  // 一键：补默认地址 + 存令牌 → 探针测连通
  const connect = async () => {
    setBusy(true);
    const patch: Record<string, string> = {};
    if (token.trim()) patch.token = token.trim();
    if (!cfg?.baseUrl) patch.baseUrl = baseUrl.trim() || DEFAULT_BASE_URL;
    else if (baseUrl.trim()) patch.baseUrl = baseUrl.trim();
    if (adv && (appId.trim() || cfg?.applicationId)) patch.applicationId = appId.trim();
    if (Object.keys(patch).length) {
      const s = await window.api.invoke("kb:setConfig", patch) as { success: boolean; error?: string };
      if (!s?.success) { setTest({ ok: false, text: s?.error || "保存失败" }); setBusy(false); return; }
      qc.invalidateQueries({ queryKey: ["kb", "config"] });
      setToken("");
    }
    const r = await window.api.invoke("kb:testConnection") as {
      success: boolean; error?: string; data?: { verdict: string; hint: string };
    };
    setTest(r?.success ? { ok: r.data?.verdict === "connected", text: r.data?.hint || "已测试" } : { ok: false, text: r?.error || "测试失败" });
    setBusy(false);
  };

  const status = test
    ? (test.ok ? <Tag color="green">已连通</Tag> : <Tag color="orange">未连通</Tag>)
    : (cfg?.hasToken ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>);

  return (
    <SettingCard icon="" title="KB 中转接口" status={status}>
      <div className="text-[11px] text-gray-400 mb-2">
        填入 KB 测试令牌即可让 Prospector 访问公司内网接口。令牌在 KB「个人中心 → 申请测试令牌」获取，24 小时后需重新申请。
      </div>
      <div className="flex items-center gap-2">
        <span className="w-[72px] text-right text-[11px] text-gray-500 shrink-0">KB 令牌</span>
        <Input.Password size="small" className="flex-1"
          placeholder={cfg?.hasToken ? `已配置 ${cfg.tokenPreview}，留空则不修改` : "粘贴 kbtt_ 开头的令牌"}
          value={token} onChange={e => setToken(e.target.value)} onPressEnter={connect} />
        {cfg?.hasToken && (
          <Button size="small" danger type="text" onClick={async () => {
            await window.api.invoke("kb:setConfig", { token: "" });
            qc.invalidateQueries({ queryKey: ["kb", "config"] }); setTest(null); message.success("令牌已清除");
          }}>清除</Button>
        )}
      </div>
      <div className="flex items-center justify-between mt-2">
        <button className="text-[11px] text-gray-400 hover:text-teal-600" onClick={() => setAdv(v => !v)}>
          {adv ? "收起高级设置" : "高级设置"}
        </button>
        <Button size="small" type="primary" loading={busy} onClick={connect}>保存并测试连接</Button>
      </div>

      {adv && (
        <div className="mt-2 space-y-2 pt-2 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <span className="w-[72px] text-right text-[11px] text-gray-500 shrink-0">KB 地址</span>
            <Input size="small" placeholder={DEFAULT_BASE_URL}
              value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-[72px] text-right text-[11px] text-gray-500 shrink-0">App ID</span>
            <Input size="small" placeholder="生产环境用，可选"
              value={appId} onChange={e => setAppId(e.target.value)} />
          </div>
        </div>
      )}

      {test && (
        <div className={`mt-2 text-[11px] leading-snug px-2 py-1.5 rounded border ${test.ok ? "bg-green-50 border-green-200 text-green-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
          {test.text}
        </div>
      )}
    </SettingCard>
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
                  ) : null}
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
// ── 发信时间预估（设置页展示用，纯函数推导，不落库不参与发送）──
const SEND_OVERHEAD_SEC = 2; // 每组 SMTP 处理耗时近似值

interface SendPlanInput {
  count: number; groupSize: number; delayMin: number; delayMax: number;
  winEnabled: boolean; startHour: number; endHour: number;
}

/** 由发信参数推算：组数/平均速率(封/小时)/窗口小时/纯节奏耗时/预计完成时刻 */
function estimateSendPlan(o: SendPlanInput, now: Date) {
  const groupSize = Math.max(1, Math.floor(o.groupSize) || 1);
  const delayMin = Math.max(0, o.delayMin || 0), delayMax = Math.max(delayMin, o.delayMax || 0);
  const cadence = (delayMin + delayMax) / 2 + SEND_OVERHEAD_SEC; // 相邻两组的平均间隔(秒)
  const groups = Math.ceil(Math.max(0, o.count) / groupSize);
  const activeSec = Math.round(groups * cadence);
  const ratePerHour = cadence > 0 ? (3600 / cadence) * groupSize : 0;
  const rawWin = o.startHour < o.endHour ? o.endHour - o.startHour : 24 - o.startHour + o.endHour;
  const winHours = o.winEnabled && rawWin > 0 ? rawWin : 24;
  const win = o.winEnabled && rawWin > 0;
  const finish = win
    ? advanceWithinWindows(now, activeSec, o.startHour, o.endHour)
    : new Date(now.getTime() + activeSec * 1000);
  return { groups, cadenceSec: cadence, ratePerHour, activeSec, winHours, finish };
}

/** 从 now 起、只在发信窗口内消耗所需时长，推算完成时刻（本机时区=北京时） */
function advanceWithinWindows(from: Date, needSec: number, startH: number, endH: number): Date {
  const cross = startH >= endH; // 跨天窗口（如 21 → 8）
  const inWin = (h: number) => cross ? (h >= startH || h < endH) : (h >= startH && h < endH);
  const secToBoundary = (d: Date) => {
    const elapsed = d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    const h = d.getHours();
    const target = inWin(h) ? (endH <= h && cross ? 24 : endH) : startH; // 目标钟点
    return Math.max(1, (((target * 3600 - elapsed) - h * 3600) % 86400 + 86400) % 86400); // 顺推至该钟点的秒数
  };
  let need = needSec;
  let cur = new Date(from.getTime());
  for (let guard = 0; need > 0 && guard < 2000; guard++) {
    const seg = Math.min(need, secToBoundary(cur));
    cur = new Date(cur.getTime() + seg * 1000);
    need -= seg;
  }
  return cur;
}

const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} 小时${m > 0 ? ` ${m} 分` : ""}` : `${Math.max(1, m)} 分钟`;
};
const fmtFinish = (d: Date) =>
  d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" });

// ── AI 活动记录：agent_tool_calls 审计可视化（谁在什么会话里调了什么工具、写操作是否经人工确认）──
interface ToolCallLog {
  id: number;
  conversationId: string;
  toolName: string;
  sideEffect: string;
  argsPreview: string;
  approval: string;
  error: string | null;
  createdAt: string;
}

const AUDIT_TOOL_LABELS: Record<string, string> = {
  quote_search: "查询运价", search_contacts: "检索联系人", record_followup: "记录跟进",
  inbox_search: "检索邮件", email_summarize: "总结邮件", company_backcheck: "公司背调",
  generate_draft: "撰写开发信", send_queue_add: "加入发信队列",
  queue_status: "发送进度", reminders_due: "到期提醒", accounts_status: "账号健康", reasoning: "思考",
};

function AgentAuditCard() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["agentToolCalls"],
    queryFn: async () => {
      const r = await window.api.invoke("agent:toolCalls", 60) as { success: boolean; data?: ToolCallLog[] };
      return r?.success ? (r.data ?? []) : [];
    },
    refetchInterval: 30_000,
  });

  const approvalTag = (a: string) =>
    a === "approved" ? <Tag color="green">已批准</Tag>
      : a === "rejected" ? <Tag color="red">已拒绝</Tag>
        : <Tag color="default">自动</Tag>;

  const columns = [
    { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 150,
      render: (v: string) => <span className="text-[11px] text-gray-400">{(v || "").replace("T", " ").slice(0, 19)}</span> },
    { title: "工具", dataIndex: "toolName", key: "toolName", width: 110,
      render: (v: string) => AUDIT_TOOL_LABELS[v] || v },
    { title: "副作用", dataIndex: "sideEffect", key: "sideEffect", width: 70,
      render: (v: string) => v === "write" ? <Tag color="orange">写</Tag> : <Tag color="default">读</Tag> },
    { title: "参数摘要", dataIndex: "argsPreview", key: "argsPreview", ellipsis: true,
      render: (v: string) => <span className="text-[11px] text-gray-500">{v || "—"}</span> },
    { title: "确认", dataIndex: "approval", key: "approval", width: 80, render: approvalTag },
    { title: "异常", dataIndex: "error", key: "error", ellipsis: true,
      render: (v: string | null) => v ? <span className="text-[11px] text-red-400">{v}</span> : null },
  ];

  const writes = (data ?? []).filter(d => d.sideEffect === "write").length;
  const errors = (data ?? []).filter(d => d.error).length;

  return (
    <SettingCard icon="" title="AI 活动记录"
      status={errors > 0 ? <Tag color="red">{errors} 条异常</Tag> : undefined}>
      <div className="text-[11px] text-gray-400 mb-2">
        最近 {data?.length ?? 0} 次工具调用（其中写操作 {writes} 次，全部经人工确认）。30 秒自动刷新。
      </div>
      <Table<ToolCallLog>
        dataSource={data ?? []}
        rowKey="id"
        columns={columns}
        size="small"
        loading={isLoading}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        locale={{ emptyText: "暂无记录 — 在「新对话」里让助手查价/查联系人后会出现在这里" }}
      />
      <div className="pt-2">
        <Button size="small" icon={<SyncOutlined spin={isFetching} />} onClick={() => void refetch()}>刷新</Button>
      </div>
    </SettingCard>
  );
}

// ── 模型与端点：多套 profile + 一键热切换 + 真连通性测试 ──────────────
// 密钥只写 .env（后端 provider.service 负责），界面永不回显密钥值。
// 激活即写生效参数并同步 process.env —— 切换后不用重启应用。
interface ProfileDto {
  id: string; name: string; baseUrl: string; model: string; keyEnv: string;
  thinking: boolean; hasKey: boolean; active: boolean;
}
interface EndpointStatus {
  profiles: ProfileDto[];
  activeId: string | null;
  endpoint: { hasBaseUrl: boolean; hasKey: boolean; baseUrl: string; model: string; thinking: boolean; source: string; keyEnv: string };
  mode: "live" | "mock";
}
type TestState = { running?: boolean; ok?: boolean; text?: string };

const ENDPOINT_PRESETS = [
  { label: "Gemini Flash（推荐）", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.7-flash" },
  { label: "Agnes（云端 OpenAI 兼容）", baseUrl: "https://apihub.agnes-ai.com/v1", model: "agnes-2.5-pro-beta" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
  { label: "公司内部中转", baseUrl: "", model: "" },
];

function ProviderCard() {
  const qc = useQueryClient();
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProfileDto | null>(null);
  const [keyFor, setKeyFor] = useState<ProfileDto | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ["ai", "endpoint"],
    queryFn: () => window.api.invoke("ai:endpointStatus") as Promise<{ success: boolean; data?: EndpointStatus }>,
  });
  const st = data?.success ? data.data : null;
  const profiles = st?.profiles ?? [];

  // 只读展示：主进程自动检测到的出网代理状态（探活失败即直连，不阻塞任何功能）
  const { data: proxyData } = useQuery({
    queryKey: ["ai", "proxy"],
    queryFn: () => window.api.invoke("ai:proxyInfo") as Promise<{
      success: boolean; data?: { active: boolean; proxy: string; candidate: string };
    }>,
  });
  const proxy = proxyData?.success ? proxyData.data : null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ai", "endpoint"] });
    qc.invalidateQueries({ queryKey: ["agent", "status"] });
  };

  const runTest = async (p: ProfileDto) => {
    setTestStates(s => ({ ...s, [p.id]: { running: true } }));
    const r = await window.api.invoke("ai:profileTest", p.id) as
      { success: boolean; data?: { ok: boolean; latencyMs: number; error?: string }; error?: string };
    if (!r?.success) { setTestStates(s => ({ ...s, [p.id]: { ok: false, text: r?.error || "测试失败" } })); return; }
    const d = r.data!;
    setTestStates(s => ({
      ...s,
      [p.id]: { ok: d.ok, text: d.ok ? `通 · ${(d.latencyMs / 1000).toFixed(1)}s` : (d.error || "失败") },
    }));
  };

  const openForm = (p: ProfileDto | null) => {
    const preset = ENDPOINT_PRESETS[0] ?? { label: "", baseUrl: "", model: "" };
    setEditing(p);
    form.setFieldsValue(p
      ? { name: p.name, baseUrl: p.baseUrl, model: p.model }
      : { name: "", baseUrl: preset.baseUrl, model: preset.model });
    setFormOpen(true);
  };

  const submitForm = async () => {
    const v = await form.validateFields();
    const r = await window.api.invoke("ai:profileUpsert", { ...(editing ? { id: editing.id } : {}), ...v }) as
      { success: boolean; error?: string };
    if (!r?.success) { message.error(r?.error || "保存失败"); return; }
    message.success(editing ? "端点已更新" : "端点已新增，填密钥后即可启用");
    setFormOpen(false);
    refresh();
  };

  const saveKey = async () => {
    if (!keyFor) return;
    const r = await window.api.invoke("ai:profileKey", { id: keyFor.id, value: keyVal }) as { success: boolean; error?: string };
    if (!r?.success) { message.error(r?.error || "写入失败"); return; }
    message.success(keyVal.trim() ? "密钥已写入 .env" : "密钥已清除");
    setKeyFor(null); setKeyVal("");
    refresh();
  };

  return (
    <SettingCard icon="" title="模型与端点"
      status={st ? <Tag color={st.mode === "live" ? "green" : "orange"}>{st.mode === "live" ? "已接入" : "Mock（未配置端点）"}</Tag> : undefined}>
      <div className="text-[11px] text-gray-500 mb-2 leading-relaxed">
        {st?.activeId
          ? <>当前生效：<b>{profiles.find(p => p.id === st.activeId)?.name ?? st.activeId}</b> · {st.endpoint.baseUrl} · 模型 {st.endpoint.model || "未填"}</>
          : <>尚未激活任何端点。{st?.endpoint.hasBaseUrl && st.endpoint.hasKey
            ? <>正在使用 .env 手写配置（{st.endpoint.baseUrl}），建议「新增端点」后启用，便于随时切换。</>
            : <>对话与背调/开发信/邮件总结都会走这一份配置。</>}</>}
      </div>

      <Table<ProfileDto>
        dataSource={profiles}
        rowKey="id"
        size="small"
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: "还没有端点 — 点下面「新增端点」，或直接用预设模板" }}
        columns={[
          {
            title: "端点", dataIndex: "name", key: "name",
            render: (v: string, r) => (
              <div>
                <span className="text-[12px] font-medium text-gray-800">
                  {r.active && <span className="text-teal-600 mr-1">●</span>}{v}
                </span>
                <div className="text-[11px] text-gray-400 font-mono">{r.baseUrl}</div>
              </div>
            ),
          },
          { title: "模型", dataIndex: "model", key: "model", width: 130,
            render: (v: string) => <span className="text-[11px] font-mono">{v || "—"}</span> },
          { title: "密钥", dataIndex: "hasKey", key: "hasKey", width: 60,
            render: (v: boolean) => v ? <Tag color="green" className="!my-0">已配</Tag> : <Tag className="!my-0">未配</Tag> },
          {
            title: "测试", key: "test", width: 120,
            render: (_: unknown, r) => {
              const t = testStates[r.id];
              return (
                <Space size={4}>
                  <Button size="small" loading={t?.running} onClick={() => void runTest(r)}>测一下</Button>
                  {t && !t.running && (
                    <span className={`text-[11px] ${t.ok ? "text-green-600" : "text-red-500"}`}>{t.text}</span>
                  )}
                </Space>
              );
            },
          },
          {
            title: "操作", key: "ops", width: 210,
            render: (_: unknown, r) => (
              <Space size={2} wrap>
                <Button size="small" type={r.active ? "default" : "primary"} ghost={!r.active} disabled={r.active}
                  onClick={async () => {
                    const res = await window.api.invoke("ai:profileActivate", r.id) as { success: boolean; error?: string };
                    if (res?.success) { message.success(`已切到「${r.name}」，立即生效`); refresh(); }
                    else message.error(res?.error || "切换失败");
                  }}>
                  {r.active ? "使用中" : "启用"}
                </Button>
                <Tooltip title={r.active ? "思考模式影响当前生效端点的首字速度" : "启用后生效"}>
                  <span>
                    <Switch size="small" checked={r.thinking}
                      onChange={async (v) => {
                        await window.api.invoke("ai:profileThinking", { id: r.id, thinking: v });
                        refresh();
                      }} />
                  </span>
                </Tooltip>
                <Button size="small" type="text" onClick={() => { setKeyFor(r); setKeyVal(""); }}>密钥</Button>
                <Button size="small" type="text" onClick={() => openForm(r)}>编辑</Button>
                <Popconfirm title="删除该端点？其 .env 密钥一并清除" onConfirm={async () => {
                  await window.api.invoke("ai:profileDelete", r.id);
                  refresh();
                }}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <div className="pt-2">
        <Space wrap size={8}>
          <Button size="small" icon={<PlusOutlined />} onClick={() => openForm(null)}>新增端点</Button>
          <Tooltip title="主进程的 fetch 不读系统代理，海外端点（Gemini / OpenAI）必须经本地代理才通。这里自动读你系统里配的那个，不做端口扫描，探活成功才用。">
            <span className="text-[11px] text-gray-400">
              出网代理：{proxy?.active
                ? <span className="text-teal-600">已自动启用 {proxy.proxy}</span>
                : proxy?.candidate
                  ? <span className="text-amber-600">检测到 {proxy.candidate} 但未连通（直连中，开启 VPN 后自动跟上）</span>
                  : <span>未检测到（直连中）</span>}
            </span>
          </Tooltip>
          <Button size="small" type="text" onClick={() => qc.invalidateQueries({ queryKey: ["ai", "proxy"] })}>重新探测</Button>
          <span className="text-[10px] text-gray-400">密钥写 <code>.env</code>，不入库；切换即时生效，无需重启</span>
        </Space>
      </div>

      <Modal open={formOpen} title={editing ? "编辑端点" : "新增端点"} okText="保存"
        cancelText="取消" maskClosable={false}
        onOk={submitForm} onCancel={() => setFormOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical" size="small" className="pt-1">
          {!editing && (
            <Form.Item label="快速模板">
              <Space wrap size={4}>
                {ENDPOINT_PRESETS.map(p => (
                  <Tag key={p.label} className="cursor-pointer" onClick={() => form.setFieldsValue({ baseUrl: p.baseUrl, model: p.model })}>
                    {p.label}
                  </Tag>
                ))}
              </Space>
            </Form.Item>
          )}
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "给这个端点起个名" }]}>
            <Input placeholder="如 Agnes 测试档 / 本地 Ollama" />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, pattern: /^https?:\/\//, message: "需以 http(s):// 开头" }]}>
            <Input placeholder="https://xxx/v1" className="!font-mono" />
          </Form.Item>
          <Form.Item name="model" label="模型名" rules={[{ required: true, message: "模型名必填，否则会报 400" }]}>
            <Input placeholder="如 agnes-2.5-pro-beta / deepseek-chat" className="!font-mono" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={!!keyFor} title={`${keyFor?.name ?? ""} · 密钥`} okText="写入 .env" cancelText="取消"
        confirmLoading={false} onOk={saveKey} onCancel={() => setKeyFor(null)} destroyOnClose>
        <div className="text-[11px] text-gray-400 mb-2">
          变量名 <code>{keyFor?.keyEnv}</code>；留空保存即清除。密钥不进数据库、不进对话上下文。
        </div>
        <Input.Password value={keyVal} onChange={e => setKeyVal(e.target.value)} placeholder="sk-…" autoFocus />
      </Modal>

      <div className="mt-3 pt-3 border-t border-gray-100">
        <div className="text-[11px] text-gray-400 mb-1.5">搜索与回落密钥（同样写入 .env，保存即生效）</div>
        <ApiKeyRow label="Exa AI" name="EXA_API_KEY" hint="仅「公司背调」工具使用" />
        <ApiKeyRow label="Tavily" name="TAVILY_API_KEY" hint="背调搜索源（Exa 不可用时备用）" />
        <ApiKeyRow label="DeepSeek" name="DEEPSEEK_API_KEY" hint="回落端点：只有没激活任何模型端点时，背调/开发信/邮件总结才用它" />
      </div>
    </SettingCard>
  );
}

export function SettingsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const [activeSection, setActiveSection] = useState("sec-general");

  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: EmailAccount[] }>,
  });

  // 收信健康度事件驱动刷新：后台每轮抓取成功后账号列表状态实时更新（无需重进设置页）
  useEffect(() => {
    return window.api.on("inbox:health", () => { qc.invalidateQueries({ queryKey: ["accounts"] }); });
  }, [qc]);

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

  // 发送预估的"预计发送 N 封"输入（空 = 默认取日限额，无限额则 1000）
  const [estCount, setEstCount] = useState<number | null>(null);

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
    // 滚动发生在 antd Content 容器（overflow:auto），scroll 不冒泡，需 capture 阶段捕获
    document.addEventListener("scroll", handle, { capture: true, passive: true });
    handle(); // 初始执行
    return () => document.removeEventListener("scroll", handle, { capture: true } as EventListenerOptions);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const accountColumns = [
    { title: "邮箱", dataIndex: "email", key: "email", render: (v: string) => <span className="font-mono text-xs">{v}</span> },
    { title: "SMTP", key: "smtp", render: (_: unknown, r: EmailAccount) => <span className="text-[11px] text-gray-500">{r.smtpHost}:{r.smtpPort}</span> },
    { title: "状态", key: "status", width: 120, render: (_: unknown, r: EmailAccount) => {
      // 发信熔断（consecutiveFails）与收信失败（fetchFailCount）分开呈现
      const sendBad = r.consecutiveFails > 0;
      const recvBad = r.fetchFailCount > 0;
      if (!sendBad && !recvBad) return <Tag color="green">正常</Tag>;
      return (
        <Space size={2}>
          {sendBad && <Tooltip title={`发信连续失败 ${r.consecutiveFails} 次（已熔断）`}><Tag color="orange">发信异常</Tag></Tooltip>}
          {recvBad && (
            <Tooltip title={`连续失败 ${r.fetchFailCount} 次${r.lastFetchAt ? ` · ${new Date(r.lastFetchAt).toLocaleString("zh-CN")}` : ""}：${r.lastFetchError || "收信失败"}`}>
              <Tag color="red">收信异常</Tag>
            </Tooltip>
          )}
        </Space>
      );
    } },
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
          <Button size="small" icon={<CheckCircleOutlined />} loading={testingId === r.id} onClick={async () => {
            setTestingId(r.id);
            try {
              const res = await window.api.invoke("accounts:validate", r.id) as {
                success: boolean;
                data?: { smtpOk: boolean; smtpError?: string; imapOk: boolean; imapError?: string };
                error?: string;
              };
              if (!res?.success || !res.data) { message.error(res?.error || "验证请求失败"); return; }
              const { smtpOk, smtpError, imapOk, imapError } = res.data;
              if (smtpOk && imapOk) {
                message.success(`${r.email} 连接正常（SMTP + IMAP 认证通过）`);
              } else {
                const parts = [
                  !smtpOk && `SMTP ✗ ${smtpError || "失败"}`,
                  !imapOk && `IMAP ✗ ${imapError || "失败"}`,
                ].filter(Boolean).join("；");
                notification.error({
                  message: `${r.email} 连接异常`,
                  description: parts,
                  duration: 8,
                });
              }
            } finally {
              setTestingId(null);
            }
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
    <div className="mx-auto flex w-full max-w-6xl gap-8">
      {/* 主内容 */}
      <div className="min-w-[600px] flex-1 space-y-8">
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

            {/* 发送参数 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1">发送参数</div>
            <SettingRow label="每组人数" value={sched?.groupSize ?? 20} type="number"
              onSave={v => saveSched({ groupSize: Number(v) })} hint="人/组" />
            {sched && (
              <RangeRow label="组间暂停" min={sched.groupDelayMinSeconds} max={sched.groupDelayMaxSeconds}
                onSaveMin={v => saveSched({ groupDelayMinSeconds: v })} onSaveMax={v => saveSched({ groupDelayMaxSeconds: v })}
                hint="秒" />
            )}

            {/* 发送预估 — 由上方参数纯推导，仅供参考（不参与实际发送逻辑） */}
            {sched && (() => {
              const quota = Number((config as unknown as { sendQuota?: { dailyLimit?: number } })?.sendQuota?.dailyLimit) || 0;
              const n = Math.max(1, Math.floor(estCount ?? (quota > 0 ? quota : 1000)));
              const p = estimateSendPlan({
                count: n, groupSize: sched.groupSize,
                delayMin: sched.groupDelayMinSeconds, delayMax: sched.groupDelayMaxSeconds,
                winEnabled: sched.timeWindowEnabled, startHour: sched.startHour, endHour: sched.endHour,
              }, new Date());
              const windowCap = p.ratePerHour * p.winHours;
              const perDay = quota > 0 ? Math.min(windowCap, quota) : windowCap;
              const days = perDay > 0 ? n / perDay : 0;
              return (
                <div className="mt-3 pt-2.5 border-t border-gray-100">
                  <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">发送预估</span>
                    <span>平均约 <b className="text-gray-800">{Math.round(p.ratePerHour)}</b> 封/小时</span>
                    <span className="text-gray-300">·</span>
                    <span>发信窗口 {p.winHours} 小时/天，日产能约 <b className="text-gray-800">{Math.round(perDay)}</b> 封{quota > 0 && quota < windowCap ? "（受日限额封顶）" : ""}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-[11px] text-gray-400">预计发送</span>
                    <InputNumber size="small" min={1} max={999999} controls={false} style={{ width: 92 }}
                      value={estCount ?? (quota > 0 ? quota : 1000)}
                      onChange={v => setEstCount(typeof v === "number" ? v : null)} />
                    <span className="text-[11px] text-gray-500">封 · 分 <b className="text-gray-800">{p.groups}</b> 组</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-[11px] text-gray-500">耗时约 <b className="text-gray-800">{fmtDur(p.activeSec)}</b></span>
                    <span className="text-gray-300">·</span>
                    <span className="text-[11px] text-gray-500">预计 <b className="text-gray-800">{fmtFinish(p.finish)}</b> 完成{days > 1.5 ? `（约 ${Math.ceil(days)} 天）` : ""}</span>
                  </div>
                  <div className="text-[10px] text-gray-300 mt-1.5">按组间暂停均值、每组约 2s 处理耗时、仅在发信窗口内推进推算；实际受网络与服务商响应影响</div>
                </div>
              );
            })()}
          </SettingCard>
        </div>

        {/* ═══ API 与服务 ═══ */}
        <div id="sec-api" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">API 与服务</div>
          <ProviderCard />
          <KbDispatchCard />
          <AgentAuditCard />
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
