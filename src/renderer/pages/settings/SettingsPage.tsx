import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, Form, Input, InputNumber, Button, message, Table, Modal, Tag, Space,
  Descriptions, Switch, TimePicker, Divider,
} from "antd";
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, RobotOutlined } from "@ant-design/icons";
import dayjs from "dayjs";

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
}

interface SendSchedule {
  timeWindowEnabled: boolean;
  startHour: number; endHour: number;
  minDelaySeconds: number; maxDelaySeconds: number;
  companyDelayMinMinutes: number; companyDelayMaxMinutes: number;
  singleRecipDelayMinSeconds: number; singleRecipDelayMaxSeconds: number;
  templateRotateGroups: number;
  batchSize: number;
  batchPauseMinSeconds: number; batchPauseMaxSeconds: number;
}

interface RuntimeConfig {
  smtpAccounts: EmailAccount[];
  schedule: SendSchedule;
}

export function SettingsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [scheduleForm] = Form.useForm();
  const qc = useQueryClient();

  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: EmailAccount[] }>,
  });

  const { data: configData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{ success: boolean; data?: RuntimeConfig }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("accounts:upsert", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("accounts:delete", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const saveConfigMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); message.success("配置已保存"); },
  });

  const accounts = accountData?.success ? accountData.data || [] : [];
  const config = configData?.success ? configData.data : null;
  const sched = config?.schedule;

  const accountColumns = [
    {
      title: "邮箱", dataIndex: "email", key: "email",
      render: (v: string) => <span className="font-mono text-sm">{v}</span>,
    },
    { title: "SMTP", key: "smtp",
      render: (_: unknown, r: EmailAccount) => <span className="text-xs text-gray-500">{r.smtpHost}:{r.smtpPort}</span> },
    { title: "状态", key: "status", width: 70,
      render: (_: unknown, r: EmailAccount) => r.consecutiveFails > 0 ? <Tag color="orange">异常</Tag> : <Tag color="green">正常</Tag> },
    {
      title: "操作", key: "actions", width: 140,
      render: (_: unknown, r: EmailAccount) => (
        <Space size="small">
          <Button size="small" icon={<CheckCircleOutlined />} onClick={async () => {
            const res = await window.api.invoke("accounts:validate", r.id) as { success: boolean; data?: { smtpOk: boolean; imapOk: boolean }; error?: string };
            res?.success ? message.info(`SMTP: ${res.data?.smtpOk ? "✓" : "✗"} IMAP: ${res.data?.imapOk ? "✓" : "✗"}`) : message.error(res?.error || "失败");
          }}>测试</Button>
          <Button danger size="small" icon={<DeleteOutlined />} onClick={async () => {
            const res = await deleteMut.mutateAsync(r.id);
            res?.success ? message.success("已删除") : message.error(res?.error || "失败");
          }} />
        </Space>
      ),
    },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* 发件账号 */}
      <Card title="发件账号" extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>新增</Button>
      }>
        <Table dataSource={accounts} columns={accountColumns} rowKey="id" size="middle" pagination={false}
          locale={{ emptyText: "还没有发件账号" }} />
      </Card>

      {/* 模拟人工发送规则 */}
      <Card title={
        <div className="flex items-center gap-2">
          <RobotOutlined className="text-teal-500" />
          模拟人工发送规则
        </div>
      }>
        {sched && (
          <Form form={scheduleForm} layout="vertical" size="small"
            initialValues={{
              timeWindowEnabled: sched.timeWindowEnabled,
              timeRange: [dayjs().hour(sched.startHour).minute(0), dayjs().hour(sched.endHour).minute(0)],
              minDelaySeconds: sched.minDelaySeconds, maxDelaySeconds: sched.maxDelaySeconds,
              companyDelayMinMinutes: sched.companyDelayMinMinutes, companyDelayMaxMinutes: sched.companyDelayMaxMinutes,
              singleRecipDelayMinSeconds: sched.singleRecipDelayMinSeconds, singleRecipDelayMaxSeconds: sched.singleRecipDelayMaxSeconds,
              templateRotateGroups: sched.templateRotateGroups,
              batchSize: sched.batchSize,
              batchPauseMinSeconds: sched.batchPauseMinSeconds, batchPauseMaxSeconds: sched.batchPauseMaxSeconds,
            }}
            onFinish={(v) => {
              const startH = v.timeRange?.[0] ? v.timeRange[0].hour() : sched.startHour;
              const endH = v.timeRange?.[1] ? v.timeRange[1].hour() : sched.endHour;
              saveConfigMut.mutateAsync({
                schedule: {
                  timeWindowEnabled: v.timeWindowEnabled,
                  startHour: startH, endHour: endH,
                  minDelaySeconds: v.minDelaySeconds, maxDelaySeconds: v.maxDelaySeconds,
                  companyDelayMinMinutes: v.companyDelayMinMinutes, companyDelayMaxMinutes: v.companyDelayMaxMinutes,
                  singleRecipDelayMinSeconds: v.singleRecipDelayMinSeconds, singleRecipDelayMaxSeconds: v.singleRecipDelayMaxSeconds,
                  templateRotateGroups: v.templateRotateGroups,
                  batchSize: v.batchSize,
                  batchPauseMinSeconds: v.batchPauseMinSeconds, batchPauseMaxSeconds: v.batchPauseMaxSeconds,
                },
              });
            }}
          >
            {/* 时间窗口 */}
            <Form.Item label="发送时间窗口" className="mb-2">
              <div className="flex items-center gap-3">
                <Form.Item name="timeWindowEnabled" valuePropName="checked" noStyle>
                  <Switch size="small" />
                </Form.Item>
                <Form.Item name="timeRange" noStyle>
                  <TimePicker.RangePicker format="HH:mm" size="small" allowClear={false} />
                </Form.Item>
                <span className="text-[11px] text-gray-400">（北京时间，仅在窗口内发送）</span>
              </div>
            </Form.Item>

            <Divider className="my-3" />

            {/* 单封间隔 */}
            <div className="text-[11px] font-semibold text-gray-600 mb-2">单封邮件间隔（组内）</div>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <Form.Item name="minDelaySeconds" label="最小间隔（秒）">
                <InputNumber min={1} max={300} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="maxDelaySeconds" label="最大间隔（秒）">
                <InputNumber min={1} max={300} style={{ width: "100%" }} />
              </Form.Item>
            </div>

            {/* 公司组间隔 — 核心模拟人工 */}
            <div className="text-[11px] font-semibold text-gray-600 mb-2">
              公司组之间间隔 <span className="text-teal-500 font-normal">（核心：模拟人工一批批处理，15-20 分钟）</span>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <Form.Item name="companyDelayMinMinutes" label="最小间隔（分钟）">
                <InputNumber min={1} max={120} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="companyDelayMaxMinutes" label="最大间隔（分钟）">
                <InputNumber min={1} max={120} style={{ width: "100%" }} />
              </Form.Item>
            </div>

            {/* 单联系人额外间隔 */}
            <div className="text-[11px] font-semibold text-gray-600 mb-2">单公司单联系人额外间隔</div>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <Form.Item name="singleRecipDelayMinSeconds" label="最小（秒）">
                <InputNumber min={1} max={120} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="singleRecipDelayMaxSeconds" label="最大（秒）">
                <InputNumber min={1} max={120} style={{ width: "100%" }} />
              </Form.Item>
            </div>

            {/* 模板轮换 + 批次 */}
            <div className="text-[11px] font-semibold text-gray-600 mb-2">模板轮换 & 批次</div>
            <div className="grid grid-cols-3 gap-4 mb-3">
              <Form.Item name="templateRotateGroups" label="每几组换模板">
                <InputNumber min={1} max={20} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="batchSize" label="每批数量">
                <InputNumber min={1} max={100} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="batchPauseMinSeconds" label="批间暂停最小(秒)">
                <InputNumber min={1} max={600} style={{ width: "100%" }} />
              </Form.Item>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-3">
              <Form.Item name="batchPauseMaxSeconds" label="批间暂停最大(秒)">
                <InputNumber min={1} max={600} style={{ width: "100%" }} />
              </Form.Item>
            </div>

            <Button type="primary" htmlType="submit" size="small" loading={saveConfigMut.isPending}>
              保存发送规则
            </Button>
          </Form>
        )}
        {!sched && <div className="text-xs text-gray-400">配置加载中...</div>}
      </Card>

      {/* 系统信息 */}
      <Card title="系统信息">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="版本">Prospector 4.0.0</Descriptions.Item>
          <Descriptions.Item label="技术栈">Electron + TypeScript + React + SQLite</Descriptions.Item>
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
            r.success ? (setAddOpen(false), form.resetFields(), message.success("账号已保存，连接验证通过"))
              : message.error(r.error || "保存失败");
          }
        }}
        confirmLoading={upsertMut.isPending}
      >
        <Form form={form} layout="vertical" size="small">
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
            <Input.TextArea rows={3} placeholder="Best regards,\nJohn Doe\nABC Logistics" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
