import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Tag, Button, Tabs, Input, Select, message, Empty, Timeline, DatePicker, Modal, Popconfirm, Tooltip } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ClockCircleOutlined, CloseOutlined, MailOutlined, SearchOutlined,
  DownOutlined, RightOutlined, EditOutlined, SaveOutlined,
  DeleteOutlined, PlusOutlined, SendOutlined, EnvironmentOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";

// ══════════════════════════════════════════════════════════════
// 类型 & 常量（沿用旧 PE）
// ══════════════════════════════════════════════════════════════

interface PipelineContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  title: string | null; phone: string | null; linkedinUrl: string | null;
  companyName: string | null; companyId: number | null;
  stage: string; notes: string | null;
  reminderAt: string | null; reminderNote: string | null;
  country: string | null; language: string | null; clientType: string | null;
  assignee: string | null;
  stageChangedAt: string | null;
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
  sent: { label: "已发送", color: "#2563eb" },
  replied: { label: "已回复", color: "#22a644" },
  bounced: { label: "退信", color: "#d93025" },
  autoreply: { label: "自动回复", color: "#ff9800" },
  note: { label: "跟进", color: "#607d8b" },
};

function daysAgo(d: string) {
  const delta = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (delta === 0) return "今天";
  if (delta === 1) return "昨天";
  return `${delta} 天前`;
}

function stageDays(c: PipelineContact): { days: number; warn: boolean; danger: boolean } {
  if (!c.stageChangedAt) return { days: 0, warn: false, danger: false };
  const days = Math.floor((Date.now() - new Date(c.stageChangedAt).getTime()) / 86400000);
  // 按阶段设阈值
  const thresholds: Record<string, { warn: number; danger: number }> = {
    reaching: { warn: 7, danger: 14 },
    quoting: { warn: 5, danger: 10 },
    trial: { warn: 10, danger: 21 },
  };
  const t = thresholds[c.stage];
  return { days, warn: t ? days >= t.warn : false, danger: t ? days >= t.danger : false };
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

  // 从联系人页跳转来 → 记录待打开 ID
  const pendingDetailRef = useRef<number | null>(null);
  useEffect(() => {
    const rawHash = window.location.hash;
    const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
    if (!qs) return;
    const sp = new URLSearchParams(qs);
    const detailStr = sp.get("detail");
    if (!detailStr) return;
    const id = Number(detailStr);
    if (isNaN(id)) return;
    pendingDetailRef.current = id;
    setDetailId(id);
    const base = rawHash.split("?")[0]!;
    window.location.hash = base;
  }, []);
  const [emailPopup, setEmailPopup] = useState<{
    fromEmail: string; subject: string | null; receivedAt: string; bodyPreview: string | null;
  } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [sendContact, setSendContact] = useState<PipelineContact | null>(null);
  const [sendTemplateId, setSendTemplateId] = useState<number | undefined>();
  const [sendAccountId, setSendAccountId] = useState<number | undefined>();
  const [sendPreview, setSendPreview] = useState<{ subject: string; body: string } | null>(null);
  const [sendSending, setSendSending] = useState(false);

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

  const clearReminderMut = useMutation({
    mutationFn: (contactId: number) => window.api.invoke("crm:clearReminder", contactId),
    onSuccess: (result) => {
      const r = result as { success: boolean; error?: string };
      if (r?.success) {
        qc.invalidateQueries({ queryKey: ["crm"] });
        message.success("提醒已清除");
      } else {
        message.error(r?.error || "清除失败");
      }
    },
    onError: (err) => { message.error("清除失败: " + (err instanceof Error ? err.message : String(err))); },
  });

  const updateNoteMut = useMutation({
    mutationFn: (p: { interactionId: number; text: string }) => window.api.invoke("crm:updateNote", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm"] }); },
  });

  const deleteNoteMut = useMutation({
    mutationFn: (interactionId: number) => window.api.invoke("crm:deleteNote", interactionId),
    onSuccess: (result) => {
      const r = result as { success: boolean; error?: string };
      r?.success ? message.success("已删除") : message.error(r?.error || "删除失败");
      qc.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  // 模板 + 账号（快速发送用）
  const { data: templatesData } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{ success: boolean; data?: Array<{ id: number; name: string; subject: string; body: string }> }>,
  });
  const { data: accountsData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: Array<{ id: number; email: string }> }>,
  });
  const templates = templatesData?.success ? templatesData.data || [] : [];
  const accounts = accountsData?.success ? accountsData.data || [] : [];

  const handleQuickSend = async () => {
    if (!sendContact || !sendTemplateId || !sendAccountId) return;
    setSendSending(true);
    try {
      const tpl = templates.find(t => t.id === sendTemplateId);
      const r = await window.api.invoke("send:test", {
        to: sendContact.email,
        accountId: sendAccountId,
        subject: tpl?.subject,
        body: tpl?.body,
        contactId: sendContact.id,
      }) as { success: boolean; error?: string };
      r?.success ? message.success(`已发送到 ${sendContact.email}`) : message.error(r?.error || "发送失败");
      if (r?.success) setSendContact(null);
    } catch (err) {
      message.error("发送失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSendSending(false);
    }
  };

  const stages: StageData[] = data?.success ? data.data || [] : STAGES.map(s => ({ ...s, contacts: [] }));
  const contact = detail?.success ? detail.data?.contact : null;
  const detailData = detail?.success ? detail.data : null;

  // 自动展开有联系人的阶段，收起空阶段（collapsed=true 表示收起）
  useEffect(() => {
    if (!data?.success) return;
    const next: Record<string, boolean> = {};
    for (const s of stages) {
      next[s.key] = s.contacts.length === 0; // 空的→收起，有人的→展开
    }
    setCollapsed(next);
  }, [data]);

  // 数据加载后 → 展开阶段 + 滚动到联系人
  useEffect(() => {
    if (pendingDetailRef.current === null) return;
    const id = pendingDetailRef.current;
    const contactStage = stages.find(s => s.contacts.some(c => c.id === id));
    if (contactStage) {
      setCollapsed(prev => ({ ...prev, [contactStage.key]: false }));
      setTimeout(() => {
        const el = document.getElementById(`crm-contact-${id}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 200);
    }
    pendingDetailRef.current = null;
  }, [stages]);

  const toggleStage = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    localStorage.setItem("crm-stage-state", JSON.stringify(next));
  };

  const saveNote = async () => {
    if (!noteText.trim() || !contact) return;
    // 只写跟进记录，不设置提醒（提醒由用户通过 DatePicker 手动设置）
    await window.api.invoke("crm:addNote", { contactId: contact.id, text: noteText.trim() });
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
                      id={`crm-contact-${c.id}`}
                      className={`flex items-center gap-2 px-4 py-2 cursor-pointer border-b border-gray-50 hover:bg-gray-50 transition-colors text-xs ${detailId === c.id ? "bg-violet-50 border-l-2 border-l-violet-400" : ""}`}
                      onClick={() => { setDetailId(c.id); setCurrentTab("info"); }}
                    >
                      <span className="font-medium flex-shrink-0 w-20 truncate">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-[11px] text-gray-400 flex-1 truncate">{c.companyName || "—"}</span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        {(() => {
                          const sd = stageDays(c);
                          if (sd.days > 0) {
                            return (
                              <span className={`text-[10px] ${sd.danger ? "text-red-500 font-semibold" : sd.warn ? "text-amber-500" : "text-gray-400"}`}>
                                {sd.days}天
                              </span>
                            );
                          }
                          return null;
                        })()}
                        {c.reminderAt ? (
                          <span className={`text-[10px] flex items-center gap-0.5 ${new Date(c.reminderAt) < new Date() ? "text-red-500 font-semibold" : "text-amber-500"}`}>
                            <ClockCircleOutlined className="text-[9px]" />
                            {new Date(c.reminderAt) < new Date() ? `逾期${daysAgo(c.reminderAt)}` : dayjs(c.reminderAt).format("MM/DD")}
                          </span>
                        ) : <span className="text-[10px] text-gray-300">—</span>}
                      </span>
                      <SendOutlined className="text-[11px] text-gray-300 hover:text-blue-500 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setSendContact(c); setSendTemplateId(undefined); setSendAccountId(undefined); setSendPreview(null); }}
                      />
                    </div>
                  ))}
                  {s.contacts.length === 0 && <div className="text-center text-[11px] text-gray-300 py-4">暂无</div>}
                </div>
              )}
            </div>
          ))
        }
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
              <Tooltip title="在联系人中查看">
                <SearchOutlined
                  className="text-[11px] text-gray-400 hover:text-blue-500 cursor-pointer transition-colors"
                  onClick={() => {
                    if (contact?.id) window.location.hash = `#/contacts?detail=${contact.id}`;
                  }}
                />
              </Tooltip>
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
            ]}
          />

          <div className="flex-1 p-3 flex flex-col crm-detail-scroll" style={{ overflowY: "auto" }}>
            {detailLoading && <Card loading />}

            {/* Tab 1: 基本信息 */}
            {currentTab === "info" && contact && (
              <div className="space-y-1 text-xs">
                {([
                  { label: "姓名", type: "double", field1: "firstName", field2: "lastName" },
                  { label: "邮箱", type: "text", field: "email" },
                  { label: "公司", type: "text", field: "companyName" },
                  { label: "国家", type: "text", field: "country" },
                  { label: "语言", type: "select", field: "language", options: [
                    { key: "EN", label: "EN 英语", color: "#1565c0" },
                    { key: "ES", label: "ES 西班牙语", color: "#e65100" },
                    { key: "PT", label: "PT 葡萄牙语", color: "#2e7d32" },
                    { key: "", label: "未设置", color: "#999" },
                  ] },
                  { label: "职位", type: "text", field: "title" },
                  { label: "负责人", type: "text", field: "assignee" },
                  { label: "发送阶段", type: "select", field: "stage", options: [
                    { key: "cold", label: "新线索", color: "#1565c0" },
                    { key: "f1", label: "第1轮", color: "#2e7d32" },
                    { key: "f2", label: "第2轮", color: "#e65100" },
                    { key: "f3", label: "第3轮", color: "#7b1fa2" },
                    { key: "f4", label: "第4轮+", color: "#546e7a" },
                    { key: "", label: "未设置", color: "#999" },
                  ] },
                  { label: "电话", type: "text", field: "phone" },
                  { label: "领英", type: "text", field: "linkedinUrl" },
                  { label: "客户类型", type: "select", field: "clientType", options: [
                    { key: "agent", label: "代理", color: "#5c6bc0" },
                    { key: "direct", label: "直客", color: "#22a644" },
                    { key: "", label: "未设置", color: "#999" },
                  ] },
                ] as const).map(row => (
                  <div key={row.label} className="flex items-center py-1.5 border-b border-gray-50">
                    <span className="w-14 text-[10px] text-gray-400">{row.label}</span>
                    {row.type === "select" && "options" in row ? (
                      <StagePicker
                        value={String((contact as unknown as Record<string, string>)[(row as unknown as { field: string }).field] || "—")}
                        options={(row as unknown as { options: string[] | { key: string; label: string; color?: string }[] }).options}
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
                      if (v) {
                        addReminderMut.mutate({ contactId: contact.id, reminderAt: v.toISOString() });
                      } else {
                        clearReminderMut.mutate(contact.id);
                      }
                    }}
                    placeholder="设置跟进提醒"
                    allowClear
                  />
                </div>
              </div>
            )}

            {/* Tab 2: 偏好设置 — 存储在 contact.extra */}
            {currentTab === "prefs" && contact && (() => {
              const extra = (contact as unknown as Record<string, unknown>).extra as Record<string, unknown> || {};
              const ports: Array<{ pol: string; pod: string }> = (() => {
                try { const p = JSON.parse(String(extra.preferredPorts || "[]")); return Array.isArray(p) ? p : []; } catch { return []; }
              })();

              const saveExtra = async (patch: Record<string, unknown>) => {
                const newExtra = { ...extra, ...patch };
                await upsertMut.mutateAsync({ id: contact.id, email: contact.email, extra: JSON.stringify(newExtra) });
                qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
              };

              const updatePort = async (idx: number, field: "pol" | "pod", val: string) => {
                const next = ports.map((p, i) => i === idx ? { ...p, [field]: val } : p);
                await saveExtra({ preferredPorts: JSON.stringify(next) });
              };

              const addPort = async () => {
                await saveExtra({ preferredPorts: JSON.stringify([...ports, { pol: "", pod: "" }]) });
              };

              const removePort = async (idx: number) => {
                const next = ports.filter((_, i) => i !== idx);
                await saveExtra({ preferredPorts: JSON.stringify(next) });
              };

              return (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="space-y-3 text-xs flex-shrink-0">
                    {/* 偏好港口 — 自由输入 */}
                    <div className="pb-2 border-b border-gray-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase">偏好港口</span>
                        <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ fontSize: 10, height: 22 }}
                          onClick={addPort}>添加</Button>
                      </div>
                      {ports.length === 0 ? (
                        <div className="text-[10px] text-gray-300 py-2 text-center">暂无，点击"添加"录入</div>
                      ) : (
                        <div className="space-y-1">
                          {ports.map((p, idx) => (
                            <div key={idx} className="flex items-center gap-1.5">
                              <span className="text-[9px] text-gray-400 w-4 flex-shrink-0">#{idx + 1}</span>
                              <Input size="small" style={{ width: 120, fontSize: 10 }}
                                value={p.pol || ""} placeholder="装货港 POL"
                                onChange={e => updatePort(idx, "pol", e.target.value)}
                              />
                              <span className="text-[9px] text-gray-300">→</span>
                              <Input size="small" style={{ width: 120, fontSize: 10 }}
                                value={p.pod || ""} placeholder="卸货港 POD"
                                onChange={e => updatePort(idx, "pod", e.target.value)}
                              />
                              <Button type="text" size="small" danger icon={<DeleteOutlined />}
                                style={{ padding: 0, minWidth: 16, height: 16, fontSize: 10 }}
                                onClick={() => removePort(idx)} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 其他偏好 */}
                    {([
                      { label: "决策角色", field: "decisionRole", opts: ["", "决策者", "影响者", "信息提供者"] },
                      { label: "价格敏感度", field: "priceSensitivity", opts: ["", "高", "中", "低"] },
                      { label: "年度货量", field: "annualVolume", opts: ["", "<100TEU", "100-500TEU", "500-2000TEU", ">2000TEU"] },
                    ]).map(row => {
                      const currentVal = String(extra[row.field] || "");
                      return (
                        <div key={row.field} className="flex items-center py-1.5 border-b border-gray-50">
                          <span className="w-20 text-[10px] text-gray-400">{row.label}</span>
                          <Select size="small" style={{ width: 150, fontSize: 11 }}
                            value={currentVal || undefined}
                            onChange={async (v) => {
                              await saveExtra({ [row.field]: v || null });
                            }}
                            options={row.opts.map(o => ({ value: o, label: o || "—" }))}
                            allowClear
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* 备注 — 自适应拉伸到底部 */}
                  <div className="flex-1 min-h-0 mt-3 flex flex-col">
                    <span className="text-[10px] font-semibold text-gray-500 uppercase mb-1 flex-shrink-0">备注</span>
                    <Input.TextArea
                      className="flex-1"
                      style={{ fontSize: 11, resize: "none" }}
                      value={String(extra.crmNote || "")}
                      placeholder="客户的特殊需求、偏好细节、注意事项…"
                      onChange={e => {
                        extra.crmNote = e.target.value;
                      }}
                      onBlur={async (e) => {
                        await saveExtra({ crmNote: e.target.value || null });
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* Tab 3: 跟进记录 */}
            {currentTab === "followup" && detailData && (
              <div className="flex flex-col flex-1 min-h-0">
                {/* 输入区 — 固定在顶部 */}
                <div className="flex-shrink-0 space-y-2 mb-3">
                  <div className="flex gap-2">
                    <Input.TextArea size="small" rows={2} value={noteText}
                      onChange={e => setNoteText(e.target.value)}
                      placeholder="添加跟进记录..."
                      style={{ fontSize: 11 }}
                    />
                  </div>
                  <Button size="small" type="primary" icon={<PlusOutlined />}
                    onClick={saveNote} block>保存</Button>
                </div>

                {/* 时间线 — 独立滚动，有边框 */}
                <div className="flex-1 overflow-y-auto min-h-0 border border-gray-200 rounded-lg p-3 bg-white">
                  <Timeline items={detailData.interactions.slice(0, 40).map(i => ({
                  color: TYPE_LABELS[i.type]?.color || "gray",
                  children: (
                    <div className="text-[10px]">
                      <div className="flex items-center gap-1.5">
                        <Tag color={TYPE_LABELS[i.type]?.color} className="text-[9px] leading-none px-1">
                          {TYPE_LABELS[i.type]?.label || i.type}
                        </Tag>
                        <span className="text-gray-400">{new Date(i.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                        {i.type === "note" && editingNoteId === i.id ? (
                          <Button type="text" size="small" icon={<SaveOutlined />}
                            style={{ padding: 0, minWidth: 16, height: 16 }}
                            onClick={async () => {
                              const r = await updateNoteMut.mutateAsync({ interactionId: i.id as number, text: editText });
                              if (r && typeof r === "object" && "success" in r) {
                                const rr = r as { success: boolean; error?: string };
                                rr.success ? message.success("已更新") : message.error(rr.error || "更新失败");
                              }
                              setEditingNoteId(null);
                            }} />
                        ) : i.type === "note" ? (
                          <>
                            <Button type="text" size="small" icon={<EditOutlined />}
                              style={{ padding: 0, minWidth: 16, height: 16 }}
                              onClick={() => { setEditingNoteId(i.id || null); setEditText(i.bodyPreview || ""); }} />
                            <Popconfirm title="确定删除？" onConfirm={() => deleteNoteMut.mutate(i.id as number)}
                              okText="删除" cancelText="取消">
                              <Button type="text" size="small" danger icon={<DeleteOutlined />}
                                style={{ padding: 0, minWidth: 16, height: 16 }} />
                            </Popconfirm>
                          </>
                        ) : null}
                      </div>
                      {editingNoteId === i.id ? (
                        <div className="mt-1">
                          <Input.TextArea size="small" rows={2} value={editText}
                            onChange={e => setEditText(e.target.value)} style={{ fontSize: 10 }} />
                          <div className="flex gap-1 mt-1">
                            <Button size="small" type="primary" loading={updateNoteMut.isPending}
                              onClick={async () => {
                                const r = await updateNoteMut.mutateAsync({ interactionId: i.id as number, text: editText });
                                if (r && typeof r === "object" && "success" in r) {
                                  const rr = r as { success: boolean; error?: string };
                                  rr.success ? message.success("已更新") : message.error(rr.error || "更新失败");
                                }
                                setEditingNoteId(null);
                              }}>保存</Button>
                            <Button size="small" onClick={() => setEditingNoteId(null)}>取消</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {i.type === "note" ? (
                            i.bodyPreview && <div className="text-[11px] mt-0.5 text-gray-600 leading-relaxed">{i.bodyPreview}</div>
                          ) : (
                            i.subject && <div className="text-[11px] mt-0.5 font-medium text-gray-700 truncate" title={i.subject}>{i.subject}</div>
                          )}
                        </>
                      )}
                    </div>
                  ),
                }))} />
                {!detailData.interactions.length && <Empty description="暂无跟进记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                </div>
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
                    <div className="text-[9px] text-gray-400 mt-0.5">{new Date(e.receivedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                ))}
                {!detailData.emails.length && <Empty description="暂无邮件记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
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

      {/* 快速发送弹窗 */}
      <Modal title={["发送邮件", sendContact?.firstName, sendContact?.lastName].filter(Boolean).join(" — ")}
        open={!!sendContact} onCancel={() => setSendContact(null)}
        okText="发送" confirmLoading={sendSending}
        onOk={handleQuickSend}
        okButtonProps={{ disabled: !sendTemplateId || !sendAccountId }}
      >
        <div className="space-y-3 text-xs">
          <div>
            <span className="text-gray-400">收件人：</span>
            <span className="font-mono text-blue-600">{sendContact?.email}</span>
            {sendContact?.companyName && <span className="text-gray-400 ml-2">({sendContact.companyName})</span>}
          </div>
          <Select size="small" placeholder="选择模板" style={{ width: "100%" }}
            value={sendTemplateId}
            onChange={v => { setSendTemplateId(v); setSendPreview(null); }}
            options={templates.map(t => ({ value: t.id, label: t.name }))}
          />
          {sendTemplateId && (
            <Button size="small" type="link" onClick={() => {
              const tpl = templates.find(t => t.id === sendTemplateId);
              if (tpl && sendContact) {
                const pre = (s: string) => s
                  .replace(/\{\{firstName\}\}/g, sendContact.firstName || "")
                  .replace(/\{\{lastName\}\}/g, sendContact.lastName || "")
                  .replace(/\{\{company\}\}/g, sendContact.companyName || "");
                setSendPreview({ subject: pre(tpl.subject), body: pre(tpl.body) });
              }
            }}>预览渲染效果</Button>
          )}
          {sendPreview && (
            <div className="bg-gray-50 rounded p-2 space-y-2 text-[11px]">
              <div className="font-semibold text-gray-800">{sendPreview.subject}</div>
              <div className="text-gray-600 whitespace-pre-wrap leading-relaxed">{sendPreview.body}</div>
            </div>
          )}
          <Select size="small" placeholder="选择发件账号" style={{ width: "100%" }}
            value={sendAccountId}
            onChange={setSendAccountId}
            options={accounts.map(a => ({ value: a.id, label: a.email }))}
          />
        </div>
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
              {item.key === value ? "● " : ""}{item.label}
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
