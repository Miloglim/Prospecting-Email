import { useState, useEffect } from "react";
import { Button, Card, Checkbox, Tag, message, Progress, Popconfirm, Space, Tabs, Input, Select } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, SendOutlined, StopOutlined, ReloadOutlined } from "@ant-design/icons";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RichTextEditor, HtmlText } from "../../components/RichTextEditor";
import { COUNTRIES } from "../../components/ContactDetail";

const STAGE_LABELS: Record<string, string> = {
  initial: "初次", followup1: "跟进1", followup2: "跟进2", closing: "促单", reactivate: "激活",
};
const CAT_LABELS: Record<string, string> = { direct: "直客", peer: "同行", general: "通用" };

interface TimeBucket {
  key: string; label: string; description: string;
  contacts: unknown[]; count: number;
}

interface PipelineContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  companyName: string | null; country: string | null; assignee: string | null;
  lastFollowupAt: string | null; lastFollowupNote: string | null;
}
interface StageData { key: string; label: string; color: string; contacts: PipelineContact[]; }

interface Template {
  id: number; name: string; language: string; subject: string; body: string;
  category: string | null; stage: string | null; version: number;
}

interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: unknown | null; delaySeconds: number;
  accountStats: Array<{ accountId: number; email: string; sent: number; failed: number; isCircuitOpen: boolean }>;
}

// ── 分栏复选框组件 ──
function BucketColumn({ title, buckets, selected, onToggle, disabled, loading }: {
  title: string;
  buckets: TimeBucket[];
  selected: string[];
  onToggle: (key: string) => void;
  disabled: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex-1 min-w-[150px]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">{title}</div>
      <div className="space-y-0.5">
        {loading ? (
          <div className="text-[11px] text-gray-300 py-2">加载中…</div>
        ) : buckets.length === 0 ? (
          <div className="text-[11px] text-gray-300 py-2">暂无数据</div>
        ) : (
          buckets.map(b => {
            const sel = selected.includes(b.key);
            const isReached = b.key === "reached"; // 已触达不可选（跟进走客户跟进界面）
            return (
              <label key={b.key}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors
                  ${sel ? "bg-blue-50" : "hover:bg-gray-50"}
                  ${disabled || isReached ? "opacity-50 pointer-events-none" : ""}`}
              >
                <Checkbox checked={sel} onChange={() => onToggle(b.key)} disabled={disabled || isReached} />
                <span className="flex-1 text-xs text-gray-700">{b.label}</span>
                <span className="text-[11px] text-gray-400 tabular-nums">{b.count}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

export function CampaignList() {
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);
  const [sendMode, setSendMode] = useState<string>("mine");
  const [instantSubject, setInstantSubject] = useState("");
  const [instantBody, setInstantBody] = useState("");
  const [dynCountries, setDynCountries] = useState<string[]>([]);
  const [dynUnchecked, setDynUnchecked] = useState<Set<number>>(new Set());
  const [dynSubject, setDynSubject] = useState("");
  const [dynBody, setDynBody] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();

  // 动态更新：客户跟进（CRM reached）联系人
  const { data: pipelineData } = useQuery({
    queryKey: ["crm", "pipeline"],
    queryFn: () => window.api.invoke("crm:listPipeline") as Promise<{ success: boolean; data?: StageData[] }>,
    enabled: sendMode === "dynamic",
  });

  const { data: statusBuckets, isLoading: sbLoading } = useQuery({
    queryKey: ["send", "statusBuckets"],
    queryFn: () => window.api.invoke("send:getTimeBuckets") as Promise<{ success: boolean; data?: TimeBucket[] }>,
    staleTime: 60_000,
  });
  const { data: stageBuckets, isLoading: gbLoading } = useQuery({
    queryKey: ["send", "stageBuckets"],
    queryFn: () => window.api.invoke("send:getStageBuckets") as Promise<{ success: boolean; data?: TimeBucket[] }>,
    staleTime: 60_000,
  });
  const { data: sendTimeBuckets, isLoading: tbLoading } = useQuery({
    queryKey: ["send", "sendTimeBuckets"],
    queryFn: () => window.api.invoke("send:getSendTimeBuckets") as Promise<{ success: boolean; data?: TimeBucket[] }>,
    staleTime: 60_000,
  });

  const { data: templateData } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{ success: boolean; data?: Template[] }>,
  });

  const { data: statusData } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{ success: boolean; data?: SendStatus }>,
    refetchInterval: 3000,
  });

  const { data: accountsData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: Array<{ id: number; email: string }> }>,
  });

  const { data: configData } = useQuery({
    queryKey: ["config"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{
      success: boolean; data?: { schedule: { timeWindowEnabled: boolean; startHour: number; endHour: number;
        groupSize: number; groupDelayMinSeconds: number; groupDelayMaxSeconds: number; };
        sendQuota?: { dailyLimit: number; firstSendAt: string | null; sentToday: number };
        signature?: string };
    }>,
  });

  const { data: quotaData } = useQuery({
    queryKey: ["send", "quota"],
    queryFn: () => window.api.invoke("send:getQuota") as Promise<{ success: boolean; data?: { ok: boolean; remaining: number; reason?: string } }>,
    refetchInterval: 30000,
  });

  const startMut = useMutation({
    mutationFn: (payload: { keys: string[]; templates?: Array<{ subject: string; body: string }> }) =>
      window.api.invoke("send:start", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["send"] }),
  });

  const status = statusData?.success ? statusData.data : null;
  const isRunning = status?.isRunning || false;
  const isPaused = status?.isPaused || false;
  const sList = statusBuckets?.success ? statusBuckets.data || [] : [];
  const gList = stageBuckets?.success ? stageBuckets.data || [] : [];
  const tList = sendTimeBuckets?.success ? sendTimeBuckets.data || [] : [];
  const templates = templateData?.success ? templateData.data || [] : [];
  const accounts = accountsData?.success ? accountsData.data || [] : [];
  const sched = configData?.success ? configData.data?.schedule : null;
  const signature = configData?.success ? (configData.data?.signature || "") : "";

  // 动态更新：客户跟进联系人 + 国家去重
  const pipelineContacts: PipelineContact[] = pipelineData?.success
    ? (pipelineData.data || []).flatMap(s => s.contacts)
    : [];
  const dynAvailableCountries = [...new Set(pipelineContacts.map(c => c.country).filter((x): x is string => !!x))].sort();
  const dynFilteredContacts = dynCountries.length === 0
    ? []
    : pipelineContacts.filter(c => c.country && dynCountries.includes(c.country));
  const dynSelectedCount = dynFilteredContacts.filter(c => !dynUnchecked.has(c.id)).length;

  const handleDynamicSend = async () => {
    const ids = dynFilteredContacts.filter(c => !dynUnchecked.has(c.id)).map(c => c.id);
    if (ids.length === 0) { message.warning("请选择联系人"); return; }
    if (!dynSubject.trim()) { message.warning("请填写主题"); return; }
    if (!dynBody.trim()) { message.warning("请填写正文"); return; }
    const r = await window.api.invoke("send:dynamic", { contactIds: ids, subject: dynSubject, body: dynBody }) as { success: boolean; error?: string };
    r?.success ? (message.success(`开始发送 ${ids.length} 人`), navigate({ to: "/queue" })) : message.error(r?.error || "启动失败");
  };

  // 合并三个维度的所有 key，取并集统计人数（去重由后端 buildQueue 处理）
  const toggleBucket = (key: string) => {
    if (key === "reached") return; // 已触达不可选
    setSelectedBuckets(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  // 估算选中人数：三个维度中匹配的 contact ids 取并集，受限于配额
  const allBuckets = [...sList, ...gList, ...tList];
  const allSelectedContacts = new Set<number>();
  for (const b of allBuckets) {
    if (selectedBuckets.includes(b.key)) {
      for (const c of b.contacts as Array<{ id: number }>) allSelectedContacts.add(c.id);
    }
  }
  const rawCount = allSelectedContacts.size;
  const quotaRemaining = quotaData?.success ? quotaData.data?.remaining ?? -1 : -1;
  const selectedCount = quotaRemaining >= 0 ? Math.min(rawCount, quotaRemaining) : rawCount;

  useEffect(() => {
    const off = window.api.on("send:progress", () => qc.invalidateQueries({ queryKey: ["send"] }));
    return off;
  }, [qc]);

  const handleStart = async () => {
    const payload: Record<string, unknown> = { keys: selectedBuckets };
    if (sendMode === "mine") {
      const allTpls = templates.map(t => ({ subject: t.subject, body: t.body, category: t.category, stage: t.stage, language: t.language }));
      if (allTpls.length === 0) { message.warning("没有可用模板"); return; }
      payload.templates = allTpls;
    } else if (sendMode === "instant") {
      payload.templates = [{ subject: instantSubject, body: instantBody }];
    }
    const r = await startMut.mutateAsync(payload as { keys: string[]; templates?: Array<{ subject: string; body: string }> });
    if (r && typeof r === "object" && "success" in r) {
      const rr = r as { success: boolean; error?: string };
      rr.success
        ? (message.success(`开始发送 ${selectedCount} 人`), navigate({ to: "/queue" }))
        : message.error(rr.error || "启动失败");
    }
  };

  return (
    <div className="space-y-4">
      {/* ── 发送状态条 ── */}
      {isRunning && (
        <Card size="small">
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <Tag color={isPaused ? "orange" : "green"}>{isPaused ? "已暂停" : "发送中"}</Tag>
              <span>{status?.sentCount || 0} / {status?.totalItems || 0} 组{status?.failedCount ? `（${status.failedCount} 失败）` : ""}</span>
              {status?.delaySeconds ? <span className="text-gray-400">间隔: {status.delaySeconds}s</span> : null}
            </div>
            <Progress percent={status?.totalItems ? Math.round((status.sentCount + status.failedCount) / status.totalItems * 100) : 0}
              status={status?.failedCount ? "exception" : "active"} size="small" />
            <Space>
              <Button size="small" icon={isPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                onClick={() => { window.api.invoke(isPaused ? "send:resume" : "send:pause"); qc.invalidateQueries({ queryKey: ["send"] }); }}>
                {isPaused ? "恢复" : "暂停"}</Button>
              <Popconfirm title="取消后已发保留，未发丢弃" onConfirm={async () => {
                await window.api.invoke("send:cancel"); qc.invalidateQueries({ queryKey: ["send"] });
              }}>
                <Button size="small" danger icon={<StopOutlined />}>取消</Button>
              </Popconfirm>
              <Button size="small" type="link" onClick={() => navigate({ to: "/queue" })}>查看队列 →</Button>
            </Space>
          </div>
        </Card>
      )}

      {/* ── ① 发送模式 ── */}
      <Card size="small" title={<span className="text-xs font-semibold text-gray-600">发送模式</span>}>
        <Tabs activeKey={sendMode} onChange={setSendMode} size="small"
          items={[
            {
              key: "mine", label: "我的模板",
              children: (
                <div className="space-y-2">
                  <div className="text-[11px] text-gray-400">
                    根据联系人类型 + 阶段智能匹配，共 {templates.length} 个模板
                  </div>
                  {templates.length === 0 ? (
                    <div className="text-xs text-gray-400 py-8 text-center">暂无模板，请在模板管理页创建</div>
                  ) : (
                    <div className="flex gap-2 flex-wrap">
                      {templates.map(t => (
                        <div key={t.id}
                          className="flex flex-col gap-1 px-3 py-2 rounded border border-gray-200 bg-white w-[180px]"
                        >
                          <div className="text-xs font-medium text-gray-800 truncate">{t.name}</div>
                          <div className="flex gap-1">
                            {t.category && <Tag className="text-[9px] leading-none px-1">{CAT_LABELS[t.category] || t.category}</Tag>}
                            {t.stage && <Tag className="text-[9px] leading-none px-1">{STAGE_LABELS[t.stage] || t.stage}</Tag>}
                            <Tag className="text-[9px] leading-none px-1">{t.language}</Tag>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "instant", label: "即时发送",
              children: (
                <div className="space-y-3">
                  <div className="text-[11px] text-gray-400">
                    手动编写邮件内容，支持模板变量
                  </div>
                  <Input size="small" placeholder="邮件主题（支持 {{firstName}} {{company}} 变量）"
                    value={instantSubject} onChange={e => setInstantSubject(e.target.value)} />
                  <Input.TextArea rows={10}
                    placeholder={"邮件正文…\n\n可用变量：{{firstName}} {{lastName}} {{company}} {{title}}"}
                    value={instantBody} onChange={e => setInstantBody(e.target.value)} />
                  <div className="text-[10px] text-gray-400">
                    变量：{"{{firstName}}"} {"{{lastName}}"} {"{{company}}"} {"{{title}}"} {"{{email}}"}
                  </div>
                </div>
              ),
            },
            {
              key: "preset", label: "预设句库",
              children: (
                <div className="space-y-2">
                  <div className="text-[11px] text-gray-400">
                    使用内置多语言句库（EN/ES/PT），按联系人类型 + 阶段自动组装开发信，无需手动选模板
                  </div>
                  <div className="text-[10px] text-gray-400">
                    每家公司随机组合一套：称呼 → 问候 → 自我介绍 → 价值连接 → 服务要点 → 行动号召 → 收尾
                  </div>
                </div>
              ),
            },
            {
              key: "dynamic", label: "动态更新",
              children: (
                <div className="space-y-3 dynamic-enter">
                  <Select mode="multiple" allowClear size="small" placeholder="选择国家（多选，来自客户跟进）"
                    value={dynCountries} onChange={setDynCountries}
                    options={dynAvailableCountries.map(c => ({ value: c, label: `${c} ${COUNTRIES.find(x => x.code === c)?.label || ""}` }))}
                    style={{ width: "100%" }} />
                  {dynCountries.length > 0 && (
                    <div className="border border-gray-200 rounded-lg max-h-[240px] overflow-y-auto">
                      {dynFilteredContacts.length === 0 ? (
                        <div className="text-[11px] text-gray-400 py-6 text-center">该国家下暂无客户跟进联系人</div>
                      ) : (
                        dynFilteredContacts.map(c => {
                          const checked = !dynUnchecked.has(c.id);
                          return (
                            <div key={c.id} className="flex items-center gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0 hover:bg-gray-50 text-xs">
                              <Checkbox checked={checked} onChange={() => setDynUnchecked(prev => { const n = new Set(prev); checked ? n.add(c.id) : n.delete(c.id); return n; })} />
                              <span className="font-medium w-24 truncate">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</span>
                              <span className="text-[11px] text-gray-400 flex-1 truncate">{c.companyName || "—"}</span>
                              {c.country && <span className="text-[9px] text-gray-400 px-1 rounded bg-gray-50">{c.country}</span>}
                              {c.assignee && <Tag color="geekblue" className="text-[10px] my-0 leading-none py-0.5 px-1.5">{c.assignee}</Tag>}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                  <Input size="small" placeholder="主题" value={dynSubject} onChange={e => setDynSubject(e.target.value)} />
                  <RichTextEditor value={dynBody} onChange={setDynBody} placeholder="正文（支持粘贴表格、图片）"
                    style={{ minHeight: 200, border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }} />
                  {signature && (
                    <div className="border-t border-gray-100 pt-2">
                      <div className="text-[10px] text-gray-400 mb-1">签名预览</div>
                      <HtmlText html={signature} className="text-[11px] text-gray-600" />
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">已选 {dynSelectedCount} 人</span>
                    <Button type="primary" size="small" icon={<SendOutlined />} onClick={handleDynamicSend}>发信</Button>
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Card>

      {/* ── ② 发送范围 — 三栏分选（动态更新模式下隐藏） ── */}
      {sendMode !== "dynamic" && (
        <Card size="small" title={<span className="text-xs font-semibold text-gray-600">发送范围</span>}>
          <div className="flex gap-4">
            <BucketColumn
              title="按发送阶段"
              buckets={gList}
              selected={selectedBuckets}
              onToggle={toggleBucket}
              disabled={isRunning}
              loading={gbLoading}
            />
            <div className="w-px bg-gray-200 flex-shrink-0" />
            <BucketColumn
              title="按客户状态"
              buckets={sList}
              selected={selectedBuckets}
              onToggle={toggleBucket}
              disabled={isRunning}
              loading={sbLoading}
            />
            <div className="w-px bg-gray-200 flex-shrink-0" />
            <BucketColumn
              title="按最后发送"
              buckets={tList}
              selected={selectedBuckets}
              onToggle={toggleBucket}
              disabled={isRunning}
              loading={tbLoading}
            />
          </div>
          <div className="mt-3 pt-2 border-t border-gray-100 text-[11px] text-gray-400">
            已选 <strong className="text-gray-700">{selectedCount}</strong> 人{rawCount > selectedCount ? <span className="text-amber-500">（限额上限，共{rawCount}人）</span> : "（三栏取并集）"}
          </div>
        </Card>
      )}

      {/* ── ③ 发送规则 + 按钮（动态更新模式下隐藏） ── */}
      {sendMode !== "dynamic" && (
        <Card size="small">
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-gray-400 leading-relaxed">
              {sched ? `${sched.timeWindowEnabled ? `${String(sched.startHour).padStart(2, "0")}:00–${String(sched.endHour).padStart(2, "0")}:00` : "不限时段"} · 每组${sched.groupSize}人 · 组间${sched.groupDelayMinSeconds}–${sched.groupDelayMaxSeconds}s` : ""}
              {quotaData?.success && quotaData.data && (() => {
                const q = quotaData.data;
                if (q.remaining <= 0 && !q.ok) return <span className="text-red-500 ml-3">{q.reason}</span>;
                if (q.remaining > 0) return <span className="ml-3">剩余配额: <strong className="text-gray-700">{q.remaining}</strong> 封</span>;
                if (q.remaining < 0) return null; // 不限
                return null;
              })()}
            </div>
            <Space>
              <Button type="primary" size="small" icon={<SendOutlined />}
                disabled={selectedCount === 0 || isRunning}
                onClick={handleStart}>
                发送 {selectedCount} 人
              </Button>
            </Space>
          </div>
        </Card>
      )}

    </div>
  );
}
