import { useQuery } from "@tanstack/react-query";
import { Table, Tag, Select, Button, Space } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

const CLASSIFY_COLORS: Record<string, string> = {
  reply: "green", bounce: "red", auto_reply: "orange", unknown: "default",
};

interface InboxItem {
  id: number; fromEmail: string; fromName: string | null;
  subject: string | null; classification: string | null;
  matchedContactId: number | null; isRead: number;
  receivedAt: string;
}

export function InboxList() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => window.api.invoke("inbox:fetch") as Promise<{
      success: boolean; data?: InboxItem[]; error?: string;
    }>,
  });

  const items = data?.success ? data.data || [] : [];

  const columns = [
    {
      title: "状态", dataIndex: "isRead", key: "isRead", width: 60,
      render: (v: number) => v === 0
        ? <div className="w-2 h-2 rounded-full bg-violet-500" />
        : <div className="w-2 h-2 rounded-full bg-gray-300" />,
    },
    { title: "发件人", key: "from",
      render: (_: unknown, r: InboxItem) => (
        <div>
          <div className="text-sm">{r.fromName || r.fromEmail}</div>
          <div className="text-xs text-gray-500">{r.fromEmail}</div>
        </div>
      ),
    },
    { title: "主题", dataIndex: "subject", key: "subject",
      render: (v: string | null) => v || <span className="text-gray-400">无主题</span> },
    {
      title: "分类", dataIndex: "classification", key: "classification", width: 100,
      render: (v: string | null) => (
        <Tag color={CLASSIFY_COLORS[v || "unknown"]}>{v || "未知"}</Tag>
      ),
    },
    { title: "时间", dataIndex: "receivedAt", key: "receivedAt", width: 160,
      render: (v: string) => new Date(v).toLocaleString("zh-CN") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-600">{items.length} 封邮件</span>
        <Button icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>
      </div>

      <Table dataSource={items} columns={columns} rowKey="id"
        loading={isLoading} size="middle" />
    </div>
  );
}
