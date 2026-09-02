import { useCallback, useEffect, useRef, useState } from "react";
import { DotPattern } from "@/components/ui/dot-pattern";
import { cn } from "@/lib/utils";
import "./OnboardingWizard.css";

// ── 新手向导（复刻旧 PE OOBE：全屏覆盖 + 步骤滑入 + 完成页 Logo/渐变字 + 毛玻璃退出 + 可拖拽教程卡）──
// 触发：启动后无 SMTP 账号自动弹出；Shift+点击侧边栏版本号强制重开（open-onboarding 事件）。
// 步骤：①邮箱（保存即服务端 SMTP/IMAP 连通性验证）②署名 ③通用设置 → 完成页 → 教程卡。

type IpcResult<T> = { success: boolean; data?: T; error?: string };

interface FormState {
  smtpHost: string; smtpPort: string; user: string; pass: string;
  imapHost: string; imapPort: string;
  fromName: string;
  closeAction: "tray" | "quit"; autoLaunch: boolean;
}

const INITIAL: FormState = {
  smtpHost: "smtp.mxhichina.com", smtpPort: "465", user: "", pass: "",
  imapHost: "", imapPort: "993",
  fromName: "",
  closeAction: "tray", autoLaunch: false,
};

const TUTORIAL_STEPS = [
  <>客户页 → 导入联系人（CSV / Excel）</>,
  <>发送中心 → 选人 → 选择发送模式 → <strong>加入队列</strong></>,
  <>队列页 → 点击 <strong>开始发送</strong></>,
  <>收件箱 → 回件与退信自动回流识别</>,
  <>客户管理 → 跟进时间线与超期提醒</>,
];

// 步骤图标（细线风格，同旧版 24x24 stroke SVG）
const STEP_ICONS = [
  <svg key="0" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4l-10 8L2 4"/></svg>,
  <svg key="1" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>,
  <svg key="2" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
];

const STEP_TITLES = ["添加您的邮箱", "您的署名", "通用设置"];
const STEP_DESCS = [
  "配置 SMTP 服务器以发送开发信",
  "用于程序身份识别，也是客户在收件箱看到的名字",
  "选择程序的默认行为",
];

type Phase = "closed" | "opening" | "open" | "hiding" | "finishing" | "fadeout";

export function OnboardingWizard() {
  const [phase, setPhase] = useState<Phase>("closed");
  const [step, setStep] = useState(0);            // 0..3 表单步，4=完成页
  const [back, setBack] = useState(false);         // 步骤动画方向
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errs, setErrs] = useState<Set<string>>(new Set());
  const [serverErr, setServerErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const timers = useRef<number[]>([]);
  // 旧版同款：全局跟踪 Shift 按下状态（下一步按钮点击时读取）
  const shiftHeld = useRef(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeld.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeld.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  // 启动检测 + Shift+版本号强制重开
  useEffect(() => {
    const open = () => { setStep(0); setBack(false); setForm(INITIAL); setErrs(new Set()); setServerErr(""); setPhase("opening"); };
    const check = async () => {
      const r = await window.api.invoke("accounts:list") as IpcResult<unknown[]>;
      if (r?.success && (r.data?.length ?? 0) === 0) later(300, open);
    };
    void check();
    window.addEventListener("open-onboarding", open);
    return () => window.removeEventListener("open-onboarding", open);
  }, []);

  // opening → 双 rAF 挂 show 类（进场过渡）
  useEffect(() => {
    if (phase !== "opening") return;
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")));
  }, [phase]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm(f => ({ ...f, [k]: v }));
    setErrs(e => { if (!e.has(k)) return e; const n = new Set(e); n.delete(k); return n; });
  };

  const skip = () => setPhase("hiding");
  useEffect(() => {
    if (phase === "hiding") later(600, () => setPhase("closed"));
    if (phase === "finishing") later(700, () => setPhase("fadeout"));
    if (phase === "fadeout") later(1600, () => { setPhase("closed"); setTutorial(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const next = useCallback(async () => {
    setServerErr("");
    if (step === 0) {
      // 旧版同款隐藏调试口：按住 Shift 点「下一步」跳过必填校验
      // （字段齐全仍照常保存；不全则跳过保存直接进下一步，真错误不吞）
      const required: Array<[keyof FormState, string]> = [
        ["smtpHost", "SMTP 服务器"], ["user", "邮箱地址"], ["pass", "密码"],
      ];
      const complete = required.every(([k]) => String(form[k]).trim());
      if (!complete && !shiftHeld.current) {
        setErrs(new Set(required.filter(([k]) => !String(form[k]).trim()).map(([k]) => k)));
        return;
      }
      if (!complete) { setBack(false); setStep(1); return; }
      setSaving(true);
      const r = await window.api.invoke("accounts:upsert", {
        email: form.user, smtpHost: form.smtpHost, smtpPort: parseInt(form.smtpPort) || 465,
        imapHost: form.imapHost || undefined,
        imapPort: form.imapHost ? (parseInt(form.imapPort) || 993) : undefined,
        password: form.pass,
      }) as IpcResult<unknown>;
      setSaving(false);
      if (!r?.success) { setServerErr(r?.error || "账号保存失败"); return; }
      setBack(false); setStep(1);
    } else if (step === 1) {
      setSaving(true);
      await window.api.invoke("system:updateConfig", { fromName: form.fromName });
      setSaving(false); setBack(false); setStep(2);
    } else if (step === 2) {
      setSaving(true);
      const cfg = await window.api.invoke("system:getConfig") as IpcResult<{ general?: Record<string, unknown> }>;
      await window.api.invoke("system:updateConfig", {
        general: { ...(cfg?.data?.general || {}), closeAction: form.closeAction },
      });
      await window.api.invoke("system:setAutoLaunch", form.autoLaunch);
      setSaving(false); setBack(false); setStep(3);
    }
  }, [step, form]);

  const backStep = () => { setBack(true); setErrs(new Set()); setServerErr(""); setStep(s => Math.max(0, s - 1)); };

  if (phase === "closed" && !tutorial) return null;

  const rootCls = ["ob-root",
    phase === "open" ? "show" : "",
    phase === "hiding" ? "hide" : "",
    phase === "finishing" ? "finishing" : "",
    phase === "fadeout" ? "fadeout" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      {phase !== "closed" && (
        <div className={rootCls}>
          {/* 第一屏专属：shadcn 点阵背景（中心围绕卡片径向淡出） */}
          {step === 0 && (
            <DotPattern
              width={20} height={20} cr={1.3}
              className={cn("[mask-image:radial-gradient(560px_circle_at_50%_42%,white,transparent)]")}
            />
          )}

          <div className="ob-card">
            {step < 3 ? (
              <div key={step} className={back ? "ob-step back" : "ob-step"}>
                <div className="ob-icon">{STEP_ICONS[step]}</div>
                <h2 className="ob-h2">{STEP_TITLES[step]}</h2>
                <p className="ob-desc">{STEP_DESCS[step]}</p>

                <div className="ob-form">
                  {step === 0 && (<>
                    <div className="ob-inline" style={{ display: "flex", gap: 10 }}>
                      <div style={{ flex: 2 }}>
                        <Field label="SMTP 服务器" err={errs.has("smtpHost")} placeholder={errs.has("smtpHost") ? "请填写 SMTP 服务器" : "smtp.mxhichina.com"}
                          value={form.smtpHost} onChange={v => set("smtpHost", v)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Field label="端口" err={errs.has("smtpPort")} placeholder="465" value={form.smtpPort} onChange={v => set("smtpPort", v)} />
                      </div>
                    </div>
                    <Field label="邮箱地址" err={errs.has("user")} placeholder={errs.has("user") ? "请填写邮箱地址" : "your@email.com"}
                      value={form.user} onChange={v => set("user", v)} />
                    <Field label="密码或授权码" err={errs.has("pass")} placeholder={errs.has("pass") ? "请填写密码" : "邮箱密码或服务商授权码"} type="password"
                      value={form.pass} onChange={v => set("pass", v)} />
                    <div className="ob-inline" style={{ display: "flex", gap: 10 }}>
                      <div style={{ flex: 2 }}>
                        <Field label="IMAP 服务器（选填）" placeholder="imap.mxhichina.com" value={form.imapHost} onChange={v => set("imapHost", v)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Field label="IMAP 端口" placeholder="993" value={form.imapPort} onChange={v => set("imapPort", v)} />
                      </div>
                    </div>
                  </>)}
                  {step === 1 && (
                    <Field label="发件人名称" placeholder="如 Zayne Jin" value={form.fromName} onChange={v => set("fromName", v)} />
                  )}
                  {step === 2 && (<>
                    <div className="ob-field">
                      <label>关闭窗口时</label>
                      <div className="ob-seg">
                        <button type="button" className={"ob-seg-btn" + (form.closeAction === "tray" ? " on" : "")}
                          onClick={() => set("closeAction", "tray")}>最小化到后台托盘</button>
                        <button type="button" className={"ob-seg-btn" + (form.closeAction === "quit" ? " on" : "")}
                          onClick={() => set("closeAction", "quit")}>直接退出程序</button>
                      </div>
                    </div>
                    <div className="ob-switch-row">
                      <span>开机自动启动</span>
                      <button className={"ob-switch" + (form.autoLaunch ? " on" : "")} role="switch" aria-checked={form.autoLaunch}
                        onClick={() => set("autoLaunch", !form.autoLaunch)} />
                    </div>
                  </>)}
                </div>

                {serverErr && <div className="ob-error">{serverErr}</div>}

                <div className="ob-actions">
                  {step > 0 && <button className="ob-btn secondary" onClick={backStep}>上一步</button>}
                  <button className="ob-btn" disabled={saving} onClick={() => { void next(); }}>
                    {saving ? "验证中…" : step === 2 ? "完成" : "下一步"}
                  </button>
                </div>
                {step === 0 && <div style={{ textAlign: "center" }}><button className="ob-skip" onClick={skip}>跳过，稍后设置</button></div>}

                <div className="ob-dots">
                  {[0, 1, 2].map(i => (
                    <span key={i} className={"ob-dot" + (i <= step ? " active" : "")} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="ob-step">
                <div className="ob-logo">
                  <div className="ob-logo-mark" />
                  <div className="ob-logo-text">
                    <span className="ob-logo-line1">Milogin's</span>
                    <span className="ob-logo-line2">Prospector.</span>
                  </div>
                </div>
                <h2 className="ob-h2 done">一切就绪</h2>
                <p className="ob-desc">您的邮箱已配置完成，退信检测将自动使用相同的邮箱与密码，无需额外设置。</p>
                <div className="ob-actions">
                  <button className="ob-btn" onClick={() => setPhase("finishing")}>开始使用</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tutorial && <TutorialCard onClose={() => setTutorial(false)} />}
    </>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", err }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; err?: boolean;
}) {
  return (
    <div className="ob-field">
      <label>{label}</label>
      <input type={type} className={err ? "err" : ""} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </div>
  );
}

/** 教程卡 — 可拖拽（沿用旧版 handle 拖拽交互） */
function TutorialCard({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      setPos({ x: drag.current.origX + e.clientX - drag.current.startX,
               y: drag.current.origY + e.clientY - drag.current.startY });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    const r = cardRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top };
    e.preventDefault();
  };

  const style: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, transform: "none", animation: "none", margin: 0 }
    : {};

  return (
    <div className="tut-overlay">
      <div ref={cardRef} className="tut-card" style={style}>
        <div className="tut-handle" onMouseDown={startDrag}><span /></div>
        <h2>开始你的第一次发信</h2>
        <div className="tut-steps">
          {TUTORIAL_STEPS.map((s, i) => (
            <div key={i} className="tut-step"><span className="tut-num">{i + 1}</span>{s}</div>
          ))}
        </div>
        <button className="tut-dismiss" onClick={onClose}>开始使用</button>
      </div>
    </div>
  );
}
