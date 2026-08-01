import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, Input, InputNumber, Button, message, Table, Modal, Form, Tag, Space,
  Switch, TimePicker, Tooltip, Badge,
} from "antd";
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, RobotOutlined } from "@ant-design/icons";
import dayjs from "dayjs";

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
}

interface SendSchedule {
  timeWindowEnabled: boolean; startHour: number; endHour: number;
  minDelaySeconds: number; maxDelaySeconds: number;
  companyDelayMinMinutes: number; companyDelayMaxMinutes: number;
  singleRecipDelayMinSeconds: number; singleRecipDelayMaxSeconds: number;
  templateRotateGroups: number; batchSize: number;
  batchPauseMinSeconds: number; batchPauseMaxSeconds: number;
}

interface RuntimeConfig { smtpAccounts: EmailAccount[]; schedule: SendSchedule; }

// ── 右侧浮动导航分区 ──
const SECTIONS = [
  { id: "sec-general", label: "通用" },
  { id: "sec-mail", label: "邮件发送" },
  { id: "sec-api", label: "API 与服务" },
  { id: "sec-advanced", label: "高级" },
];

// ── 内联编辑行（点击变输入，自动保存）──
function SettingRow({ label, value, onSave, type = "text", placeholder, required, hint }: {
  label: string; value: string | number; onSave: (v: string | number) => void;
  type?: "text" | "number"; placeholder?: string; required?: boolean; hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (val === String(value ?? "")) return;
    setSaving("saving");
    try {
      await onSave(type === "number" ? Number(val) : val);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 2000);
    } catch { setSaving("error"); setTimeout(() => setSaving("idle"), 2000); }
  };

  return (
    <div className="flex items-center gap-2.5 py-1.5 min-h-[30px] group">
      <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">
        {label}{required && <span className="text-red-500 ml-0.5">·</span>}
      </label>
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          type={type === "number" ? "number" : "text"}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setVal(String(value ?? "")); setEditing(false); }
          }}
          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded outline-none focus:border-teal-400"
        />
      ) : (
        <span
          className="flex-1 text-xs text-gray-700 cursor-pointer px-1 py-0.5 rounded hover:bg-gray-50 truncate"
          onClick={() => setEditing(true)}
        >
          {value !== null && value !== undefined && value !== "" ? String(value) : placeholder || "未设置"}
        </span>
      )}
      {hint && <span className="text-[10px] text-gray-400 whitespace-nowrap">{hint}</span>}
      {saving === "saving" && <span className="text-[11px] text-amber-500 w-4">…</span>}
      {saving === "saved" && <span className="text-[11px] text-green-500 w-4">✓</span>}
      {saving === "error" && <span className="text-[11px] text-red-500 w-4">✗</span>}
    </div>
  );
}

// ── 范围输入（min~max 双框，自动保存）──
function RangeRow({ label, min, max, onSaveMin, onSaveMax, hint }: {
  label: string; min: number; max: number;
  onSaveMin: (v: number) => void; onSaveMax: (v: number) => void;
  hint: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editingField, setEditingField] = useState<"min" | "max" | null>(null);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState<"idle" | "saved">("idle");

  const startEdit = (field: "min" | "max") => {
    setEditing(true);
    setEditingField(field);
    setVal(String(field === "min" ? min : max));
  };

  const commit = async () => {
    if (!editingField) return;
    const n = Number(val);
    if (!isNaN(n) && n >= 0) {
      if (editingField === "min") onSaveMin(n);
      else onSaveMax(n);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1500);
    }
    setEditing(false);
    setEditingField(null);
  };

  const displayVal = (v: number) => (editing && editingField === "min" ? val : String(v));

  return (
    <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
      <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">{label}</label>
      <div className="flex-1 flex items-center gap-1 text-xs">
        <input
          value={editingField === "min" ? val : String(min)}
          onChange={e => { if (editingField === "min") setVal(e.target.value); }}
          onFocus={() => startEdit("min")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
        <span className="text-gray-400">~</span>
        <input
          value={editingField === "max" ? val : String(max)}
          onChange={e => { if (editingField === "max") setVal(e.target.value); }}
          onFocus={() => startEdit("max")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
      </div>
      <span className="text-[10px] text-gray-400 whitespace-nowrap">{hint}</span>
      {saving === "saved" && <span className="text-[11px] text-green-500 w-4">✓</span>}
    </div>
  );
}

// ── 分区卡片 ──
function SettingCard({ icon, title, required, children, status }: {
  icon: React.ReactNode; title: string; required?: boolean; children: React.ReactNode; status?: React.ReactNode;
}) {
  return (
    <div className={`border border-gray-200 bg-white ${required ? "border-l-2 border-l-teal-400" : ""}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 flex items-center gap-1.5">
          <span className="opacity-50">{icon}</span> {title}
        </h3>
        <span className="text-[11px]">{status}</span>
      </div>
      <div className="px-4 pt-1 pb-3">{children}</div>
    </div>
  );
}

// ── 设置页主组件 ──
export function SettingsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const [activeSection, setActiveSection] = useState("sec-general");

  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: EmailAccount[] }>,
  });

  const { data: configData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{ success: boolean; data?: RuntimeConfig }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("accounts:upsert", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("accounts:delete", id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const saveConfigMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); message.success("已保存"); },
  });

  const accounts = accountData?.success ? accountData.data || [] : [];
  const config = configData?.success ? configData.data : null;
  const sched = config?.schedule;

  // 保存 schedule 单个字段
  const saveSched = (patch: Partial<SendSchedule>) => {
    saveConfigMut.mutate({ schedule: { ...sched, ...patch } });
  };

  // 滚动高亮分区
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-40% 0px -50% 0px" }
    );
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const accountColumns = [
    { title: "邮箱", dataIndex: "email", key: "email", render: (v: string) => <span className="font-mono text-xs">{v}</span> },
    { title: "SMTP", key: "smtp", render: (_: unknown, r: EmailAccount) => <span className="text-[11px] text-gray-500">{r.smtpHost}:{r.smtpPort}</span> },
    { title: "状态", key: "status", width: 70, render: (_: unknown, r: EmailAccount) => r.consecutiveFails > 0 ? <Tag color="orange">异常</Tag> : <Tag color="green">正常</Tag> },
    {
      title: "操作", key: "actions", width: 120,
      render: (_: unknown, r: EmailAccount) => (
        <Space size="small">
          <Button size="small" icon={<CheckCircleOutlined />} onClick={async () => {
            const res = await window.api.invoke("accounts:validate", r.id) as { success: boolean; data?: { smtpOk: boolean; imapOk: boolean }; error?: string };
            res?.success ? message.info(`SMTP: ${res.data?.smtpOk ? "✓" : "✗"} IMAP: ${res.data?.imapOk ? "✓" : "✗"}`) : message.error(res?.error || "失败");
          }}>测试</Button>
          <Button danger size="small" icon={<DeleteOutlined />} onClick={async () => {
            const res = await deleteMut.mutateAsync(r.id);
            res?.success ? message.success("已删除") : message.error(res?.error || "失败");
          }} />
        </Space>
      ),
    },
  ];

  return (
    <div className="flex gap-8 max-w-2xl mx-auto">
      {/* 主内容 */}
      <div className="flex-1 space-y-8">
        {/* ═══ 通用 ═══ */}
        <div id="sec-general" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">通用</div>
          <SettingCard icon="⚡" title="启动与关闭">
            <SettingRow label="关闭窗口时" value={config?.schedule ? "tray" : ""} type="text"
              onSave={() => {}} placeholder="最小化到托盘" />
          </SettingCard>
          <SettingCard icon="🎨" title="外观">
            <SettingRow label="加载动画" value="关闭" onSave={() => {}} type="text" placeholder="关闭加载动画" />
          </SettingCard>
        </div>

        {/* ═══ 邮件发送 ═══ */}
        <div id="sec-mail" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">邮件发送</div>

          {/* 发信账号 */}
          <SettingCard icon="✉️" title="发信账号" required
            status={<Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>+ 添加账号</Button>}
          >
            <Table dataSource={accounts} columns={accountColumns} rowKey="id"
              size="small" pagination={false} locale={{ emptyText: "还没有发信账号" }}
              className="mb-2" />
          </SettingCard>

          {/* 发信人信息 */}
          <SettingCard icon="👤" title="发信人信息" required>
            <SettingRow label="发件人名称" value="" onSave={() => {}} placeholder="收件人看到的发件人名称" />
            <SettingRow label="正文署名" value="" onSave={() => {}} placeholder="邮件正文中的自称" />
          </SettingCard>

          {/* 发送规则 — 模拟人工 */}
          <SettingCard icon="🕐" title="发送规则 — 模拟人工" required>
            {/* 模板引擎 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-2 mb-1">模板引擎</div>
            <SettingRow label="组间轮换" value={sched?.templateRotateGroups ?? 3} type="number"
              onSave={v => saveSched({ templateRotateGroups: Number(v) })} hint="组/换" />

            {/* 发送参数 */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1">发送参数</div>
            {sched && (
              <>
                <RangeRow label="单封间隔" min={sched.minDelaySeconds} max={sched.maxDelaySeconds}
                  onSaveMin={v => saveSched({ minDelaySeconds: v })} onSaveMax={v => saveSched({ maxDelaySeconds: v })}
                  hint="秒" />
                <RangeRow label="公司组间隔" min={sched.companyDelayMinMinutes} max={sched.companyDelayMaxMinutes}
                  onSaveMin={v => saveSched({ companyDelayMinMinutes: v })} onSaveMax={v => saveSched({ companyDelayMaxMinutes: v })}
                  hint="分钟" />
                <RangeRow label="单联系人" min={sched.singleRecipDelayMinSeconds} max={sched.singleRecipDelayMaxSeconds}
                  onSaveMin={v => saveSched({ singleRecipDelayMinSeconds: v })} onSaveMax={v => saveSched({ singleRecipDelayMaxSeconds: v })}
                  hint="秒" />
                <RangeRow label="批间暂停" min={sched.batchPauseMinSeconds} max={sched.batchPauseMaxSeconds}
                  onSaveMin={v => saveSched({ batchPauseMinSeconds: v })} onSaveMax={v => saveSched({ batchPauseMaxSeconds: v })}
                  hint="秒" />
              </>
            )}
          </SettingCard>
        </div>

        {/* ═══ API 与服务 ═══ */}
        <div id="sec-api" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">API 与服务</div>
          <SettingCard icon="🔑" title="API 密钥">
            <SettingRow label="Exa AI" value="" onSave={() => {}} placeholder="Exa API Key" type="text" />
            <SettingRow label="Tavily" value="" onSave={() => {}} placeholder="tvly-..." type="text" />
            <SettingRow label="Serper" value="" onSave={() => {}} placeholder="Serper API Key" type="text" />
            <SettingRow label="Agnes AI" value="" onSave={() => {}} placeholder="sk-..." type="text" />
            <SettingRow label="DeepSeek" value="" onSave={() => {}} placeholder="sk-..." type="text" />
          </SettingCard>
          <SettingCard icon="🌐" title="网络代理">
            <SettingRow label="HTTP 代理" value="" onSave={() => {}} placeholder="127.0.0.1:7890" type="text" />
          </SettingCard>
        </div>

        {/* ═══ 高级 ═══ */}
        <div id="sec-advanced" className="settings-section">
          <div className="text-[13px] font-bold mb-3 text-gray-800">高级</div>
          <SettingCard icon="🧪" title="测试模式">
            <SettingRow label="测试邮箱" value="" onSave={() => {}} placeholder="test@example.com" type="text" />
            <SettingRow label="测试公司" value="" onSave={() => {}} placeholder="测试公司名" type="text" />
          </SettingCard>
        </div>
      </div>

      {/* 右侧浮动导航 */}
      <nav className="fixed right-8 top-1/2 -translate-y-1/2 z-20 hidden lg:block">
        {SECTIONS.map(s => (
          <div key={s.id} className="flex items-center gap-2 py-1.5 cursor-pointer group"
            onClick={() => scrollTo(s.id)}>
            <span className={`text-[10px] transition-all duration-200 ${activeSection === s.id ? "text-gray-800" : "text-gray-400 opacity-0 group-hover:opacity-100"}`}>
              {s.label}
            </span>
            <span className={`w-2 h-2 rounded-full transition-all duration-200 ${activeSection === s.id ? "bg-teal-400 shadow-[0_0_8px_rgba(0,191,165,0.4)] scale-125" : "bg-gray-300 group-hover:scale-150 group-hover:bg-teal-400"}`} />
          </div>
        ))}
      </nav>

      {/* 新增账号弹窗 */}
      <Modal title="发信账号" open={addOpen} width={460}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        onOk={async () => {
          const values = await form.validateFields();
          const result = await upsertMut.mutateAsync(values);
          if (result && typeof result === "object" && "success" in result) {
            const r = result as { success: boolean; error?: string };
            r.success ? (setAddOpen(false), form.resetFields(), message.success("账号已保存，连接验证通过"))
              : message.error(r.error || "保存失败");
          }
        }}
        confirmLoading={upsertMut.isPending}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="displayName" label="账号名称"><Input placeholder="主账号、备用" /></Form.Item>
          <Form.Item name="smtpHost" label="服务器地址" rules={[{ required: true }]}><Input placeholder="smtp.example.com" /></Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="smtpPort" label="端口" rules={[{ required: true }]} initialValue={465}><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item>
            <Form.Item name="email" label="邮箱地址" rules={[{ required: true, type: "email" }]}><Input placeholder="your@email.com" /></Form.Item>
          </div>
          <Form.Item name="password" label="密码 / 授权码" rules={[{ required: true }]}><Input.Password /></Form.Item>
          <Form.Item name="imapHost" label="IMAP 服务器"><Input placeholder="自动推导" /></Form.Item>
          <Form.Item name="imapPort" label="IMAP 端口"><InputNumber min={1} max={65535} style={{ width: "100%" }} placeholder="993" /></Form.Item>
          <Form.Item name="signature" label="HTML 签名"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
