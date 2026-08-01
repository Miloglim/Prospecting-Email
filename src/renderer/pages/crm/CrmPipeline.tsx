import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Tag, Button, Tabs, Input, Select, message, Empty, Timeline, DatePicker, Modal, Popover } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ClockCircleOutlined, CloseOutlined, MailOutlined, SearchOutlined,
  DownOutlined, RightOutlined, EditOutlined, SaveOutlined,
  DeleteOutlined, PlusOutlined, SendOutlined, EnvironmentOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import * as d3 from "d3";

// ══════════════════════════════════════════════════════════════
// 类型 & 常量（沿用旧 PE）
// ══════════════════════════════════════════════════════════════

interface PipelineContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  title: string | null; phone: string | null; linkedinUrl: string | null;
  companyName: string | null; companyId: number | null;
  stage: string; notes: string | null;
  reminderAt: string | null; reminderNote: string | null;
  country: string | null; clientType: string | null;
}

interface StageData { key: string; label: string; color: string; contacts: PipelineContact[]; }

const STAGES = [
  { key: "reaching", label: "触达中", color: "#ff9800" },
  { key: "quoting", label: "报价中", color: "#2196f3" },
  { key: "trial", label: "试单", color: "#8e24aa" },
  { key: "cooperating", label: "合作中", color: "#4caf50" },
  { key: "lost", label: "已流失", color: "#b0b0b0" },
  { key: "other", label: "其他", color: "#333333" },
];

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  sent: { label: "已发送", color: "#5c6bc0" },
  replied: { label: "已回复", color: "#22a644" },
  bounced: { label: "退信", color: "#d93025" },
  autoreply: { label: "自动回复", color: "#ff9800" },
};

function daysAgo(d: string) {
  const delta = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (delta === 0) return "今天";
  if (delta === 1) return "昨天";
  return `${delta} 天前`;
}

// ══════════════════════════════════════════════════════════════
// 主组件
// ══════════════════════════════════════════════════════════════

export function CrmPipeline() {
  const qc = useQueryClient();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [currentTab, setCurrentTab] = useState("info");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("crm-stage-state") || "{}"); } catch { return {}; }
  });
  const [emailPopup, setEmailPopup] = useState<{
    fromEmail: string; subject: string | null; receivedAt: string; bodyPreview: string | null;
  } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["crm", "pipeline"],
    queryFn: () => window.api.invoke("crm:listPipeline") as Promise<{ success: boolean; data?: StageData[] }>,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["crm", "detail", detailId],
    queryFn: () => window.api.invoke("crm:getDetail", detailId) as Promise<{
      success: boolean; data?: {
        contact: PipelineContact | null;
        interactions: Array<{ id?: number; type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string }>;
        emails: Array<{ id?: number; fromEmail: string; subject: string | null; classification: string | null; receivedAt: string; bodyPreview?: string | null }>;
      };
    }>,
    enabled: !!detailId,
  });

  const setStageMut = useMutation({
    mutationFn: (p: { contactId: number; stage: string }) => window.api.invoke("crm:setStage", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm"] }); },
  });

  const upsertMut = useMutation({
    mutationFn: (p: Record<string, unknown>) => window.api.invoke("contacts:upsert", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm"] }); },
  });

  const addReminderMut = useMutation({
    mutationFn: (p: { contactId: number; reminderAt: string; note?: string }) => window.api.invoke("crm:addReminder", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm"] }); },
  });

  const stages: StageData[] = data?.success ? data.data || [] : STAGES.map(s => ({ ...s, contacts: [] }));
  const contact = detail?.success ? detail.data?.contact : null;
  const detailData = detail?.success ? detail.data : null;

  const toggleStage = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    localStorage.setItem("crm-stage-state", JSON.stringify(next));
  };

  const saveNote = async () => {
    if (!noteText.trim() || !contact) return;
    await addReminderMut.mutateAsync({
      contactId: contact.id,
      reminderAt: new Date().toISOString(),
      note: noteText.trim(),
    });
    setNoteText("");
    qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
  };

  return (
    <div className="flex gap-4 h-full" style={{ minHeight: "calc(100vh - 130px)" }}>
      {/* ═══ 左侧看板 ═══ */}
      <div className="flex-1 overflow-y-auto pb-4 space-y-1">
        {isLoading ? <Card loading className="w-full" /> :
          stages.map(s => (
            <div key={s.key}>
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none sticky top-0 z-10 bg-gray-50"
                style={{ borderLeft: `3px solid ${s.color}` }}
                onClick={() => toggleStage(s.key)}
              >
                {collapsed[s.key] ? <RightOutlined className="text-[10px] text-gray-400" /> : <DownOutlined className="text-[10px] text-gray-400" />}
                <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                <span className="font-semibold text-xs">{s.label}</span>
                <span className="text-[11px] text-gray-400 ml-auto">{s.contacts.length}</span>
              </div>
              {!collapsed[s.key] && (
                <div>
                  {s.contacts.map(c => (
                    <div key={c.id}
                      className={`flex items-center gap-2 px-4 py-2 cursor-pointer border-b border-gray-50 hover:bg-gray-50 transition-colors text-xs ${detailId === c.id ? "bg-violet-50 border-l-2 border-l-violet-400" : ""}`}
                      onClick={() => { setDetailId(c.id); setCurrentTab("info"); }}
                    >
                      <span className="font-medium flex-shrink-0 w-20 truncate">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-[11px] text-gray-400 flex-1 truncate">{c.companyName || "—"}</span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        {c.reminderAt ? (
                          <span className={`text-[10px] flex items-center gap-0.5 ${new Date(c.reminderAt) < new Date() ? "text-red-500 font-semibold" : "text-amber-500"}`}>
                            <ClockCircleOutlined className="text-[9px]" />
                            {new Date(c.reminderAt) < new Date() ? `逾期${daysAgo(c.reminderAt)}` : dayjs(c.reminderAt).format("MM/DD")}
                          </span>
                        ) : <span className="text-[10px] text-gray-300">—</span>}
                      </span>
                    </div>
                  ))}
                  {s.contacts.length === 0 && <div className="text-center text-[11px] text-gray-300 py-4">暂无</div>}
                </div>
              )}
            </div>
          ))
        }
        {stages.every(s => s.contacts.length === 0) && (
          <Empty description="暂无跟进中的客户" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </div>

      {/* ═══ 右侧详情面板 ═══ */}
      {detailId && (
        <div className="flex-shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden" style={{ width: 340 }}>
          {/* 头部 */}
          <div className="p-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm">
                {contact?.firstName} {contact?.lastName}
              </span>
              <SearchOutlined className="text-[10px] text-gray-400 cursor-pointer" />
              <MailOutlined className="text-[10px] text-gray-400 cursor-pointer" />
            </div>
            <Button type="text" size="small" onClick={() => { setDetailId(null); setEmailPopup(null); }}>
              <CloseOutlined />
            </Button>
          </div>

          {/* Tabs */}
          <Tabs activeKey={currentTab} onChange={setCurrentTab} size="small"
            tabBarStyle={{ margin: 0, padding: "0 8px" }}
            items={[
              { key: "info", label: <span className="text-[10px]">基本信息</span> },
              { key: "prefs", label: <span className="text-[10px]">偏好设置</span> },
              { key: "followup", label: <span className="text-[10px]">跟进记录</span> },
              { key: "emails", label: <span className="text-[10px]">邮件往来</span> },
              { key: "relations", label: <span className="text-[10px]">关系网络</span> },
            ]}
          />

          <div className="flex-1 overflow-y-auto p-3">
            {detailLoading && <Card loading />}

            {/* Tab 1: 基本信息 */}
            {currentTab === "info" && contact && (
              <div className="space-y-1 text-xs">
                {([
                  { label: "姓名", type: "double", field1: "firstName", field2: "lastName" },
                  { label: "邮箱", type: "text", field: "email" },
                  { label: "公司", type: "text", field: "companyName" },
                  { label: "国家", type: "select", field: "country", options: ["EN", "ES", "PT", "CN", "BR"] },
                  { label: "职位", type: "text", field: "title" },
                  { label: "电话", type: "text", field: "phone" },
                  { label: "领英", type: "text", field: "linkedinUrl" },
                  { label: "客户类型", type: "select", field: "clientType", options: ["agent", "direct", "unlabeled"] },
                ] as const).map(row => (
                  <div key={row.label} className="flex items-center py-1.5 border-b border-gray-50">
                    <span className="w-14 text-[10px] text-gray-400">{row.label}</span>
                    {row.type === "select" && "options" in row ? (
                      <StagePicker
                        value={String((contact as unknown as Record<string, string>)[(row as unknown as { field: string }).field] || "—")}
                        options={(row as unknown as { options: string[] }).options as unknown as string[]}
                        onChange={async (v) => {
                          await upsertMut.mutateAsync({ id: contact.id, email: contact.email, [(row as { field: string }).field]: v });
                          qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
                        }}
                      />
                    ) : (
                      <InlineEdit
                        value={row.type === "double"
                          ? `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "—"
                          : String((contact as unknown as Record<string, string>)[(row as { field: string }).field || ""] || "—")
                        }
                        onSave={async (val) => {
                          if (row.type === "double") {
                            const [first, ...rest] = val.split(" ");
                            await upsertMut.mutateAsync({ id: contact.id, email: contact.email, firstName: first || "", lastName: rest.join(" ") || "" });
                          } else {
                            await upsertMut.mutateAsync({ id: contact.id, email: contact.email, [(row as { field: string }).field]: val });
                          }
                          qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
                        }}
                      />
                    )}
                  </div>
                ))}

                {/* 阶段 — 弹窗选择器（沿用旧 PE stage picker） */}
                <div className="flex items-center py-1.5 border-b border-gray-50">
                  <span className="w-14 text-[10px] text-gray-400">阶段</span>
                  <StagePicker
                    value={contact.stage}
                    options={STAGES}
                    onChange={v => setStageMut.mutate({ contactId: contact.id, stage: v })}
                  />
                </div>

                {/* 提醒 */}
                <div className="flex items-center py-1.5 border-b border-gray-50">
                  <span className="w-14 text-[10px] text-gray-400">提醒</span>
                  <DatePicker showTime size="small" style={{ width: 170, fontSize: 11 }}
                    value={contact.reminderAt ? dayjs(contact.reminderAt) : null}
                    onChange={v => {
                      if (v) addReminderMut.mutate({ contactId: contact.id, reminderAt: v.toISOString() });
                    }}
                    placeholder="设置跟进提醒"
                  />
                </div>
              </div>
            )}

            {/* Tab 2: 偏好设置 */}
            {currentTab === "prefs" && contact && (
              <div className="space-y-3 text-xs">
                {([
                  { label: "偏好路线", field: "preferredRoutes", type: "select", opts: ["南美西", "南美东", "加勒比", "中美", "墨西哥", "欧洲", "亚洲", "非洲"] },
                  { label: "决策角色", field: "decisionRole", type: "select", opts: ["决策者", "影响者", "信息提供者"] },
                  { label: "价格敏感度", field: "priceSensitivity", type: "select", opts: ["高", "中", "低"] },
                  { label: "年度货量", field: "annualVolume", type: "select", opts: ["<100TEU", "100-500TEU", "500-2000TEU", ">2000TEU"] },
                ]).map(row => (
                  <div key={row.field} className="flex items-center py-1.5 border-b border-gray-50">
                    <span className="w-20 text-[10px] text-gray-400">{row.label}</span>
                    <span className="text-[11px] text-gray-400">（后续实现）</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tab 3: 跟进记录 */}
            {currentTab === "followup" && detailData && (
              <div className="space-y-3">
                {/* 写跟进记录 */}
                <div className="flex gap-2">
                  <Input.TextArea size="small" rows={2} value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    placeholder="添加跟进记录..."
                    style={{ fontSize: 11 }}
                  />
                </div>
                <Button size="small" type="primary" icon={<PlusOutlined />}
                  onClick={saveNote} block>保存</Button>

                <Timeline items={detailData.interactions.slice(0, 40).map(i => ({
                  color: TYPE_LABELS[i.type]?.color || "gray",
                  children: (
                    <div className="text-[10px]">
                      <div className="flex items-center gap-1.5">
                        <Tag color={TYPE_LABELS[i.type]?.color} className="text-[9px] leading-none px-1">
                          {TYPE_LABELS[i.type]?.label || i.type}
                        </Tag>
                        <span className="text-gray-400">{new Date(i.createdAt).toLocaleDateString("zh-CN")}</span>
                        {editingNoteId === i.id ? (
                          <Button type="text" size="small" icon={<SaveOutlined />}
                            style={{ padding: 0, minWidth: 16, height: 16 }}
                            onClick={() => setEditingNoteId(null)} />
                        ) : (
                          <Button type="text" size="small" icon={<EditOutlined />}
                            style={{ padding: 0, minWidth: 16, height: 16 }}
                            onClick={() => { setEditingNoteId(i.id || null); }} />
                        )}
                      </div>
                      {i.subject && <div className="text-[11px] mt-0.5 font-medium text-gray-700">{i.subject}</div>}
                      {i.bodyPreview && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{i.bodyPreview}</div>}
                    </div>
                  ),
                }))} />
                {!detailData.interactions.length && <Empty description="暂无跟进记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
            )}

            {/* Tab 4: 邮件往来 */}
            {currentTab === "emails" && detailData && (
              <div className="space-y-1.5">
                {detailData.emails.map((e, i) => (
                  <div key={i} className="border border-gray-100 rounded p-2 text-xs hover:border-gray-300 cursor-pointer"
                    onClick={() => setEmailPopup({
                      fromEmail: e.fromEmail,
                      subject: e.subject,
                      receivedAt: e.receivedAt,
                      bodyPreview: e.bodyPreview ?? null,
                    })}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <MailOutlined className="text-[9px] text-gray-400" />
                      <span className="text-[10px] font-mono">{e.fromEmail}</span>
                      {e.classification && (
                        <Tag color={TYPE_LABELS[e.classification]?.color || "default"}
                          className="text-[9px] leading-none px-1 ml-auto"
                        >{TYPE_LABELS[e.classification]?.label || e.classification}</Tag>
                      )}
                    </div>
                    <div className="text-[10px] truncate">{e.subject || "无主题"}</div>
                    <div className="text-[9px] text-gray-400 mt-0.5">{new Date(e.receivedAt).toLocaleDateString("zh-CN")}</div>
                  </div>
                ))}
                {!detailData.emails.length && <Empty description="暂无邮件记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
            )}

            {/* Tab 5: 关系网络 */}
            {currentTab === "relations" && contact && (
              <RelationGraph contactId={contact.id} />
            )}
          </div>
        </div>
      )}

      {/* 邮件正文弹窗 */}
      <Modal title={emailPopup?.subject || "邮件详情"} open={!!emailPopup}
        onCancel={() => setEmailPopup(null)} footer={null} width={640}
      >
        {emailPopup && (
          <div className="text-xs space-y-2">
            <div className="flex gap-4 text-gray-500">
              <span>发件人: {emailPopup.fromEmail}</span>
              <span>{new Date(emailPopup.receivedAt).toLocaleString("zh-CN")}</span>
            </div>
            <div className="border-t pt-2 whitespace-pre-wrap text-[11px] leading-relaxed">
              {emailPopup.bodyPreview || "（无法加载正文）"}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 小组件：阶段/选项选择器（沿用旧 PE 弹窗模式）
// ══════════════════════════════════════════════════════════════

function StagePicker({ value, options, onChange }: {
  value: string; options: string[] | { key: string; label: string; color?: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  const items = options.map(o =>
    typeof o === "string" ? { key: o, label: o, color: "#999" } : { key: o.key, label: o.label, color: o.color || "#999" }
  );
  const current = items.find(i => i.key === value);
  const color = current?.color || "#999";

  return (
    <div className="flex-1 relative">
      <div ref={btnRef}
        className="flex items-center gap-1.5 cursor-pointer text-[11px] px-1 py-0.5 hover:bg-gray-50 rounded"
        onClick={() => setOpen(!open)}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span>{current?.label || value || "—"}</span>
      </div>
      {open && (
        <div className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px] text-xs"
          style={{
            left: Math.min((btnRef.current?.getBoundingClientRect().left || 0), window.innerWidth - 160),
            top: (btnRef.current?.getBoundingClientRect().bottom || 0) + 4,
          }}
        >
          {items.map(item => (
            <div key={item.key}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50 ${item.key === value ? "font-semibold" : ""}`}
              onClick={() => { onChange(item.key); setOpen(false); }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: item.color }} />
              {item.key === value ? " ●" : ""} {item.label}
            </div>
          ))}
        </div>
      )}
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 内联编辑
// ══════════════════════════════════════════════════════════════

function InlineEdit({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  const save = async () => {
    setEditing(false);
    if (val !== value) await onSave(val);
  };

  if (editing) {
    return (
      <div className="flex-1 flex gap-1">
        <Input size="small" value={val} onChange={e => setVal(e.target.value)}
          onPressEnter={save} autoFocus style={{ fontSize: 11, height: 22 }}
          onKeyDown={e => { if (e.key === "Escape") { setVal(value); setEditing(false); } }}
        />
        <Button type="text" size="small" icon={<SaveOutlined />} style={{ padding: 0, minWidth: 18, height: 18 }} onClick={save} />
        <Button type="text" size="small" icon={<CloseOutlined />} style={{ padding: 0, minWidth: 18, height: 18 }} onClick={() => { setVal(value); setEditing(false); }} />
      </div>
    );
  }

  return (
    <span className="flex-1 text-[11px] cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5" onClick={() => setEditing(true)}>
      {value}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════
// D3 关系图（沿用旧 PE 力导向图）
// ══════════════════════════════════════════════════════════════

function RelationGraph({ contactId }: { contactId: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; type: "company" | "contact"; label: string; color?: string; stage?: string }>>([]);
  const [edges, setEdges] = useState<Array<{ source: string; target: string; type: "company" | "custom"; label?: string }>>([]);

  useEffect(() => {
    (async () => {
      const r = await window.api.invoke("crm:listRelations", contactId) as {
        success: boolean; data?: Array<{
          id: number; firstName: string | null; lastName: string | null;
          companyId: number | null; companyName?: string | null;
        }>;
      };
      if (!r?.success || !r.data?.length) return;

      const contacts = r.data;
      const company = contacts[0]!;
      const ns: typeof nodes = [
        { id: `c_${company.companyId || 0}`, type: "company", label: company.companyName || "公司", color: "#1a1a1a" },
      ];
      const es: typeof edges = [];

      for (const c of contacts) {
        const sid = `p_${c.id}`;
        ns.push({ id: sid, type: "contact", label: [c.firstName, c.lastName].filter(Boolean).join(" ") || "—" });
        es.push({ source: `c_${c.companyId || 0}`, target: sid, type: "company" });
      }

      setNodes(ns);
      setEdges(es);
    })();
  }, [contactId]);

  useEffect(() => {
    if (!svgRef.current || !nodes.length || !containerRef.current) return;

    const w = containerRef.current.clientWidth;
    const h = 400;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("width", w).attr("height", h);

    const g = svg.append("g");
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 3]).on("zoom", (e) => { g.attr("transform", e.transform); });
    svg.call(zoom);

    const sim = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide(30))
      .force("link", d3.forceLink(edges).distance(100))
      .on("tick", () => {
        g.selectAll<SVGLineElement, typeof edges[0]>("line")
          .data(edges)
          .join("line")
          .attr("x1", d => ((d.source as d3.SimulationNodeDatum).x || 0))
          .attr("y1", d => ((d.source as d3.SimulationNodeDatum).y || 0))
          .attr("x2", d => ((d.target as d3.SimulationNodeDatum).x || 0))
          .attr("y2", d => ((d.target as d3.SimulationNodeDatum).y || 0))
          .attr("stroke", d => d.type === "custom" ? "#e6a817" : "#b0b0b0")
          .attr("stroke-dasharray", d => d.type === "custom" ? "5,3" : "none")
          .attr("stroke-opacity", 0.5);

        g.selectAll<SVGCircleElement, typeof nodes[0]>("circle")
          .data(nodes)
          .join("circle")
          .attr("r", d => d.type === "company" ? 24 : 10)
          .attr("cx", d => (d as d3.SimulationNodeDatum).x || 0)
          .attr("cy", d => (d as d3.SimulationNodeDatum).y || 0)
          .attr("fill", d => d.type === "company" ? d.color || "#1a1a1a" : "#4caf50")
          .attr("stroke", "#fff")
          .attr("stroke-width", 2);

        g.selectAll<SVGTextElement, typeof nodes[0]>("text")
          .data(nodes)
          .join("text")
          .attr("x", d => ((d as d3.SimulationNodeDatum).x || 0))
          .attr("y", d => ((d as d3.SimulationNodeDatum).y || 0) + (d.type === "company" ? 34 : 16))
          .attr("text-anchor", "middle")
          .attr("fill", "#666")
          .attr("font-size", 9)
          .text(d => d.label.slice(0, 8));
      });

    return () => { sim.stop(); };
  }, [nodes, edges]);

  return (
    <div ref={containerRef} className="w-full">
      <svg ref={svgRef} />
      {!nodes.length && <Empty description="暂无关系数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    </div>
  );
}
