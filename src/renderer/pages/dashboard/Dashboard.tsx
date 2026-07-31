import { useQuery } from "@tanstack/react-query";
import { Card, Statistic, Row, Col, Table } from "antd";
import {
  UserOutlined, SendOutlined, MessageOutlined, WarningOutlined,
} from "@ant-design/icons";

interface DashboardStats {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  openRate: number;
  replyRate: number;
  pipelineSummary: Record<string, number>;
  recentActivity: Array<{
    type: string; contactEmail: string; subject: string | null; createdAt: string;
  }>;
}

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
                <Statistic title={stage} value={count} />
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
              { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 180 },
            ]}
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={false}
          />
        </Card>
      )}
    </div>
  );
}
