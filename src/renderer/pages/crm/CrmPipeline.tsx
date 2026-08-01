import { useState, useEffect } from "react";
import { Card, Tag, Button, Tabs, Input, Select, message, Empty, Timeline, Popover, DatePicker } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SwapOutlined, ClockCircleOutlined, EditOutlined, SaveOutlined,
  CloseOutlined, MailOutlined, SearchOutlined, UserOutlined,
  SendOutlined, DownOutlined, RightOutlined, PhoneOutlined,
  LinkedinOutlined, EnvironmentOutlined, TagOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";

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

function daysAgo(d: string) {
  const delta = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (delta === 0) return "今天";
  if (delta === 1) return "昨天";
  return `${delta} 天前`;
}

export function CrmPipeline() {
  const qc = useQueryClient();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [currentTab, setCurrentTab] = useState("info");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("crm-stage-state") || "{}"); } catch { return {}; }
  });

  const { data, isLoading } = useQuery({
    queryKey: ["crm", "pipeline"],
    queryFn: () => window.api.invoke("crm:listPipeline") as Promise<{ success: boolean; data?: StageData[] }>,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["crm", "detail", detailId],
    queryFn: () => window.api.invoke("crm:getDetail", detailId) as Promise<{
      success: boolean; data?: {
        contact: PipelineContact | null;
        interactions: Array<{ type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string }>;
        emails: Array<{ fromEmail: string; subject: string | null; classification: string | null; receivedAt: string }>;
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

  const stages: StageData[] = data?.success ? data.data || [] : STAGES.map(s => ({ ...s, contacts: [] }));
  const contact = detail?.success ? detail.data?.contact : null;

  const typeLabels: Record<string, { label: string; color: string; icon: string }> = {
    sent: { label: "已发送", color: "#5c6bc0", icon: "send" },
    replied: { label: "已回复", color: "#22a644", icon: "mail" },
    bounced: { label: "退信", color: "#d93025", icon: "alert" },
    autoreply: { label: "自动回复", color: "#ff9800", icon: "share" },
  };

  const toggleStage = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    localStorage.setItem("crm-stage-state", JSON.stringify(next));
  };

  return (
    <div className="flex gap-4 h-full" style={{ minHeight: "calc(100vh - 130px)" }}>
      {/* 左侧看板 */}
      <div className="flex-1 overflow-y-auto pb-4 space-y-1" id="crm-pipeline">
        {isLoading ? <Card loading className="w-full" /> :
          stages.map(s => (
            <div key={s.key} className="crm-stage-block">
              {/* 阶段标题 — 可折叠 */}
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none sticky top-0 z-10 bg-gray-50 border-b border-gray-100"
                style={{ borderLeft: `3px solid ${s.color}` }}
                onClick={() => toggleStage(s.key)}
              >
                {collapsed[s.key] ? <RightOutlined className="text-[10px] text-gray-400" /> : <DownOutlined className="text-[10px] text-gray-400" />}
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="font-semibold text-xs text-gray-700">{s.label}</span>
                <span className="text-[11px] text-gray-400 ml-auto">{s.contacts.length}</span>
              </div>

              {/* 联系人卡片 */}
              {!collapsed[s.key] && (
                <div className="space-y-0.5">
                  {s.contacts.map(c => (
                    <div
                      key={c.id}
                      className={`flex items-center gap-2 px-4 py-2 cursor-pointer border-b border-gray-50 hover:bg-gray-50 transition-colors text-xs ${detailId === c.id ? "bg-violet-50 border-l-2 border-l-violet-400" : ""}`}
                      onClick={() => setDetailId(c.id)}
                    >
                      <span className="font-medium text-gray-800 flex-shrink-0 w-20 truncate">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                      </span>
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
                  {s.contacts.length === 0 && (
                    <div className="text-center text-[11px] text-gray-300 py-4 px-3">暂无</div>
                  )}
                </div>
              )}
            </div>
          ))
        }
      </div>

      {/* 右侧详情面板 */}
      {detailId && (
        <div className="flex-shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden" style={{ width: 340 }}>
          {/* 头部 */}
          <div className="p-3 border-b border-gray-100 flex items-center justify-between bg-gray-50 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-gray-800">
                {contact?.firstName} {contact?.lastName}
              </span>
              <Button type="text" size="small" icon={<SearchOutlined />}
                style={{ padding: 0, minWidth: 20, height: 20, fontSize: 12 }} />
              <Button type="text" size="small" icon={<MailOutlined />}
                style={{ padding: 0, minWidth: 20, height: 20, fontSize: 12 }} />
            </div>
            <Button type="text" size="small" onClick={() => setDetailId(null)}>
              <CloseOutlined />
            </Button>
          </div>

          {/* Tab 栏 */}
          <Tabs activeKey={currentTab} onChange={setCurrentTab} size="small"
            className="flex-shrink-0"
            tabBarStyle={{ margin: 0, padding: "0 8px" }}
            items={[
              { key: "info", label: <span className="text-[10px]">基本信息</span> },
              { key: "prefs", label: <span className="text-[10px]">偏好设置</span> },
              { key: "followup", label: <span className="text-[10px]">跟进记录</span> },
              { key: "emails", label: <span className="text-[10px]">邮件往来</span> },
            ]}
          />

          {/* Tab 内容 */}
          <div className="flex-1 overflow-y-auto p-3">
            {detailLoading && <Card loading />}

            {/* Tab 1: 基本信息 */}
            {currentTab === "info" && contact && (
              <div className="space-y-1 text-xs">
                {([
                  { label: "姓名", type: "double", field1: "firstName", field2: "lastName" },
                  { label: "邮箱", type: "text", field: "email" },
                  { label: "公司", type: "text", field: "companyName" },
                  { label: "国家", type: "select", field: "country", options: ["EN", "ES", "PT", "CN", "BR", "DE", "FR", "IT", "JP", "KR", "VN", "IN"] },
                  { label: "职位", type: "text", field: "title" },
                  { label: "电话", type: "text", field: "phone" },
                  { label: "领英", type: "text", field: "linkedinUrl" },
                  { label: "客户类型", type: "select", field: "clientType", options: ["agent", "direct", "unlabeled"] },
                ] as const).map(row => (
                  <div key={row.label} className="flex items-center py-1.5 border-b border-gray-50 group">
                    <span className="w-14 text-[10px] text-gray-400 flex-shrink-0">{row.label}</span>
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
                          await upsertMut.mutateAsync({ id: contact.id, email: contact.email, [(row as { field: string }).field!]: val });
                        }
                        qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
                      }}
                    />
                  </div>
                ))}

                {/* 阶段选择 */}
                <div className="flex items-center py-1.5 border-b border-gray-50">
                  <span className="w-14 text-[10px] text-gray-400">阶段</span>
                  <Select size="small" value={contact.stage}
                    style={{ width: 130, fontSize: 11 }}
                    options={STAGES.map(s => ({ value: s.key, label: s.label }))}
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
                        window.api.invoke("crm:addReminder", {
                          contactId: contact.id,
                          reminderAt: v.toISOString(),
                        }).then(() => qc.invalidateQueries({ queryKey: ["crm"] }));
                      }
                    }}
                    placeholder="设置跟进提醒"
                  />
                </div>
              </div>
            )}

            {/* Tab 2: 偏好设置 */}
            {currentTab === "prefs" && (
              <div className="text-[11px] text-gray-400 text-center py-8">
                偏好设置（待实现）
              </div>
            )}

            {/* Tab 3: 跟进记录 */}
            {currentTab === "followup" && detail?.success && detail.data && (
              <div className="space-y-3">
                <Timeline items={detail.data!.interactions.slice(0, 40).map(i => ({
                  color: typeLabels[i.type]?.color || "gray",
                  children: (
                    <div className="text-[10px]">
                      <div className="flex items-center gap-1.5">
                        <Tag color={typeLabels[i.type]?.color} className="text-[9px] leading-none px-1">
                          {typeLabels[i.type]?.label || i.type}
                        </Tag>
                        <span className="text-gray-400">{new Date(i.createdAt).toLocaleDateString("zh-CN")}</span>
                      </div>
                      {i.subject && <div className="text-[11px] mt-0.5 font-medium text-gray-700">{i.subject}</div>}
                      {i.bodyPreview && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{i.bodyPreview}</div>}
                    </div>
                  ),
                }))} />
                {!detail.data!.interactions.length && <Empty description="暂无跟进记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
            )}

            {/* Tab 4: 邮件往来 */}
            {currentTab === "emails" && detail?.success && detail.data && (
              <div className="space-y-1.5">
                {detail.data!.emails.map((e, i) => (
                  <div key={i} className="border border-gray-100 rounded p-2 text-xs hover:border-gray-300 cursor-pointer">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <MailOutlined className="text-[9px] text-gray-400" />
                      <span className="text-[10px] font-mono">{e.fromEmail}</span>
                      {e.classification && (
                        <Tag color={typeLabels[e.classification]?.color || "default"}
                          className="text-[9px] leading-none px-1 ml-auto"
                        >{typeLabels[e.classification]?.label || e.classification}</Tag>
                      )}
                    </div>
                    <div className="text-[10px] truncate">{e.subject || "无主题"}</div>
                    <div className="text-[9px] text-gray-400 mt-0.5">{new Date(e.receivedAt).toLocaleDateString("zh-CN")}</div>
                  </div>
                ))}
                {!detail.data!.emails.length && <Empty description="暂无邮件记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 内联编辑组件 ──

function InlineEdit({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  const handleSave = async () => {
    setEditing(false);
    if (val !== value) await onSave(val);
  };

  if (editing) {
    return (
      <div className="flex-1 flex gap-1">
        <Input size="small" value={val} onChange={e => setVal(e.target.value)}
          onPressEnter={handleSave} autoFocus
          style={{ fontSize: 11, height: 22 }}
        />
        <Button type="text" size="small" icon={<SaveOutlined />}
          style={{ padding: 0, minWidth: 18, height: 18 }} onClick={handleSave} />
        <Button type="text" size="small" icon={<CloseOutlined />}
          style={{ padding: 0, minWidth: 18, height: 18 }}
          onClick={() => { setVal(value); setEditing(false); }} />
      </div>
    );
  }

  return (
    <span className="flex-1 text-[11px] cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
      onClick={() => setEditing(true)}
    >{value}</span>
  );
}
