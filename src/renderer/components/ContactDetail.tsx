import { useState, type ReactNode } from "react";
import { Drawer, Tabs, Tag, Select, message, Timeline, Input, Button, Tooltip } from "antd";
import { EditOutlined, SearchOutlined, PartitionOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useUpsertContact, type Contact } from "../hooks/useContacts";
import { CompanyBackcheck } from "./CompanyBackcheck";
import { DiamondLogo } from "./DiamondLogo";
import { askAssistant } from "../lib/ask-ai";

/* ---------- 展示元数据（列表/详情共用） ---------- */
export const CLIENT_TYPE: Record<string, { label: string; color: string }> = {
  agent: { label: "代理", color: "#5c6bc0" },
  direct: { label: "直客", color: "#22a644" },
};
export const STATUS_META: Record<string, { label: string; color: string }> = {
  reached: { label: "已触达", color: "blue" },
  replied: { label: "已回复", color: "green" },
  bounced: { label: "退信", color: "red" },
  autoreply: { label: "自动回复", color: "orange" },
};
// 发送阶段标签 = key 本身（Cold/F1…），全项目唯一事实源。
// 不做中文翻译：之前联系人页「冷启动」、发送页「新线索」、导出「跟进1」各写各的，同一个人三个叫法。
export const STAGE_META: Record<string, { label: string; color: string }> = {
  cold: { label: "Cold", color: "default" },
  f1: { label: "F1", color: "blue" },
  f2: { label: "F2", color: "geekblue" },
  f3: { label: "F3", color: "purple" },
  f4: { label: "F4", color: "magenta" },
};
/** CRM 标签（contacts.tags）— 固定 6 值单选，与后端 crm.service STAGES 同步 */
export const CRM_STAGES: { key: string; label: string; color: string }[] = [
  { key: "reaching", label: "触达中", color: "#ff9800" },
  { key: "quoting", label: "报价中", color: "#2196f3" },
  { key: "trial", label: "试单", color: "#8e24aa" },
  { key: "cooperating", label: "合作中", color: "#4caf50" },
  { key: "lost", label: "已流失", color: "#b0b0b0" },
  { key: "other", label: "其他", color: "#333333" },
];

/** 国家预设列表（英文全名，输入时搜索匹配，不允许自由键入） */
export const COUNTRIES: { code: string; label: string }[] = [
  { code: "Brazil", label: "巴西" }, { code: "Mexico", label: "墨西哥" },
  { code: "Argentina", label: "阿根廷" }, { code: "Chile", label: "智利" },
  { code: "Peru", label: "秘鲁" }, { code: "Colombia", label: "哥伦比亚" },
  { code: "Ecuador", label: "厄瓜多尔" }, { code: "Uruguay", label: "乌拉圭" },
  { code: "Paraguay", label: "巴拉圭" }, { code: "Bolivia", label: "玻利维亚" },
  { code: "Venezuela", label: "委内瑞拉" }, { code: "Panama", label: "巴拿马" },
  { code: "Costa Rica", label: "哥斯达黎加" }, { code: "El Salvador", label: "萨尔瓦多" },
  { code: "Guatemala", label: "危地马拉" }, { code: "Honduras", label: "洪都拉斯" },
  { code: "Nicaragua", label: "尼加拉瓜" }, { code: "Dominican Republic", label: "多米尼加" },
  { code: "Cuba", label: "古巴" }, { code: "Puerto Rico", label: "波多黎各" },
  { code: "United States", label: "美国" }, { code: "Canada", label: "加拿大" },
  { code: "China", label: "中国" }, { code: "Hong Kong", label: "中国香港" },
  { code: "Taiwan", label: "中国台湾" }, { code: "Japan", label: "日本" },
  { code: "South Korea", label: "韩国" }, { code: "Singapore", label: "新加坡" },
  { code: "Malaysia", label: "马来西亚" }, { code: "Thailand", label: "泰国" },
  { code: "Vietnam", label: "越南" }, { code: "Indonesia", label: "印度尼西亚" },
  { code: "Philippines", label: "菲律宾" }, { code: "India", label: "印度" },
  { code: "Pakistan", label: "巴基斯坦" }, { code: "Bangladesh", label: "孟加拉国" },
  { code: "United Arab Emirates", label: "阿联酋" }, { code: "Saudi Arabia", label: "沙特阿拉伯" },
  { code: "Qatar", label: "卡塔尔" }, { code: "Kuwait", label: "科威特" },
  { code: "Israel", label: "以色列" }, { code: "Turkey", label: "土耳其" },
  { code: "United Kingdom", label: "英国" }, { code: "Germany", label: "德国" },
  { code: "France", label: "法国" }, { code: "Italy", label: "意大利" },
  { code: "Spain", label: "西班牙" }, { code: "Portugal", label: "葡萄牙" },
  { code: "Netherlands", label: "荷兰" }, { code: "Belgium", label: "比利时" },
  { code: "Switzerland", label: "瑞士" }, { code: "Poland", label: "波兰" },
  { code: "Sweden", label: "瑞典" }, { code: "Norway", label: "挪威" },
  { code: "Denmark", label: "丹麦" }, { code: "Finland", label: "芬兰" },
  { code: "Greece", label: "希腊" }, { code: "Czech Republic", label: "捷克" },
  { code: "Ukraine", label: "乌克兰" }, { code: "Russia", label: "俄罗斯" },
  { code: "Australia", label: "澳大利亚" }, { code: "New Zealand", label: "新西兰" },
  { code: "South Africa", label: "南非" }, { code: "Egypt", label: "埃及" },
  { code: "Nigeria", label: "尼日利亚" }, { code: "Kenya", label: "肯尼亚" },
  { code: "Morocco", label: "摩洛哥" }, { code: "Ghana", label: "加纳" },
];
const INTERACTION_COLORS: Record<string, string> = {
  sent: "#2563eb", replied: "#22a644", bounced: "#d93025", autoreply: "#ff9800",
};
const INTERACTION_LABELS: Record<string, string> = {
  sent: "已发送", replied: "已回复", bounced: "退信", autoreply: "自动回复", note: "跟进",
};

/* ---------- 小工具 ---------- */
function fmt(s?: string | null): string {
  return s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "-";
}
function parseTags(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-semibold text-gray-400 tracking-wider mt-6 mb-1.5 first:mt-0">{children}</div>;
}

/* ---------- 扁平信息行（读态为主） ---------- */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="group/row flex items-center gap-4 px-2 py-1.5 rounded-md -mx-2 hover:bg-gray-50 transition-colors">
      <span className="w-16 shrink-0 text-[11px] text-gray-400">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

const readBtnCls = "w-full flex items-center justify-between gap-2 text-left group/val";
const readValCls = (has: boolean) =>
  `text-xs truncate ${has ? "text-gray-800" : "text-gray-300"}`;
const Pencil = () => (
  <EditOutlined className="text-[10px] text-gray-400 opacity-30 transition-opacity group-hover/val:opacity-100" />
);

/* 文本行：点击进入编辑，失焦/回车保存 */
function EditText({ value, onSave, placeholder }: {
  value: string | null; onSave: (v: string | null) => void; placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    return (
      <button type="button" className={readBtnCls}
        onClick={() => { setDraft(value || ""); setEditing(true); }}>
        <span className={readValCls(!!value)}>{value || placeholder || "-"}</span>
        <Pencil />
      </button>
    );
  }
  return (
    <Input size="small" autoFocus value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== (value || "")) onSave(draft.trim() ? draft.trim() : null);
        setEditing(false);
      }}
      onPressEnter={e => (e.target as HTMLInputElement).blur()}
      className="!text-xs"
    />
  );
}

/* 下拉行：点击展开，选择即存 */
function EditSelect({ value, onSave, options, allowClear, readNode, disabled }: {
  value: string | null;
  onSave: (v: string | null) => void;
  options: { value: string; label: string }[];
  allowClear?: boolean;
  readNode?: ReactNode;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" className={readBtnCls} onClick={() => { if (!disabled) setEditing(true); }}>
        <span className={readValCls(!!value)}>{readNode || value || "未设置"}</span>
        {disabled ? <span className="text-[10px] text-gray-300">需先触达</span> : <Pencil />}
      </button>
    );
  }
  return (
    <Select size="small" autoFocus defaultOpen className="w-full !text-xs"
      value={value || undefined} allowClear={allowClear} options={options}
      showSearch optionFilterProp="label"
      popupMatchSelectWidth={false}
      onBlur={() => setEditing(false)}
      onChange={(v) => { onSave(v ?? null); setEditing(false); }}
    />
  );
}

/* ---------- 基本信息 Tab ---------- */
function InfoTab({ contact, onSaveField }: {
  contact: Contact; onSaveField: (field: string, value: string | null) => void;
}) {
  const clientMeta = contact.clientType ? CLIENT_TYPE[contact.clientType] : null;
  const statusMeta = STATUS_META[contact.status || ""];
  const stageMeta = STAGE_META[contact.stage || ""];
  const tagKey = parseTags(contact.tags)[0] || null;
  const tagMeta = tagKey ? CRM_STAGES.find(s => s.key === tagKey) : null;

  return (
    <div className="px-1 pb-2">
      <SectionTitle>身份信息</SectionTitle>
      <FieldRow label="名"><EditText value={contact.firstName} onSave={v => onSaveField("firstName", v)} /></FieldRow>
      <FieldRow label="姓"><EditText value={contact.lastName} onSave={v => onSaveField("lastName", v)} /></FieldRow>
      <FieldRow label="职位"><EditText value={contact.title} onSave={v => onSaveField("title", v)} placeholder="如 Purchasing Manager" /></FieldRow>

      <SectionTitle>联系方式</SectionTitle>
      <FieldRow label="邮箱"><EditText value={contact.email} onSave={v => onSaveField("email", v)} /></FieldRow>
      <FieldRow label="电话"><EditText value={contact.phone} onSave={v => onSaveField("phone", v)} placeholder="含国家码" /></FieldRow>
      <FieldRow label="LinkedIn"><EditText value={contact.linkedinUrl} onSave={v => onSaveField("linkedinUrl", v)} placeholder="linkedin.com/in/..." /></FieldRow>
      <FieldRow label="国家"><EditSelect value={contact.country} onSave={v => onSaveField("country", v)} allowClear options={COUNTRIES.map(c => ({ value: c.code, label: `${c.code} ${c.label}` }))} /></FieldRow>
      <FieldRow label="语言">
        <EditSelect value={(contact as unknown as Record<string, string>).language || null} onSave={v => onSaveField("language", v)} allowClear
          options={[
            { value: "ES", label: "ES 西班牙语" },
            { value: "PT", label: "PT 葡萄牙语" },
            { value: "EN", label: "EN 英语" },
          ]} />
      </FieldRow>

      <SectionTitle>客户与跟进</SectionTitle>
      <FieldRow label="客户类型">
        <EditSelect value={contact.clientType} onSave={v => onSaveField("clientType", v)}
          allowClear options={[
            { value: "agent", label: "代理" },
            { value: "direct", label: "直客" },
          ]}
          readNode={clientMeta ? <Tag color={clientMeta.color} className="text-[10px] my-0 leading-none py-0.5">{clientMeta.label}</Tag> : undefined} />
      </FieldRow>
      <FieldRow label="阶段">
        <EditSelect value={contact.stage} onSave={v => onSaveField("stage", v)}
          allowClear options={Object.entries(STAGE_META).map(([k, m]) => ({ value: k, label: m.label }))}
          readNode={stageMeta ? <Tag color={stageMeta.color} className="text-[10px] my-0 leading-none py-0.5">{stageMeta.label}</Tag> : undefined} />
      </FieldRow>
      <FieldRow label="负责人"><EditText value={contact.assignee} onSave={v => onSaveField("assignee", v)} /></FieldRow>
      <FieldRow label="状态">
        <EditSelect value={contact.status || null}
          onSave={v => onSaveField("status", v || null)}
          allowClear options={Object.entries(STATUS_META).map(([k, m]) => ({ value: k, label: m.label }))}
          readNode={statusMeta ? <Tag color={statusMeta.color} className="text-[10px] my-0 leading-none py-0.5">{statusMeta.label}</Tag> : undefined} />
      </FieldRow>
      <FieldRow label="标签">
        <EditSelect value={tagKey} onSave={v => onSaveField("tags", v ? JSON.stringify([v]) : null)}
          allowClear options={CRM_STAGES.map(s => ({ value: s.key, label: s.label }))}
          disabled={contact.status !== "reached"}
          readNode={tagMeta ? <Tag color={tagMeta.color} className="text-[10px] my-0 leading-none py-0.5">{tagMeta.label}</Tag> : undefined} />
      </FieldRow>

      <SectionTitle>系统信息</SectionTitle>
      <FieldRow label="公司"><EditText value={contact.companyName} onSave={v => onSaveField("companyName", v)} placeholder="公司名称" /></FieldRow>
      <FieldRow label="来源"><span className="text-xs text-gray-800 truncate">{contact.source || "-"}</span></FieldRow>
      <FieldRow label="创建时间"><span className="text-xs text-gray-500">{fmt(contact.createdAt)}</span></FieldRow>
      <FieldRow label="更新时间"><span className="text-xs text-gray-500">{fmt(contact.updatedAt)}</span></FieldRow>
    </div>
  );
}

/* ---------- 往来记录 Tab ---------- */
interface InteractionItem {
  type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string;
}

function ContactInteractions({ contactId }: { contactId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["contacts", "interactions", contactId],
    queryFn: () => window.api.invoke("contacts:interactions", contactId) as Promise<{
      success: boolean; data?: InteractionItem[]; error?: string;
    }>,
    enabled: contactId > 0,
  });

  const items = data?.success ? data.data || [] : [];

  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 mb-2 flex items-center gap-2">
        互动历史
        <Tag className="text-[9px] px-1 my-0">{items.length} 条</Tag>
      </div>

      {isLoading ? <div className="text-xs text-gray-400 py-4 text-center">加载中...</div> :
        items.length === 0 ? (
          <div className="text-xs text-gray-400 p-3 bg-gray-50 rounded text-center">
            暂无互动记录
          </div>
        ) : (
          <Timeline
            items={items.slice(0, 20).map((i, idx) => ({
              color: INTERACTION_COLORS[i.type] || "gray",
              children: (
                <div key={idx} className="text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-700">
                      {INTERACTION_LABELS[i.type] || i.type}
                    </span>
                    <span className="text-gray-400">
                      {new Date(i.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  {i.subject && (
                    <div className="text-[11px] text-gray-600 mt-0.5">{i.subject}</div>
                  )}
                  {i.bodyPreview && (
                    <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{i.bodyPreview}</div>
                  )}
                </div>
              ),
            }))}
          />
        )
      }
    </div>
  );
}

/* ---------- 主抽屉 ---------- */
export function ContactDetailDrawer({ contact, open, onClose, onUpdated }: {
  contact: Contact | null;
  open: boolean;
  onClose: () => void;
  onUpdated: (c: Contact) => void;
}) {
  const upsert = useUpsertContact();
  const [tab, setTab] = useState("info");

  if (!contact) return <Drawer open={false} onClose={onClose} />;

  // 统一保存入口：upsert 按 email 定位 existing（email 只读锚点，不可改）
  const saveField = async (field: string, value: string | null) => {
    const r = await upsert.mutateAsync({ id: contact.id, email: contact.email, [field]: value });
    if (r?.success) onUpdated({ ...contact, [field]: value });
    else message.error(r?.error || "保存失败");
  };

  const clientMeta = contact.clientType ? CLIENT_TYPE[contact.clientType] : null;
  const statusMeta = STATUS_META[contact.status || ""];
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "未命名联系人";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={500}
      title={null}
      closable={false}
      rootStyle={{ top: 36 }}
      styles={{ body: { padding: "24px", height: "100%", overflow: "hidden" } }}
    >
      <div className="flex flex-col h-full">
        {/* 头部 — 固定不滚动 */}
        <div className="flex-shrink-0 pb-3 mb-2 border-b border-gray-100">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-base font-semibold text-gray-900">{fullName}</span>
            {clientMeta && <Tag color={clientMeta.color} className="text-[10px] my-0 leading-none py-0.5">{clientMeta.label}</Tag>}
            {statusMeta && <Tag color={statusMeta.color} className="text-[10px] my-0 leading-none py-0.5">{statusMeta.label}</Tag>}
            {/* 操作按钮 — 无色悬停显色 */}
            <Tooltip title="在收件箱中搜索">
              <Button type="text" size="small" icon={<SearchOutlined />}
                className="btn-hover-color" style={{ color: "#bbb", padding: 0, minWidth: 20, height: 20 }}
                onClick={() => { window.location.hash = `#/inbox?search=${encodeURIComponent(contact.email)}`; }}
              />
            </Tooltip>
            <Tooltip title={contact.status === "reached" ? "在CRM中查看" : "未进入CRM管线"}>
              <Button type="text" size="small" icon={<PartitionOutlined />}
                disabled={contact.status !== "reached"}
                className="btn-hover-color" style={{ color: contact.status === "reached" ? "#bbb" : "#d9d9d9", padding: 0, minWidth: 20, height: 20 }}
                onClick={() => { window.location.hash = `#/customers?view=board&detail=${contact.id}`; }}
              />
            </Tooltip>
            {/* 带着这个联系人问 AI：跳对话页并注入上下文（助手能读到 TA 的资料/邮件/提醒） */}
            <Tooltip title="带着这位联系人问 AI">
              <Button type="text" size="small" icon={<DiamondLogo size={14} state="static" />}
                className="btn-hover-color" style={{ color: "#00bfa5", padding: 0, minWidth: 20, height: 20 }}
                onClick={() => askAssistant({
                  ctx: `contact:${contact.id}`,
                  question: `${fullName} 最近的情况怎么样？今天该不该跟进，建议怎么跟？`,
                })}
              />
            </Tooltip>
          </div>
          <div className="text-[11px] text-gray-500 font-mono mt-1">{contact.email}</div>
        </div>

        {/* Tab 内容 — 导航固定，内容可滚动 */}
        <Tabs
          activeKey={tab}
          onChange={setTab}
          size="small"
          className="contact-detail-tabs"
          items={[
            { key: "info", label: "基本信息", children: <InfoTab contact={contact} onSaveField={saveField} /> },
            { key: "company", label: "公司背调", children: <CompanyBackcheck companyId={contact.companyId} /> },
            { key: "history", label: "往来记录", children: <ContactInteractions contactId={contact.id} /> },
          ]}
        />
      </div>
    </Drawer>
  );
}
