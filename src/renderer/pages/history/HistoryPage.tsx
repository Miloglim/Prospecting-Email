import { useState } from "react";
import { Table, Card, Tabs, Input, Tag, Select, Button, Popconfirm, message } from "antd";
import { SearchOutlined, DeleteOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface HistoryRow {
  id: number; contactId: number; email: string;
  firstName: string | null; lastName: string | null;
  companyName: string | null; subject: string | null;
  accountEmail: string | null; sentAt: string;
}

interface BounceRow {
  id: number; contactId: number; email: string;
  firstName: string | null; lastName: string | null;
  companyName: string | null; subject: string | null;
  reason: string | null; detectedAt: string;
}

const DATE_FMT = (s: string) => {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.toLocaleDateString("zh-CN")} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
};

export function HistoryPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState<number | undefined>();

  const { data: history, isLoading: histLoading } = useQuery({
    queryKey: ["history", q, accountId],
    queryFn: () => window.api.invoke("history:list", { q, accountId }) as Promise<{
      success: boolean; data?: HistoryRow[];
    }>,
  });

  const { data: bounces, isLoading: bounceLoading } = useQuery({
    queryKey: ["bounce", q],
    queryFn: () => window.api.invoke("bounce:list", { q }) as Promise<{
      success: boolean; data?: BounceRow[];
    }>,
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{
      success: boolean; data?: Array<{ id: number; email: string }>;
    }>,
  });

  const histRows = history?.success ? history.data || [] : [];

  const clearMut = useMutation({
    mutationFn: () => window.api.invoke("history:clear") as Promise<{ success: boolean; data?: number; error?: string }>,
    onSuccess: (r: unknown) => {
      const rr = r as { success: boolean; data?: number; error?: string };
      rr?.success ? message.success(`已清除 ${rr.data} 条发送历史`) : message.error(rr?.error || "失败");
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const bounceRows = bounces?.success ? bounces.data || [] : [];

  const historyColumns = [
    {
      title: "时间", dataIndex: "sentAt", key: "at", width: 140,
      render: (v: string) => <span className="text-[11px] text-gray-500">{DATE_FMT(v)}</span>,
    },
    { title: "联系人", key: "name",
      render: (_: unknown, r: HistoryRow) =>
        <span className="text-xs">{r.firstName} {r.lastName}</span> },
    { title: "邮箱", dataIndex: "email", key: "email",
      render: (v: string) => <span className="text-[11px] font-mono text-gray-500">{v}</span> },
    { title: "公司", dataIndex: "companyName", key: "company",
      render: (v: string | null) => v || "-" },
    { title: "主题", dataIndex: "subject", key: "subject",
      render: (v: string | null) => <span className="text-[11px]">{v || "-"}</span> },
    { title: "发件账号", dataIndex: "accountEmail", key: "account",
      render: (v: string | null) => v ? <Tag className="text-[10px]">{v}</Tag> : "-" },
  ];

  const bounceColumns = [
    {
      title: "退信时间", dataIndex: "detectedAt", key: "at", width: 140,
      render: (v: string) => <span className="text-[11px] text-gray-500">{DATE_FMT(v)}</span>,
    },
    { title: "联系人", key: "name",
      render: (_: unknown, r: BounceRow) =>
        <span className="text-xs">{r.firstName} {r.lastName}</span> },
    { title: "邮箱", dataIndex: "email", key: "email",
      render: (v: string) => <span className="text-[11px] font-mono text-gray-500">{v}</span> },
    { title: "公司", dataIndex: "companyName", key: "company",
      render: (v: string | null) => v || "-" },
    {
      title: "原因", dataIndex: "reason", key: "reason",
      render: (v: string | null) =>
        <span className="text-[11px] text-red-500 line-clamp-2 max-w-[420px] block">{v || "-"}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <Card size="small">
        <div className="flex gap-3 flex-wrap">
          <Input
            prefix={<SearchOutlined className="text-gray-300" />}
            placeholder="搜索邮箱 / 公司名"
            allowClear value={q}
            onChange={e => setQ(e.target.value)}
            className="max-w-xs"
            size="small"
          />
          <Select
            placeholder="按发件账号筛选"
            allowClear value={accountId}
            onChange={setAccountId}
            options={(accounts?.success ? accounts.data || [] : []).map(a => ({ value: a.id, label: a.email }))}
            className="w-56"
            size="small"
          />
        </div>
      </Card>

      <Tabs
        size="small"
        items={[
          {
            key: "history", label: `发送历史 (${histRows.length})`,
            children: (
              <Card size="small">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs text-gray-400">共 {histRows.length} 条记录</span>
                  <Popconfirm title="清空所有发送历史？此操作不可恢复，仪表盘「已发送」计数也会清零" okText="清空" okType="danger" cancelText="取消" onConfirm={() => clearMut.mutate()}>
                    <Button size="small" danger icon={<DeleteOutlined />} loading={clearMut.isPending}>清空发送历史</Button>
                  </Popconfirm>
                </div>
                <Table dataSource={histRows} columns={historyColumns} rowKey="id"
                  loading={histLoading} size="small" pagination={{ pageSize: 50, showSizeChanger: false }} />
              </Card>
            ),
          },
          {
            key: "bounce", label: `退信日志 (${bounceRows.length})`,
            children: (
              <Card size="small">
                <Table dataSource={bounceRows} columns={bounceColumns} rowKey="id"
                  loading={bounceLoading} size="small" pagination={{ pageSize: 50, showSizeChanger: false }} />
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
