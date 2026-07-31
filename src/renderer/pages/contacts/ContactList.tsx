import { useState } from "react";
import { Table, Button, Input, Space, Modal, Form, message } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined } from "@ant-design/icons";
import { useContacts, useUpsertContact, useDeleteContact, type Contact } from "../../hooks/useContacts";

export function ContactList() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();

  const { data, isLoading, error } = useContacts({ search, page });
  const upsertContact = useUpsertContact();
  const deleteContact = useDeleteContact();

  // 加载状态
  if (isLoading) return <Table loading />;

  // 错误状态
  if (error) {
    return (
      <div className="text-red-400 p-4 border border-red-800 rounded bg-red-950/20">
        加载失败: {String(error)}
      </div>
    );
  }

  const contacts = data?.success ? (data.data?.items || []) : [];
  const total = data?.success ? (data.data?.total || 0) : 0;

  const columns = [
    {
      title: "邮箱",
      dataIndex: "email",
      key: "email",
      render: (email: string) => <span className="text-violet-400 font-mono text-sm">{email}</span>,
    },
    {
      title: "名",
      dataIndex: "firstName",
      key: "firstName",
      render: (v: string | null) => v || "-",
    },
    {
      title: "姓",
      dataIndex: "lastName",
      key: "lastName",
      render: (v: string | null) => v || "-",
    },
    {
      title: "职位",
      dataIndex: "title",
      key: "title",
      render: (v: string | null) => v || "-",
    },
    {
      title: "来源",
      dataIndex: "source",
      key: "source",
      width: 100,
    },
    {
      title: "操作",
      key: "actions",
      width: 80,
      render: (_: unknown, record: Contact) => (
        <Button
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={async () => {
            const result = await deleteContact.mutateAsync(record.id);
            if (result?.success) {
              message.success("已删除");
            } else {
              message.error(result?.error || "删除失败");
            }
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索邮箱、姓名、职位..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          style={{ width: 300 }}
          allowClear
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          新增联系人
        </Button>
      </div>

      {/* 表格 */}
      <Table
        dataSource={contacts}
        columns={columns}
        rowKey="id"
        pagination={{
          current: page,
          pageSize: 50,
          total,
          onChange: setPage,
          showTotal: t => `共 ${t} 个联系人`,
        }}
        size="middle"
      />

      {/* 新增弹窗 */}
      <Modal
        title="新增联系人"
        open={addOpen}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const result = await upsertContact.mutateAsync(values);
          if (result?.success) {
            message.success("联系人已保存");
            setAddOpen(false);
            form.resetFields();
          } else {
            message.error(result?.error || "保存失败");
          }
        }}
        confirmLoading={upsertContact.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
            <Input placeholder="contact@example.com" />
          </Form.Item>
          <Form.Item name="firstName" label="名">
            <Input placeholder="John" />
          </Form.Item>
          <Form.Item name="lastName" label="姓">
            <Input placeholder="Doe" />
          </Form.Item>
          <Form.Item name="title" label="职位">
            <Input placeholder="CEO" />
          </Form.Item>
          <Form.Item name="phone" label="电话">
            <Input placeholder="+1 234 567 890" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
