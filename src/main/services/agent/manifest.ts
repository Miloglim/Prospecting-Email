// ── Agent 工具注册表：唯一事实源 ──────────────────────────────────
// 每个工具的预算/审批/副作用（spec）、UI 中文名（label）、"何时用我"路由（route）、
// 追问引导（followUps）全部登记在这里。TOOL_SPECS、系统提示词工具段、渲染端标签
// 与追问引导一律从本表派生 —— 新增工具只改这一处，禁止在任何地方维护第二份清单。
// 红线：write 类工具 requiresApproval 必须为 true；发信类（send_queue_add）与
// 批量导入（import_contacts）autoApprovable 永远 false。
import type { ToolSpec } from "./policy";

export interface ToolMeta {
  name: string;
  /** UI 中文名（过程卡「已{label}」） */
  label: string;
  /** 一句话路由说明：拼进系统提示词的工具清单段 */
  route: string;
  /** 追问引导（本轮用过该工具后展示；可省） */
  followUps?: string[];
  spec: ToolSpec;
}

export const TOOL_MANIFEST: ToolMeta[] = [
  {
    name: "search_contacts", label: "检索联系人",
    route: "检索联系人（支持按沉默时长排序，「沉默最久的是谁」用 sortBy:'stale'）；",
    followUps: ["给这位联系人记一条跟进", "查一下这个人的往来邮件记录"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 5 },
  },
  {
    name: "delete_contacts", label: "删除联系人",
    route: "删除联系人（按邮箱后缀或关键词批量，写、需确认、不可恢复）；",
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 2, autoApprovable: false },
  },
  {
    name: "read_program_config", label: "读取程序配置",
    route: "读取程序运行配置（发信时段/限额/测试模式/身份档案/CRM 参数/账号/生效端点）；用户问程序怎么配的、为什么这个点不发信，先查它；",
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 2 },
  },
  {
    name: "update_program_config", label: "修改程序配置",
    route: "修改程序配置（写、需确认、永不豁免）；用户说「把发信窗口改成…」「限额调到…」时用；",
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 2, autoApprovable: false },
  },
  {
    name: "update_contact", label: "更新联系人资料",
    route: "更新联系人档案字段（职位/电话/国家/客户类型/标签/偏好备注，写、需确认）；",
    followUps: ["把刚才邮件里提到的偏好也记进 TA 的档案"],
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 4, autoApprovable: true },
  },
  {
    name: "email_read_full", label: "读取邮件全文",
    route: "按 id 读取一封邮件的完整正文与收发信息（用户要原文/全文/导出前先看全文时用）；",
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 3 },
  },
  {
    name: "quote_search", label: "查询运价",
    route: "查询海运运价镜像；",
    followUps: ["按最便宜的船司给客户写一封开发信", "把这条航线的报价按柜型对比一下"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 5 },
  },
  {
    name: "inbox_search", label: "检索邮件",
    route: "检索收件箱邮件；",
    followUps: ["把最值得回复的三封总结一下", "帮我起草一封回复给最新那封询盘"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 6 },
  },
  {
    name: "market_research", label: "调研公开行情",
    route: "联网调研某航线的公开市场运价与船期（多源检索→逐页核实→标注可信度→出带来源链接的报告）；",
    followUps: ["这个价格在我们台账里算什么水平", "按公开市场价给客户写一封报价信"],
    // 联网调研：一次调用就跑完整套「多源检索→页面核实→交叉分级→成稿」，成本高，单轮最多 2 次
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 2 },
  },
  {
    name: "email_summarize", label: "总结邮件",
    route: "总结单封邮件并给下一步建议（先 inbox_search 拿 id）；",
    followUps: ["按同样标准总结其他未读邮件", "把这条建议对应的跟进记到联系人上"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 6 },
  },
  {
    name: "reminders_due", label: "查询到期提醒",
    route: "到期/逾期跟进提醒（「今天该跟进谁」必查）；",
    followUps: ["给第一位联系人记一条跟进", "逾期最久的那位最近有什么邮件往来"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 4 },
  },
  {
    name: "queue_status", label: "查询发送进度",
    route: "发信队列进度；",
    followUps: ["哪个发信账号在报错，帮我看看", "把待发客户里的第一家背调一下"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 4 },
  },
  {
    name: "accounts_status", label: "查询账号健康",
    route: "发信账号健康；",
    followUps: ["异常的那个账号怎么修", "现在队列里还有多少没发出去"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 3 },
  },
  {
    name: "company_backcheck", label: "公司背调",
    route: "公司网络背调（外部搜索，需已配置搜索密钥）；",
    followUps: ["根据背调写一封开发信", "把这个公司的人从客户库里找出来"],
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 1 },
  },
  {
    name: "generate_draft", label: "撰写开发信",
    route: "撰写开发信草稿（只出文本）；",
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 4 },
  },
  {
    name: "record_followup", label: "记录跟进",
    route: "记录跟进（写，需确认）；",
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 4, autoApprovable: true },
  },
  {
    name: "send_queue_add", label: "加入发信队列",
    route: "把邮件加入发送队列（写，需确认；入队后不会自动发送，需用户到「发送中心」手动点开始）；",
    followUps: ["发送队列现在什么状态", "再给下一家也准备一封"],
    // 入队 ≠ 发出：真正发送仍需用户在发送中心点启动；外发动作每一次都要人工确认，永不豁免
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 3, autoApprovable: false },
  },
  {
    name: "import_contacts", label: "导入联系人",
    route: "批量导入客户信息入库（写，需确认；用户粘贴任意格式名单/表格/签名时，你负责整理成 contacts 数组再调用，"
      + "绝不要反问「用 CSV 还是 JSON」这类格式问题——邮箱是唯一键，无效或已存在会跳过不覆盖）；",
    spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 1, autoApprovable: false },
  },
  {
    name: "update_plan", label: "更新任务清单",
    route: "维护对话里的任务清单卡（只更新界面，不读写任何业务数据）；",
    // 元工具：只维护界面可见的任务清单，免审批；上限放宽防多步任务频繁刷新
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 12 },
  },
  {
    name: "export_artifact", label: "导出文件",
    route: "把整理好的内容导出成文件（md 或 csv，落盘到 outputs/agent，界面出现文件卡）；",
    followUps: ["把刚才的内容再导出一份 csv", "继续总结剩下的未读邮件"],
    // 元能力：只写 outputs/agent，不碰业务数据
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 3 },
  },
  {
    name: "start_batch_task", label: "启动后台任务",
    route: "批量后台任务（对话里出进度卡、可取消、不阻塞）：多家公司批量背调 / 各写开发信草稿，"
      + "或多封邮件批量总结（kind=email_summary，传 messageIds）；",
    followUps: ["等结果出来后，给评级最高的那家写封开发信", "发送队列现在什么状态"],
    // 元能力：只读搜索 + 生成文本，绝不发送
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 1 },
  },
  {
    name: "report_gap", label: "登记能力缺口",
    route: "登记能力缺口（开发期需求台账，只写台账不碰业务）。",
    spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 3 },
  },
];

export function toolMeta(name: string): ToolMeta | undefined {
  return TOOL_MANIFEST.find(m => m.name === name);
}

/** 按角色配置挑工具子集：不配/空数组 = 全量；未知名忽略；保持全量集原序 */
export function pickTools<T extends { name?: string }>(all: T[], toolNames?: string[]): T[] {
  return toolNames?.length ? all.filter(t => toolNames.includes(t.name ?? "")) : all;
}

/** 系统提示词工具清单段（一行一个工具） */
export function toolRoutesBlock(): string {
  return TOOL_MANIFEST.map(m => `· ${m.name} ${m.route}`).join("\n");
}

/** UI 中文名映射（渲染端经 agent:toolMeta 取） */
export function toolLabelMap(): Record<string, string> {
  return Object.fromEntries(TOOL_MANIFEST.map(m => [m.name, m.label]));
}

/** 追问引导映射（渲染端经 agent:toolMeta 取） */
export function toolFollowUpMap(): Record<string, string[]> {
  return Object.fromEntries(TOOL_MANIFEST.filter(m => m.followUps?.length).map(m => [m.name, m.followUps!]));
}
