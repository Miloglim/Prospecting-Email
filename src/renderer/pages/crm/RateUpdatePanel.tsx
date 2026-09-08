// ── 定向运价更新面板（跟进看板右上角「运价更新」）──────────────────────
// 规范 docs/rate-update-push-spec.md §6。存在的理由：销售不会打字驱动 agent，那就把这条链路做成
// 「点一下 → 看到发给谁、发什么价、长什么样 → 勾一下入队」。
// 与 agent 工具 rate_update_plan / rate_update_enqueue 打的是同一个主进程 service，方案与入队口径完全一致；
// 这里没有任何"开始发送"按钮——入队后仍要人到发送中心点开始（红线）。
import { useEffect, useMemo, useState } from "react";
import { Drawer, Button, Checkbox, Modal, Tag, Empty, Spin, Collapse, Alert, message, Tooltip, Segmented, Input } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ReloadOutlined, SendOutlined, ExportOutlined } from "@ant-design/icons";

/** 与 rate-update.service.ts 的 planView/groups 投影对齐（渲染层不跨层 import 主进程类型，字段以 service 为准） */
interface GroupRow {
  key: string; pod: string; label: string; lane: string | null; language: string;
  /** 这组凭什么成立：pref=港口偏好；port=点名这个港；country=按国家当期代表港兜底 */
  basis: "pref" | "port" | "country";
  /** 命中航线级/区域基本港价（要在界面如实标出来） */
  laneLevel: boolean;
  customers: number; quotes: number; minUsd: number | null; validTo: string | null;
  carriers: string; dropPct: number | null; subject: string;
}
interface PlanView {
  planId: string;
  scope: {
    scope: "board" | "contacts"; stages: string[]; country: string | null; includeReplied: boolean;
    port: string | null; days: number; quotesPerGroup: number;
  };
  totals: { customers: number; covered: number; groups: number; quotes: number; truncated: number; uncoveredTotal: number };
  groups: GroupRow[];
  uncovered: Array<{ contactId: number; name: string; reason: string; detail: string }>;
}
interface GroupBody {
  key: string; pod: string; language: string; subject: string; bodyHtml: string;
  customers: Array<{ id: number; name: string; email: string; company: string | null; sources: string[]; evidence: string }>;
  quotes: Array<{ carrier: string; pol: string; pod: string; p20: number | null; p40: number | null; pNor: number | null; freeDays: number | null; etd: string | null; validFrom: string | null; validTo: string | null }>;
}
type Ipc<T> = { success: boolean; data?: T; error?: string };

const REASON_LABEL: Record<string, string> = {
  no_port: "推不出港口偏好",
  no_live_rate: "台账当期无有效价",
  over_cap: "本轮组数上限没排上",
};

/**
 * @param open 面板开关
 * @param onClose 关闭
 * @param defaultStages 默认圈定的跟进阶段（看板当前列传进来=「只给这一列客户推价」）；不传=除已流失外全部
 * @param contactIds 只给这几位客户推（看板多选后用）；不传=按阶段圈全量
 */
export function RateUpdatePanel({ open, onClose, defaultStages, contactIds }: {
  open: boolean; onClose: () => void; defaultStages?: string[]; contactIds?: number[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // 范围两分：跟进看板（已触达/已回复）vs 联系人库全量（含没开发过的冷客户）——混起来就会「找不到客户」
  const [range, setRange] = useState<"board" | "contacts">("board");
  const [country, setCountry] = useState<string>("");

  const stagesKey = defaultStages?.join(",") ?? "";
  const idsKey = contactIds?.join(",") ?? "";
  const countryKey = country.trim();
  const scopeArgs = () => {
    const a: Record<string, unknown> = { scope: range };
    if (countryKey) a.country = countryKey;
    if (range === "board" && defaultStages?.length) a.stages = defaultStages;
    if (contactIds?.length) a.contactIds = contactIds;
    return a;
  };

  // 方案：打开面板或点「重新生成」时才跑（每次都要扫客户 + 解析来信，不常驻轮询）
  const { data: plan, isFetching: planLoading, refetch } = useQuery({
    queryKey: ["rate-update", "plan", stagesKey, idsKey, range, countryKey, nonce],
    queryFn: () => window.api.invoke("rateUpdate:plan", scopeArgs()) as Promise<Ipc<PlanView>>,
    enabled: open,
  });

  const planData = plan?.success ? plan.data ?? null : null;
  useEffect(() => {
    if (!open) return;
    if (!plan?.success) { setPlanError(plan?.error ?? null); return; }
    setPlanError(null);
    // 默认全选；重新生成后同样全选（所见即所发：不替用户默默少发）
    setPicked(new Set((planData?.groups ?? []).map(g => g.key)));
    setActiveKey(planData?.groups?.[0]?.key ?? null);
  }, [open, plan, planData]);

  const body = useQuery({
    queryKey: ["rate-update", "body", planData?.planId, activeKey],
    queryFn: () => window.api.invoke("rateUpdate:groupBody", planData?.planId, activeKey) as Promise<Ipc<GroupBody>>,
    enabled: open && !!planData?.planId && !!activeKey,
  });

  const chosen = useMemo(
    () => (planData?.groups ?? []).filter(g => picked.has(g.key)),
    [planData, picked],
  );
  const chosenCustomers = chosen.reduce((s, g) => s + g.customers, 0);

  const enqueue = useMutation({
    mutationFn: (overwrite: boolean) => window.api.invoke(
      "rateUpdate:enqueue", planData?.planId, chosen.map(g => g.key), overwrite,
    ) as Promise<Ipc<{ occupied: boolean; pendingGroups?: number; enqueue?: { queued: number; queuedCount: number; dropped: number; pods: string[]; batchId: string } }>>,
    onSuccess: (r) => {
      if (!r.success) { message.error(r.error || "入队失败"); return; }
      const d = r.data;
      if (d?.occupied) {
        // startQueue 会清空 send_queue 全表 → 既有未发送批次必须先让人决定，不静默覆盖
        Modal.confirm({
          title: `发送队列里还有 ${d.pendingGroups ?? 0} 组没发出去`,
          content: "运价更新入队会把当前队列清空重建。要先去发送中心把这批发掉或清掉，还是确认用这次运价更新覆盖它们？",
          okText: "确认覆盖并入队",
          cancelText: "先去处理",
          okButtonProps: { danger: true },
          onOk: () => { enqueue.mutate(true); },
        });
        return;
      }
      const e = d?.enqueue;
      message.success(`已入队 ${e?.queued ?? 0} 组 / ${e?.queuedCount ?? 0} 封${e?.dropped ? `（${e.dropped} 组被当日限额裁掉）` : ""}，到发送中心点「开始」才会真发`);
      onClose();
    },
    onError: (err: unknown) => message.error(err instanceof Error ? err.message : "入队失败"),
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={960}
      title="运价更新 · 按客户港口偏好（或所在国家）定向投递"
      destroyOnHidden
      styles={{ body: { padding: 0, display: "flex", flexDirection: "column" } }}
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">
            入队 ≠ 发送：队列建好后需到「发送中心」手动点开始
          </span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary" icon={<SendOutlined />} disabled={chosen.length === 0}
              loading={enqueue.isPending}
              onClick={() => { if (planData?.planId) enqueue.mutate(false); }}
            >
              入队 {chosenCustomers} 位客户（{chosen.length} 封样张）
            </Button>
          </div>
        </div>
      }
    >
      {planLoading ? (
        <div className="flex-1 flex items-center justify-center"><Spin tip="正在汇总跟进客户与他们的港口偏好…" /></div>
      ) : planError || !planData ? (
        <div className="p-6">
          <Alert type="warning" showIcon
            message="没能生成方案"
            description={planError || "跟进看板里没有符合条件的客户（范围：已触达 / 已回复，且除已流失外的阶段）"}
            action={<Button size="small" icon={<ReloadOutlined />} onClick={() => setNonce(n => n + 1)}>重试</Button>} />
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* 左：分组方案（一组 = 一封要发出去的邮件） */}
          <div className="w-[380px] flex-shrink-0 border-r border-gray-100 flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 flex-wrap">
              <Segmented size="small" value={range} onChange={v => setRange(v as "board" | "contacts")}
                options={[{ value: "board", label: "跟进看板" }, { value: "contacts", label: "联系人库" }]} />
              <Input size="small" allowClear placeholder="国家，如 巴西" value={country} style={{ width: 118 }}
                onChange={e => setCountry(e.target.value)}
                onPressEnter={() => setNonce(n => n + 1)} onBlur={() => setNonce(n => n + 1)} />
              <span className="text-xs text-gray-500">
                {contactIds?.length ? `已选 ${contactIds.length} 位`
                  : `圈定 ${planData?.totals.customers ?? 0} 位 → 可推 ${planData?.totals.covered ?? 0} 位 / ${planData?.totals.groups ?? 0} 组`}
                {planData && planData.totals.uncoveredTotal > 0 ? ` · ${planData.totals.uncoveredTotal} 位本轮不推` : ""}
              </span>
              <Tooltip title="按当前范围与最新运价镜像重新算一遍方案">
                <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => { void refetch(); }} />
              </Tooltip>
            </div>
            <div className="flex-1 overflow-y-auto">
              {planData.groups.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可推的组（下面看未覆盖原因）" className="mt-8" />
              ) : planData.groups.map(g => (
                <div
                  key={g.key}
                  className={`px-3 py-2 border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${activeKey === g.key ? "bg-violet-50 border-l-2 border-l-violet-400" : ""}`}
                  onClick={() => setActiveKey(g.key)}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={picked.has(g.key)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(g.key); else next.delete(g.key);
                        setPicked(next);
                      }}
                    />
                    <span className="text-sm font-medium">{g.label}</span>
                    {g.basis === "country" && (
                      <Tooltip title="TA 没登记港口偏好，按所在国家当期报价最多的港兜底">
                        <Tag className="!mr-0" color="default">按国家</Tag>
                      </Tooltip>
                    )}
                    {g.laneLevel && (
                      <Tooltip title="台账给的是该航线/区域基本港价，不是这个港的专属价（邮件里也会这样注明）">
                        <Tag className="!mr-0" color="orange">航线级价</Tag>
                      </Tooltip>
                    )}
                    <Tag className="!mr-0">{g.language}</Tag>
                    {g.dropPct != null && <Tag color="red" className="!mr-0">降 {g.dropPct}%</Tag>}
                  </div>
                  <div className="text-[11px] text-gray-400 ml-6 mt-0.5">
                    {g.customers} 位客户 · {g.quotes} 条报价 · 最低 ${g.minUsd ?? "—"}
                    {g.carriers ? ` · ${g.carriers}` : ""}
                    {g.validTo ? ` · ${g.validTo} 到期` : ""}
                  </div>
                </div>
              ))}
            </div>
            {planData.uncovered.length > 0 && (
              <div className="border-t border-gray-100">
                <Collapse ghost size="small" items={[{
                  key: "u",
                  label: <span className="text-xs text-gray-500">{planData.totals.uncoveredTotal} 位本轮不推（看原因）</span>,
                  children: (
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {planData.uncovered.map(u => (
                        <div key={u.contactId} className="text-[11px] flex items-start justify-between gap-2">
                          <a className="text-gray-600 truncate"
                            onClick={() => { window.location.hash = `#/customers?view=table&detail=${u.contactId}`; }}>
                            {u.name}
                          </a>
                          <span className="text-gray-300 flex-shrink-0">{REASON_LABEL[u.reason] ?? u.reason}：{u.detail}</span>
                        </div>
                      ))}
                      {planData.totals.uncoveredTotal > planData.uncovered.length && (
                        <div className="text-[11px] text-gray-300">仅列前 {planData.uncovered.length} 条</div>
                      )}
                    </div>
                  ),
                }]} />
              </div>
            )}
          </div>

          {/* 右：邮件预览（iframe srcDoc = 真 HTML，与客户收到的一致；样式不互染） */}
          <div className="flex-1 min-w-0 flex flex-col bg-gray-50">
            {!activeKey ? (
              <Empty description="左边选一组看邮件内容" className="mt-20" />
            ) : body.isFetching ? (
              <div className="flex-1 flex items-center justify-center"><Spin /></div>
            ) : !body.data?.success || !body.data.data ? (
              <div className="p-4"><Alert type="error" showIcon message={body.data?.error ?? "预览取不到"} /></div>
            ) : (() => {
              const g = body.data.data;
              return (
                <>
                  <div className="px-4 py-2 bg-white border-b border-gray-100">
                    <div className="text-xs text-gray-400">主题</div>
                    <div className="text-sm font-medium">{g.subject}</div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      收件人 {g.customers.length} 位（正文里的 {"{{firstName}}"} 会按每个人各自渲染；签名取发信账号配置）
                    </div>
                  </div>
                  <iframe
                    title={`运价更新预览 · ${g.pod}`}
                    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fff}</style></head><body>${g.bodyHtml}</body></html>`}
                    className="flex-1 w-full border-0 bg-white"
                    sandbox=""
                  />
                  <div className="px-4 py-2 bg-white border-t border-gray-100 max-h-32 overflow-y-auto">
                    <div className="text-[11px] text-gray-400 mb-1">这一组为什么收到（偏好出处，标注必须=实给）</div>
                    <div className="space-y-0.5">
                      {g.customers.map(c => (
                        <div key={c.id} className="text-[11px] text-gray-500 flex items-center gap-2">
                          <a onClick={() => { window.location.hash = `#/customers?view=table&detail=${c.id}`; }}>{c.name}</a>
                          <span className="text-gray-300">{c.company ?? "—"}</span>
                          <span className="text-gray-300 truncate">{c.evidence}</span>
                        </div>
                      ))}
                    </div>
                    <Button size="small" type="link" className="!px-0 mt-1" icon={<ExportOutlined />}
                      onClick={() => { window.location.hash = "#/queue"; }}>
                      入队后到发送中心点开始
                    </Button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </Drawer>
  );
}
