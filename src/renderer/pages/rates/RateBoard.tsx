import { useEffect, useMemo, useState } from "react";
import { Button, Descriptions, Drawer, Input, Select, Space, Table, Tag, Tooltip, App as AntApp } from "antd";
import { SearchOutlined, SyncOutlined, DollarOutlined, GlobalOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface RateStatus {
  total: number; active: number; lastSyncAt: string | null; lastImported: number | null;
  remoteHost: string; lastError: string | null;
}

interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
  validityRaw: string | null; freeDays: string | null; shortfallFee: string | null; sender: string | null;
  imageUrl: string | null;
}

interface IpcResult<T> { success: boolean; data?: T; error?: string }

const CONTAINERS = ["20GP", "40GP", "40HQ", "NOR", "40GP+40HQ"];

/** 柜型色标：固定映射到归一化后的柜型值，扫表时一眼分桶 */
const CONTAINER_COLORS: Record<string, string> = {
  "20GP": "blue",
  "40GP": "cyan",
  "40HQ": "green",
  "NOR": "orange",
  "40GP+40HQ": "geekblue",
};

function fmtMsgTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 有效期紧凑格式（列表用，年份无信息量且挤占列宽）：
 *  同月 1-7 Sep；跨月 31 Aug – 6 Sep；单边只显一天；hover 出完整日期 */
function fmtValidity(from: string | null, to: string | null): string {
  const d = (s: string | null) => {
    const mt = /^\d{4}-(\d{2})-(\d{2})$/.exec(s || "");
    return mt ? { mo: Number(mt[1]), dy: Number(mt[2]) } : null;
  };
  const a = d(from), b = d(to);
  const tag = (x: { mo: number; dy: number }) => `${x.dy} ${MONTHS_EN[x.mo - 1]}`;
  if (a && b) return a.mo === b.mo ? `${a.dy}-${b.dy} ${MONTHS_EN[a.mo - 1]}` : `${tag(a)} – ${tag(b)}`;
  if (a) return tag(a);
  if (b) return tag(b);
  return "—";
}

/**
 * 运价库 — 钉钉《海运运价智能台账》的本地镜像查询界面。
 * 数据来源单向：AI 表格（另一台电脑定时导出快照文件）→ 本程序读快照入库。
 * 镜像价为参考价，对外报价以船司实时运价为准。
 */
export function RateBoard() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [container, setContainer] = useState<string | undefined>();
  const [podInput, setPodInput] = useState("");
  const [pod, setPod] = useState<string | undefined>();     // 防抖后的目的港关键词
  const [polInput, setPolInput] = useState("");
  const [pol, setPol] = useState<string | undefined>();     // 防抖后的起运港关键词（模糊）
  const [laneInput, setLaneInput] = useState("");
  const [lane, setLane] = useState<string | undefined>();   // 防抖后的航线关键词（模糊）
  const [carrierInput, setCarrierInput] = useState("");
  const [carrier, setCarrier] = useState<string | undefined>(); // 防抖后的船司关键词（模糊）
  /** 详情抽屉的当前行（船司/POL/POD/柜型/海运费/有效期之外的信息都收在这里） */
  const [detail, setDetail] = useState<QuoteDto | null>(null);

  // 文本筛选统一防抖 400ms
  useEffect(() => {
    const t = setTimeout(() => {
      setPod(podInput.trim() || undefined);
      setPol(polInput.trim() || undefined);
      setLane(laneInput.trim() || undefined);
      setCarrier(carrierInput.trim() || undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [podInput, polInput, laneInput, carrierInput]);

  const filters = useMemo(() => ({ lane, carrier, pol, container, pod, limit: 5000 }),
    [lane, carrier, pol, container, pod]);

  const { data, isLoading } = useQuery({
    queryKey: ["rates", "list", filters],
    queryFn: () => window.api.invoke("rates:list", filters) as Promise<IpcResult<QuoteDto[]>>,
  });
  const { data: statusData } = useQuery({
    queryKey: ["rates", "status"],
    queryFn: () => window.api.invoke("rates:status") as Promise<IpcResult<RateStatus>>,
    refetchInterval: 60_000,
  });
  const syncMut = useMutation({
    mutationFn: () => window.api.invoke("rates:sync") as Promise<IpcResult<{ imported: number }>>,
    onSuccess: (r) => {
      r?.success ? message.success(`镜像已刷新 ${r.data?.imported} 条`) : message.error(r?.error || "同步失败");
      qc.invalidateQueries({ queryKey: ["rates"] });
    },
  });
  /** 台账工作台：主进程先探测局域网可达再开浏览器；探测最长 3 秒，按钮期间转 loading */
  const boardMut = useMutation({
    mutationFn: () => window.api.invoke("rates:openBoard") as Promise<IpcResult<void>>,
    onSuccess: (r) => { if (!r?.success) message.error(r?.error || "网络出错"); },
    onError: () => message.error("网络出错"),
  });

  const rows = data?.success ? data.data || [] : [];
  const st = statusData?.success ? statusData.data : null;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      {/* 页头 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Space>
          <h2 className="text-lg font-bold text-gray-800 m-0">
            <DollarOutlined className="text-emerald-600 mr-1" />运价库
          </h2>
          <span className="text-[12px] text-gray-400">
            {st ? <><b className="font-medium text-gray-600">{st.total.toLocaleString()}</b> 条</> : "…"}
          </span>
          {st?.lastSyncAt && (
            <span className="text-[11px] text-gray-400">
              上次同步 {new Date(st.lastSyncAt).toLocaleString("zh-CN")}
            </span>
          )}
          {st?.lastError && (
            <Tooltip title={st.lastError}>
              <Tag color="red">同步异常</Tag>
            </Tooltip>
          )}
        </Space>
        <Space>
          <Button size="small" icon={<GlobalOutlined />} loading={boardMut.isPending}
            onClick={() => boardMut.mutate()}>台账工作台</Button>
          <Button size="small" icon={<SyncOutlined spin={syncMut.isPending} />}
            loading={syncMut.isPending} onClick={() => syncMut.mutate()}>同步运价库</Button>
        </Space>
      </div>

      {/* 筛选栏：与表格列同序（船司→起运港→目的港→柜型→航线） */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2">
        <Input size="small" placeholder="船司" allowClear
          style={{ width: 90 }} value={carrierInput} onChange={e => setCarrierInput(e.target.value)} />
        <Input size="small" placeholder="起运港" allowClear
          style={{ width: 100 }} value={polInput} onChange={e => setPolInput(e.target.value)} />
        <Input size="small" prefix={<SearchOutlined className="text-gray-300" />}
          placeholder="目的港（如 santos / KINGSTON）" allowClear
          style={{ width: 220 }} value={podInput} onChange={e => setPodInput(e.target.value)} />
        <Select size="small" placeholder="柜型" allowClear style={{ width: 120 }}
          value={container} onChange={v => setContainer(v)}
          options={CONTAINERS.map(c => ({ value: c, label: c }))} />
        <Input size="small" placeholder="航线" allowClear
          style={{ width: 100 }} value={laneInput} onChange={e => setLaneInput(e.target.value)} />
        {rows.length >= 5000 && (
          <span className="text-[10px] text-amber-600">命中过多，按价格升序仅显示前 5000 条，请细化筛选</span>
        )}
      </div>

      {/* 运价表：主表只放一眼要用的六列，其余信息与报价截图收进「详情」抽屉 */}
      <Table
        dataSource={rows}
        rowKey={(r: QuoteDto, i?: number) => `${i ?? 0}|${r.podRaw}|${r.carrier}|${r.container}|${r.validFrom}|${r.sourceGroup}|${r.msgTime}`}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: false, size: "small", showTotal: t => `${t} 条` }}
        columns={[
          { title: "船司", dataIndex: "carrier", key: "carrier", width: 80, align: "center", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="top"><span className="text-xs font-bold text-gray-800 block truncate">{v}</span></Tooltip>
              : "—" },
          { title: "起运港", dataIndex: "pol", key: "pol", width: 110, align: "left", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="topLeft"><span className="text-xs text-gray-700 block truncate">{v}</span></Tooltip>
              : "—" },
          {
            title: "目的港", dataIndex: "podRaw", key: "pod", width: 200, align: "left", ellipsis: { showTitle: false },
            render: (v: string, r: QuoteDto) => (
              <Tooltip title={r.lane ? `${v}（${r.lane}）` : v} placement="topLeft">
                <span className="text-xs font-medium text-gray-800 block truncate">{v}
                  {r.lane && <span className="text-[10px] text-gray-400 ml-1">{r.lane}</span>}
                </span>
              </Tooltip>
            ),
          },
          { title: "柜型", dataIndex: "container", key: "container", width: 110, align: "center", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="top"><Tag color={CONTAINER_COLORS[v] || "purple"} className="text-[10px] !max-w-full overflow-hidden text-ellipsis">{v}</Tag></Tooltip>
              : <span className="text-[10px] text-gray-300">未填</span> },
          {
            title: "海运费", key: "usd", width: 90, align: "center",
            sorter: (a: QuoteDto, b: QuoteDto) => (a.oceanUsd ?? 0) - (b.oceanUsd ?? 0),
            render: (_: unknown, r: QuoteDto) => r.oceanUsd != null
              ? <span className="text-xs font-mono font-semibold text-gray-800">${r.oceanUsd}</span>
              : <span className="text-[10px] text-gray-300">议价</span>,
          },
          {
            title: "有效期", key: "valid", width: 110, align: "center",
            render: (_: unknown, r: QuoteDto) => {
              if (!r.validFrom && !r.validTo) return <span className="text-[10px] text-gray-300">—</span>;
              const expired = r.validTo && r.validTo < today;
              const full = `${r.validFrom || "?"} ~ ${r.validTo || "?"}${expired ? "（已过期）" : ""}`;
              return (
                <Tooltip title={full}>
                  <span className={`text-[11px] whitespace-nowrap cursor-default ${expired ? "text-red-400 line-through" : "text-gray-600"}`}>
                    {fmtValidity(r.validFrom, r.validTo)}
                  </span>
                </Tooltip>
              );
            },
          },
          { title: "消息时间", dataIndex: "msgTime", key: "time", width: 92, align: "center",
            render: (v: string | null) => <span className="text-[10px] text-gray-400 whitespace-nowrap">{fmtMsgTime(v)}</span> },
          {
            title: "", key: "go", width: 52, align: "center",
            render: (_: unknown, r: QuoteDto) => (
              <Button size="small" type="link" className="!px-0 text-[11px]" onClick={() => setDetail(r)}>详情</Button>
            ),
          },
        ]}
        tableLayout="fixed"
        scroll={{ x: 844 }}
      />

      {/* 详情抽屉：航线/有效期原文/免箱/亏舱费/来源/备注 + 报价截图（board_server /images 静态服务） */}
      <Drawer
        title={detail ? `${detail.carrier || "—"} · ${detail.pol || "?"} → ${detail.podRaw} · ${detail.container || "—"}` : ""}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
      >
        {detail && (
          <div className="space-y-3">
            <Descriptions size="small" column={1} bordered
              items={[
                { key: "usd", label: "海运费", children: detail.oceanUsd != null ? <b className="font-mono">${detail.oceanUsd}</b> : "议价" },
                { key: "valid", label: "有效期", children: [detail.validFrom, detail.validTo].filter(Boolean).join(" ~ ") || "—" },
                { key: "validRaw", label: "有效期原文", children: detail.validityRaw || "—" },
                { key: "lane", label: "航线", children: detail.lane || "—" },
                { key: "free", label: "免箱天数", children: detail.freeDays || "—" },
                { key: "short", label: "亏舱费", children: detail.shortfallFee || "—" },
                { key: "src", label: "来源群", children: detail.sourceGroup || "—" },
                { key: "sender", label: "报价人", children: detail.sender || "—" },
                { key: "time", label: "消息时间", children: fmtMsgTime(detail.msgTime) },
                { key: "note", label: "备注", children: detail.note || "—" },
              ]}
            />
            {detail.imageUrl ? (
              <div>
                <div className="text-[11px] text-gray-400 mb-1">报价截图</div>
                <img
                  src={detail.imageUrl}
                  alt="报价截图"
                  className="w-full rounded-lg border border-gray-200"
                  onError={(e) => {
                    const img = e.currentTarget;
                    img.style.display = "none";
                    img.nextElementSibling?.classList.remove("hidden");
                  }}
                />
                <div className="hidden text-[11px] text-gray-400 py-2">截图加载失败——需与公司电脑的运价服务在同一网络</div>
              </div>
            ) : (
              <div className="text-[11px] text-gray-300">这条记录没有关联报价截图</div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
