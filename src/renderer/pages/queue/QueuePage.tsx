import { useState, useEffect } from "react";
import { Button, Card, Progress, Tag, Popconfirm, Space, Empty, message } from "antd";
import {
  PauseCircleOutlined, PlayCircleOutlined, StopOutlined,
  ClockCircleOutlined, LoadingOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { askAssistant } from "../../lib/ask-ai";
import { DiamondLogo } from "../../components/DiamondLogo";

interface QueueItem {
  id: string; companyName: string; companyId: number;
  recipients: Array<{ contactId: number; email: string; name: string }>;
  accountId: number; accountEmail?: string;
  subject: string;
  tplName?: string;  // 该组采用的模板名（句库/即时/动态模式为来源标签）
  country?: string;  // 公司国家（ISO 码，如 MX/BR）
  language?: string; // 语言（EN/ES/PT）
  status: "pending" | "sending" | "sent" | "failed";
  error?: string; sentAt?: string;
}

interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: QueueItem | null; delaySeconds: number; delayUntil: string | null;
  delayReason?: "group" | "window" | null; // window=未到发送时段（显示提示而非倒计时）
  /** 暂停原因：user=手动暂停；sender_block=服务商反垃圾/限流拦截触发（走红色横幅） */
  pausedReason?: "user" | "sender_block" | null;
  accountStats: Array<{ accountId: number; email: string; sent: number; failed: number; total: number; isCircuitOpen: boolean }>;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "等待" },
  sending: { color: "processing", label: "发送中" },
  sent: { color: "success", label: "已发送" },
  failed: { color: "error", label: "失败" },
};

function fmtDelay(s: number): string {
  if (s <= 0) return "";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
}

export function QueuePage() {
  const qc = useQueryClient();

  const { data: statusData } = useQuery({
    queryKey: ["send", "status"],
    queryFn: () => window.api.invoke("send:status") as Promise<{ success: boolean; data?: SendStatus }>,
    refetchInterval: 2000,
    // 缓存被 GC 或后台刷新时保留上一份数据渲染，绝不闪「正在发送」转圈
    placeholderData: prev => prev,
  });

  const { data: queueData } = useQuery({
    queryKey: ["send", "queue"],
    queryFn: () => window.api.invoke("send:getQueue") as Promise<{ success: boolean; data?: QueueItem[] }>,
    // 队列项变化由下方 send:progress 事件 invalidate 驱动，轮询只作兜底 → 低频即可（原 3s 全量拉取是进页卡顿元凶之一）
    refetchInterval: 15000,
    placeholderData: prev => prev,
  });

  // destroyOnHidden 下切到队列 tab 时 CampaignList 已卸载，其事件监听随之消失 ——
  // 这里必须自己监听，否则发送中看队列只能等 15s 轮询
  useEffect(() => {
    const off = window.api.on("send:progress", () => {
      qc.invalidateQueries({ queryKey: ["send", "queue"] });
    });
    return off;
  }, [qc]);

  const status = statusData?.success ? statusData.data : null;
  const items = queueData?.success ? queueData.data || [] : [];
  const isRunning = status?.isRunning ?? false;
  const isPaused = status?.isPaused ?? false;

  // 等待倒计时：按后端给的结束时刻算剩余。
  // 不能用本地递减 —— 离开页面组件卸载后 state 就没了，回来会从完整时长重新倒数（显示"还要等 8 分钟"，实际马上就发）
  const [delayLeft, setDelayLeft] = useState(0);
  useEffect(() => {
    const until = status?.delayUntil;
    if (!until) { setDelayLeft(0); return; }
    const tick = () => setDelayLeft(Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status?.delayUntil]);

  // 折叠已发送的组 + 长队列默认收起
  // 修复：空闲(未开始发送)时百组队列曾全部展开渲染 —— 每组全部收件人 Tag
  // 同步挂载上千组件，是切到队列 tab 卡住的主因。现在 ≥10 组无论是否在发送，
  // 默认只展开锚点组：发送中=当前组；空闲=首个待发组（复盘时兜底首个失败组）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (items.length >= 10) {
      const folded = new Set(items.map(i => i.id));
      const anchor = isRunning
        ? status?.currentItem?.id
        : (items.find(i => i.status === "pending") || items.find(i => i.status === "failed"))?.id;
      if (anchor) folded.delete(anchor);
      setCollapsed(folded);
    } else if (!isRunning && items.length > 0) {
      setCollapsed(new Set(items.filter(i => i.status === "sent").map(i => i.id)));
    }
  }, [isRunning, items.length, status?.currentItem?.id]);

  const toggleCollapse = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const hasPending = items.some(i => i.status === "pending");
  const isDone = items.length > 0 && !isRunning && !hasPending;
  const canResume = !isRunning && hasPending;

  const pct = status?.totalItems
    ? Math.round(((status.sentCount + status.failedCount) / status.totalItems) * 100)
    : (items.length > 0 ? Math.round((items.filter(i => i.status === "sent" || i.status === "failed").length / items.length) * 100) : 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-800 m-0">发送队列</h2>
          {status && (
            <span className="text-xs text-gray-400">
              {status.sentCount}/{status.totalItems}
              {status.failedCount > 0 && <span className="text-red-500">（{status.failedCount} 失败）</span>}
            </span>
          )}
        </div>
        <Space>
          {isRunning && status && (
            <span className="text-[11px] text-gray-500">
              {isPaused ? (
                status.pausedReason === "sender_block" ? (
                  <><StopOutlined className="text-red-500" /> 发信受阻 — 已暂停整批</>
                ) : (
                  <><PauseCircleOutlined className="text-amber-500" /> 已暂停 — 等待恢复</>
                )
              ) : status.delayReason === "window" ? (
                <><ClockCircleOutlined className="text-teal-500" /> 未到发送时段 — 到点后自动开始</>
              ) : delayLeft > 0 ? (
                <><ClockCircleOutlined className="text-teal-500" /> 等待 {fmtDelay(delayLeft)} 后继续</>
              ) : (
                <><LoadingOutlined className="text-blue-500" spin /> 正在发送...</>
              )}
            </span>
          )}
          {isRunning && (
            <>
              <Button size="small" icon={isPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                onClick={() => {
                  window.api.invoke(isPaused ? "send:resume" : "send:pause");
                  qc.invalidateQueries({ queryKey: ["send"] });
                }}>
                {isPaused ? "恢复" : "暂停"}
              </Button>
              <Popconfirm title="取消后已发保留，未发丢弃" onConfirm={async () => {
                await window.api.invoke("send:cancel");
                qc.invalidateQueries({ queryKey: ["send"] });
              }}>
                <Button size="small" danger icon={<StopOutlined />}>取消发送</Button>
              </Popconfirm>
            </>
          )}
          <Button size="small" icon={<DiamondLogo size={14} state="static" />}
            onClick={() => askAssistant({
              question: status
                ? `发送队列现在什么状态？已发 ${status.sentCount} 组、失败 ${status.failedCount} 组，有问题的账号帮我查一下原因`
                : "发送队列现在什么状态？还有多少没发出去",
            })}>问 AI</Button>
          <Button size="small" onClick={() => setCollapsed(new Set(items.map(i => i.id)))}>
            全部折叠
          </Button>
        </Space>
      </div>

      {/* 发信受阻：服务商把内容/频率拦下（反垃圾、限流）→ 整批已暂停、被拦账号已摘出轮换。
          不写清「为什么停」和「点了恢复会怎样」，用户只会当成程序发疯（规范 docs/sender-block-circuit-spec.md §7） */}
      {isRunning && isPaused && status?.pausedReason === "sender_block" && (
        <Card size="small" className="!bg-red-50 !border-red-200">
          <div className="flex items-start justify-between gap-4">
            <div className="text-xs text-red-700 leading-5">
              <div className="font-medium">发信被服务商反垃圾/限流拦截，整批已暂停（未发送的组都还在队列里）。</div>
              <div className="text-red-600/80 mt-0.5">
                被拦的账号已摘出发信轮换，24 小时后自动放回；也可到「设置 → 邮箱账号」点「解除熔断」提前放行。
                建议先改掉被拦的内容、把组间暂停调长（降低发信频率）再恢复，否则会再次触发。
              </div>
            </div>
            <Button size="small" danger type="primary" ghost icon={<PlayCircleOutlined />}
              onClick={() => {
                window.api.invoke("send:resume");
                qc.invalidateQueries({ queryKey: ["send"] });
              }}>仍要恢复发送</Button>
          </div>
        </Card>
      )}

      {/* 开始发送按钮 — 队列已就绪但未运行（新入队 or 重启后中断恢复，两种情况共用） */}
      {canResume && (
        <Card size="small" className="!bg-amber-50 !border-amber-200">
          <div className="flex items-center justify-between">
            <div className="text-xs text-amber-700">
              有 {items.filter(i => i.status === "pending").length} 组待发送
              {(status?.sentCount ?? 0) > 0 ? "（批次被中断，可继续）" : " — 确认收件人无误后开始"}
            </div>
            <Button type="primary" size="small" icon={<PlayCircleOutlined />}
              onClick={async () => {
                const r = await window.api.invoke("send:resumeQueue") as { success: boolean; error?: string };
                r?.success ? message.success("已开始发送") : message.error(r?.error || "启动失败");
                qc.invalidateQueries({ queryKey: ["send"] });
              }}>开始发送</Button>
          </div>
        </Card>
      )}

      {/* 状态条 */}
      {isRunning && (
        <Card size="small">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Tag color={isPaused ? "orange" : "green"}>{isPaused ? "已暂停" : "发送中"}</Tag>
              <span className="text-xs text-gray-500">
                已发 {status?.sentCount ?? 0} / {status?.totalItems ?? 0} 组
              </span>
              {status?.currentItem && (
                <span className="text-xs text-gray-600">
                  当前: {status.currentItem.companyName}
                  <span className="text-gray-400 ml-2">
                    {status.currentItem.recipients.length}人 · {status.currentItem.accountEmail}
                  </span>
                </span>
              )}
            </div>
            <Progress percent={pct} size="small"
              status={status?.failedCount ? "exception" : "active"} />
            {/* 账号状态 */}
            <div className="flex gap-2 flex-wrap">
              {status?.accountStats?.map(a => (
                <Tag key={a.accountId} color={a.isCircuitOpen ? "red" : "green"} className="text-[10px]">
                  {a.email}: 已发{a.sent}/{a.total}{a.failed > 0 ? ` 失败${a.failed}` : ""}{a.isCircuitOpen ? " 熔断" : ""}
                </Tag>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* 已完成摘要 */}
      {isDone && (
        <Card size="small" className="!bg-gray-50">
          <div className="flex items-center gap-4 text-sm">
            <Tag color="default">已完成</Tag>
            <span>发送 {items.filter(i => i.status === "sent").length} / 失败 {items.filter(i => i.status === "failed").length} / 共 {items.length} 组</span>
          </div>
        </Card>
      )}

      {/* 队列卡片列表 */}
      {items.length === 0 ? (
        <Card>
          <Empty description="队列为空 — 从「邮件发送」选择公司加入队列" />
        </Card>
      ) : (
        <div className="space-y-1 max-h-[calc(100vh-280px)] overflow-y-auto">
          {items.map((item) => {
            const folded = collapsed.has(item.id);
            const st = STATUS_TAG[item.status] ?? STATUS_TAG.pending!;
            return (
              <div key={item.id}
                style={{ contentVisibility: "auto" as never, containIntrinsicSize: "auto 48px" }}
                className={`border rounded-lg bg-white transition-shadow hover:shadow-sm ${
                  item.status === "sending" ? "border-blue-300 shadow-blue-50 shadow-sm" : "border-gray-200"
                }`}
              >
                {/* 头部 — 可折叠 */}
                <div
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none"
                  onClick={() => toggleCollapse(item.id)}
                >
                  <span className="text-[10px] text-gray-300 transition-transform"
                    style={{ transform: folded ? "rotate(-90deg)" : "rotate(0deg)" }}>
                    ▼
                  </span>
                  <span className="text-sm font-medium text-gray-800 flex-1 truncate">
                    {item.companyName}
                  </span>
                  {item.country && (
                    <Tag className="text-[10px] leading-none px-1 py-0.5" style={{ background: "#f5f5f4", borderColor: "#e7e5e4", color: "#78716c" }}>
                      {item.country.toUpperCase()}
                    </Tag>
                  )}
                  {item.language && (
                    <Tag color="cyan" className="text-[10px] leading-none px-1 py-0.5">{item.language.toUpperCase()}</Tag>
                  )}
                  <Tag className="text-[10px]">{item.recipients.length}人</Tag>
                  {item.tplName && (
                    <Tag color="purple" className="text-[10px] max-w-[140px] truncate" title={item.tplName}>
                      {item.tplName}
                    </Tag>
                  )}
                  <Tag color={st.color} className="text-[10px]">{st.label}</Tag>
                  <span className="text-[10px] text-gray-400 font-mono w-32 text-right truncate">
                    {item.accountEmail || `#${item.accountId}`}
                  </span>
                </div>

                {/* 展开内容 */}
                {!folded && (
                  <div className="px-4 pb-3 border-t border-gray-100 space-y-1.5">
                    <div className="flex flex-wrap gap-1 pt-2">
                      {item.recipients.map((r) => (
                        <Tag key={r.contactId} className="text-[10px] leading-none font-mono">
                          {r.email}
                        </Tag>
                      ))}
                    </div>
                    <div className="text-xs text-gray-600 truncate">
                      <span className="text-gray-400">主题: </span>{item.subject}
                    </div>
                    {item.tplName && (
                      <div className="text-xs text-gray-600 truncate">
                        <span className="text-gray-400">采用模板: </span>{item.tplName}
                      </div>
                    )}
                    {item.error && (
                      <div className="text-[11px] text-red-500 truncate">
                        错误: {item.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
