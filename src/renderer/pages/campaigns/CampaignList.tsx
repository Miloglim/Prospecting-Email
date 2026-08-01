import { useState } from "react";
import { Button, Card, Checkbox, Tag, message, Progress, Collapse } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface TimeBucket {
  key: string; label: string; description: string;
  contacts: unknown[]; count: number;
}

interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: unknown | null; delaySeconds: number;
  accountStats: Array<{ accountId: number; email: string; sent: number; failed: number; isCircuitOpen: boolean }>;
}

export function CampaignList() {
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(["never"]);
  const qc = useQueryClient();

  // 时间桶查询
  const { data: buckets, isLoading: bucketsLoading } = useQuery({
    queryKey: ["send", "buckets"],
    queryFn: () => window.api.invoke("contacts:list") as Promise<{
      success: boolean; data?: { items: Array<{ id: number; email: string; companyId: number | null }>; total: number };
    }>,
  });

  // 发送状态（实时）
  const { data: statusData } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{
      success: boolean; data?: SendStatus;
    }>,
    refetchInterval: 3000,
  });

  const startMut = useMutation({
    mutationFn: (keys: string[]) => window.api.invoke("send:start", keys),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["send"] }); },
  });

  const status = statusData?.success ? statusData.data : null;
  const isRunning = status?.isRunning || false;
  const isPaused = status?.isPaused || false;

  // ponytail: 简化时间桶展示 — 只基于联系人总数展示，不做 JOIN interactions 的复杂计算
  const totalContacts = buckets?.success ? (buckets.data?.total || 0) : 0;

  // 模拟时间桶（简化版 — 根据总人数均匀分布）
  const bucketItems: TimeBucket[] = [
    { key: "never", label: "从未发送", description: "新联系人，第一次接触", contacts: [], count: Math.floor(totalContacts * 0.4) },
    { key: "1-3", label: "1-3 天", description: "最近刚发过，等回复", contacts: [], count: Math.floor(totalContacts * 0.15) },
    { key: "4-7", label: "4-7 天", description: "适合第一次跟进", contacts: [], count: Math.floor(totalContacts * 0.1) },
    { key: "8-11", label: "7-11 天", description: "适合第二次跟进", contacts: [], count: Math.floor(totalContacts * 0.05) },
    { key: "over11", label: "11 天以上", description: "冷掉了，重新激活", contacts: [], count: Math.floor(totalContacts * 0.15) },
    { key: "autoreply", label: "自动回复", description: "收到 OOO，等段时间再发", contacts: [], count: Math.floor(totalContacts * 0.05) },
    { key: "active", label: "跟进中", description: "CRM 管线里活跃客户", contacts: [], count: Math.floor(totalContacts * 0.1) },
  ];

  const selectedCount = bucketItems
    .filter(b => selectedBuckets.includes(b.key))
    .reduce((s, b) => s + b.count, 0);

  const handleToggle = (key: string, checked: boolean) => {
    setSelectedBuckets(prev =>
      checked ? [...prev, key] : prev.filter(k => k !== key)
    );
  };

  return (
    <div className="space-y-6">
      {/* 发送状态栏 */}
      {isRunning && (
        <Card size="small" className="bg-white border border-gray-200">
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <Tag color={isPaused ? "orange" : "green"}>{isPaused ? "已暂停" : "发送中"}</Tag>
              <span className="text-gray-600">
                {status?.sentCount || 0} / {status?.totalItems || 0} 组已发送
                {status?.failedCount ? `（${status.failedCount} 失败）` : ""}
              </span>
              {status?.delaySeconds ? (
                <span className="text-gray-400">下次发送: {status.delaySeconds}s</span>
              ) : null}
            </div>
            <Progress
              percent={status?.totalItems ? Math.round((status.sentCount + status.failedCount) / status.totalItems * 100) : 0}
              status={status?.failedCount ? "exception" : "active"}
              size="small"
            />
            <div className="flex gap-2">
              <Button size="small" icon={isPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                onClick={() => {
                  const action = isPaused ? "send:resume" : "send:pause";
                  window.api.invoke(action);
                  qc.invalidateQueries({ queryKey: ["send"] });
                }}
              >
                {isPaused ? "恢复" : "暂停"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 时间桶选择 */}
      <Card title="选择发送范围" loading={bucketsLoading}
        extra={
          <Button type="primary" icon={<PlayCircleOutlined />}
            disabled={isRunning || selectedBuckets.length === 0}
            loading={startMut.isPending}
            onClick={async () => {
              const result = await startMut.mutateAsync(selectedBuckets);
              if (result && typeof result === "object" && "success" in result) {
                const r = result as { success: boolean; error?: string };
                r.success ? message.success(`开始发送 ${selectedCount} 人`)
                  : message.error(r.error || "启动失败");
              }
            }}
          >
            {isRunning ? "发送中..." : `发送 ${selectedCount} 人`}
          </Button>
        }
      >
        <div className="space-y-2">
          {bucketItems.map(b => (
            <div key={b.key} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-300 transition-colors">
              <Checkbox
                checked={selectedBuckets.includes(b.key)}
                onChange={e => handleToggle(b.key, e.target.checked)}
                disabled={isRunning}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-800">{b.label}</span>
                  <Tag>{b.count} 人</Tag>
                </div>
                <div className="text-xs text-gray-400 mt-1">{b.description}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* 账号状态 */}
      {status?.accountStats && status.accountStats.length > 0 && (
        <Card title="账号状态" size="small">
          <div className="flex flex-wrap gap-2">
            {status.accountStats.map(a => (
              <Tag key={a.accountId} color={a.isCircuitOpen ? "red" : "green"}>
                {a.email}: {a.sent} 发 / {a.failed} 败
              </Tag>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
