import { useState } from "react";
import { Card, Tag, Button, Tabs, Input, message, Select, Descriptions, Empty, Timeline, Badge } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SwapOutlined, ClockCircleOutlined, EditOutlined, SaveOutlined,
  CloseOutlined, MailOutlined, UserOutlined,
} from "@ant-design/icons";

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

export function CrmPipeline() {
  const qc = useQueryClient();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [currentTab, setCurrentTab] = useState("info");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  // 看板数据
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "pipeline"],
    queryFn: () => window.api.invoke("crm:listPipeline") as Promise<{
      success: boolean; data?: StageData[];
    }>,
  });

  // 详情数据
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

  const stages = data?.success ? data.data || [] : STAGES.map(s => ({ ...s, contacts: [] }));
  const contact = detail?.success ? detail.data?.contact : null;

  const moveToStage = (contactId: number, fromStage: string, direction: 1 | -1) => {
    const idx = STAGES.findIndex(s => s.key === fromStage);
    const next = STAGES[idx + direction];
    if (!next) { message.warning(direction > 0 ? "已是最后阶段" : "已是最前阶段"); return; }
    setStageMut.mutate({ contactId, stage: next.key });
  };

  const handleInlineEdit = (field: string, value: string) => {
    setEditing(field);
    setEditVal(value || "");
  };

  const saveInlineEdit = async () => {
    if (!contact || !editing) return;
    await upsertMut.mutateAsync({ id: contact.id, email: contact.email, [editing]: editVal });
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
  };

  const typeLabels: Record<string, { label: string; color: string }> = {
    sent: { label: "已发送", color: "#5c6bc0" },
    replied: { label: "已回复", color: "#22a644" },
    bounced: { label: "退信", color: "#d93025" },
    autoreply: { label: "自动回复", color: "#ff9800" },
  };

  return (
    <div className="flex gap-4 h-full" style={{ minHeight: "calc(100vh - 130px)" }}>
      {/* 左侧看板 */}
      <div className="flex-1 flex gap-3 overflow-x-auto pb-4">
        {isLoading ? <Card loading className="w-full" /> :
          stages.map(s => (
            <div key={s.key} className="flex-shrink-0" style={{ width: 260 }}>
              {/* 阶段标题 */}
              <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-t-md"
                style={{ borderLeft: `3px solid ${s.color}`, background: `${s.color}10` }}>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                  <span className="font-semibold text-xs">{s.label}</span>
                  <span className="text-[10px] text-gray-400">({s.contacts.length})</span>
                </div>
              </div>

              {/* 联系人卡片 */}
              <div className="space-y-1.5 max-h-[calc(100vh-200px)] overflow-y-auto">
                {s.contacts.map(c => (
                  <Card
                    key={c.id} size="small"
                    className={`cursor-pointer border border-gray-100 hover:border-gray-300 transition-colors text-xs ${detailId === c.id ? "ring-2 ring-violet-400" : ""}`}
                    styles={{ body: { padding: "8px 10px" } }}
                    onClick={() => setDetailId(c.id)}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-medium truncate text-gray-800">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ") || "未命名"}
                      </span>
                      <div className="flex gap-0.5">
                        <Button type="text" size="small"
                          style={{ padding: 0, minWidth: 18, height: 18, fontSize: 11 }}
                          icon={<SwapOutlined style={{ transform: "rotate(180deg)" }} />}
                          onClick={(e) => { e.stopPropagation(); moveToStage(c.id, s.key, -1); }}
                        />
                        <Button type="text" size="small"
                          style={{ padding: 0, minWidth: 18, height: 18, fontSize: 11 }}
                          icon={<SwapOutlined />}
                          onClick={(e) => { e.stopPropagation(); moveToStage(c.id, s.key, 1); }}
                        />
                      </div>
                    </div>
                    <div className="text-[11px] text-gray-400 font-mono truncate mb-0.5">{c.email}</div>
                    {c.companyName && <div className="text-[11px] text-gray-500 truncate">{c.companyName}</div>}
                    {c.reminderAt && (
                      <div className={`text-[10px] mt-1 flex items-center gap-1 ${new Date(c.reminderAt) < new Date() ? "text-red-500 font-semibold" : "text-amber-500"}`}>
                        <ClockCircleOutlined className="text-[10px]" />
                        {new Date(c.reminderAt).toLocaleDateString("zh-CN")}
                      </div>
                    )}
                  </Card>
                ))}
                {s.contacts.length === 0 && (
                  <div className="text-center text-[11px] text-gray-300 py-6">空</div>
                )}
              </div>
            </div>
          ))
        }
      </div>

      {/* 右侧详情面板 */}
      {detailId && (
        <div className="flex-shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden"
          style={{ width: 360 }}>
          {/* 头部 */}
          <div className="p-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
            <div>
              <div className="font-semibold text-sm text-gray-800">
                {contact?.firstName} {contact?.lastName}
              </div>
              <div className="text-[11px] text-gray-400 font-mono">{contact?.email}</div>
            </div>
            <Button type="text" size="small" onClick={() => setDetailId(null)}><CloseOutlined /></Button>
          </div>

          {/* Tab 内容 */}
          <Tabs activeKey={currentTab} onChange={setCurrentTab} size="small"
            className="flex-1 overflow-hidden"
            style={{ fontSize: 12 }}
            items={[
              {
                key: "info",
                label: <span className="text-[11px]">基本信息</span>,
                children: (
                  <div className="p-3 space-y-2 overflow-y-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
                    {detailLoading ? <Card loading /> : contact ? (
                      <div className="space-y-1.5 text-xs">
                        {[
                          { label: "公司", field: "companyName" },
                          { label: "职位", field: "title" },
                          { label: "电话", field: "phone" },
                          { label: "国家", field: "country" },
                        ].map(({ label, field }) => (
                          <div key={field} className="flex items-center py-1 border-b border-gray-50">
                            <span className="w-16 text-[11px] text-gray-400 flex-shrink-0">{label}</span>
                            {editing === field ? (
                              <div className="flex-1 flex gap-1">
                                <Input size="small" value={editVal}
                                  onChange={e => setEditVal(e.target.value)}
                                  onPressEnter={saveInlineEdit} autoFocus
                                  style={{ fontSize: 11, height: 24 }}
                                />
                                <Button size="small" type="text" icon={<SaveOutlined />}
                                  style={{ padding: 0, minWidth: 20, height: 20 }} onClick={saveInlineEdit} />
                                <Button size="small" type="text" icon={<CloseOutlined />}
                                  style={{ padding: 0, minWidth: 20, height: 20 }}
                                  onClick={() => setEditing(null)} />
                              </div>
                            ) : (
                              <span className="flex-1 text-[11px] cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
                                onClick={() => handleInlineEdit(field, String((contact as unknown as Record<string, unknown>)[field] || ""))}
                              >{String((contact as unknown as Record<string, unknown>)[field] || "-")}</span>
                            )}
                          </div>
                        ))}

                        {/* 阶段 */}
                        <div className="flex items-center py-1 border-b border-gray-50">
                          <span className="w-16 text-[11px] text-gray-400">阶段</span>
                          <Select size="small" value={contact.stage}
                            style={{ width: 120, fontSize: 11 }}
                            options={STAGES.map(s => ({ value: s.key, label: s.label }))}
                            onChange={v => {
                              setStageMut.mutate({ contactId: contact.id, stage: v });
                              qc.invalidateQueries({ queryKey: ["crm", "detail", detailId] });
                            }}
                          />
                        </div>

                        {/* 提醒 */}
                        <div className="flex items-center py-1 border-b border-gray-50">
                          <span className="w-16 text-[11px] text-gray-400">提醒</span>
                          <Input type="datetime-local" size="small" style={{ fontSize: 11, width: 170, height: 24 }}
                            value={contact.reminderAt ? contact.reminderAt.slice(0, 16) : ""}
                            onChange={e => {
                              window.api.invoke("crm:addReminder", {
                                contactId: contact.id,
                                reminderAt: new Date(e.target.value).toISOString(),
                              }).then(() => qc.invalidateQueries({ queryKey: ["crm"] }));
                            }}
                          />
                        </div>
                      </div>
                    ) : <Empty description="加载失败" />}
                  </div>
                ),
              },
              {
                key: "interactions",
                label: <span className="text-[11px]">互动记录</span>,
                children: (
                  <div className="p-3 overflow-y-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
                    {detailLoading ? <Card loading /> : detail?.success && detail.data?.interactions.length ?
                      <Timeline items={detail.data.interactions.slice(0, 30).map((i, idx) => ({
                        color: typeLabels[i.type]?.color || "gray",
                        children: (
                          <div key={idx} className="text-[11px]">
                            <div className="flex items-center gap-2">
                              <Tag color={typeLabels[i.type]?.color}
                                className="text-[10px] leading-none px-1"
                              >{typeLabels[i.type]?.label || i.type}</Tag>
                              <span className="text-gray-400">{new Date(i.createdAt).toLocaleDateString("zh-CN")}</span>
                            </div>
                            {i.subject && <div className="text-[11px] mt-0.5 font-medium">{i.subject}</div>}
                            {i.bodyPreview && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{i.bodyPreview}</div>}
                          </div>
                        ),
                      }))} />
                      : <Empty description="暂无互动记录" />}
                  </div>
                ),
              },
              {
                key: "emails",
                label: <span className="text-[11px]">邮件往来</span>,
                children: (
                  <div className="p-3 overflow-y-auto space-y-2" style={{ maxHeight: "calc(100vh - 280px)" }}>
                    {detailLoading ? <Card loading /> : detail?.success && detail.data?.emails.length ?
                      detail.data.emails.map((e, i) => (
                        <div key={i} className="border border-gray-100 rounded p-2 text-xs hover:border-gray-300 cursor-pointer">
                          <div className="flex items-center gap-2 mb-0.5">
                            <MailOutlined className="text-[10px] text-gray-400" />
                            <span className="text-[11px] font-mono">{e.fromEmail}</span>
                            {e.classification && (
                              <Tag color={typeLabels[e.classification]?.color || "default"}
                                className="text-[9px] leading-none px-1 ml-auto"
                              >{typeLabels[e.classification]?.label || e.classification}</Tag>
                            )}
                          </div>
                          <div className="text-[11px] truncate">{e.subject || "无主题"}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            {new Date(e.receivedAt).toLocaleDateString("zh-CN")}
                          </div>
                        </div>
                      )) : <Empty description="暂无邮件记录" />}
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
