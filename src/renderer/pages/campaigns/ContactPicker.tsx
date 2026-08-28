import { useMemo, useState, useRef, useLayoutEffect } from "react";
import { Table, Tag, Input, Button, Select, Space, Popover, Empty, Tooltip } from "antd";
import { SearchOutlined, RightOutlined, ClearOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";

/**
 * 邮件发送第一步：Excel 式高密度联系人选择表
 * - 一次性拉全量（库内几千级，sql.js 本就整库在内存，无分页压力）
 * - 列筛选（状态/阶段/国家/语言/类型）+ 关键字搜索 + 快捷分桶 chips（数据源复用三个桶查询，跨组件共享 react-query 缓存）
 * - preserveSelectedRowKeys：筛选变化不丢勾选
 * - 底部汇总条：已选 N 人 · M 家公司，可展开逐个移除
 */

interface PickRow {
  id: number;
  firstName: string | null; lastName: string | null; email: string;
  companyId: number | null; companyName: string | null;
  country: string | null; language: string | null; clientType: string | null;
  status: string | null; stage: string | null; assignee: string | null;
}

interface Bucket { key: string; label: string; description: string; contacts: { id: number }[]; count: number }
type BucketList = Result2<Bucket[]>;
interface Result2<T> { success: boolean; data?: T }

const STAGE_LABELS: Record<string, string> = { cold: "Cold", f1: "F1", f2: "F2", f3: "F3", f4: "F4" };
const TYPE_LABELS: Record<string, string> = { direct: "直客", agent: "代理", peer: "同行", general: "通用" };
const STATUS_META: Record<string, { label: string; color: string }> = {
  reached: { label: "已触达", color: "green" },
  replied: { label: "已回复", color: "blue" },
  autoreply: { label: "自动回复", color: "orange" },
  bounced: { label: "退信", color: "red" },
};

const nameOf = (r: PickRow) => [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;

export function ContactPicker({ value, onChange, onNext }: {
  value: number[];
  onChange: (ids: number[]) => void;
  onNext: () => void;
}) {
  const [search, setSearch] = useState("");
  const [fStatus, setFStatus] = useState<string | undefined>();
  const [fStage, setFStage] = useState<string | undefined>();
  const [fCountry, setFCountry] = useState<string | undefined>();
  const [fLang, setFLang] = useState<string | undefined>();
  const [fType, setFType] = useState<string | undefined>();

  const { data: listData, isLoading } = useQuery({
    queryKey: ["contacts", "allForPick"],
    queryFn: () => window.api.invoke("contacts:list", { page: 1, pageSize: 100000 }) as Promise<{
      success: boolean; data?: { items: PickRow[]; total: number };
    }>,
    staleTime: 60_000,
  });
  const rows = useMemo(() => listData?.success ? listData.data?.items || [] : [], [listData]);

  // 复用发送页三个桶查询（同 queryKey → 同缓存），把桶成员反解成联系人标签
  const { data: statusBuckets } = useQuery({
    queryKey: ["send", "statusBuckets"],
    queryFn: () => window.api.invoke("send:getTimeBuckets") as Promise<BucketList>,
    staleTime: 60_000,
  });
  const { data: sendTimeBuckets } = useQuery({
    queryKey: ["send", "sendTimeBuckets"],
    queryFn: () => window.api.invoke("send:getSendTimeBuckets") as Promise<BucketList>,
    staleTime: 60_000,
  });

  const neverIds = useMemo(() => {
    const b = (statusBuckets?.data || []).find(x => x.key === "never");
    return new Set((b?.contacts || []).map(c => c.id));
  }, [statusBuckets]);
  const lastSentMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of sendTimeBuckets?.data || []) for (const c of b.contacts || []) m.set(c.id, b.label);
    return m;
  }, [sendTimeBuckets]);

  const statusOf = (r: PickRow): string => r.status || (neverIds.has(r.id) ? "never" : "");
  const statusLabel = (r: PickRow) => {
    const s = statusOf(r);
    return s === "never" ? { label: "从未发送", color: "default" } : STATUS_META[s] || { label: "—", color: "default" };
  };

  const countryOptions = useMemo(() => {
    const cs = [...new Set(rows.map(r => r.country).filter((x): x is string => !!x))].sort();
    return cs.map(c => ({ value: c, label: c }));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (q && !`${r.email} ${r.firstName || ""} ${r.lastName || ""} ${r.companyName || ""} ${r.assignee || ""}`.toLowerCase().includes(q)) return false;
      if (fStatus && statusOf(r) !== fStatus) return false;
      if (fStage && (r.stage || "cold") !== fStage) return false;
      if (fCountry && r.country !== fCountry) return false;
      if (fLang && (r.language || "EN") !== fLang) return false;
      if (fType && (r.clientType || "general") !== fType) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, fStatus, fStage, fCountry, fLang, fType, neverIds]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedRows = useMemo(() => rows.filter(r => selectedSet.has(r.id)), [rows, selectedSet]);
  const companyCount = useMemo(() => new Set(selectedRows.map(r => r.companyId ?? `c_${r.id}`)).size, [selectedRows]);
  const reachedSelected = useMemo(() => selectedRows.filter(r => r.status === "reached").length, [selectedRows]);

  const columns = useMemo(() => [
    { title: "姓名", dataIndex: "firstName", width: 130, ellipsis: true,
      render: (_: unknown, r: PickRow) => <span className="text-[11px] font-medium text-gray-800">{nameOf(r)}</span> },
    { title: "邮箱", dataIndex: "email", width: 210, ellipsis: true,
      render: (v: string) => <span className="text-[10px] font-mono text-gray-500">{v}</span> },
    { title: "公司", dataIndex: "companyName", width: 190, ellipsis: true,
      render: (v: string | null) => <span className="text-[11px] text-gray-600">{v || "—"}</span> },
    { title: "国家", dataIndex: "country", width: 56,
      render: (v: string | null) => v ? <span className="text-[10px] text-gray-500">{v.toUpperCase()}</span> : <span className="text-[10px] text-gray-300">—</span> },
    { title: "语言", dataIndex: "language", width: 56,
      render: (v: string | null) => v ? <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color="cyan">{v.toUpperCase()}</Tag> : <span className="text-[10px] text-gray-300">—</span> },
    { title: "类型", dataIndex: "clientType", width: 60,
      render: (v: string | null) => <span className="text-[10px] text-gray-600">{TYPE_LABELS[v || "general"] || "通用"}</span> },
    { title: "状态", key: "status", width: 78,
      render: (_: unknown, r: PickRow) => { const m = statusLabel(r); return <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color={m.color}>{m.label}</Tag>; } },
    { title: "阶段", dataIndex: "stage", width: 56,
      render: (v: string | null) => <span className="text-[10px] text-gray-600">{STAGE_LABELS[v || "cold"]}</span> },
    { title: "最近发送", key: "lastSent", width: 78,
      render: (_: unknown, r: PickRow) => { const t = lastSentMap.get(r.id); return t ? <span className="text-[10px] text-gray-500">{t}</span> : <span className="text-[10px] text-gray-300">—</span>; } },
    { title: "负责人", dataIndex: "assignee", width: 82, ellipsis: true,
      render: (v: string | null) => v ? <Tag color="geekblue" className="text-[9px] leading-none px-1 py-0.5 m-0">{v}</Tag> : <span className="text-[10px] text-gray-300">—</span> },
  ], [lastSentMap, neverIds]);

  // 快捷分桶 chips：点击 = 应用对应筛选（与三栏分桶心智一致）
  const applyPreset = (key: "never" | "replied" | "autoreply" | "bounced") => {
    setFStatus(key); setFStage(undefined); setSearch("");
  };
  const clearFilters = () => { setSearch(""); setFStatus(undefined); setFStage(undefined); setFCountry(undefined); setFLang(undefined); setFType(undefined); };
  const selectAllFiltered = () => {
    const merged = new Set(value);
    for (const r of filtered) merged.add(r.id);
    onChange([...merged]);
  };
  const deselectAllFiltered = () => {
    const drop = new Set(filtered.map(r => r.id));
    onChange(value.filter(id => !drop.has(id)));
  };

  // 虚拟滚动要求 scroll.y 为数字 → 实测容器高度（antd 表头约占 39px 已扣）
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(480);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBoxH(Math.max(200, el.clientHeight - 39));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 210px)", minHeight: 420 }}>
      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-wrap pb-2.5">
        <Input allowClear size="small" style={{ width: 220 }} prefix={<SearchOutlined className="text-gray-300" />}
          placeholder="搜索姓名 / 邮箱 / 公司 / 负责人" value={search} onChange={e => setSearch(e.target.value)} />
        <Select allowClear size="small" style={{ width: 110 }} placeholder="状态" value={fStatus} onChange={setFStatus}
          options={[
            { value: "never", label: "从未发送" },
            { value: "reached", label: "已触达" },
            { value: "replied", label: "已回复" },
            { value: "autoreply", label: "自动回复" },
            { value: "bounced", label: "退信" },
          ]} />
        <Select allowClear size="small" style={{ width: 100 }} placeholder="阶段" value={fStage} onChange={setFStage}
          options={Object.entries(STAGE_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
        <Select allowClear size="small" style={{ width: 92 }} placeholder="国家" value={fCountry} onChange={setFCountry} options={countryOptions} showSearch />
        <Select allowClear size="small" style={{ width: 88 }} placeholder="语言" value={fLang} onChange={setFLang}
          options={[{ value: "EN", label: "EN" }, { value: "ES", label: "ES" }, { value: "PT", label: "PT" }]} />
        <Select allowClear size="small" style={{ width: 92 }} placeholder="类型" value={fType} onChange={setFType}
          options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
        <Button size="small" icon={<ClearOutlined />} onClick={clearFilters}>清筛选</Button>
        <span className="flex-1" />
        <Space size={4}>
          <span className="text-[10px] text-gray-400 mr-1">快捷:</span>
          <Tag className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("never")}>从未发送</Tag>
          <Tag color="blue" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("replied")}>已回复</Tag>
          <Tag color="orange" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("autoreply")}>自动回复</Tag>
          <Tag color="red" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("bounced")}>退信</Tag>
        </Space>
      </div>

      {/* 高密度虚拟表格 */}
      <div ref={boxRef} className="flex-1 min-h-0 border border-gray-200 rounded-lg overflow-hidden bg-white">
        <Table<PickRow>
          size="small"
          virtual
          dataSource={filtered}
          columns={columns as never}
          rowKey="id"
          loading={isLoading}
          pagination={false}
          scroll={{ x: 1060, y: boxH }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合筛选条件的联系人" /> }}
          rowSelection={{
            selectedRowKeys: value,
            preserveSelectedRowKeys: true,
            columnWidth: 44,
            fixed: true,
            onChange: keys => onChange(keys as number[]),
          }}
          onRow={(r) => ({
            onClick: (e) => {
              // 点击行 = 勾选/取消（Excel 式快捷操作）；点在选中框上不重复触发
              if ((e.target as HTMLElement).closest(".ant-table-selection-column")) return;
              selectedSet.has(r.id) ? onChange(value.filter(id => id !== r.id)) : onChange([...value, r.id]);
            },
          })}
        />
      </div>

      {/* 汇总条 */}
      <div className="flex items-center gap-3 pt-2.5">
        <div className="text-xs text-gray-600 flex items-center gap-2 flex-wrap">
          <span>已选 <strong className="text-gray-900">{value.length}</strong> 人</span>
          <span className="text-gray-300">·</span>
          <span>覆盖 <strong className="text-gray-900">{companyCount}</strong> 家公司</span>
          {reachedSelected > 0 && (
            <Tooltip title="已触达客户走「动态更新」模式跟进；开发信模式（我的模板/即时/句库）会自动排除这些人">
              <span className="text-amber-600">含 {reachedSelected} 位已触达</span>
            </Tooltip>
          )}
          {filtered.length > 0 && value.length > 0 && (
            <Popover trigger="click" title="已选联系人（最多显示 100 个）"
              content={
                <div style={{ maxWidth: 520, maxHeight: 260, overflowY: "auto" }} className="flex flex-wrap gap-1">
                  {selectedRows.slice(0, 100).map(r => (
                    <Tag key={r.id} closable onClose={() => onChange(value.filter(id => id !== r.id))} className="text-[10px] m-0">
                      {nameOf(r)}
                    </Tag>
                  ))}
                  {selectedRows.length > 100 && <span className="text-[10px] text-gray-400">…共 {selectedRows.length} 人</span>}
                </div>
              }
            >
              <Button size="small" type="link" style={{ padding: 0, height: "auto" }}>查看/移除</Button>
            </Popover>
          )}
        </div>
        <span className="flex-1" />
        <Space>
          <Button size="small" onClick={selectAllFiltered} disabled={!filtered.length}>选中筛选结果({filtered.length})</Button>
          <Button size="small" onClick={deselectAllFiltered} disabled={!filtered.length}>取消筛选结果</Button>
          <Button size="small" onClick={() => onChange([])} disabled={!value.length}>清空</Button>
        </Space>
        <Button type="primary" icon={<RightOutlined />} onClick={onNext}>
          下一步：选择发送模式
        </Button>
      </div>
    </div>
  );
}
