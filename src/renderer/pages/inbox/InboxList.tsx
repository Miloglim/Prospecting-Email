import { useState } from "react";
import { Button, Input, Tag, Empty, message, Select } from "antd";
import {
  ReloadOutlined, MailOutlined, StarOutlined, SearchOutlined,
  DeleteOutlined, CheckOutlined,
} from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface InboxItem {
  id: number; fromEmail: string; fromName: string | null;
  subject: string | null; bodyPreview: string | null;
  classification: string | null; matchedContactId: number | null;
  isRead: number; receivedAt: string;
}

const TYPE_LABELS: Record<string, { label: string; color: string; dot: string }> = {
  replied: { label: "回复", color: "green", dot: "#22a644" },
  bounce: { label: "退信", color: "red", dot: "#e5484d" },
  autoreply: { label: "自动回复", color: "orange", dot: "#e6a817" },
  other: { label: "其他", color: "default", dot: "#8b8b8b" },
};

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "replied", label: "回复", dot: "#22a644" },
  { key: "autoreply", label: "自动回复", dot: "#e6a817" },
  { key: "bounce", label: "退信", dot: "#e5484d" },
  { key: "other", label: "其他", dot: "#8b8b8b" },
];

export function InboxList() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["inbox", filter, search],
    queryFn: () => window.api.invoke("inbox:fetch") as Promise<{
      success: boolean; data?: InboxItem[]; error?: string;
    }>,
  });

  const markReadMut = useMutation({
    mutationFn: () => window.api.invoke("inbox:classify", selectedId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });

  let items = data?.success ? data.data || [] : [];
  if (filter !== "all") items = items.filter(i => i.classification === filter);
  if (search.trim()) {
    const q = search.toLowerCase();
    items = items.filter(i =>
      (i.subject || "").toLowerCase().includes(q) ||
      i.fromEmail.toLowerCase().includes(q) ||
      (i.fromName || "").toLowerCase().includes(q)
    );
  }

  const selected = items.find(i => i.id === selectedId) || null;

  return (
    <div className="flex gap-4 h-full" style={{ minHeight: "calc(100vh - 130px)" }}>
      {/* ═══ 左侧列表 ═══ */}
      <div className="flex flex-col flex-shrink-0" style={{ width: 360 }}>
        {/* 工具栏 */}
        <div className="flex items-center gap-2 mb-2">
          <Button size="small" icon={<ReloadOutlined />} loading={isFetching}
            onClick={() => refetch()}>刷新</Button>
          <Input size="small" prefix={<SearchOutlined />} placeholder="搜索..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: 160, fontSize: 11 }} allowClear />
        </div>

        {/* 筛选栏 */}
        <div className="flex gap-0.5 mb-2 bg-white border border-gray-200 rounded overflow-hidden">
          {FILTERS.map(f => (
            <button key={f.key}
              className={`flex-1 py-1.5 text-[10px] cursor-pointer transition-colors ${filter === f.key ? "font-semibold bg-gray-100 text-gray-800" : "bg-white text-gray-400 hover:bg-gray-50"}`}
              style={filter === f.key ? { boxShadow: "inset 0 -2px 0 #1a1a1a" } : undefined}
              onClick={() => { setFilter(f.key); setSelectedId(null); }}
            >
              <span className="flex items-center justify-center gap-1">
                {"dot" in f && <span className="w-1.5 h-1.5 rounded-full" style={{ background: f.dot }} />}
                {f.label}
              </span>
            </button>
          ))}
        </div>

        {/* 邮件列表 */}
        <div className="flex-1 overflow-y-auto border border-gray-200 rounded bg-white">
          {isLoading ? <div className="text-center text-xs text-gray-400 py-10">加载中...</div> :
            items.length === 0 ? <Empty description="没有邮件" image={Empty.PRESENTED_IMAGE_SIMPLE} className="mt-10" /> :
            items.map(i => {
              const t = TYPE_LABELS[i.classification || "other"];
              return (
                <div key={i.id}
                  className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-50 hover:bg-gray-50 transition-colors ${selectedId === i.id ? "bg-violet-50 border-l-[3px] border-l-violet-400" : ""}`}
                  onClick={() => { setSelectedId(i.id); markReadMut.mutate(); }}
                >
                  {/* 类型圆点 */}
                  <span className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ background: t.dot }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs truncate ${i.isRead === 0 ? "font-semibold" : "font-normal text-gray-600"}`}>
                        {i.fromName || i.fromEmail}
                      </span>
                      <span className="text-[9px] text-gray-400 flex-shrink-0">
                        {new Date(i.receivedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-700 truncate mt-0.5">{i.subject || "无主题"}</div>
                    <div className="flex items-center gap-1 mt-1">
                      {i.classification && (
                        <Tag color={t.color} className="text-[9px] leading-none px-1 my-0">{t.label}</Tag>
                      )}
                      {i.matchedContactId && (
                        <span className="text-[9px] text-blue-500 bg-blue-50 px-1 rounded">已匹配</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          }
        </div>
      </div>

      {/* ═══ 右侧正文 ═══ */}
      <div className="flex-1 bg-white border border-gray-200 rounded flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-300">
            <MailOutlined className="text-4xl mb-3" />
            <span className="text-xs">选择左侧邮件查看正文</span>
          </div>
        ) : (
          <>
            {/* 邮件头部 */}
            <div className="p-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">{selected.subject || "无主题"}</h3>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-700">{selected.fromName || selected.fromEmail}</span>
                  <span className="text-[10px] font-mono text-gray-400">{selected.fromEmail}</span>
                </div>
                <div className="flex items-center gap-2">
                  {selected.classification && (
                    <Tag color={TYPE_LABELS[selected.classification]?.color}>
                      {TYPE_LABELS[selected.classification]?.label || selected.classification}
                    </Tag>
                  )}
                  <span className="text-[10px]">
                    {new Date(selected.receivedAt).toLocaleString("zh-CN")}
                  </span>
                </div>
              </div>
            </div>

            {/* 正文 */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
                {selected.bodyPreview || "（无法加载正文）"}
              </div>
            </div>

            {/* 操作栏 */}
            <div className="p-3 border-t border-gray-100 flex items-center justify-between">
              <div className="flex gap-2">
                <Select size="small" placeholder="标记为..."
                  style={{ width: 130, fontSize: 11 }}
                  options={Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v.label }))}
                  onChange={async (v) => {
                    const r = await window.api.invoke("inbox:classify", selected.id);
                    r?.success ? message.success("已更新分类") : message.error(r?.error || "失败");
                  }}
                />
              </div>
              <Button size="small" danger icon={<DeleteOutlined />}
                onClick={() => message.info("删除功能待接入")}>删除</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
