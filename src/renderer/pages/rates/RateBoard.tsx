import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select, Space, Table, Tag, Tooltip, App as AntApp } from "antd";
import { SearchOutlined, SyncOutlined, DollarOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface RateStatus {
  total: number; active: number; lastSyncAt: string | null; lastImported: number | null;
  remoteHost: string; lastError: string | null;
}

interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
}

interface IpcResult<T> { success: boolean; data?: T; error?: string }

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
  const [container, setContainer] = useState<string | undefined>();
  const [podInput, setPodInput] = useState("");
  const [pod, setPod] = useState<string | undefined>();     // 防抖后的目的港关键词
  const [laneInput, setLaneInput] = useState("");
  const [lane, setLane] = useState<string | undefined>();   // 防抖后的航线关键词（模糊）
  const [carrierInput, setCarrierInput] = useState("");
  const [carrier, setCarrier] = useState<string | undefined>(); // 防抖后的船司关键词（模糊）

  // 文本筛选统一防抖 400ms
  useEffect(() => {
    const t = setTimeout(() => {
      setPod(podInput.trim() || undefined);
      setLane(laneInput.trim() || undefined);
      setCarrier(carrierInput.trim() || undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [podInput, laneInput, carrierInput]);

  const filters = useMemo(() => ({ lane, carrier, container, pod, limit: 5000 }),
    [lane, carrier, container, pod]);

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
            {st ? `${st.total} 条` : "…"}
          </Tag>
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
          <Tooltip title="从公司电脑的运价服务刷新本地镜像（每 10 分钟自动同步一次）">
            <Button size="small" icon={<SyncOutlined spin={syncMut.isPending} />}
              loading={syncMut.isPending} onClick={() => syncMut.mutate()}>同步运价库</Button>
          </Tooltip>
        </Space>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2">
        <Input size="small" placeholder="航线" allowClear
          style={{ width: 100 }} value={laneInput} onChange={e => setLaneInput(e.target.value)} />
        <Input size="small" placeholder="船司" allowClear
          style={{ width: 90 }} value={carrierInput} onChange={e => setCarrierInput(e.target.value)} />
        <Select size="small" placeholder="柜型" allowClear style={{ width: 120 }}
          value={container} onChange={v => setContainer(v)}
          options={CONTAINERS.map(c => ({ value: c, label: c }))} />
        <Input size="small" prefix={<SearchOutlined className="text-gray-300" />}
          placeholder="目的港关键词（如 santos / KINGSTON）" allowClear
          style={{ width: 240 }} value={podInput} onChange={e => setPodInput(e.target.value)} />
        {rows.length >= 5000 && (
          <span className="text-[10px] text-amber-600">命中过多，按价格升序仅显示前 5000 条，请细化筛选</span>
        )}
      </div>

      {/* 运价表 */}
      <Table
        dataSource={rows}
        rowKey={(r: QuoteDto, i?: number) => `${i ?? 0}|${r.podRaw}|${r.carrier}|${r.container}|${r.validFrom}|${r.sourceGroup}|${r.msgTime}`}
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
