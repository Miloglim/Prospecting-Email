import { useState } from "react";
import { Table, Button, Input, Space, Drawer, Descriptions, Tag, message, Form } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { useContacts, useUpsertContact, useDeleteContact, type Contact } from "../../hooks/useContacts";
import { useQuery } from "@tanstack/react-query";
import { Timeline } from "antd";

const INTERACTION_COLORS: Record<string, string> = {
  sent: "#5c6bc0", replied: "#22a644", bounced: "#d93025", autoreply: "#ff9800",
};
const INTERACTION_LABELS: Record<string, string> = {
  sent: "已发送", replied: "已回复", bounced: "退信", autoreply: "自动回复",
};

export function ContactList() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading, error } = useContacts({ search, page });
  const upsertContact = useUpsertContact();
  const deleteContact = useDeleteContact();

  const contacts = data?.success ? (data.data?.items || []) : [];
  const total = data?.success ? (data.data?.total || 0) : 0;

  const columns = [
    {
      title: "邮箱", dataIndex: "email", key: "email",
      render: (v: string) => <span className="text-xs font-mono text-blue-600">{v}</span>,
    },
    { title: "名", dataIndex: "firstName", key: "fn", width: 80, render: (v: string | null) => v || "-" },
    { title: "姓", dataIndex: "lastName", key: "ln", width: 80, render: (v: string | null) => v || "-" },
    { title: "职位", dataIndex: "title", key: "title", width: 140, render: (v: string | null) => v ? <span className="text-xs text-gray-500">{v}</span> : "-" },
    { title: "电话", dataIndex: "phone", key: "phone", width: 130, render: (v: string | null) => v || "-" },
    { title: "来源", dataIndex: "source", key: "source", width: 60, render: (v: string | null) => v ? <Tag className="text-[10px] leading-none px-1">{v}</Tag> : null },
    {
      title: "", key: "actions", width: 40,
      render: (_: unknown, r: Contact) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />}
          onClick={async (e) => { e.stopPropagation();
            const res = await deleteContact.mutateAsync(r.id);
            res?.success ? message.success("已删除") : message.error(res?.error || "失败");
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* 工具栏 — 紧凑 */}
      <div className="flex items-center justify-between">
        <Input prefix={<SearchOutlined />} placeholder="搜索邮箱、姓名..."
          value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
          size="small" style={{ width: 260 }} allowClear />
        <Space size="small">
          <span className="text-xs text-gray-400">共 {total} 人</span>
          <Button type="primary" size="small" icon={<PlusOutlined />}
            onClick={() => { form.resetFields(); setAddOpen(true); }}>新增</Button>
        </Space>
      </div>

      {/* 加载 / 错误 */}
      {error && <div className="text-xs text-red-500 p-2 bg-red-50 rounded">加载失败</div>}

      {/* 表格 — 高密度 */}
      <Table
        dataSource={contacts}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{
          current: page, pageSize: 50, total, onChange: setPage,
          size: "small", showSizeChanger: false,
          showTotal: t => `${t} 人`,
        }}
        onRow={(record) => ({
          onDoubleClick: () => setDetailContact(record),
        })}
        rowClassName="cursor-pointer"
      />

      {/* 新增弹窗 — 紧凑 */}
      <Drawer title="新增联系人" open={addOpen} onClose={() => setAddOpen(false)} width={400}>
        <Form form={form} layout="vertical" size="small"
          onFinish={async (v) => {
            const r = await upsertContact.mutateAsync(v);
            r?.success ? (setAddOpen(false), message.success("已保存")) : message.error(r?.error || "失败");
          }}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
            <Input size="small" />
          </Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="firstName" label="名"><Input size="small" /></Form.Item>
            <Form.Item name="lastName" label="姓"><Input size="small" /></Form.Item>
          </div>
          <Form.Item name="title" label="职位"><Input size="small" /></Form.Item>
          <Form.Item name="phone" label="电话"><Input size="small" /></Form.Item>
          <Form.Item name="linkedinUrl" label="LinkedIn"><Input size="small" /></Form.Item>
          <Form.Item name="country" label="语言偏好">
            <Input size="small" maxLength={2} placeholder="EN/ES/PT" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="small" block loading={upsertContact.isPending}>
            保存
          </Button>
        </Form>
      </Drawer>

      {/* 详情抽屉 — 双击打开 */}
      <Drawer
        title={detailContact ? `${detailContact.firstName || ""} ${detailContact.lastName || ""}` : "详情"}
        open={!!detailContact}
        onClose={() => setDetailContact(null)}
        width={480}
      >
        {detailContact && (
          <div className="space-y-4">
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="邮箱" span={2}>{detailContact.email}</Descriptions.Item>
              <Descriptions.Item label="名">{detailContact.firstName || "-"}</Descriptions.Item>
              <Descriptions.Item label="姓">{detailContact.lastName || "-"}</Descriptions.Item>
              <Descriptions.Item label="职位">{detailContact.title || "-"}</Descriptions.Item>
              <Descriptions.Item label="电话">{detailContact.phone || "-"}</Descriptions.Item>
              <Descriptions.Item label="LinkedIn" span={2}>
                {detailContact.linkedinUrl ? (
                  <a href={detailContact.linkedinUrl} target="_blank" rel="noreferrer"
                    className="text-blue-500 text-xs">{detailContact.linkedinUrl}</a>
                ) : "-"}
              </Descriptions.Item>
              <Descriptions.Item label="来源">{detailContact.source || "-"}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{new Date(detailContact.createdAt).toLocaleDateString("zh-CN")}</Descriptions.Item>
            </Descriptions>

            {/* 互动历史 */}
            <ContactInteractions contactId={detailContact.id} />
          </div>
        )}
      </Drawer>
    </div>
  );
}

interface InteractionItem {
  type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string;
}

function ContactInteractions({ contactId }: { contactId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["contacts", "interactions", contactId],
    queryFn: () => window.api.invoke("contacts:interactions", contactId) as Promise<{
      success: boolean; data?: InteractionItem[]; error?: string;
    }>,
    enabled: contactId > 0,
  });

  const items = data?.success ? data.data || [] : [];

  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 mb-2 flex items-center gap-2">
        互动历史
        <Tag className="text-[9px] px-1 my-0">{items.length} 条</Tag>
      </div>

      {isLoading ? <div className="text-xs text-gray-400 py-4 text-center">加载中...</div> :
        items.length === 0 ? (
          <div className="text-xs text-gray-400 p-3 bg-gray-50 rounded text-center">
            暂无互动记录
          </div>
        ) : (
          <Timeline
            items={items.slice(0, 20).map((i, idx) => ({
              color: INTERACTION_COLORS[i.type] || "gray",
              children: (
                <div key={idx} className="text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-700">
                      {INTERACTION_LABELS[i.type] || i.type}
                    </span>
                    <span className="text-gray-400">
                      {new Date(i.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  {i.subject && (
                    <div className="text-[11px] text-gray-600 mt-0.5">{i.subject}</div>
                  )}
                  {i.bodyPreview && (
                    <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{i.bodyPreview}</div>
                  )}
                </div>
              ),
            }))}
          />
        )
      }
    </div>
  );
}
