import { useState } from "react";
import { Button, Card, Checkbox, Tag, message, Progress, Modal, Form, Input, Select } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, EyeOutlined, SendOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface TimeBucket {
  key: string; label: string; description: string;
  contacts: unknown[]; count: number;
}

interface Template {
  id: number; name: string; language: string;
  subject: string; body: string; category: string | null;
}

interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: unknown | null; delaySeconds: number;
  accountStats: Array<{ accountId: number; email: string; sent: number; failed: number; isCircuitOpen: boolean }>;
}

export function CampaignList() {
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>(["never"]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [customTemplate, setCustomTemplate] = useState<{ subject: string; body: string } | null>(null);
  const [composeForm] = Form.useForm();
  const qc = useQueryClient();

  // 时间桶
  const { data: buckets, isLoading: bucketsLoading } = useQuery({
    queryKey: ["send", "buckets"],
    queryFn: () => window.api.invoke("send:getTimeBuckets") as Promise<{
      success: boolean; data?: TimeBucket[];
    }>,
  });

  // 模板列表
  const { data: templateData } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{
      success: boolean; data?: Template[];
    }>,
  });

  // 发送状态
  const { data: statusData } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{ success: boolean; data?: SendStatus }>,
    refetchInterval: 3000,
  });

  const startMut = useMutation({
    mutationFn: (payload: { keys: string[]; template?: { subject: string; body: string } }) =>
      window.api.invoke("send:start", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["send"] }),
  });

  const status = statusData?.success ? statusData.data : null;
  const isRunning = status?.isRunning || false;
  const isPaused = status?.isPaused || false;

  const bucketList = buckets?.success ? buckets.data || [] : [];
  const templates = templateData?.success ? templateData.data || [] : [];
  const selectedTemplate = templates.find(t => t.id === templateId) || null;

  const selectedCount = bucketList
    .filter(b => selectedBuckets.includes(b.key))
    .reduce((s, b) => s + b.count, 0);

  const handlePreview = async () => {
    if (!selectedTemplate) return;
    const r = await window.api.invoke("send:preview", {
      subject: selectedTemplate.subject,
      body: selectedTemplate.body,
    }) as { success: boolean; data?: { subject: string; body: string } };
    if (r?.success) { setPreview(r.data); setPreviewOpen(true); }
    else message.error(r?.error || "预览失败");
  };

  const handleStart = async () => {
    const template = customTemplate
      ? customTemplate
      : selectedTemplate
        ? { subject: selectedTemplate.subject, body: selectedTemplate.body }
        : undefined;
    const r = await startMut.mutateAsync({ keys: selectedBuckets, template });
    if (r && typeof r === "object" && "success" in r) {
      const rr = r as { success: boolean; error?: string };
      rr.success ? message.success(`开始发送 ${selectedCount} 人`) : message.error(rr.error || "启动失败");
    }
  };

  return (
    <div className="space-y-6">
      {/* 发送状态栏 */}
      {isRunning && (
        <Card size="small">
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <Tag color={isPaused ? "orange" : "green"}>{isPaused ? "已暂停" : "发送中"}</Tag>
              <span className="text-gray-600">
                {status?.sentCount || 0} / {status?.totalItems || 0} 组
                {status?.failedCount ? `（${status.failedCount} 失败）` : ""}
              </span>
              {status?.delaySeconds ? <span className="text-gray-400">间隔: {status.delaySeconds}s</span> : null}
            </div>
            <Progress
              percent={status?.totalItems ? Math.round((status.sentCount + status.failedCount) / status.totalItems * 100) : 0}
              status={status?.failedCount ? "exception" : "active"} size="small"
            />
            <Button size="small" icon={isPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              onClick={() => { window.api.invoke(isPaused ? "send:resume" : "send:pause"); qc.invalidateQueries({ queryKey: ["send"] }); }}
            >{isPaused ? "恢复" : "暂停"}</Button>
          </div>
        </Card>
      )}

      {/* 撰写区 */}
      <Card title="发送撰写" size="small" extra={
        <Button type="primary" icon={<SendOutlined />} size="small"
          disabled={isRunning || selectedCount === 0 || (!selectedTemplate && !customTemplate)}
          loading={startMut.isPending} onClick={handleStart}
        >发送 {selectedCount} 人</Button>
      }>
        <div className="grid grid-cols-2 gap-4">
          {/* 左侧：时间桶 */}
          <div>
            <div className="text-[11px] font-semibold text-gray-600 mb-2">1. 选择发送范围</div>
            <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
              {bucketList.map(b => (
                <label key={b.key} className="flex items-center gap-2 p-2 rounded border border-gray-100 hover:border-gray-300 cursor-pointer text-xs">
                  <Checkbox
                    checked={selectedBuckets.includes(b.key)}
                    onChange={e => {
                      const checked = e.target.checked;
                      setSelectedBuckets(prev => checked ? [...prev, b.key] : prev.filter(k => k !== b.key));
                    }}
                    disabled={isRunning}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-700">{b.label}</span>
                      <Tag className="text-[9px] leading-none px-1 my-0">{b.count} 人</Tag>
                    </div>
                    <div className="text-[10px] text-gray-400">{b.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* 右侧：模板选择 */}
          <div>
            <div className="text-[11px] font-semibold text-gray-600 mb-2">2. 选择邮件模板</div>
            <div className="space-y-2">
              <Select
                placeholder="选择模板..."
                value={templateId}
                onChange={setTemplateId}
                style={{ width: "100%" }}
                options={templates.map(t => ({
                  value: t.id, label: `${t.name} (${t.language})`,
                }))}
                size="small"
              />
              {selectedTemplate && (
                <div className="text-[10px] text-gray-400 space-y-1 p-2 bg-gray-50 rounded">
                  <div><b>主题:</b> {selectedTemplate.subject}</div>
                  <div className="line-clamp-3"><b>正文:</b> {selectedTemplate.body}</div>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="small" icon={<EyeOutlined />} onClick={handlePreview} disabled={!selectedTemplate}>
                  预览渲染效果
                </Button>
                <Button size="small" onClick={() => setComposeOpen(true)} disabled={isRunning}>
                  自定义模板
                </Button>
              </div>
              <div className="text-[10px] text-gray-400">
                可用变量: <code className="bg-gray-100 px-1 rounded">{"{{firstName}}"}</code>{" "}
                <code className="bg-gray-100 px-1 rounded">{"{{lastName}}"}</code>{" "}
                <code className="bg-gray-100 px-1 rounded">{"{{company}}"}</code>{" "}
                <code className="bg-gray-100 px-1 rounded">{"{{email}}"}</code>
              </div>
            </div>
          </div>
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

      {/* 预览弹窗 */}
      <Modal title="邮件预览" open={previewOpen} onCancel={() => setPreviewOpen(false)}
        footer={null} width={560}
      >
        {preview && (
          <div className="text-sm space-y-3">
            <div className="font-semibold text-gray-800">{preview.subject}</div>
            <div className="border-t pt-3 text-[13px] text-gray-700 whitespace-pre-wrap leading-relaxed">
              {preview.body}
            </div>
          </div>
        )}
      </Modal>

      {/* 自定义模板弹窗 */}
      <Modal title="自定义模板" open={composeOpen} onCancel={() => setComposeOpen(false)}
        onOk={async () => {
          const v = await composeForm.validateFields();
          setCustomTemplate({ subject: v.subject, body: v.body });
          setComposeOpen(false);
          setPreview({ subject: v.subject, body: v.body });
          setPreviewOpen(true);
        }}
        width={560}
      >
        <Form form={composeForm} layout="vertical" size="small">
          <Form.Item name="subject" label="邮件主题" rules={[{ required: true }]}>
            <Input placeholder="{{firstName}} — 关于您的货运需求" />
          </Form.Item>
          <Form.Item name="body" label="邮件正文" rules={[{ required: true }]}>
            <Input.TextArea rows={8}
              placeholder={"Hi {{firstName}},\n\nI hope this email finds you well. ..."}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
