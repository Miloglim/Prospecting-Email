import { useState } from "react";
import { Table, Button, Input, Space, Modal, Form, message } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface Company {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  country: string | null;
}

export function CompanyList() {
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["companies", search],
    queryFn: () => window.api.invoke("companies:list", search) as Promise<{
      success: boolean; data?: Company[]; error?: string;
    }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("companies:upsert", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["companies"] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("companies:delete", id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["companies"] }); },
  });

  const companies = data?.success ? data.data || [] : [];

  const columns = [
    { title: "公司名称", dataIndex: "name", key: "name" },
    { title: "域名", dataIndex: "domain", key: "domain", render: (v: string | null) => v || "-" },
    { title: "行业", dataIndex: "industry", key: "industry", render: (v: string | null) => v || "-" },
    { title: "国家", dataIndex: "country", key: "country", width: 80 },
    {
      title: "操作", key: "actions", width: 80,
      render: (_: unknown, r: Company) => (
        <Button danger size="small" icon={<DeleteOutlined />}
          onClick={async () => {
            const result = await deleteMut.mutateAsync(r.id);
            result?.success ? message.success("已删除") : message.error(result?.error || "删除失败");
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Input prefix={<SearchOutlined />} placeholder="搜索公司名称或域名..."
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: 300 }} allowClear />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          新增公司
        </Button>
      </div>

      <Table dataSource={companies} columns={columns} rowKey="id"
        loading={isLoading} size="middle" />

      <Modal title="新增公司" open={addOpen}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const result = await upsertMut.mutateAsync(values);
          result?.success ? (setAddOpen(false), form.resetFields(), message.success("已保存"))
            : message.error(result?.error || "保存失败");
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="公司名称" rules={[{ required: true }]}>
            <Input placeholder="Acme Inc." />
          </Form.Item>
          <Form.Item name="domain" label="域名">
            <Input placeholder="acme.com" />
          </Form.Item>
          <Form.Item name="industry" label="行业">
            <Input placeholder="物流/贸易/..." />
          </Form.Item>
          <Form.Item name="country" label="国家代码">
            <Input placeholder="EN/ES/PT" maxLength={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
