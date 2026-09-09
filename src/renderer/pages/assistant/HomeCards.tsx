// ── 首页两张功能卡片（docs/home-cards-spec.md）────────────────────────
// 卡片一「运价查询」：弹窗收 起运港/目的港/柜型/备注 → 确认后把规范化提示词发进会话；
// 卡片二「自动开发信」：主进程按联系人库+限额确定性推荐群组（无模型调用），确认后带名单跳发送中心。
// 红线：自动开发信只做"推荐 + 预选 + 跳转"，入队/发送决策全部在发送界面由人完成。
import { useState } from "react";
import { Modal, Input, Select, Button, Table, Spin, Alert, Tag } from "antd";
import { SearchOutlined, MailOutlined, InboxOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { buildQuotePrompt, buildMailBriefPrompt, stashDevLetterPreset, type QuoteCardInput } from "../../lib/homeCards";

const CONTAINERS = ["40HQ", "40GP", "20GP", "40NOR"];

/** 两张卡片（空态居中） */
export function HomeCards({ onSend }: { onSend: (text: string) => void }) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-[860px] mx-auto">
        <button type="button" onClick={() => setQuoteOpen(true)}
          className="group text-left rounded-xl border border-gray-200 bg-white px-4 py-3.5 cursor-pointer transition-all hover:border-teal-300 hover:shadow-[0_2px_8px_rgba(20,184,166,0.10)]">
          <span className="inline-flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center group-hover:bg-teal-100 transition-colors">
              <SearchOutlined />
            </span>
            <span>
              <span className="block text-[14px] font-medium text-gray-800">运价查询</span>
              <span className="block text-[11px] text-gray-400 mt-0.5">起运港 · 目的港 · 柜型，填完一键标准化查价</span>
            </span>
          </span>
        </button>
        <button type="button" onClick={() => setDevOpen(true)}
          className="group text-left rounded-xl border border-gray-200 bg-white px-4 py-3.5 cursor-pointer transition-all hover:border-teal-300 hover:shadow-[0_2px_8px_rgba(20,184,166,0.10)]">
          <span className="inline-flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center group-hover:bg-teal-100 transition-colors">
              <MailOutlined />
            </span>
            <span>
              <span className="block text-[14px] font-medium text-gray-800">自动开发信</span>
              <span className="block text-[11px] text-gray-400 mt-0.5">按联系人库与限额推荐开发群组，确认后进发送中心</span>
            </span>
          </span>
        </button>
        <button type="button" onClick={() => setBriefOpen(true)}
          className="group text-left rounded-xl border border-gray-200 bg-white px-4 py-3.5 cursor-pointer transition-all hover:border-teal-300 hover:shadow-[0_2px_8px_rgba(20,184,166,0.10)]">
          <span className="inline-flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center group-hover:bg-teal-100 transition-colors">
              <InboxOutlined />
            </span>
            <span>
              <span className="block text-[14px] font-medium text-gray-800">今日邮箱概览</span>
              <span className="block text-[11px] text-gray-400 mt-0.5">今天收了多少、谁在等你回，一眼看清</span>
            </span>
          </span>
        </button>
      </div>
      <QuoteModal open={quoteOpen} onClose={() => setQuoteOpen(false)}
        onSend={(text) => { setQuoteOpen(false); onSend(text); }} />
      <DevLetterModal open={devOpen} onClose={() => setDevOpen(false)} />
      <MailBriefModal open={briefOpen} onClose={() => setBriefOpen(false)}
        onSend={(text) => { setBriefOpen(false); onSend(text); }} />
    </>
  );
}

/** 卡片一：运价查询弹窗。目的港必填，其余可空；确认 = 规范化提示词进会话。 */
function QuoteModal({ open, onClose, onSend }: {
  open: boolean; onClose: () => void; onSend: (text: string) => void;
}) {
  const [pol, setPol] = useState("");
  const [pod, setPod] = useState("");
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [remark, setRemark] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setPol(""); setPod(""); setContainer(undefined); setRemark(""); setErr(null); onClose(); };
  const confirm = () => {
    const input: QuoteCardInput = { pol, pod, container, remark };
    if (!input.pod.trim()) { setErr("目的港要填一个（如 SANTOS / Santos / BRSSZ）"); return; }
    onSend(buildQuotePrompt(input));
    close();
  };
  return (
    <Modal open={open} onCancel={close} width={480} title="运价查询" destroyOnHidden
      footer={[
        <Button key="cancel" onClick={close}>取消</Button>,
        <Button key="ok" type="primary" onClick={confirm}>确认查价</Button>,
      ]}>
      <div className="space-y-3 py-1">
        <div>
          <div className="text-[11px] text-gray-400 mb-1">起运港（可空 = 不限；台账按群记账，蛇口/深圳/华南 会自动互相理解）</div>
          <Input value={pol} onChange={e => setPol(e.target.value)} placeholder="如 蛇口 / SHEKOU / 深圳"
            onPressEnter={confirm} allowClear />
        </div>
        <div>
          <div className="text-[11px] text-gray-400 mb-1">目的港（必填；中英文/UN LOCODE 都认，如 SANTOS / Santos / BRSSZ）</div>
          <Input status={err ? "error" : undefined} value={pod} onChange={e => { setPod(e.target.value); setErr(null); }}
            placeholder="如 SANTOS / BRSSZ" onPressEnter={confirm} allowClear />
          {err && <div className="text-[11px] text-red-500 mt-1">{err}</div>}
        </div>
        <div>
          <div className="text-[11px] text-gray-400 mb-1">柜型（可空）</div>
          <Select style={{ width: "100%" }} value={container} onChange={setContainer} allowClear
            placeholder="不填 = 全部柜型"
            options={CONTAINERS.map(c => ({ value: c, label: c }))} />
        </div>
        <div>
          <div className="text-[11px] text-gray-400 mb-1">备注（可空；想强调的要求写这里）</div>
          <Input.TextArea value={remark} onChange={e => setRemark(e.target.value)} rows={2}
            placeholder="如：重点看价格最低的两家；只要 40HQ" />
        </div>
        <div className="text-[11px] text-gray-400">确认后按固定流程查价并分层呈现：本港专属价在前、航线级适用价在后，舱位动态一并带上。</div>
      </div>
    </Modal>
  );
}

interface DevLetterContact {
  id: number; email: string; name: string;
  company: string | null; country: string | null; language: string | null;
}
interface DevLetterRec {
  contacts: DevLetterContact[];
  groupSize: number; totalCandidates: number; companyCount: number;
  quota: { dailyLimit: number; sentToday: number; remaining: number | null; accountCount: number };
  languages: Array<{ lang: string; n: number }>;
  reasons: string[];
}

/** 卡片二：自动开发信弹窗。打开即算推荐（确定性规则，零模型调用）；确认 = 带名单跳发送中心。 */
function DevLetterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isFetching } = useQuery({
    queryKey: ["dev-letter", "recommend"],
    queryFn: () => window.api.invoke("devLetter:recommend") as Promise<{ success: boolean; data?: DevLetterRec; error?: string }>,
    enabled: open,
  });
  const rec = data?.success ? data.data ?? null : null;
  const confirm = () => {
    if (!rec?.contacts.length) return;
    stashDevLetterPreset(rec.contacts.map(c => c.id),
      `首页「自动开发信」推荐 ${rec.groupSize} 位冷客户（每公司 1 位，限额内）`);
    window.location.hash = "#/campaigns?create=1";
    onClose();
  };
  return (
    <Modal open={open} onCancel={onClose} width={720} title="自动开发信 · 推荐群组" destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" disabled={!rec?.contacts.length || isFetching} onClick={confirm}>
          确定，去发送界面确认任务
        </Button>,
      ]}>
      {isFetching ? (
        <div className="flex items-center justify-center py-10"><Spin tip="正在按联系人库与发送限额计算推荐群组…" /></div>
      ) : !rec ? (
        <Alert type="warning" showIcon message="推荐算不出来" description="联系人库不可读或服务异常，请重试" />
      ) : rec.contacts.length === 0 ? (
        <Alert type="info" showIcon message="没有可推荐的开发对象" description={rec.reasons[0] ?? "联系人库里没有从未触达的有效邮箱客户"} />
      ) : (
        <div className="space-y-3 py-1">
          <div className="flex items-center gap-2 flex-wrap text-[12px] text-gray-500">
            <Tag color="teal" className="!mr-0">推荐 {rec.groupSize} 位</Tag>
            <span>来自 {rec.totalCandidates} 位未触达冷客户（{rec.companyCount} 家公司，每家 1 位）</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[12px]">
            {rec.languages.map(l => <Tag key={l.lang} className="!mr-0">{l.lang} × {l.n}</Tag>)}
            <span className="text-gray-400">
              限额：今日已发 {rec.quota.sentToday}{rec.quota.dailyLimit > 0 ? `/${rec.quota.dailyLimit}` : "（未设上限）"}
              · 可用账号 {rec.quota.accountCount} 个
            </span>
          </div>
          <ul className="text-[11px] text-gray-400 list-disc pl-4 space-y-0.5">
            {rec.reasons.map(r => <li key={r}>{r}</li>)}
          </ul>
          <Table
            size="small" bordered rowKey="id"
            dataSource={rec.contacts}
            pagination={{ pageSize: 6, hideOnSinglePage: true }}
            columns={[
              { title: "姓名", dataIndex: "name", width: 160, ellipsis: true },
              { title: "邮箱", dataIndex: "email", ellipsis: true },
              { title: "公司", dataIndex: "company", width: 170, ellipsis: true, render: (v: string | null) => v ?? "—" },
              { title: "国家", dataIndex: "country", width: 90, render: (v: string | null) => v ?? "—" },
              { title: "语言", dataIndex: "language", width: 70, render: (v: string | null) => v ?? "—" },
            ]}
          />
          <div className="text-[11px] text-gray-400">
            确定后带名单进入「发送中心 · 开发任务」，在创建任务子窗口里确认名单与发送模式——这里不会直接入队或发送。
          </div>
        </div>
      )}
    </Modal>
  );
}

interface BriefMail {
  id: number; fromEmail: string; fromName: string | null; subject: string | null;
  classification: string | null; intent: string | null; receivedAt: string; isRead: boolean;
  matchedContactId: number | null;
}
interface MailBrief {
  day: string; inbound: number; unread: number; byClass: Record<string, number>;
  priceInquiry: number; sentToday: number;
  awaiting: Array<BriefMail & { waitedHours: number }>;
  latest: BriefMail[]; summary: string;
}

/** 卡片三：今日邮箱概览（主进程确定性统计，只读快照；深挖交给助手逐封看）。 */
function MailBriefModal({ open, onClose, onSend }: {
  open: boolean; onClose: () => void; onSend: (text: string) => void;
}) {
  const { data, isFetching } = useQuery({
    queryKey: ["mail-brief", "today"],
    queryFn: () => window.api.invoke("inbox:todayBrief") as Promise<{ success: boolean; data?: MailBrief; error?: string }>,
    enabled: open,
  });
  const b = data?.success ? data.data ?? null : null;
  const stat = (label: string, n: number, tone = "") => (
    <div key={label} className="flex items-baseline gap-1.5">
      <span className={`text-[18px] font-semibold ${tone || "text-gray-800"}`}>{n}</span>
      <span className="text-[11px] text-gray-400">{label}</span>
    </div>
  );
  return (
    <Modal open={open} onCancel={onClose} width={640} title="今日邮箱概览" destroyOnHidden
      footer={[
        <Button key="inbox" onClick={() => { window.location.hash = "#/inbox"; onClose(); }}>去收件箱</Button>,
        <Button key="ai" type="primary" disabled={!b} onClick={() => onSend(buildMailBriefPrompt())}>让助手逐封看</Button>,
      ]}>
      {isFetching ? (
        <div className="flex items-center justify-center py-10"><Spin tip="正在汇总今天的邮件…" /></div>
      ) : !b ? (
        <Alert type="warning" showIcon message="概览取不到" description={data?.error ?? "服务异常，稍后再试"} />
      ) : (
        <div className="space-y-3 py-1">
          <div className="text-[12px] text-gray-600">{b.summary}</div>
          <div className="grid grid-cols-4 gap-2 rounded-lg border border-gray-100 px-3 py-2.5">
            {stat("今日来信", b.inbound)}
            {stat("未读", b.unread, b.unread ? "text-teal-600" : "")}
            {stat("客户回复", b.byClass.replied ?? 0)}
            {stat("询价", b.priceInquiry)}
            {stat("退信", b.byClass.bounce ?? 0, (b.byClass.bounce ?? 0) ? "text-red-500" : "")}
            {stat("自动回复", b.byClass.autoreply ?? 0)}
            {stat("其他来信", b.byClass.other ?? 0)}
            {stat("我方发出", b.sentToday)}
          </div>
          {b.awaiting.length > 0 && (
            <div>
              <div className="text-[11px] text-gray-400 mb-1">等你回复（{b.awaiting.length}）</div>
              <div className="space-y-1">
                {b.awaiting.map(m => (
                  <div key={m.id} className="flex items-center gap-2 text-[12px]">
                    <span className="w-14 flex-shrink-0 text-red-500">已等 {m.waitedHours}h</span>
                    <span className="truncate text-gray-700">{m.fromName || m.fromEmail}</span>
                    <span className="truncate text-gray-400">{m.subject ?? "（无主题）"}</span>
                    {m.matchedContactId && (
                      <a className="ml-auto flex-shrink-0 text-[11px] text-gray-400 hover:text-teal-600"
                        onClick={() => { window.location.hash = `#/customers?view=table&detail=${m.matchedContactId}`; }}>
                        看客户
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {b.latest.length > 0 && (
            <div>
              <div className="text-[11px] text-gray-400 mb-1">今天最新（{b.latest.length}）</div>
              <div className="space-y-1">
                {b.latest.map(m => (
                  <div key={m.id} className="flex items-center gap-2 text-[12px]">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.isRead ? "bg-gray-200" : "bg-teal-400"}`} />
                    <span className="truncate w-40 flex-shrink-0 text-gray-700">{m.fromName || m.fromEmail}</span>
                    <span className="truncate flex-1 text-gray-500">{m.subject ?? "（无主题）"}</span>
                    <span className="flex-shrink-0 text-[11px] text-gray-300">{(m.receivedAt || "").slice(11, 16)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[11px] text-gray-400">概览是只读快照：不改已读、不触发抓取，也不会替你发任何邮件。</div>
        </div>
      )}
    </Modal>
  );
}
