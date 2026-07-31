import { useState } from "react";
import { Table, Button, Tag, Input, Space, message } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, SendOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function CampaignList() {
  const [composeOpen, setComposeOpen] = useState(false);
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{
      success: boolean; data?: { queueLength: number; sentToday: number; isPaused: boolean };
    }>,
    refetchInterval: 5000,
  });

  const sendStatus = status?.success ? status.data : null;

  return (
    <div className="space-y-6">
      {/* 发送状态栏 */}
      <div className="flex items-center gap-6 p-4 bg-zinc-900 rounded-lg border border-zinc-800">
        <div>
          <div className="text-2xl font-bold text-zinc-100">{sendStatus?.sentToday || 0}</div>
          <div className="text-xs text-zinc-500">今日已发送</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-zinc-100">{sendStatus?.queueLength || 0}</div>
          <div className="text-xs text-zinc-500">队列待发</div>
        </div>
        <Tag color={sendStatus?.isPaused ? "orange" : "green"}>
          {sendStatus?.isPaused ? "已暂停" : "运行中"}
        </Tag>
        <div className="ml-auto flex gap-2">
          <Button icon={<PauseCircleOutlined />}
            onClick={async () => {
              await window.api.invoke("send:pause");
              qc.invalidateQueries({ queryKey: ["send"] });
            }}
          >
            暂停
          </Button>
          <Button icon={<PlayCircleOutlined />}
            onClick={async () => {
              await window.api.invoke("send:resume");
              qc.invalidateQueries({ queryKey: ["send"] });
            }}
          >
            恢复
          </Button>
          <Button type="primary" icon={<SendOutlined />}
            onClick={() => setComposeOpen(true)}
          >
            新建发送
          </Button>
        </div>
      </div>

      {/* 发送历史 */}
      <Table
        columns={[
          { title: "主题", dataIndex: "subject", key: "subject" },
          { title: "收件人", dataIndex: "recipientCount", key: "recipients" },
          { title: "状态", dataIndex: "status", key: "status" },
          { title: "时间", dataIndex: "createdAt", key: "createdAt" },
        ]}
        dataSource={[]}
        rowKey="id"
        size="middle"
        locale={{ emptyText: "还没有发送记录" }}
      />
    </div>
  );
}
