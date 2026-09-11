import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Drawer, Empty, Popconfirm, Progress, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  PlusOutlined, RocketOutlined, EditOutlined, PauseCircleOutlined,
  PlayCircleOutlined, StopOutlined, ClockCircleOutlined, LoadingOutlined, DeleteOutlined,
} from "@ant-design/icons";

/**
 * 开发任务（定时器式任务组营销的唯一操作页，用户定案 v5.9）：
 * · 任务组以卡片展示（标题/进行状态/进度/止损计数/队列组数）；
 * · 后台（发送队列与引擎状态）挂在卡片背后运行——点开卡片（抽屉）才看到运行情况；
 * · 不再有全局"待发送"状态条：队列组带 campaign_id 归属，各任务各看各的。
 */

interface CampaignRow {
  id: string; name: string; status: string; autoSend: boolean; planRounds: number;
  total: number; pending: number; queued: number; sent: number;
  replied: number; bounced: number; unsubscribed: number; skipped: number;
  /** 封数口径进度：Σ已发轮次 / 计划封数（终态触点只计已发轮数，止损即收缩分母） */
  touchesSent: number; touchesPlanned: number;
  queuedGroups: number;
  createdAt: string;
}

interface TargetRow {
  contactId: number; name: string; email: string;
  status: string; round: number; nextTouchAt: string | null; lastSentAt: string | null;
}

interface QueueGroupRow {
  id: string; companyName: string; recipientCount: number;
  status: string; error: string | null; sentAt: string | null; accountEmail: string | null;
}

interface DetailData {
  campaign: CampaignRow | null;
  targets: TargetRow[];
  queue: QueueGroupRow[];
  raw: { accountPolicy: "rotate" | "fixed" } | null;
}

interface EngineStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: { id: string; companyName: string; recipients: unknown[]; accountEmail?: string } | null;
  delaySeconds: number; delayUntil: string | null;
  delayReason?: "group" | "window" | null;
  pausedReason?: "user" | "sender_block" | null;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  draft: { color: "gold", label: "草稿" },
  running: { color: "processing", label: "进行中" },
  paused: { color: "warning", label: "已暂停" },
  done: { color: "success", label: "已完成" },
  stopped: { color: "default", label: "已终止" },
};
const TARGET_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待发" },
  queued: { color: "processing", label: "已入队" },
  sent: { color: "success", label: "已完成" },
  replied: { color: "green", label: "已回复" },
  bounced: { color: "red", label: "退信" },
  unsubscribed: { color: "orange", label: "退订" },
  skipped: { color: "default", label: "已跳过" },
};
const GROUP_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待发送" },
  sending: { color: "processing", label: "发送中" },
  sent: { color: "success", label: "已发出" },
  failed: { color: "red", label: "失败" },
};

const fmtTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const fmtDelay = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
};

export function CampaignTasks({ onCreate, onEdit }: { onCreate: () => void; onEdit: (id: string) => void }) {
  const qc = useQueryClient();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => window.api.invoke("send:campaigns") as Promise<{ success: boolean; data?: CampaignRow[] }>,
    // 轮询只是兜底：有任务在跑时收紧到 4s，空闲回落 15s（实时性靠 send:progress，见下）
    refetchInterval: q => ((q.state.data?.data ?? []).some(r => r.status === "running") ? 4_000 : 15_000),
  });
  const rows = data?.success ? (data.data ?? []) : [];
  const runningCount = rows.filter(r => r.status === "running").length;
  const totalQueuedGroups = rows.reduce((a, r) => a + r.queuedGroups, 0);

  useEffect(() => {
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["campaign", "detail"] });
      // 发出信会推进 stage/interactions → 首页推荐口径与选人器灰显口径都跟着变
      qc.invalidateQueries({ queryKey: ["send", "pickerStats"] });
    };
    let again: ReturnType<typeof setTimeout> | null = null;
    const off = window.api.on("send:progress", () => {
      refresh();
      // 轮次推进是在发送回调里异步落库的：只对一次会读到旧数字，1.2s 后二次对账
      if (again) clearTimeout(again);
      again = setTimeout(refresh, 1200);
    });
    return () => { off?.(); if (again) clearTimeout(again); };
  }, [qc]);

  // 详情抽屉数据（打开时才拉；queue = 挂在卡片背后的运行情况）
  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ["campaign", "detail", drawerId],
    queryFn: () => window.api.invoke("send:campaignDetail", drawerId) as Promise<{ success: boolean; data?: DetailData }>,
    enabled: !!drawerId,
    refetchInterval: 5000,
  });
  const detail = detailData?.success ? detailData.data ?? null : null;

  // 发送引擎状态（全局单引擎，只在抽屉打开时轮询展示——后台挂在卡片背后）
  const { data: statusData } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{ success: boolean; data?: EngineStatus }>,
    enabled: !!drawerId,
    refetchInterval: 2000,
    placeholderData: prev => prev,
  });
  const status = statusData?.success ? statusData.data ?? null : null;

  const [delayLeft, setDelayLeft] = useState(0);
  useEffect(() => {
    const until = status?.delayUntil;
    if (!until) { setDelayLeft(0); return; }
    const tick = () => setDelayLeft(Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status?.delayUntil]);

  const engine = async (action: "start" | "pause" | "resume" | "cancel") => {
    const ch: Record<string, string> = { start: "send:resumeQueue", pause: "send:pause", resume: "send:resume", cancel: "send:cancel" };
    try {
      const r = await window.api.invoke(ch[action]!) as { success: boolean; error?: string };
      if (!r?.success) { message.error(r?.error || "操作失败"); return; }
      if (action === "start") message.success("已开始发送");
      qc.invalidateQueries({ queryKey: ["send"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (err) {
      message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const control = async (id: string, action: "pause" | "resume" | "stop" | "restart", name: string) => {
    const verb = action === "pause" ? "暂停" : action === "resume" ? "启动" : action === "restart" ? "再启动" : "终止";
    try {
      const r = await window.api.invoke("send:campaignControl", { campaignId: id, action }) as { success: boolean; error?: string };
      qc.invalidateQueries({ queryKey: ["campaigns"] }); // 失败也可能改了状态（restart 缺内容 → 转草稿），两边都要刷新
      qc.invalidateQueries({ queryKey: ["dev-letter"] });   // 任务归属变了 → 首页可推荐名单要重算（规范 §5）
      qc.invalidateQueries({ queryKey: ["send", "pickerStats"] });
      if (!r?.success) { message.warning(r?.error || `${verb}失败`); return; }
      message.success(`已${verb}「${name}」`);
    } catch (err) {
      message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 删除任务（触点账本一起删，发送历史保留）；running/paused 主进程会拒删并说明 */
  const remove = async (id: string, name: string) => {
    try {
      const r = await window.api.invoke("send:campaignDelete", id) as { success: boolean; error?: string };
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["dev-letter"] });
      qc.invalidateQueries({ queryKey: ["send", "pickerStats"] });
      if (!r?.success) { message.warning(r?.error || "删除失败"); return; }
      if (drawerId === id) setDrawerId(null);
      message.success(`已删除任务「${name}」，发送历史保留`);
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 删除入口只在 draft/done/stopped 出现：运行中的任务要先终止（在途批次回调要靠 campaignId 找任务） */
  const deleteOp = (r: CampaignRow) => (
    <Popconfirm title={`删除任务「${r.name}」？`} description="名单与触点一并删除，发送历史保留"
      okText="删除" okType="danger" cancelText="取消"
      onConfirm={() => { void remove(r.id, r.name); }}>
      <Button size="small" danger style={{ fontSize: 12 }} icon={<DeleteOutlined />}
        onClick={e => { e.stopPropagation(); }}>删除</Button>
    </Popconfirm>
  );

  const cardOps = (r: CampaignRow) => {
    if (r.status === "draft") {
      return (
        <>
          <Button size="small" type="primary" style={{ fontSize: 12 }} icon={<RocketOutlined />}
            onClick={e => { e.stopPropagation(); void control(r.id, "resume", r.name); }}>启动</Button>
          <Button size="small" style={{ fontSize: 12 }} icon={<EditOutlined />}
            onClick={e => { e.stopPropagation(); onEdit(r.id); }}>编辑</Button>
          <Tooltip title="终止后待发触点全部清空，不可恢复">
            <Button size="small" danger style={{ fontSize: 12 }}
              onClick={e => { e.stopPropagation(); void control(r.id, "stop", r.name); }}>终止</Button>
          </Tooltip>
          {deleteOp(r)}
        </>
      );
    }
    if (r.status === "running" || r.status === "paused") {
      return (
        <>
          {r.status === "running" ? (
            <Button size="small" style={{ fontSize: 12 }} icon={<PauseCircleOutlined />}
              onClick={e => { e.stopPropagation(); void control(r.id, "pause", r.name); }}>暂停</Button>
          ) : (
            <Button size="small" style={{ fontSize: 12 }} icon={<PlayCircleOutlined />}
              onClick={e => { e.stopPropagation(); void control(r.id, "resume", r.name); }}>恢复</Button>
          )}
          <Tooltip title="终止后待发触点全部清空，不可恢复">
            <Button size="small" danger style={{ fontSize: 12 }} icon={<StopOutlined />}
              onClick={e => { e.stopPropagation(); void control(r.id, "stop", r.name); }}>终止</Button>
          </Tooltip>
        </>
      );
    }
    if (r.status === "done") {
      return (
        <>
          <Tooltip title="开启新周期：退信/退订阅户保持终态，其余触点重置重发；上周期的固定内容已清空，需先编辑补好新内容">
            <Button size="small" style={{ fontSize: 12 }} icon={<RocketOutlined />}
              onClick={e => { e.stopPropagation(); void control(r.id, "restart", r.name); }}>再启动新周期</Button>
          </Tooltip>
          {deleteOp(r)}
        </>
      );
    }
    // stopped（及任何未知终态）：只剩删除——不留删除入口这任务就永远删不掉
    return deleteOp(r);
  };

  const targetColumns: ColumnsType<TargetRow> = [
    { title: "联系人", dataIndex: "name", key: "name", width: 150, ellipsis: true,
      render: (v: string, r) => <span className="text-[11px]">{v || r.email}</span> },
    { title: "邮箱", dataIndex: "email", key: "email", ellipsis: true,
      render: (v: string) => <span className="text-[10px] font-mono text-gray-500">{v}</span> },
    { title: "状态", dataIndex: "status", key: "status", width: 86,
      render: (v: string) => { const m = TARGET_STATUS[v] ?? { color: "default", label: v }; return <Tag color={m.color} className="!my-0 !text-[10px]">{m.label}</Tag>; } },
    { title: "轮次", dataIndex: "round", key: "round", width: 52,
      render: (v: number) => <span className="text-[11px] font-mono">{v}</span> },
    { title: "下次触达", dataIndex: "nextTouchAt", key: "nextTouchAt", width: 110,
      render: (v: string | null) => <span className="text-[10px] font-mono text-gray-500">{fmtTime(v)}</span> },
    { title: "上次发出", dataIndex: "lastSentAt", key: "lastSentAt", width: 110,
      render: (v: string | null) => <span className="text-[10px] font-mono text-gray-500">{fmtTime(v)}</span> },
  ];

  const queueColumns: ColumnsType<QueueGroupRow> = [
    { title: "组（公司）", dataIndex: "companyName", key: "companyName", ellipsis: true,
      render: (v: string) => <span className="text-[11px]">{v || "—"}</span> },
    { title: "收件", dataIndex: "recipientCount", key: "recipientCount", width: 64,
      render: (v: number) => <span className="text-[11px] font-mono">{v} 封</span> },
    { title: "状态", dataIndex: "status", key: "status", width: 80,
      render: (v: string) => { const m = GROUP_STATUS[v] ?? { color: "default", label: v }; return <Tag color={m.color} className="!my-0 !text-[10px]">{m.label}</Tag>; } },
    { title: "发件账号", dataIndex: "accountEmail", key: "accountEmail", width: 170, ellipsis: true,
      render: (v: string | null) => <span className="text-[10px] font-mono text-gray-500">{v ?? "—"}</span> },
    { title: "发出时间", dataIndex: "sentAt", key: "sentAt", width: 105,
      render: (v: string | null) => <span className="text-[10px] font-mono text-gray-500">{fmtTime(v)}</span> },
    { title: "错误", dataIndex: "error", key: "error", ellipsis: true,
      render: (v: string | null) => v ? <Tooltip title={v}><span className="text-[10px] text-red-500 truncate">{v}</span></Tooltip> : <span className="text-[10px] text-gray-300">—</span> },
  ];

  // ── 抽屉里的引擎状态条（全局单引擎；从任务卡片点进来看到的就是它的运行情况） ──
  const isRunning = status?.isRunning ?? false;
  const isPaused = status?.isPaused ?? false;
  const engineBusy = isRunning || totalQueuedGroups > 0;

  return (
    <div className="pt-2 space-y-3">
      {/* 页头：统计 + 创建入口 */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-gray-500 leading-relaxed">
          共 <span className="font-medium text-gray-700">{rows.length}</span> 个任务组{rows.length > 0 && <> · 进行中 <span className="text-teal-600 font-medium">{runningCount}</span></>}
          {totalQueuedGroups > 0 && <> · 队列 <span className="text-blue-600 font-medium">{totalQueuedGroups}</span> 组</>}。
          点任务卡片查看详情；一次创建、按计划自动执行，客户回复/退订/退信自动止损。
        </div>
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onCreate}>创建任务</Button>
      </div>

      {/* 任务组卡片网格（整卡可点 → 查看详情抽屉） */}
      {rows.length === 0 && !isLoading ? (
        <Card>
          <Empty description="还没有开发任务 — 点右上角「创建任务」配置你的第一个任务组，或到 AI 助手说「给巴西的冷客户自动跟进」" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {rows.map(r => {
            const st = STATUS_TAG[r.status] ?? { color: "default", label: r.status };
            const planned = r.touchesPlanned;
            const remain = Math.max(0, planned - r.touchesSent);
            const pct = planned > 0 ? Math.min(100, Math.round((r.touchesSent / planned) * 100)) : 0;
            const drained = planned > 0 && remain === 0;
            return (
              <div key={r.id}
                onClick={() => setDrawerId(r.id)}
                className={`rounded-xl border bg-white p-4 transition-shadow hover:shadow-md cursor-pointer ${
                  r.status === "running" ? "border-teal-200" : "border-gray-200"
                }`}>
                {/* 卡片头：标题 + 状态 */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="text-[13px] font-semibold text-gray-800 truncate" title={r.name}>
                    {r.status === "running" && <span className="text-teal-500 mr-1">●</span>}{r.name}
                  </span>
                  <Tag color={st.color} className="!my-0 flex-shrink-0">{st.label}</Tag>
                </div>

                {/* 进度（封数口径：多轮任务发送途中就会往前走，不再等整条计划走完才动） */}
                <div className="mb-2">
                  <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                    <span>已发 {r.touchesSent}/{planned} 封</span>
                    <span>
                      {r.queuedGroups > 0
                        ? <span className="text-blue-600 font-medium">队列 {r.queuedGroups} 组</span>
                        : remain > 0 ? `还剩 ${remain} 封` : planned > 0 ? "全部处理完" : "—"}
                    </span>
                  </div>
                  <Progress percent={pct} size="small" showInfo={false}
                    status={r.status === "stopped" ? "normal" : drained ? "success" : r.status === "running" ? "active" : "normal"} />
                </div>

                {/* 止损计数 */}
                <div className="flex flex-wrap gap-1 mb-2 min-h-[22px]">
                  {r.replied > 0 && <Tag color="green" className="!my-0 !text-[10px]">回复 {r.replied}</Tag>}
                  {r.bounced > 0 && <Tag color="orange" className="!my-0 !text-[10px]">退信 {r.bounced}</Tag>}
                  {r.unsubscribed > 0 && <Tag className="!my-0 !text-[10px]">退订 {r.unsubscribed}</Tag>}
                  {r.skipped > 0 && <Tag className="!my-0 !text-[10px]">跳过 {r.skipped}</Tag>}
                  {r.replied + r.bounced + r.unsubscribed + r.skipped === 0 && (
                    <span className="text-[10px] text-gray-300">尚无回复/止损</span>
                  )}
                </div>

                {/* 计划摘要 + 创建时间 */}
                <div className="text-[11px] text-gray-400 flex items-center justify-between mb-3">
                  <span>{r.total} 人 · {r.planRounds} 轮计划 · {r.autoSend ? "无人值守" : "每轮手动开始"}</span>
                  <span className="font-mono">{fmtTime(r.createdAt)}</span>
                </div>

                {/* 操作（整卡可点→详情抽屉，这里只放控制按钮） */}
                <div className="flex gap-1 flex-wrap border-t border-gray-100 pt-2">
                  {cardOps(r)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 卡片展开：运行情况（队列组 + 引擎）+ 触点明细 */}
      <Drawer
        title={detail?.campaign ? `${detail.campaign.name} · 详情` : "任务详情"}
        placement="right"
        width={780}
        open={!!drawerId}
        onClose={() => setDrawerId(null)}
      >
        {detail?.campaign && (
          <div className="mb-3 flex items-center gap-2 flex-wrap text-[11px] text-gray-600">
            <Tag color={STATUS_TAG[detail.campaign.status]?.color} className="!my-0">
              {STATUS_TAG[detail.campaign.status]?.label ?? detail.campaign.status}
            </Tag>
            <span>{detail.campaign.planRounds} 轮计划</span>
            <span className="text-gray-300">·</span>
            <span>已发 {detail.campaign.touchesSent}/{detail.campaign.touchesPlanned} 封</span>
            <span className="text-gray-300">·</span>
            <span>{detail.campaign.autoSend ? "无人值守" : "每轮手动开始"}</span>
            {detail.raw?.accountPolicy === "fixed" && <Tag className="!my-0">指定账号</Tag>}
          </div>
        )}

        {/* 引擎状态条（全局单引擎；从这里控制发送的开始/暂停/取消） */}
        {engineBusy ? (
          <div className={`mb-3 rounded-lg border px-3 py-2 flex items-center justify-between gap-3 ${
            isRunning && isPaused && status?.pausedReason === "sender_block"
              ? "bg-red-50 border-red-200"
              : isRunning ? "bg-gray-50 border-gray-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center gap-2 text-xs text-gray-600 min-w-0">
              {isRunning && !isPaused && (
                <>
                  {status?.delayReason === "window"
                    ? <><ClockCircleOutlined className="text-teal-500" /> 未到发送时段 — 到点自动开始</>
                    : delayLeft > 0
                      ? <><ClockCircleOutlined className="text-teal-500" /> 组间等待 {fmtDelay(delayLeft)}</>
                      : <><LoadingOutlined className="text-blue-500" spin /> 正在发送</>}
                  <span className="text-gray-400">{status?.sentCount ?? 0}/{status?.totalItems ?? 0} 组</span>
                  {status?.currentItem && (
                    <span className="truncate text-gray-500">当前：{status.currentItem.companyName}</span>
                  )}
                </>
              )}
              {isRunning && isPaused && status?.pausedReason === "sender_block" && (
                <div className="min-w-0">
                  <div className="text-red-700 font-medium text-xs">发信被服务商反垃圾/限流拦截，整批已暂停（未发送的组都还在队列里）。</div>
                  <div className="text-[11px] text-red-600/80">被拦账号已摘出轮换，24 小时后自动放回；建议改内容/调长组间暂停再恢复。</div>
                </div>
              )}
              {isRunning && isPaused && status?.pausedReason !== "sender_block" && (
                <><PauseCircleOutlined className="text-amber-500" /> 已暂停 — {status?.sentCount ?? 0}/{status?.totalItems ?? 0} 组</>
              )}
              {!isRunning && totalQueuedGroups > 0 && (
                <>共 {totalQueuedGroups} 组待发送 — 到期触点已入队</>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {isRunning ? (
                <>
                  <Button size="small" icon={isPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                    onClick={() => { void engine(isPaused ? "resume" : "pause"); }}>
                    {isPaused ? "恢复" : "暂停"}
                  </Button>
                  <Tooltip title="取消后已发保留，未发丢弃">
                    <Button size="small" danger icon={<StopOutlined />}
                      onClick={() => { void engine("cancel"); }}>取消发送</Button>
                  </Tooltip>
                </>
              ) : (
                <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                  onClick={() => { void engine("start"); }}>开始发送</Button>
              )}
            </div>
          </div>
        ) : (
          <div className="mb-3 text-[11px] text-gray-400">发送引擎空闲 — 任务启动后，到期触点自动入队（每 10 分钟扫描一次）。</div>
        )}

        {/* 本任务队列组（卡片背后的后台） */}
        <div className="mb-1 text-[12px] font-medium text-gray-700">发送队列 · 本任务 {detail?.queue.length ?? 0} 组</div>
        <Table<QueueGroupRow>
          dataSource={detail?.queue ?? []}
          rowKey="id"
          size="small"
          loading={detailLoading}
          pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
          columns={queueColumns}
        />

        {/* 触点明细 */}
        <div className="mt-4 mb-1 text-[12px] font-medium text-gray-700">触点名单 · {detail?.targets.length ?? 0} 人</div>
        <Table<TargetRow>
          dataSource={detail?.targets ?? []}
          rowKey="contactId"
          size="small"
          loading={detailLoading}
          pagination={{ pageSize: 50, size: "small", showSizeChanger: false }}
          columns={targetColumns}
        />
      </Drawer>
    </div>
  );
}
