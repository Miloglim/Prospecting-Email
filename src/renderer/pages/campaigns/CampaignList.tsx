import { useState, useEffect } from "react";
import { Button, Card, Checkbox, Tag, message, Progress, Modal, Popconfirm, Space, Tabs, Input } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, EyeOutlined, SendOutlined, StopOutlined, ReloadOutlined } from "@ant-design/icons";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const STAGE_LABELS: Record<string, string> = {
  initial: "初次", followup1: "跟进1", followup2: "跟进2", closing: "促单", reactivate: "激活",
};
const CAT_LABELS: Record<string, string> = { direct: "直客", peer: "同行", general: "通用" };

interface TimeBucket {
  key: string; label: string; description: string;
  contacts: unknown[]; count: number;
}

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
            return (
              <label key={b.key}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors
                  ${sel ? "bg-blue-50" : "hover:bg-gray-50"}
                  ${disabled ? "opacity-50 pointer-events-none" : ""}`}
              >
                <Checkbox checked={sel} onChange={() => onToggle(b.key)} disabled={disabled} />
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
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(["never"]);
  const [sendMode, setSendMode] = useState<string>("mine");
  const [instantSubject, setInstantSubject] = useState("");
  const [instantBody, setInstantBody] = useState("");
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [recipientsPreview, setRecipientsPreview] = useState<Array<{
    id: string; companyName: string;
    recipients: Array<{ contactId: number; email: string; name: string }>;
    subject: string; accountId: number;
  }> | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

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
        companyDelayMinMinutes: number; companyDelayMaxMinutes: number;
        singleRecipDelayMinSeconds: number; singleRecipDelayMaxSeconds: number;
        templateRotateGroups: number; }; sendQuota?: { dailyLimit: number; firstSendAt: string | null; sentToday: number } };
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

  // 合并三个维度的所有 key，取并集统计人数（去重由后端 buildQueue 处理）
  const toggleBucket = (key: string) => {
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

  // 收件人预览 → 确认发送
  const handleRecipientPreview = async () => {
    const payload: Record<string, unknown> = { keys: selectedBuckets };
    if (sendMode === "mine") {
      const allTpls = templates.map(t => ({ subject: t.subject, body: t.body, category: t.category, stage: t.stage, language: t.language }));
      if (allTpls.length === 0) { message.warning("没有可用模板"); return; }
      payload.templates = allTpls;
    } else if (sendMode === "instant") {
      if (!instantSubject.trim() || !instantBody.trim()) { message.warning("请填写主题和正文"); return; }
      payload.templates = [{ subject: instantSubject, body: instantBody }];
    }
    const r = await window.api.invoke("send:preview", payload) as {
      success: boolean; data?: Array<{
        id: string; companyName: string; recipients: Array<{ contactId: number; email: string; name: string }>;
        subject: string; accountId: number;
      }>; error?: string;
    };
    if (r?.success && r.data) {
      setRecipientsPreview(r.data);
      setRecipientsOpen(true);
    } else {
      message.error(r?.error || "预览失败");
    }
  };

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
        ? (message.success(`开始发送 ${selectedCount} 人`), setRecipientsOpen(false), navigate({ to: "/queue" }))
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

      {/* ── ① 发送范围 — 三栏分选 ── */}
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

      {/* ── ② 发送模式 ── */}
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
          ]}
        />
      </Card>

      {/* ── ③ 发送规则 + 按钮 ── */}
      <Card size="small">
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-400 leading-relaxed">
            {sched ? `${sched.timeWindowEnabled ? `${String(sched.startHour).padStart(2, "0")}:00–${String(sched.endHour).padStart(2, "0")}:00` : "不限时段"} · ${sched.companyDelayMinMinutes}–${sched.companyDelayMaxMinutes}min · ${sched.singleRecipDelayMinSeconds}–${sched.singleRecipDelayMaxSeconds}s` : ""}
            {quotaData?.success && quotaData.data && (() => {
              const q = quotaData.data;
              if (q.remaining <= 0 && !q.ok) return <span className="text-red-500 ml-3">{q.reason}</span>;
              if (q.remaining > 0) return <span className="ml-3">剩余配额: <strong className="text-gray-700">{q.remaining}</strong> 封</span>;
              if (q.remaining < 0) return null; // 不限
              return null;
            })()}
          </div>
          <Space>
            <Button size="small" icon={<EyeOutlined />}
              disabled={selectedCount === 0}
              onClick={handleRecipientPreview}>预览收件人</Button>
            <Button type="primary" size="small" icon={<SendOutlined />}
              disabled={selectedCount === 0 || isRunning}
              onClick={handleRecipientPreview}>
              发送 {selectedCount} 人
            </Button>
          </Space>
        </div>
      </Card>

      {/* ── 收件人预览弹窗 ── */}
      <Modal title="发送前预览" open={recipientsOpen} onCancel={() => setRecipientsOpen(false)} width={800}
        footer={
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-400">
              共 {recipientsPreview?.length || 0} 组、{recipientsPreview?.reduce((s, g) => s + g.recipients.length, 0) || 0} 人
            </span>
            <Space>
              <Button size="small" onClick={() => setRecipientsOpen(false)}>取消</Button>
              <Button type="primary" size="small" icon={<SendOutlined />}
                loading={startMut.isPending} onClick={handleStart}>确认发送</Button>
            </Space>
          </div>
        }
      >
        {recipientsPreview && (
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {recipientsPreview.map(g => (
              <div key={g.id} className="flex items-center gap-3 py-1.5 border-b border-gray-100 text-xs">
                <span className="font-medium w-28 truncate">{g.companyName || "—"}</span>
                <Tag className="text-[10px]">{g.recipients.length}人</Tag>
                <span className="text-[10px] text-blue-500 font-mono">
                  {accounts.find(a => a.id === g.accountId)?.email || `#${g.accountId}`}
                </span>
                <span className="text-[11px] text-gray-400 truncate flex-1">{g.subject}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
