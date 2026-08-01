import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, Form, Input, InputNumber, Button, message, Table, Modal, Tag, Space, Descriptions } from "antd";
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined } from "@ant-design/icons";

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
}

export function SettingsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [configForm] = Form.useForm();
  const qc = useQueryClient();

  // 账号列表
  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{
      success: boolean; data?: EmailAccount[];
    }>,
  });

  // 全局配置
  const { data: configData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{
      success: boolean; data?: { schedule: { minDelaySeconds: number; maxPerBatch: number } };
    }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("accounts:upsert", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("accounts:delete", id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); },
  });

  const saveConfigMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input),
    onSuccess: () => message.success("配置已保存"),
  });

  const accounts = accountData?.success ? accountData.data || [] : [];
  const config = configData?.success ? configData.data : null;

  const columns = [
    {
      title: "邮箱", dataIndex: "email", key: "email",
      render: (v: string) => <span className="font-mono text-sm">{v}</span>,
    },
    { title: "SMTP", key: "smtp",
      render: (_: unknown, r: EmailAccount) =>
        <span className="text-xs text-gray-500">{r.smtpHost}:{r.smtpPort}</span>,
    },
    {
      title: "状态", key: "status", width: 80,
      render: (_: unknown, r: EmailAccount) => r.consecutiveFails > 0
        ? <Tag color="orange">异常</Tag>
        : <Tag color="green">正常</Tag>,
    },
    {
      title: "操作", key: "actions", width: 140,
      render: (_: unknown, r: EmailAccount) => (
        <Space size="small">
          <Button size="small" icon={<CheckCircleOutlined />}
            onClick={async () => {
              const result = await window.api.invoke("accounts:validate", r.id) as {
                success: boolean; data?: { smtpOk: boolean; imapOk: boolean };
              };
              if (result?.success) {
                const d = result.data;
                message.info(`SMTP: ${d?.smtpOk ? "✓" : "✗"}  IMAP: ${d?.imapOk ? "✓" : "✗"}`);
              }
            }}
          >测试</Button>
          <Button danger size="small" icon={<DeleteOutlined />}
            onClick={async () => {
              const res = await deleteMut.mutateAsync(r.id);
              res?.success ? message.success("已删除") : message.error(res?.error || "失败");
            }}
          />
        </Space>
      ),
    },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* 账号管理 */}
      <Card title="发件账号" extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>新增</Button>
      }>
        <Table dataSource={accounts} columns={columns} rowKey="id"
          size="middle" pagination={false} locale={{ emptyText: "还没有发件账号" }} />
      </Card>

      {/* 发送设置 */}
      <Card title="发送设置">
        <Form form={configForm} layout="vertical"
          initialValues={config?.schedule || { minDelaySeconds: 30, maxPerBatch: 50 }}
          onFinish={(v) => saveConfigMut.mutateAsync({ schedule: v })}
        >
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="minDelaySeconds" label="发送间隔（秒）" rules={[{ required: true }]}>
              <InputNumber min={5} max={300} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="maxPerBatch" label="每批最大数量" rules={[{ required: true }]}>
              <InputNumber min={1} max={200} style={{ width: "100%" }} />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" loading={saveConfigMut.isPending}>保存</Button>
        </Form>
      </Card>

      {/* 系统信息 */}
      <Card title="系统信息">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="版本">Prospector 4.0.0</Descriptions.Item>
          <Descriptions.Item label="技术栈">Electron + TypeScript + React + SQLite</Descriptions.Item>
          <Descriptions.Item label="数据库">data/prospector.db</Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 新增账号弹窗 */}
      <Modal title="新增发件账号" open={addOpen} width={560}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const result = await upsertMut.mutateAsync(values);
          if (result && typeof result === "object" && "success" in result) {
            const r = result as { success: boolean; error?: string };
            if (r.success) {
              message.success("账号已保存，连接验证通过");
              setAddOpen(false);
              form.resetFields();
            } else {
              message.error(r.error || "保存失败");
            }
          }
        }}
        confirmLoading={upsertMut.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="email" label="邮箱地址" rules={[{ required: true, type: "email" }]}>
            <Input placeholder="sender@company.com" />
          </Form.Item>
          <Form.Item name="displayName" label="发件人名称">
            <Input placeholder="John from ABC Logistics" />
          </Form.Item>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="smtpHost" label="SMTP 服务器" rules={[{ required: true }]}>
              <Input placeholder="smtp.office365.com" />
            </Form.Item>
            <Form.Item name="smtpPort" label="SMTP 端口" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} style={{ width: "100%" }} />
            </Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="imapHost" label="IMAP 服务器">
              <Input placeholder="outlook.office365.com" />
            </Form.Item>
            <Form.Item name="imapPort" label="IMAP 端口">
              <InputNumber min={1} max={65535} style={{ width: "100%" }} />
            </Form.Item>
          </div>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password placeholder="邮箱密码或应用专用密码" />
          </Form.Item>
          <Form.Item name="signature" label="HTML 签名">
            <Input.TextArea rows={3} placeholder="Best regards,&#10;John Doe&#10;ABC Logistics" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
