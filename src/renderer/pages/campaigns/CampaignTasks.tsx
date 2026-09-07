import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";

// ═══════════════════════════════════════════════════════════════
// 发信任务（Campaign，docs/smart-send-spec.md）：一次批准、按计划自动跟进。
// 这张表是任务的"账本视图"：进度、回复止损计数、暂停/恢复/终止。
// 创建入口在对话（首页建议卡 → agent 编排 → 确认卡），这里只管看与控。
// ═══════════════════════════════════════════════════════════════

interface CampaignRow {
  id: string; name: string; status: string; autoSend: boolean; planRounds: number;
  total: number; pending: number; queued: number; sent: number;
  replied: number; bounced: number; unsubscribed: number; skipped: number;
  createdAt: string;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  running: { color: "processing", label: "进行中" },
  paused: { color: "warning", label: "已暂停" },
  done: { color: "success", label: "已完成" },
  stopped: { color: "default", label: "已终止" },
};

export function CampaignTasks() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => window.api.invoke("send:campaigns") as Promise<{ success: boolean; data?: CampaignRow[] }>,
    refetchInterval: 15_000,   // 调度器每 10 分钟排新触点，15s 轮询足够新鲜
  });
  const rows = data?.success ? (data.data ?? []) : [];

  const control = async (id: string, action: "pause" | "resume" | "stop", name: string) => {
    const verb = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "终止";
    const r = await window.api.invoke("send:campaignControl", { campaignId: id, action }) as { success: boolean; error?: string };
    if (!r?.success) { message.error(r?.error || `${verb}失败`); return; }
    message.success(`已${verb}「${name}」`);
    qc.invalidateQueries({ queryKey: ["campaigns"] });
  };

  const columns: ColumnsType<CampaignRow> = [
    {
      title: "任务", dataIndex: "name", key: "name",
      render: (v: string, r) => (
        <div>
          <span className="text-[12px] font-medium text-gray-800">
            {r.status === "running" && <span className="text-teal-600 mr-1">●</span>}{v}
          </span>
          <div className="text-[11px] text-gray-400">
            {r.planRounds} 轮计划 · {r.autoSend ? "无人值守" : "每轮手动开始"}
          </div>
        </div>
      ),
    },
    {
      title: "状态", dataIndex: "status", key: "status", width: 90,
      render: (v: string) => {
        const t = STATUS_TAG[v] ?? { color: "default", label: v };
        return <Tag color={t.color} className="!my-0">{t.label}</Tag>;
      },
    },
    {
      title: "进度", key: "progress", width: 200,
      render: (_: unknown, r) => (
        <span className="text-[11px] text-gray-600 font-mono">
          已发 {r.sent}/{r.total} · 待发 {r.pending + r.queued}
        </span>
      ),
    },
    {
      title: "回复/止损", key: "stoploss", width: 150,
      render: (_: unknown, r) => (
        <span className="text-[11px]">
          {r.replied > 0 && <Tag color="green" className="!my-0">回复 {r.replied}</Tag>}
          {r.bounced > 0 && <Tag color="orange" className="!my-0">退信 {r.bounced}</Tag>}
          {r.unsubscribed > 0 && <Tag className="!my-0">退订 {r.unsubscribed}</Tag>}
          {r.replied + r.bounced + r.unsubscribed === 0 && <span className="text-gray-400">—</span>}
        </span>
      ),
    },
    {
      title: "操作", key: "ops", width: 130,
      render: (_: unknown, r) => {
        const active = r.status === "running" || r.status === "paused";
        if (!active) return <span className="text-[11px] text-gray-400">—</span>;
        return (
          <div className="flex gap-1">
            {r.status === "running" ? (
              <Button size="small" style={{ fontSize: 12 }} onClick={() => { void control(r.id, "pause", r.name); }}>暂停</Button>
            ) : (
              <Button size="small" style={{ fontSize: 12 }} onClick={() => { void control(r.id, "resume", r.name); }}>恢复</Button>
            )}
            <Tooltip title="终止后待发触点全部清空，不可恢复">
              <Button size="small" danger style={{ fontSize: 12 }}
                onClick={() => { void control(r.id, "stop", r.name); }}>终止</Button>
            </Tooltip>
          </div>
        );
      },
    },
  ];

  return (
    <div className="pt-2">
      <div className="text-[11px] text-gray-500 mb-2 leading-relaxed">
        任务在对话里创建（首页建议卡 → agent 编排 → 确认）：首信发出后按计划自动跟进，
        客户回复/退订/退信自动止损。创建入口与明细查询找 AI 助手。
      </div>
      <Table<CampaignRow>
        dataSource={rows}
        rowKey="id"
        size="small"
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: "还没有发信任务 — 到 AI 助手首页点建议卡，或直接说「给巴西的冷客户自动跟进」" }}
        columns={columns}
      />
    </div>
  );
}
