import { useState, useEffect, type ReactNode } from "react";
import { Table, Button, Input, Space, Drawer, Tag, message, Form, Select, Popover, Checkbox, Tooltip } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined, SettingOutlined, ImportOutlined, PartitionOutlined, MailOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import { useContacts, useUpsertContact, useDeleteContact, type Contact } from "../../hooks/useContacts";
import { ContactDetailDrawer, CLIENT_TYPE, STATUS_META, STAGE_META, CRM_STAGES } from "../../components/ContactDetail";
import { ImportDrawer } from "../../components/ImportDrawer";

/* ---------- 可配置列定义 ---------- */
const COLS_KEY = "contacts-cols";
const DEFAULT_COLS = ["name", "email", "companyName", "clientType", "status", "stage", "title", "source"];

interface ColDef { key: string; title: string; width?: number; render: (c: Contact) => ReactNode; }

const Muted = ({ v }: { v: string | null | undefined }) => (
  <Tooltip title={v || undefined}>
    <span className="text-xs text-gray-500 block truncate">{v || "-"}</span>
  </Tooltip>
);
const Dash = () => <span className="text-xs text-gray-300">—</span>;
const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "-";
const parseTags = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};

const COLUMN_DEFS: ColDef[] = [
  {
    key: "name", title: "姓名", width: 120,
    render: (c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email.split("@")[0];
      return <Tooltip title={name}><span className="text-xs font-medium text-gray-800 block truncate">{name}</span></Tooltip>;
    },
  },
  {
    key: "email", title: "邮箱", width: 200,
    render: (c) => <Tooltip title={c.email}><span className="text-xs font-mono text-blue-600 block truncate">{c.email}</span></Tooltip>,
  },
  { key: "companyName", title: "公司", width: 140, render: (c) => <Muted v={c.companyName} /> },
  { key: "title", title: "职位", width: 120, render: (c) => <Muted v={c.title} /> },
  {
    key: "clientType", title: "类型", width: 70,
    render: (c) => {
      const m = c.clientType ? CLIENT_TYPE[c.clientType] : null;
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  {
    key: "status", title: "状态", width: 80,
    render: (c) => {
      const m = STATUS_META[c.status || ""];
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  {
    key: "stage", title: "阶段", width: 80,
    render: (c) => {
      const m = STAGE_META[c.stage || ""];
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  { key: "phone", title: "电话", width: 130, render: (c) => <Muted v={c.phone} /> },
  { key: "country", title: "国家", width: 70, render: (c) => <Muted v={c.country} /> },
  {
    key: "source", title: "来源", width: 70,
    render: (c) => c.source ? <Tag className="text-[10px] my-0 leading-none px-1.5">{c.source}</Tag> : <Dash />,
  },
  { key: "assignee", title: "负责人", width: 90, render: (c) => <Muted v={c.assignee} /> },
  {
    key: "tags", title: "标签", width: 90,
    render: (c) => {
      const key = parseTags(c.tags)[0];
      const m = key ? CRM_STAGES.find(s => s.key === key) : null;
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  { key: "createdAt", title: "创建", width: 80, render: (c) => <Muted v={fmtDate(c.createdAt)} /> },
  { key: "updatedAt", title: "更新", width: 80, render: (c) => <Muted v={fmtDate(c.updatedAt)} /> },
];

export function ContactList() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<{
    stage?: string; status?: string; tags?: string; clientType?: string; country?: string;
  }>({});
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem(COLS_KEY);
      return s ? (JSON.parse(s) as string[]) : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const [form] = Form.useForm();

  const { data, isLoading, error } = useContacts({ search, page, ...filters });
  const upsertContact = useUpsertContact();
  const deleteContact = useDeleteContact();

  const contacts = data?.success ? (data.data?.items || []) : [];
  const total = data?.success ? (data.data?.total || 0) : 0;

  // 从收件箱跳转来的预填/详情（读 hash 路由的 search 部分）
  useEffect(() => {
    const rawHash = window.location.hash; // 如 "#/contacts?add=1&email=..." 或 "#/contacts?detail=123"
    const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
    if (!qs) return;
    const sp = new URLSearchParams(qs);

    // 打开详情 — 直接按 id 拉取，不依赖当前分页/筛选结果（否则目标联系人不在当前页就弹不出）
    const detailId = sp.get("detail");
    if (detailId) {
      const id = Number(detailId);
      if (!isNaN(id)) {
        window.api.invoke("contacts:getById", id).then((res) => {
          const r = res as { success: boolean; data?: Contact };
          if (r?.success && r.data) setDetailContact(r.data);
        });
      }
      window.location.hash = rawHash.split("?")[0]!;
      return;
    }

    // 新增预填
    if (sp.get("add") === "1" && sp.get("email")) {
      form.setFieldsValue({
        email: sp.get("email") || "",
        companyName: sp.get("company") || "",
        firstName: sp.get("firstName") || "",
        lastName: sp.get("lastName") || "",
        clientType: sp.get("clientType") || undefined,
      });
      setAddOpen(true);
      window.location.hash = rawHash.split("?")[0]!;
    }
  }, [contacts, isLoading]);

  const updateCols = (cols: string[]) => {
    setVisibleCols(cols);
    localStorage.setItem(COLS_KEY, JSON.stringify(cols));
  };

  const columns: TableColumnsType<Contact> = [
    ...COLUMN_DEFS.filter(d => visibleCols.includes(d.key)).map(d => ({
      title: d.title, key: d.key, width: d.width,
      render: (_: unknown, r: Contact) => d.render(r),
    })),
    {
      title: "", key: "actions", width: 96, fixed: "right" as const,
      render: (_: unknown, r: Contact) => (
        <Space size={0} style={{ display: "flex", justifyContent: "center" }}>
          <Tooltip title="在收件箱中搜索">
            <Button type="text" size="small" icon={<MailOutlined />}
              className="btn-hover-color"
              style={{ color: "#bbb" }}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                window.location.hash = `#/inbox?search=${encodeURIComponent(r.email)}`;
              }}
            />
          </Tooltip>
          <Tooltip title={r.status === "reached" ? "在CRM中查看" : "未进入CRM管线"}>
            <Button type="text" size="small" icon={<PartitionOutlined />}
              disabled={r.status !== "reached"}
              className="btn-hover-color"
              style={{ color: r.status === "reached" ? "#bbb" : "#d9d9d9" }}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (r.status !== "reached") return;
                window.location.hash = `#/crm?detail=${r.id}`;
              }}
            />
          </Tooltip>
          <Button type="text" size="small" icon={<DeleteOutlined />}
            loading={deletingId === r.id}
            className="btn-hover-color"
            style={{ color: "#bbb" }}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              if (deletingId) return;
              setDeletingId(r.id);
              try {
                const res = await deleteContact.mutateAsync(r.id);
                res?.success ? message.success("已删除") : message.error(res?.error || "失败");
              } catch {
                message.error("删除失败");
              } finally {
                setDeletingId(null);
              }
            }}
          />
        </Space>
      ),
    },
  ];

  const colsPanel = (
    <div className="w-56">
      <div className="text-[11px] font-semibold text-gray-500 mb-2">显示字段</div>
      <Checkbox.Group
        value={visibleCols}
        onChange={(v) => updateCols(v as string[])}
        className="grid grid-cols-2 gap-x-2"
      >
        {COLUMN_DEFS.map(d => (
          <Checkbox key={d.key} value={d.key} className="text-xs">{d.title}</Checkbox>
        ))}
      </Checkbox.Group>
      <div className="flex justify-between mt-3 pt-2 border-t border-gray-100">
        <Button size="small" type="text" onClick={() => updateCols(DEFAULT_COLS)}>恢复默认</Button>
        <Button size="small" type="text" onClick={() => updateCols(COLUMN_DEFS.map(d => d.key))}>全选</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* 工具栏 — 紧凑 */}
      <div className="flex items-center justify-between">
        <Input prefix={<SearchOutlined />} placeholder="搜索邮箱、姓名、公司..."
          value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
          size="small" style={{ width: 260 }} allowClear />
        <Space size="small">
          <span className="text-xs text-gray-400">共 {total} 人</span>
          <Popover trigger="click" placement="bottomRight" content={colsPanel}>
            <Button size="small" icon={<SettingOutlined />}>列设置</Button>
          </Popover>
          <Button size="small" icon={<ImportOutlined />}
            onClick={() => setImportOpen(true)}>导入</Button>
          <Button type="primary" size="small" icon={<PlusOutlined />}
            onClick={() => { form.resetFields(); setAddOpen(true); }}>新增</Button>
        </Space>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select size="small" placeholder="阶段" allowClear style={{ width: 100 }}
          value={filters.stage} onChange={v => { setFilters(prev => ({ ...prev, stage: v })); setPage(1); }}
          options={Object.entries(STAGE_META).map(([k, m]) => ({ value: k, label: m.label }))}
        />
        <Select size="small" placeholder="状态" allowClear style={{ width: 100 }}
          value={filters.status} onChange={v => { setFilters(prev => ({ ...prev, status: v })); setPage(1); }}
          options={Object.entries(STATUS_META).map(([k, m]) => ({ value: k, label: m.label }))}
        />
        <Select size="small" placeholder="标签" allowClear style={{ width: 100 }}
          value={filters.tags} onChange={v => { setFilters(prev => ({ ...prev, tags: v })); setPage(1); }}
          options={CRM_STAGES.map(s => ({ value: s.key, label: s.label }))}
        />
        <Select size="small" placeholder="客户类型" allowClear style={{ width: 100 }}
          value={filters.clientType} onChange={v => { setFilters(prev => ({ ...prev, clientType: v })); setPage(1); }}
          options={[
            { value: "agent", label: "代理" },
            { value: "direct", label: "直客" },
          ]}
        />
        <Select size="small" placeholder="语言" allowClear style={{ width: 120 }}
          value={filters.country} onChange={v => { setFilters(prev => ({ ...prev, country: v })); setPage(1); }}
          options={[
            { value: "ES", label: "ES 西班牙语" },
            { value: "PT", label: "PT 葡萄牙语" },
            { value: "EN", label: "EN 英语" },
          ]}
        />
        {Object.values(filters).some(Boolean) && (
          <Button size="small" type="text" onClick={() => { setFilters({}); setPage(1); }}>
            清除筛选
          </Button>
        )}
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
        scroll={{ x: "max-content" }}
        className="[&_.ant-table-thead>tr>th]:!text-[11px] [&_.ant-table-thead>tr>th]:!text-gray-400 [&_.ant-table-thead>tr>th]:!font-medium"
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
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="companyName" label="公司"><Input size="small" placeholder="公司名称" /></Form.Item>
            <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}><Input size="small" /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="firstName" label="名"><Input size="small" /></Form.Item>
            <Form.Item name="lastName" label="姓"><Input size="small" /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="title" label="职位"><Input size="small" /></Form.Item>
            <Form.Item name="linkedinUrl" label="LinkedIn"><Input size="small" /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="country" label="国家"><Input size="small" placeholder="如 MX, BR" /></Form.Item>
            <Form.Item name="language" label="语言">
                <Select size="small" allowClear placeholder="匹配发信模板"
                  options={[
                    { value: "ES", label: "ES 西班牙语" },
                    { value: "PT", label: "PT 葡萄牙语" },
                    { value: "EN", label: "EN 英语" },
                  ]} />
              </Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="phone" label="电话"><Input size="small" /></Form.Item>
            <Form.Item name="clientType" label="客户类型">
                <Select size="small" allowClear placeholder="代理 / 直客"
                  options={[
                    { value: "agent", label: "代理" },
                    { value: "direct", label: "直客" },
                  ]} />
              </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" size="small" block loading={upsertContact.isPending}>
            保存
          </Button>
        </Form>
      </Drawer>

      {/* 导入抽屉 */}
      <ImportDrawer open={importOpen} onClose={() => setImportOpen(false)} />

      {/* 详情抽屉 — 双击打开，分页标签 */}
      <ContactDetailDrawer
        contact={detailContact}
        open={!!detailContact}
        onClose={() => setDetailContact(null)}
        onUpdated={(c) => setDetailContact(c)}
      />
    </div>
  );
}
