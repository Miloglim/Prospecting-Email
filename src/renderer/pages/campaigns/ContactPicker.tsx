import { useMemo, useState, useRef, useEffect, useLayoutEffect } from "react";
import { Table, Tag, Input, Button, Select, Space, Empty, Tooltip } from "antd";
import { SearchOutlined, RightOutlined } from "@ant-design/icons";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

/**
 * 邮件发送第一步：Excel 式高密度联系人选择表
 * - 一次性拉全量（库内几千级，slim 投影只取展示列，IPC 体积 ~1.2MB）
 * - 列筛选（状态/阶段/国家/语言/类型）+ 关键字搜索 + 快捷分桶 chips
 * - preserveSelectedRowKeys：筛选变化不丢勾选
 * - 底部汇总条：已选 N 人 · M 家公司，可展开逐个移除
 * - 缓存纪律：slim 全量 + pickerStats 均 staleTime 10min、placeholderData 保旧值 ——
 *   进页先渲染缓存（不再"每次都在加载"），超时才后台静默刷新
 */

interface PickRow {
  id: number;
  firstName: string | null; lastName: string | null; email: string;
  companyId: number | null; companyName: string | null;
  country: string | null; language: string | null; clientType: string | null;
  status: string | null; stage: string | null; assignee: string | null;
}

interface PickerStats {
  neverIds: number[];
  lastSent: Array<{ id: number; label: string }>;
  /** 已归属未完结任务（draft/running/paused）的联系人：灰显 + 「已在任务」标签 */
  inCampaign: Array<{ id: number; campaignName: string }>;
}
type StatsResult = Result2<PickerStats>;
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
  /** 快捷筛选：true=只看已在任务里的人（chip 点亮）；undefined=不过滤 */
  const [fOnlyCampaign, setFOnlyCampaign] = useState<boolean | undefined>();

  const { data: listData, isLoading } = useQuery({
    queryKey: ["contacts", "allForPick"],
    queryFn: () => window.api.invoke("contacts:list", { page: 1, pageSize: 100000, slim: true }) as Promise<{
      success: boolean; data?: { items: PickRow[]; total: number };
    }>,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => listData?.success ? listData.data?.items || [] : [], [listData]);

  // 轻量统计（主进程两条聚合 SQL，替代旧的两个全表桶查询）：never 集合 + 最近发送档位
  const { data: statsData } = useQuery({
    queryKey: ["send", "pickerStats"],
    queryFn: () => window.api.invoke("send:getPickerStats") as Promise<StatsResult>,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const neverIds = useMemo(() => new Set(statsData?.data?.neverIds || []), [statsData]);
  const lastSentMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of statsData?.data?.lastSent || []) m.set(e.id, e.label);
    return m;
  }, [statsData]);
  // 已在未完结任务里的人 → 任务名（灰显与「已在任务」标签共用；同一人只记第一个）
  const campaignMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of statsData?.data?.inCampaign || []) if (!m.has(e.id)) m.set(e.id, e.campaignName);
    return m;
  }, [statsData]);

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
      if (fOnlyCampaign && !campaignMap.has(r.id)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, fStatus, fStage, fCountry, fLang, fType, fOnlyCampaign, neverIds, campaignMap]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedRows = useMemo(() => rows.filter(r => selectedSet.has(r.id)), [rows, selectedSet]);
  const companyCount = useMemo(() => new Set(selectedRows.map(r => r.companyId ?? `c_${r.id}`)).size, [selectedRows]);
  // 已选里「已经在别的任务里有人跟」的人数：只提示不拦截（smart-send-spec §0.6-1 资格闸已解除）
  const selectedInCampaign = useMemo(() => selectedRows.filter(r => campaignMap.has(r.id)).length, [selectedRows, campaignMap]);
  const dropInCampaign = () => onChange(value.filter(id => !campaignMap.has(id)));
  // 已选里「不该再收开发信」的：已触达/已回复（已在跟进，不该收冷启动信）、退信与自动回复（地址无效或人不在）
  // —— 汇总条上给一个快捷移除，按状态分类计数，点一下全部剔出勾选
  const UNSUITABLE_LABELS: Record<string, string> = { reached: "已触达", replied: "已回复", bounced: "退信", autoreply: "自动回复" };
  const unsuitable = useMemo(() => {
    const byStatus = new Map<string, number[]>();
    for (const r of selectedRows) {
      const st = r.status ?? "";
      if (!UNSUITABLE_LABELS[st]) continue;
      byStatus.set(st, [...(byStatus.get(st) ?? []), r.id]);
    }
    const ids = new Set([...byStatus.values()].flat());
    const breakdown = [...byStatus.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([st, list]) => `${UNSUITABLE_LABELS[st]} ${list.length}`).join(" · ");
    return { ids, count: ids.size, breakdown };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows]);

  const columns = useMemo(() => [
    { title: "姓名", dataIndex: "firstName", width: 104, ellipsis: true,
      render: (_: unknown, r: PickRow) => <span className="text-[11px] font-medium text-gray-800">{nameOf(r)}</span> },
    { title: "邮箱", dataIndex: "email", width: 178, ellipsis: true,
      render: (v: string) => <span className="text-[10px] font-mono text-gray-500">{v}</span> },
    { title: "公司", dataIndex: "companyName", width: 148, ellipsis: true,
      render: (v: string | null) => <span className="text-[11px] text-gray-600">{v || "—"}</span> },
    { title: "国家", dataIndex: "country", width: 48,
      render: (v: string | null) => v ? <span className="text-[10px] text-gray-500">{v.toUpperCase()}</span> : <span className="text-[10px] text-gray-300">—</span> },
    { title: "语言", dataIndex: "language", width: 46,
      render: (v: string | null) => v ? <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color="cyan">{v.toUpperCase()}</Tag> : <span className="text-[10px] text-gray-300">—</span> },
    { title: "类型", dataIndex: "clientType", width: 50,
      render: (v: string | null) => <span className="text-[10px] text-gray-600">{TYPE_LABELS[v || "general"] || "通用"}</span> },
    { title: "状态", key: "status", width: 78,
      render: (_: unknown, r: PickRow) => {
        const cn = campaignMap.get(r.id);
        if (cn) return <Tooltip title={`已在任务「${cn}」，再建任务会重复触达`}>
          <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color="purple">已在任务</Tag></Tooltip>;
        const m = statusLabel(r);
        return <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color={m.color}>{m.label}</Tag>;
      } },
    { title: "阶段", dataIndex: "stage", width: 46,
      render: (v: string | null) => <span className="text-[10px] text-gray-600">{STAGE_LABELS[v || "cold"]}</span> },
    { title: "最近发送", key: "lastSent", width: 62,
      render: (_: unknown, r: PickRow) => { const t = lastSentMap.get(r.id); return t ? <span className="text-[10px] text-gray-500">{t}</span> : <span className="text-[10px] text-gray-300">—</span>; } },
    { title: "负责人", dataIndex: "assignee", width: 64, ellipsis: true,
      render: (v: string | null) => v ? <Tag color="geekblue" className="text-[9px] leading-none px-1 py-0.5 m-0">{v}</Tag> : <span className="text-[10px] text-gray-300">—</span> },
  ], [lastSentMap, neverIds, campaignMap]);

  // 快捷分桶 chips：点击 = 应用对应筛选（与三栏分桶心智一致）
  const applyPreset = (key: "never" | "replied" | "autoreply" | "bounced") => {
    setFStatus(key); setFStage(undefined); setSearch(""); setFOnlyCampaign(undefined);
  };
  const toggleCampaignPreset = () => { setFStatus(undefined); setFOnlyCampaign(v => (v ? undefined : true)); };
  const removeUnsuitable = () => onChange(value.filter(id => !unsuitable.ids.has(id)));

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

  // 万行虚拟表的挂载是同步重活，若在路由转场中一起挂会卡住首帧（页面白了才见内容）。
  // 先绘制骨架（useEffect 在首帧 paint 之后执行，setTimeout 再让一拍），下一拍才挂表
  const [tableReady, setTableReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTableReady(true), 0);
    return () => clearTimeout(t);
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
        <span className="flex-1" />
        <Space size={4}>
          <span className="text-[10px] text-gray-400 mr-1">快捷:</span>
          <Tag className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("never")}>从未发送</Tag>
          <Tag color="blue" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("replied")}>已回复</Tag>
          <Tag color="orange" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("autoreply")}>自动回复</Tag>
          <Tag color="red" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("bounced")}>退信</Tag>
          {campaignMap.size > 0 && (
            <Tag color="purple" className={`cursor-pointer text-[10px] m-0 ${fOnlyCampaign ? "" : "!bg-white !text-purple-500 !border-purple-200"}`}
              onClick={toggleCampaignPreset}>
              已在任务 {campaignMap.size}
            </Tag>
          )}
        </Space>
      </div>

      {/* 高密度虚拟表格（延迟一拍挂载，见上 tableReady） */}
      <div ref={boxRef} className="flex-1 min-h-0 border border-gray-200 rounded-lg overflow-hidden bg-white">
        {tableReady ? (
          <Table<PickRow>
            className="row-select-table picker-compact"
            size="small"
            virtual
            dataSource={filtered}
            columns={columns as never}
            rowKey="id"
            loading={isLoading}
            pagination={false}
            scroll={{ x: 900, y: boxH }}
            rowClassName={r => (campaignMap.has(r.id) ? "row-in-campaign" : "")}
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
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <span className="text-xs text-gray-300">加载联系人…</span>
          </div>
        )}
      </div>

      {/* 汇总条 */}
      <div className="flex items-center gap-3 pt-2.5">
        <div className="text-xs text-gray-600 flex items-center gap-2 flex-wrap">
          <span>已选 <strong className="text-gray-900">{value.length}</strong> 人</span>
          <span className="text-gray-300">·</span>
          <span>覆盖 <strong className="text-gray-900">{companyCount}</strong> 家公司</span>
          {selectedInCampaign > 0 && (
            <Tooltip title="已归属未完结任务的人：再建任务会对同一批人重复触达。灰显只是提示，选不选由你定">
              <span className="text-purple-600">其中 {selectedInCampaign} 位已在其他任务</span>
            </Tooltip>
          )}
          {selectedInCampaign > 0 && (
            <Button size="small" type="link" style={{ padding: 0, height: "auto" }} onClick={dropInCampaign}>
              去掉已在任务的（{selectedInCampaign}）
            </Button>
          )}
          {unsuitable.count > 0 && (
            <Tooltip title="资格闸已解除，他们仍会照常入队；不想发就一键从勾选里去掉">
              <span className="text-amber-600">含 {unsuitable.count} 位不宜发信（{unsuitable.breakdown}）</span>
            </Tooltip>
          )}
          {unsuitable.count > 0 && (
            <Button size="small" type="link" style={{ padding: 0, height: "auto" }} onClick={removeUnsuitable}>
              移除这些客户（{unsuitable.count}）
            </Button>
          )}
        </div>
        <span className="flex-1" />
        <Space>
          <Button size="small" onClick={() => onChange([])} disabled={!value.length}>清空</Button>
        </Space>
        {/* 必填项没配齐（一个人都没选）就不给下一步，与向导步骤条同一口径 */}
        <Button type="primary" icon={<RightOutlined />} disabled={!value.length} onClick={onNext}>下一步</Button>
      </div>
    </div>
  );
}
