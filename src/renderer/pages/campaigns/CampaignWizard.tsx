import { useEffect, useState } from "react";
import { Button, Card, Input, InputNumber, Modal, Segmented, Select, Steps, Switch, Tag, message } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ContactPicker } from "./ContactPicker";
import { takeDevLetterPreset } from "../../lib/homeCards";

/**
 * 开发任务创建向导（定时器式任务组营销）：子窗口内完成 5 步 —— 选人 → 发送模式 → 触点计划 → 定时与账号 → 确认。
 * 「添加任务」= 创建草稿（不排触点），启动由用户在任务卡片上手动点；提交走 send:campaignCreate（startNow=false），
 * 编辑草稿走 send:campaignUpdateDraft。引擎不动：任务只是"策源"，启动后到期触点由调度器每 10 分钟喂进既有队列。
 */

const STAGE_OPTIONS = [
  { value: "initial", label: "初次接触" },
  { value: "followup1", label: "跟进 1" },
  { value: "followup2", label: "跟进 2" },
  { value: "closing", label: "促单" },
  { value: "reactivate", label: "激活" },
];
const STAGE_LABELS: Record<string, string> = Object.fromEntries(STAGE_OPTIONS.map(o => [o.value, o.label]));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00` }));

type TouchMode = "fixed" | "userTpl" | "adaptive" | "system";
const MODE_CARDS: Array<{ key: TouchMode; title: string; desc: string }> = [
  { key: "fixed", title: "固定内容", desc: "自己粘贴主题与正文，支持 {{firstName}} {{company}} 变量，所见即所发" },
  { key: "userTpl", title: "用户模板", desc: "用素材库模板，按阶段/语言自动匹配（模板可随时改，每轮入队取最新）" },
  { key: "adaptive", title: "自适应", desc: "同一匹配范围内随机取一条用户模板发信——多轮触达内容轮换，模板增删即时生效" },
  { key: "system", title: "系统句库", desc: "程序内置多语言句库（EN/ES/PT），按联系人类型+阶段自动组装" },
];

interface RoundDraft {
  stage: string;
  delayDays: number;
  mode: TouchMode;
  subject: string;
  body: string;
  cc?: string;                     // 固定内容的抄送（每轮可不同；发信时 CC 对客户可见）
  templateId?: number;
}

interface Template {
  id: number; name: string; language: string; subject: string; body: string;
  category: string | null; stage: string | null; version: number;
}

interface PreviewData {
  total: number; eligible: number; excluded: number; reachedReplied: number;
  sample: Array<{ id: number; name: string; email: string }>;
}

interface DetailResult {
  success: boolean; error?: string;
  data?: {
    campaign: { id: string; name: string; status: string; autoSend: boolean } | null;
    targets: Array<{ contactId: number }>;
    raw: {
      touches: Array<{ stage: string; delayDays: number; mode?: TouchMode; templateId?: number; content?: { subject: string; body: string; cc?: string } }>;
      accountPolicy: "rotate" | "fixed";
      accountIds: number[];
      schedule: { windowStartHour?: number; windowEndHour?: number; dailyGroupCap?: number };
      autoSend: boolean;
      sendMode?: "individual" | "bcc";
    } | null;
  };
}

const newRound = (stage: string, delayDays: number, mode: TouchMode): RoundDraft =>
  ({ stage, delayDays, mode, subject: "", body: "" });

export function CampaignWizard({ open, draftId, onClose, onDone }: {
  open: boolean; draftId: string | null; onClose: () => void; onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [mode, setMode] = useState<TouchMode>("system");
  const [name, setName] = useState("");
  const [rounds, setRounds] = useState<RoundDraft[]>([newRound("initial", 0, "system"), newRound("followup1", 5, "system")]);
  const [autoSend, setAutoSend] = useState(true);
  const [acctMode, setAcctMode] = useState<"rotate" | "fixed">("rotate");
  // 投递方式（用户拍板）：individual=每人单独一封（收件人走 To，像人工手发）；bcc=合并一封（互不可见）
  const [sendMode, setSendMode] = useState<"individual" | "bcc">("individual");
  const [acctIds, setAcctIds] = useState<number[]>([]);
  const [winEnabled, setWinEnabled] = useState(false);
  const [winStart, setWinStart] = useState(9);
  const [winEnd, setWinEnd] = useState(18);
  const [dailyCap, setDailyCap] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();

  const { data: templateData } = useQuery({
    queryKey: ["templates"],
    queryFn: () => window.api.invoke("templates:list") as Promise<{ success: boolean; data?: Template[] }>,
  });
  const { data: accountsData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: Array<{ id: number; email: string; isActive?: boolean }> }>,
  });
  const templates = templateData?.success ? templateData.data || [] : [];
  const accounts = accountsData?.success ? accountsData.data || [] : [];

  // 草稿编辑：拉详情预填（名单/计划/账号/调度全量回填，保存时全量替换）
  useEffect(() => {
    if (!open || !draftId) return;
    void (async () => {
      const r = await window.api.invoke("send:campaignDetail", draftId) as DetailResult;
      if (!r?.success || !r.data?.raw) { message.error(r?.error || "草稿读取失败"); return; }
      const { raw, campaign, targets } = r.data;
      setName(campaign?.name ?? "");
      setSelectedIds(targets.map(t => t.contactId));
      setRounds(raw.touches.map(t => ({
        stage: t.stage, delayDays: t.delayDays ?? 0,
        mode: t.mode ?? "system",
        subject: t.content?.subject ?? "", body: t.content?.body ?? "",
        cc: t.content?.cc ?? "", templateId: t.templateId,
      })));
      setAutoSend(raw.autoSend);
      setAcctMode(raw.accountPolicy);
      setAcctIds(raw.accountIds);
      const s = raw.schedule;
      if (s?.windowStartHour !== undefined && s?.windowEndHour !== undefined) {
        setWinEnabled(true);
        setWinStart(s.windowStartHour);
        setWinEnd(s.windowEndHour);
      }
      setDailyCap(s?.dailyGroupCap ?? 0);
      if (raw.touches[0]?.mode) setMode(raw.touches[0].mode);
      if (raw.sendMode) setSendMode(raw.sendMode);
    })();
  }, [open, draftId]);

  // 首页「自动开发信」推荐名单接住（一次性交接，读走即删；仅在新建时）
  useEffect(() => {
    if (!open || draftId) return;
    const p = takeDevLetterPreset();
    if (p?.ids.length) { setSelectedIds(p.ids); setPresetNote(p.note); }
  }, [open, draftId]);

  const setRound = (i: number, patch: Partial<RoundDraft>) =>
    setRounds(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  /** 全局模式切换：所有轮次一起改（用户在向导第 2 步做的是全局决策） */
  const applyMode = (m: TouchMode) => {
    setMode(m);
    setRounds(prev => prev.map(r => ({ ...r, mode: m })));
  };

  // ── 步骤守卫 ──
  const canNext = [
    selectedIds.length > 0,                                          // 1 选人
    true,                                                            // 2 模式
    rounds.length > 0 && rounds.every(r => r.stage),                 // 3 计划
    !!name.trim() && (acctMode === "rotate" || acctIds.length > 0),  // 4 定时账号
    true,                                                            // 5 确认
  ][step] ?? false;

  /** 各步必填是否配齐（步骤条向前跳步用；向后回看永不拦） */
  const stepReady = (i: number): boolean => {
    if (i <= 0) return true;
    if (i === 1) return selectedIds.length > 0;
    if (i === 2) return true;
    if (i === 3) return rounds.length > 0 && rounds.every(r => !!r.stage && !roundInvalid(r));
    return !!name.trim() && (acctMode === "rotate" || acctIds.length > 0)
      && rounds.length > 0 && rounds.every(r => !!r.stage && !roundInvalid(r));
  };
  const goStep = (i: number) => {
    if (i === step) return;
    if (i < step) { setStep(i); return; }
    if (!stepReady(i)) {
      message.warning(i >= 4 && !name.trim() ? "任务名还没填（第 4 步）"
        : rounds.some(roundInvalid) ? "有轮次的内容/模板没填完（第 3 步）" : "还有必填项没配齐");
      return;
    }
    setStep(i);
  };

  const roundInvalid = (r: RoundDraft): boolean =>
    r.mode === "fixed" ? !r.subject.trim() || !r.body.trim() : r.mode === "userTpl" && !r.templateId;

  const buildTouches = () => rounds.map(r => ({
    stage: r.stage,
    delayDays: r.delayDays,
    mode: r.mode,
    ...(r.mode === "fixed" ? { content: { subject: r.subject, body: r.body, ...(r.cc?.trim() ? { cc: r.cc.trim() } : {}) } } : {}),
    ...(r.mode === "userTpl" && r.templateId ? { templateId: r.templateId } : {}),
  }));

  // step5 资格预览（资格闸已解除：已触达/已回复照常入队，只报计数提示发不发由用户定）
  const { data: previewData } = useQuery({
    queryKey: ["campaign", "preview", draftId ?? "new", selectedIds.length],
    queryFn: () => window.api.invoke("send:campaignPreview", selectedIds) as Promise<{ success: boolean; data?: PreviewData }>,
    enabled: step === 4 && selectedIds.length > 0,
  });
  const preview = previewData?.success ? previewData.data : null;

  /** 添加任务 = 创建草稿（不排触点）；启动由用户在任务卡片上手动点（startNow 恒 false） */
  const submit = async () => {
    if (!name.trim()) { message.warning("任务名必填"); setStep(3); return; }
    if (rounds.some(roundInvalid)) { message.warning("有轮次的内容/模板未填完（第 3 步）"); setStep(2); return; }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        contactIds: selectedIds,
        touches: buildTouches(),
        autoSend, sendMode,
        accountPolicy: { mode: acctMode, ...(acctMode === "fixed" ? { accountIds: acctIds } : {}) },
        schedule: {
          ...(winEnabled && winStart !== winEnd ? { windowStartHour: winStart, windowEndHour: winEnd } : {}),
          ...(dailyCap > 0 ? { dailyGroupCap: dailyCap } : {}),
        },
        ...(draftId ? { campaignId: draftId } : {}),
      };
      // 只添加不启动：任何 IPC 异常必须显形（曾被静默吞掉 → 按钮"点不动"无任何反馈）
      const ch = draftId ? "send:campaignUpdateDraft" : "send:campaignCreate";
      const r = await window.api.invoke(ch, { ...payload, startNow: false }) as
        { success: boolean; error?: string; data?: { eligible: number; excluded: number } };
      if (!r?.success) { message.error(r?.error || "保存失败"); return; }
      const eligible = r.data?.eligible ?? selectedIds.length;
      message.success(`已添加任务「${name.trim()}」：${eligible} 人 × ${rounds.length} 轮——到任务卡片点「启动」开始执行`);
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      // 名单已归属任务 → 首页推荐与选人器灰显一起重算（漏一条就会"还在推荐同一批人"，规范 §5）
      qc.invalidateQueries({ queryKey: ["dev-letter"] });
      qc.invalidateQueries({ queryKey: ["send", "pickerStats"] });
      onDone();
    } catch (err) {
      message.error(`提交失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const modeLabel = MODE_CARDS.find(m => m.key === mode)?.title ?? mode;
  /** 该阶段可用模板条数（templates:list 只回启用中的模板）——自适应模式的每轮提示 */
  const stageTplCount = (stage: string) => templates.filter(t => (t.stage ?? "") === stage).length;

  return (
    <Modal
      open={open}
      onCancel={() => { if (!submitting) onClose(); }}
      width="min(1000px, calc(100vw - 48px))"
      style={{ top: 24 }}
      title={
        <span className="text-[15px] font-semibold text-gray-800">{draftId ? "编辑任务草稿" : "创建开发任务"}</span>
      }
      footer={null}
      destroyOnHidden
      styles={{ body: { maxHeight: "calc(100vh - 96px)", overflowY: "auto", paddingTop: 12 } }}
    >
    <div className="space-y-4">
      {/* 步骤条本身即导航：hover 有反馈，向前跳步要先把必填项配齐（不再放「上一步」按钮） */}
      <Steps size="small" current={step} className="!max-w-2xl wizard-steps"
        onChange={goStep} items={[{ title: "选择联系人" }, { title: "发送模式" }, { title: "触点计划" }, { title: "定时与账号" }, { title: "确认" }]} />

      {step === 0 && (
        <>
          {presetNote && (
            <div className="flex items-center gap-2 text-[12px] text-gray-500 bg-teal-50/60 border border-teal-100 rounded px-3 py-1.5">
              <span>{presetNote}——已为你预选，模式与计划在后面几步确认。</span>
              <Button size="small" type="text" className="!text-[11px] !px-1"
                onClick={() => { setSelectedIds([]); setPresetNote(null); }}>清空重选</Button>
            </div>
          )}
          <ContactPicker value={selectedIds} onChange={setSelectedIds} onNext={() => setStep(1)} />
        </>
      )}

      {step === 1 && (
        <Card size="small" title={<span className="text-xs font-semibold text-gray-600">发送模式</span>}>
          <div className="flex flex-col gap-2">
            {MODE_CARDS.map(m => (
              <div key={m.key}
                className={`cursor-pointer rounded-lg border p-3 transition-colors ${mode === m.key ? "border-teal-400 bg-teal-50/50" : "border-gray-200 bg-white hover:border-gray-300"}`}
                onClick={() => applyMode(m.key)}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${mode === m.key ? "bg-teal-500" : "bg-gray-300"}`} />
                  <span className="text-xs font-medium text-gray-800">{m.title}</span>
                </div>
                <div className="text-[11px] text-gray-500 mt-1 pl-4">{m.desc}</div>
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <Button type="primary" size="small" onClick={() => setStep(2)}>下一步</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card size="small" title={<span className="text-xs font-semibold text-gray-600">触点计划（{rounds.length} 轮{mode === "fixed" ? " · 每轮内容" : ""}）</span>}
        >
          <div className="space-y-3">
            {mode === "system" && (
              <div className="text-[11px] text-gray-400 bg-gray-50 rounded px-3 py-2">
                系统句库自动按联系人语言/类型/阶段组装，无需逐轮配置内容。轮次只决定「什么时候发、发哪种阶段」。
              </div>
            )}
            {mode === "adaptive" && (
              <div className="text-[11px] text-gray-400 bg-gray-50 rounded px-3 py-2">
                自适应不锁定具体模板：每轮在该阶段的启用模板里，按联系人语言随机取一条发送——同一批人多轮收信内容会轮换。该阶段没有模板时自动回落系统句库。
              </div>
            )}
            {rounds.map((r, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white"
                style={{ boxShadow: "0 1px 4px rgba(15, 23, 42, 0.07)" }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-medium text-gray-500 w-12">第 {i + 1} 轮</span>
                  <Select size="small" style={{ width: 120 }} value={r.stage}
                    options={STAGE_OPTIONS} onChange={v => setRound(i, { stage: v })} />
                  {i === 0 ? (
                    <span className="text-[11px] text-gray-400">首信（立即）</span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-gray-500">
                      上封发出后
                      <InputNumber size="small" min={1} max={60} value={r.delayDays}
                        onChange={v => setRound(i, { delayDays: Math.floor(Number(v) || 0) })} />
                      天
                    </span>
                  )}
                  <span className="flex-1" />
                  {rounds.length > 1 && (
                    <Button size="small" type="text" danger icon={<DeleteOutlined />}
                      onClick={() => setRounds(prev => prev.filter((_, idx) => idx !== i))} />
                  )}
                </div>
                {mode === "adaptive" && (
                  <div className="text-[10px] text-gray-400 mt-1.5 pl-14">
                    {stageTplCount(r.stage) > 0
                      ? `该阶段可用模板 ${stageTplCount(r.stage)} 条 · 每次随机取一条`
                      : "该阶段还没有启用模板 — 这一轮回落系统句库"}
                  </div>
                )}
                {mode === "fixed" && (
                  <div className="mt-2 space-y-2">
                    <Input size="small" placeholder="邮件主题（支持 {{firstName}} {{company}} 变量）"
                      value={r.subject} onChange={e => setRound(i, { subject: e.target.value })} />
                    <Input.TextArea size="small" rows={6} placeholder="邮件正文…（变量：{{firstName}} {{lastName}} {{company}} {{title}} {{email}}）"
                      value={r.body} onChange={e => setRound(i, { body: e.target.value })} />
                    <Input size="small" placeholder="抄送（可选，多个用逗号分隔；抄送方对客户可见）"
                      value={r.cc ?? ""} onChange={e => setRound(i, { cc: e.target.value })} />
                  </div>
                )}
                {mode === "userTpl" && (
                  <div className="mt-2">
                    <Select size="small" style={{ width: "100%" }} allowClear placeholder="选择模板（建议与阶段匹配）"
                      value={r.templateId}
                      options={templates.map(t => ({
                        value: t.id,
                        label: `${t.name}（${t.language}${t.stage ? ` · ${STAGE_LABELS[t.stage] ?? t.stage}` : ""}）`,
                      }))}
                      onChange={v => setRound(i, { templateId: v })} />
                    <div className="text-[10px] text-gray-400 mt-1">
                      未指定时按阶段+联系人语言自动匹配；模板后续修改会自动生效（每轮入队取最新版）
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button size="small" icon={<PlusOutlined />} disabled={rounds.length >= 6}
                onClick={() => setRounds(prev => [...prev, newRound("followup2", 5, mode)])}>
                添加一轮
              </Button>
              <Button type="primary" size="small" disabled={!canNext || rounds.some(roundInvalid)}
                onClick={() => setStep(3)}>下一步</Button>
            </div>
            {rounds.some(roundInvalid) && (
              <div className="text-[11px] text-amber-600">有轮次的内容或模板还没填完，补齐才能下一步</div>
            )}
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card size="small" title={<span className="text-xs font-semibold text-gray-600">定时器与发信账号</span>}
>
          <div className="space-y-4">
            <div>
              <div className="text-[11px] text-gray-500 mb-1">任务名（必填）</div>
              <Input size="small" style={{ width: 320 }} placeholder="如：巴西冷客户·4 触点"
                value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <div className="text-[11px] text-gray-500 mb-1">发信账号</div>
              <div className="flex items-center gap-2 flex-wrap">
                <Select size="small" style={{ width: 160 }} value={acctMode}
                  onChange={v => setAcctMode(v)} options={[
                    { value: "rotate", label: "智能轮换（推荐）" },
                    { value: "fixed", label: "仅用指定账号" },
                  ]} />
                {acctMode === "fixed" && (
                  <Select mode="multiple" size="small" style={{ minWidth: 280 }} allowClear
                    placeholder="选择发信账号（可多选）" value={acctIds} onChange={setAcctIds}
                    options={accounts.map(a => ({ value: a.id, label: a.email }))} />
                )}
              </div>
              <div className="text-[10px] text-gray-400 mt-1">
                {acctMode === "rotate"
                  ? "健康账号自动轮换；熔断账号（反垃圾拦截）自动避让"
                  : "只用勾选的账号；指定账号全部熔断/停用时整批顺延次日，不静默换号"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500 mb-1">投递方式</div>
              <div className="flex items-center gap-2">
                <Segmented size="small" value={sendMode} onChange={v => setSendMode(v as "individual" | "bcc")}
                  options={[{ value: "individual", label: "单独发送（每人一封）" }, { value: "bcc", label: "合并一封（BCC）" }]} />
              </div>
              <div className="text-[10px] text-gray-400 mt-1">
                {sendMode === "individual"
                  ? "收件人走 To，像人工一封封发出去的邮件；同一公司多人也不会互相出现在一封里"
                  : "一组人共用一封、收件人走 BCC 互不可见；省额度、发得快"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500 mb-1">发送时段（不勾选 = 跟随全局设置）</div>
              <div className="flex items-center gap-2">
                <Switch size="small" checked={winEnabled} onChange={setWinEnabled} />
                {winEnabled && (
                  <>
                    <Select size="small" style={{ width: 96 }} value={winStart} onChange={setWinStart} options={HOUR_OPTIONS} />
                    <span className="text-[11px] text-gray-400">至</span>
                    <Select size="small" style={{ width: 96 }} value={winEnd} onChange={setWinEnd} options={HOUR_OPTIONS} />
                    {winStart === winEnd && <span className="text-[11px] text-amber-600">起止相同 = 不生效</span>}
                  </>
                )}
              </div>
              <div className="text-[10px] text-gray-400 mt-1">时段外只入队等待，到点自动发送（本机时区）</div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500 mb-1">单日放行上限（组/天）</div>
              <div className="flex items-center gap-2">
                <InputNumber size="small" min={0} max={2000} value={dailyCap} style={{ width: 110 }}
                  onChange={v => setDailyCap(Math.max(0, Math.floor(Number(v) || 0)))} />
                <span className="text-[11px] text-gray-400">{dailyCap === 0 ? "0 = 不限（尽快发完）" : "超出部分顺延次日继续——周期式发送"}</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500 mb-1">无人值守</div>
              <div className="flex items-center gap-2">
                <Switch size="small" checked={autoSend} onChange={setAutoSend} />
                <span className="text-[11px] text-gray-500">{autoSend ? "计划内触点自动发送" : "每轮入队后，在本页顶部状态条手动开始"}</span>
              </div>
            </div>
            <div className="flex justify-end pt-1">
              <Button type="primary" size="small" disabled={!canNext} onClick={() => setStep(4)}>下一步</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card size="small" title={<span className="text-xs font-semibold text-gray-600">确认任务</span>}
>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
              <div className="flex justify-between"><span className="text-gray-500">任务名</span><span className="font-medium text-gray-800">{name}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">发送模式</span><span className="text-gray-800">{modeLabel}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">投递方式</span><span className="text-gray-800">{sendMode === "individual" ? "单独发送（每人一封）" : "合并一封（BCC）"}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">触点计划</span><span className="text-gray-800">{rounds.length} 轮</span></div>
              <div className="flex justify-between"><span className="text-gray-500">名单</span><span className="text-gray-800">{selectedIds.length} 人</span></div>
              <div className="flex justify-between"><span className="text-gray-500">发信账号</span>
                <span className="text-gray-800">{acctMode === "rotate" ? "智能轮换" : `指定 ${acctIds.length} 个账号`}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">发送时段</span>
                <span className="text-gray-800">{winEnabled && winStart !== winEnd ? `${String(winStart).padStart(2, "0")}:00–${String(winEnd).padStart(2, "0")}:00` : "跟随全局"}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">单日上限</span>
                <span className="text-gray-800">{dailyCap > 0 ? `${dailyCap} 组/天` : "不限"}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">无人值守</span>
                <span className="text-gray-800">{autoSend ? "自动发送" : "每轮手动开始"}</span></div>
            </div>

            <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/50">
              <div className="text-[12px] text-gray-700 mb-1">
                资格预览：命中 <strong className="text-teal-600">{preview?.eligible ?? "…"}</strong> 人
                {preview && preview.reachedReplied > 0 && <span className="text-amber-600">（含 {preview.reachedReplied} 位已触达/已回复）</span>}
                {preview && preview.excluded > 0 && <span className="text-gray-400">（{preview.excluded} 人不在库，已剔除）</span>}
              </div>
              {preview?.sample?.length ? (
                <div className="text-[11px] text-gray-400">
                  样本：{preview.sample.map(s => s.name || s.email).join("、")}{preview.eligible > preview.sample.length ? " …" : ""}
                </div>
              ) : null}
              <div className="text-[10px] text-gray-400 mt-1">
                名单创建时定格（所见即所发）；添加后到任务卡片点「启动」开始执行，客户回复/退订/退信自动止损
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="primary" size="small" icon={<PlusOutlined />} loading={submitting} disabled={!canNext}
                onClick={() => void submit()}>
                {draftId ? "保存修改" : "添加任务"}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
    </Modal>
  );
}
