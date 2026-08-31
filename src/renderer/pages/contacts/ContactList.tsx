import { useState, useEffect, type ReactNode } from "react";
import { Table, Button, Input, Space, Drawer, Tag, message, Form, Select, Popover, Checkbox, Tooltip, Modal, Dropdown } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined, SettingOutlined, ImportOutlined, PartitionOutlined, MailOutlined, ExportOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useContacts, useUpsertContact, useDeleteContact, type Contact } from "../../hooks/useContacts";
import { ContactDetailDrawer, CLIENT_TYPE, STATUS_META, STAGE_META, CRM_STAGES, COUNTRIES } from "../../components/ContactDetail";
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
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
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
  const qc = useQueryClient();

  // 跨页全选：拉取当前 search/筛选下的全部 id（服务端分页时表头全选只能选当前页 50 条）
  const selectAllMatched = async () => {
    const r = await window.api.invoke("contacts:listIds", { search, ...filters }) as
      { success: boolean; data?: { ids: number[] }; error?: string };
    if (r?.success && r.data) {
      setSelectedRowKeys(r.data.ids);
      message.success(`已选中全部 ${r.data.ids.length} 个匹配联系人`);
    } else message.error(r?.error || "选择失败");
  };

  // 批量删除选中联系人（一次级联 + 一次落盘，支持跨页全选）
  const batchDelete = () => {
    if (selectedRowKeys.length === 0) return;
    const ids = selectedRowKeys.map(k => Number(k)).filter(n => Number.isInteger(n) && n > 0);
    Modal.confirm({
      title: `删除 ${ids.length} 个联系人？`,
      content: "将同时清除其跟进/发送记录并解除邮件关联，空壳公司一并回收。此操作不可撤销，建议先导出。",
      okText: "删除", okType: "danger", cancelText: "取消",
      onOk: async () => {
        const r = await window.api.invoke("contacts:deleteBatch", ids) as
          { success: boolean; data?: { deleted: number; companiesRemoved: number }; error?: string };
        r?.success
          ? message.success(`已删除 ${r.data?.deleted ?? ids.length} 个联系人`)
          : message.error(r?.error || "删除失败");
        setSelectedRowKeys([]);
        qc.invalidateQueries({ queryKey: ["contacts"] });
      },
    });
  };

  const contacts = data?.success ? (data.data?.items || []) : [];
  const total = data?.success ? (data.data?.total || 0) : 0;

  // ── 导出（原独立导出页功能并入：联系人 CSV / 跟进记录 CSV）──
  const [exporting, setExporting] = useState(false);
  const downloadCsv = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleExport = async (kind: "contacts" | "notes") => {
    setExporting(true);
    try {
      const result = kind === "contacts"
        ? await window.api.invoke("export:contactsToExcel", { search })
        : await window.api.invoke("export:notesToCsv");
      const r = result as { success: boolean; data?: string; error?: string };
      if (!r?.success) { message.error(r?.error || "导出失败"); return; }
      const name = kind === "contacts" ? "contacts" : "跟进记录";
      downloadCsv(r.data || "", `${name}_${new Date().toISOString().slice(0, 10)}.csv`);
      message.success("导出完成");
    } catch {
      message.error("导出失败");
    } finally {
      setExporting(false);
    }
  };

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
          {selectedRowKeys.length > 0 && selectedRowKeys.length < total && (
            <Button size="small" type="link" style={{ padding: 0, height: "auto" }}
              onClick={selectAllMatched}>选择全部 {total} 个匹配项</Button>
          )}
          {selectedRowKeys.length > 0 && (
            <Button size="small" danger icon={<DeleteOutlined />}
              onClick={batchDelete}>删除选中 ({selectedRowKeys.length})</Button>
          )}
          <Popover trigger="click" placement="bottomRight" content={colsPanel}>
            <Button size="small" icon={<SettingOutlined />}>列设置</Button>
          </Popover>
          <Dropdown menu={{
            items: [
              { key: "contacts", label: "导出联系人 CSV" },
              { key: "notes", label: "导出跟进记录 CSV" },
            ],
            onClick: (e) => handleExport(e.key as "contacts" | "notes"),
          }}>
            <Button size="small" icon={<ExportOutlined />} loading={exporting}>导出</Button>
          </Dropdown>
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
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
          preserveSelectedRowKeys: true,
        }}
        onRow={(record) => ({
          onDoubleClick: () => setDetailContact(record),
          onClick: (e: React.MouseEvent) => {
            if (e.ctrlKey || e.metaKey) {
              setSelectedRowKeys(prev => prev.includes(record.id) ? prev.filter(k => k !== record.id) : [...prev, record.id]);
            } else if (e.shiftKey) {
              const last = selectedRowKeys.length ? selectedRowKeys[selectedRowKeys.length - 1] : record.id;
              const idxA = contacts.findIndex(c => c.id === last);
              const idxB = contacts.findIndex(c => c.id === record.id);
              const [lo, hi] = [Math.min(idxA, idxB), Math.max(idxA, idxB)];
              const range = contacts.slice(lo, hi + 1).map(c => c.id);
              setSelectedRowKeys(prev => [...new Set([...prev, ...range])]);
            }
          },
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
            <Form.Item name="country" label="国家">
              <Select size="small" showSearch optionFilterProp="label" allowClear placeholder="搜索选择国家"
                options={COUNTRIES.map(c => ({ value: c.code, label: `${c.code} ${c.label}` }))} />
            </Form.Item>
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
