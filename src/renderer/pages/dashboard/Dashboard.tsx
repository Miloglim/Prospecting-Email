import { useQuery } from "@tanstack/react-query";
import { Card, Statistic, Row, Col, Table, Tag } from "antd";
import {
  UserOutlined, SendOutlined, MessageOutlined, WarningOutlined,
} from "@ant-design/icons";

interface DashboardStats {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  pipelineSummary: Record<string, number>;
  recentActivity: Array<{
    type: string; contactEmail: string; subject: string | null; createdAt: string;
  }>;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const STAGE_LABELS: Record<string, string> = {
  reaching: "触达中", quoting: "报价中", trial: "试单",
  cooperating: "合作中", lost: "已流失", other: "其他",
};

export function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => window.api.invoke("dashboard:stats") as Promise<{
      success: boolean; data?: DashboardStats; error?: string;
    }>,
    refetchInterval: 30_000,
  });

  const stats = data?.success ? data.data : null;

  return (
    <div className="space-y-6">
      {/* 统计卡片 */}
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="联系人总数"
              value={stats?.totalContacts || 0}
              prefix={<UserOutlined />}
              loading={isLoading}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="已发送"
              value={stats?.totalSent || 0}
              prefix={<SendOutlined />}
              loading={isLoading}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="已回复"
              value={stats?.totalReplied || 0}
              prefix={<MessageOutlined />}
              loading={isLoading}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="退信"
              value={stats?.bounceCount || 0}
              prefix={<WarningOutlined />}
              valueStyle={{ color: stats?.bounceCount ? "#ef4444" : undefined }}
              loading={isLoading}
            />
          </Card>
        </Col>
      </Row>

      {/* 管线概览 */}
      {stats?.pipelineSummary && Object.keys(stats.pipelineSummary).length > 0 && (
        <Card title="CRM 管线概览" size="small">
          <Row gutter={16}>
            {Object.entries(stats.pipelineSummary).map(([stage, count]) => (
              <Col key={stage} span={3}>
                <Statistic title={STAGE_LABELS[stage] || stage} value={count} />
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* 最近活动 */}
      {stats?.recentActivity && stats.recentActivity.length > 0 && (
        <Card title="最近活动" size="small">
          <Table
            dataSource={stats.recentActivity}
            columns={[
              { title: "类型", dataIndex: "type", key: "type", width: 100 },
              { title: "联系人", dataIndex: "contactEmail", key: "contactEmail" },
              { title: "主题", dataIndex: "subject", key: "subject" },
              { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 150,
                render: (v: string) => <span className="text-[11px] text-gray-500">{fmtTime(v)}</span> },
            ]}
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={false}
          />
        </Card>
      )}

      {/* 今日任务 — 待跟进 */}
      <TodayTasks />
    </div>
  );
}

interface ReminderContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  companyName: string | null; reminderAt: string | null; followupNote: string | null;
}

function TodayTasks() {
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "reminders"],
    queryFn: () => window.api.invoke("crm:checkReminders") as Promise<{
      success: boolean; data?: { due: ReminderContact[]; overdue: ReminderContact[] };
    }>,
    refetchInterval: 60000,
  });

  const due = data?.success ? data.data?.due || [] : [];
  const overdue = data?.success ? data.data?.overdue || [] : [];

  if (isLoading || (due.length === 0 && overdue.length === 0)) return null;

  return (
    <Card title={
      <div className="flex items-center gap-2">
        今日任务
        {overdue.length > 0 && <Tag color="red" className="text-[9px] px-1">{overdue.length} 逾期</Tag>}
        {due.length > 0 && <Tag className="text-[9px] px-1">{due.length} 待跟进</Tag>}
      </div>
    } size="small">
      <Table
        dataSource={[...overdue, ...due]}
        rowKey="id"
        size="small"
        pagination={false}
        columns={[
          {
            title: "状态", key: "status", width: 70,
            render: (_: unknown, r: ReminderContact) => (
              new Date(r.reminderAt || "") < new Date()
                ? <Tag color="red" className="text-[9px] px-1">逾期</Tag>
                : <Tag color="orange" className="text-[9px] px-1">今天</Tag>
            ),
          },
          {
            title: "联系人", key: "name",
            render: (_: unknown, r: ReminderContact) => (
              <span className="text-xs">{r.firstName} {r.lastName}</span>
            ),
          },
          { title: "邮箱", dataIndex: "email", key: "email",
            render: (v: string) => <span className="text-[11px] font-mono text-gray-500">{v}</span> },
          { title: "公司", dataIndex: "companyName", key: "company",
            render: (v: string | null) => v || "-" },
          {
            title: "提醒时间", dataIndex: "reminderAt", key: "at", width: 110,
            render: (v: string) => <span className="text-[11px]">{fmtTime(v)}</span>,
          },
          { title: "备注", dataIndex: "followupNote", key: "note",
            render: (v: string | null) => <span className="text-[11px] text-gray-500">{v || "-"}</span> },
        ]}
      />
    </Card>
  );
}
