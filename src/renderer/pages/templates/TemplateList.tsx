import { useState } from "react";
import { Table, Button, Input, Modal, Form, Select, message, Tag } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const LANGUAGES = ["EN", "ES", "PT"];
const CATEGORIES = ["hook", "pain_point", "proof", "cta", "custom"];

interface Template {
  id: number; name: string; language: string; subject: string;
  category: string | null; version: number;
}

export function TemplateList() {
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{
      success: boolean; data?: Template[]; error?: string;
    }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("templates:upsert", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("templates:delete", id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); },
  });

  const templates = data?.success ? data.data || [] : [];

  const columns = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "语言", dataIndex: "language", key: "language", width: 60,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: "主题", dataIndex: "subject", key: "subject" },
    { title: "分类", dataIndex: "category", key: "category", width: 100,
      render: (v: string | null) => v ? <Tag color="purple">{v}</Tag> : "-" },
    { title: "版本", dataIndex: "version", key: "version", width: 60 },
    {
      title: "操作", key: "actions", width: 80,
      render: (_: unknown, r: Template) => (
        <Button danger size="small" icon={<DeleteOutlined />}
          onClick={async () => {
            const result = await deleteMut.mutateAsync(r.id);
            result?.success ? message.success("已删除") : message.error(result?.error || "失败");
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <span className="text-sm text-zinc-400">{templates.length} 个模板</span>
        <Button type="primary" icon={<PlusOutlined />}
          onClick={() => setAddOpen(true)}>新增模板</Button>
      </div>

      <Table dataSource={templates} columns={columns} rowKey="id"
        loading={isLoading} size="middle" />

      <Modal title="新增模板" open={addOpen} width={600}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const result = await upsertMut.mutateAsync(values);
          result?.success ? (setAddOpen(false), form.resetFields(), message.success("已保存"))
            : message.error(result?.error || "保存失败");
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input placeholder="Hook - 痛点问题" />
          </Form.Item>
          <Form.Item name="language" label="语言" rules={[{ required: true }]}>
            <Select options={LANGUAGES.map(l => ({ value: l, label: l }))} />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select options={CATEGORIES.map(c => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item name="subject" label="邮件主题" rules={[{ required: true }]}>
            <Input placeholder="{{ contact.first_name }} — 关于您的货运需求" />
          </Form.Item>
          <Form.Item name="body" label="邮件正文" rules={[{ required: true }]}>
            <Input.TextArea rows={8}
              placeholder="Hi {{ contact.first_name }},&#10;&#10;I noticed that your company..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
