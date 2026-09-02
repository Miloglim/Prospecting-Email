import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Input, Select, Space, Table, Tag, Tooltip, App as AntApp } from "antd";
import { SearchOutlined, SyncOutlined, DollarOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { askAssistant } from "../../lib/ask-ai";
import { DiamondLogo } from "../../components/DiamondLogo";

interface RateStatus {
  total: number; active: number; lastSyncAt: string | null; lastImported: number | null;
  snapshotExists: boolean; snapshotMtime: string | null;
}

interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
}

interface IpcResult<T> { success: boolean; data?: T; error?: string }

const LANES = ["加勒比", "南美东", "南美西", "墨西哥", "中美洲", "欧地"];
const CARRIERS = ["CMA", "COSCO", "MSK", "HMM", "WHL", "MSC", "YML", "TSL", "EMC"];
const CONTAINERS = ["20GP", "40GP", "40HQ", "NOR", "40GP+40HQ"];

function fmtMsgTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 运价库 — 钉钉《海运运价智能台账》的本地镜像查询界面。
 * 数据来源单向：AI 表格（另一台电脑定时导出快照文件）→ 本程序读快照入库。
 * 镜像价为参考价，对外报价以船司实时运价为准。
 */
export function RateBoard() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [lane, setLane] = useState<string | undefined>();
  const [carrier, setCarrier] = useState<string | undefined>();
  const [container, setContainer] = useState<string | undefined>();
  const [includeExpired, setIncludeExpired] = useState(false);
  const [podInput, setPodInput] = useState("");
  const [pod, setPod] = useState<string | undefined>(); // 防抖后的目的港关键词

  // 目的港输入防抖 400ms
  useEffect(() => {
    const t = setTimeout(() => setPod(podInput.trim() || undefined), 400);
    return () => clearTimeout(t);
  }, [podInput]);

  const filters = useMemo(() => ({ lane, carrier, container, pod, includeExpired, limit: 5000 }),
    [lane, carrier, container, pod, includeExpired]);

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
          <Tag color={st && st.total ? "green" : "default"}>
            {st ? `${st.total} 条镜像 · ${st.active} 条有效` : "…"}
          </Tag>
          {st?.snapshotExists && (
            <span className="text-[11px] text-gray-400">
              快照 {st.snapshotMtime ? new Date(st.snapshotMtime).toLocaleString("zh-CN") : "—"} 导出
            </span>
          )}
        </Space>
        <Space>
          <Tooltip title="把当前筛选条件带进对话，AI 直接按这批条件查价并给结论">
            <Button size="small" icon={<DiamondLogo size={14} state="static" />}
              onClick={() => askAssistant({
                question: (() => {
                  const parts = [lane && `${lane}航线`, container, carrier && `${carrier}船司`, pod && `到 ${pod}`].filter(Boolean);
                  return parts.length
                    ? `查一下 ${parts.join(" ")} 的运价，按船司和柜型汇总，附有效期`
                    : "运价镜像库里现在有哪些航线和船司的报价？";
                })(),
              })}>问 AI</Button>
          </Tooltip>
          <Tooltip title="从快照文件刷新镜像（快照由同步任务写入 data/rates-snapshot.json）">
            <Button size="small" icon={<SyncOutlined spin={syncMut.isPending} />}
              loading={syncMut.isPending} onClick={() => syncMut.mutate()}>同步台账</Button>
          </Tooltip>
        </Space>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2">
        <Select size="small" placeholder="航线" allowClear style={{ width: 110 }}
          value={lane} onChange={v => setLane(v)}
          options={LANES.map(l => ({ value: l, label: l }))} />
        <Select size="small" placeholder="船司" allowClear style={{ width: 90 }}
          value={carrier} onChange={v => setCarrier(v)}
          options={CARRIERS.map(c => ({ value: c, label: c }))} />
        <Select size="small" placeholder="柜型" allowClear style={{ width: 120 }}
          value={container} onChange={v => setContainer(v)}
          options={CONTAINERS.map(c => ({ value: c, label: c }))} />
        <Input size="small" prefix={<SearchOutlined className="text-gray-300" />}
          placeholder="目的港关键词（如 SANTOS / KINGSTON）" allowClear
          style={{ width: 240 }} value={podInput} onChange={e => setPodInput(e.target.value)} />
        <Checkbox checked={includeExpired} onChange={e => setIncludeExpired(e.target.checked)}>
          <span className="text-[11px] text-gray-500">含已过期</span>
        </Checkbox>
        {rows.length >= 5000 && (
          <span className="text-[10px] text-amber-600">命中过多，按价格升序仅显示前 5000 条，请细化筛选</span>
        )}
      </div>

      {/* 运价表 */}
      <Table
        dataSource={rows}
        rowKey={(_, i) => String(i)}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: false, size: "small", showTotal: t => `${t} 条` }}
        columns={[
          {
            title: "目的港", dataIndex: "podRaw", key: "pod", width: 260,
            render: (v: string) => <span className="text-xs font-medium text-gray-800">{v}</span>,
          },
          { title: "航线", dataIndex: "lane", key: "lane", width: 80,
            render: (v: string | null) => v || "—" },
          { title: "船司", dataIndex: "carrier", key: "carrier", width: 70,
            render: (v: string | null) => v ? <Tag className="text-[10px]">{v}</Tag> : "—" },
          { title: "柜型", dataIndex: "container", key: "container", width: 110,
            render: (v: string | null) => v ? <Tag color="cyan" className="text-[10px]">{v}</Tag> : <span className="text-[10px] text-gray-300">未填</span> },
          {
            title: "海运费", key: "usd", width: 90, align: "right",
            sorter: (a: QuoteDto, b: QuoteDto) => (a.oceanUsd ?? 0) - (b.oceanUsd ?? 0),
            render: (_: unknown, r: QuoteDto) => r.oceanUsd != null
              ? <span className="text-xs font-mono font-semibold text-gray-800">${r.oceanUsd}</span>
              : <span className="text-[10px] text-gray-300">议价</span>,
          },
          {
            title: "有效期", key: "valid", width: 150,
            render: (_: unknown, r: QuoteDto) => {
              if (!r.validFrom && !r.validTo) return <span className="text-[10px] text-gray-300">—</span>;
              const expired = r.validTo && r.validTo < today;
              return (
                <span className={`text-[11px] ${expired ? "text-red-400 line-through" : "text-gray-600"}`}>
                  {r.validFrom} ~ {r.validTo}{expired && <Tag color="red" className="text-[9px] ml-1 my-0">过期</Tag>}
                </span>
              );
            },
          },
          {
            title: "备注（附加费/航次）", dataIndex: "note", key: "note",
            render: (v: string | null) => v
              ? <Tooltip title={v}><span className="text-[11px] text-gray-500 block truncate max-w-[260px]">{v}</span></Tooltip>
              : <span className="text-[10px] text-gray-300">—</span>,
          },
          { title: "来源群", dataIndex: "sourceGroup", key: "src", width: 150,
            render: (v: string | null) => <span className="text-[10px] text-gray-400">{v || "—"}</span> },
          { title: "消息时间", dataIndex: "msgTime", key: "time", width: 100,
            render: (v: string | null) => <span className="text-[10px] text-gray-400">{fmtMsgTime(v)}</span> },
        ]}
        scroll={{ x: "max-content" }}
      />
    </div>
  );
}
