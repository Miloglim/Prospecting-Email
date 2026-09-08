const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
  BorderStyle, WidthType, ShadingType, PageNumber, PageBreak,
} = require("docx");

// ── helpers ──────────────────────────────────────────────────
const CJK = "Microsoft YaHei";
const FONT = { ascii: "Arial", hAnsi: "Arial", eastAsia: CJK };
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0 },
    alignment: opts.align ?? AlignmentType.LEFT,
    children: [new TextRun({ text, font: FONT, size: opts.size ?? 22, bold: opts.bold ?? false, color: opts.color ?? "333333" })],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, font: FONT, size: 30, bold: true, color: "1A1759" })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, font: FONT, size: 26, bold: true, color: "4B3FE3" })],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, font: FONT, size: 22, color: "333333" })],
  });
}

function bulletBold(label, desc) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 60 },
    children: [
      new TextRun({ text: label, font: FONT, size: 22, bold: true, color: "1A1759" }),
      new TextRun({ text: " — " + desc, font: FONT, size: 22, color: "333333" }),
    ],
  });
}

function codeLine(text) {
  return new Paragraph({
    spacing: { after: 0 },
    indent: { left: 360 },
    children: [new TextRun({ text, font: { ascii: "Consolas", hAnsi: "Consolas", eastAsia: CJK }, size: 19, color: "6054F1" })],
  });
}

function makeCell(text, opts = {}) {
  return new TableCell({
    borders,
    width: { size: opts.width, type: WidthType.DXA },
    shading: opts.header ? { fill: "E5EAFF", type: ShadingType.CLEAR } : undefined,
    margins: cellMargins,
    children: [new Paragraph({
      children: [new TextRun({ text, font: FONT, size: 20, bold: opts.header ?? false, color: opts.header ? "1A1759" : "333333" })],
    })],
  });
}

function makeTable(headers, rows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalW, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({
        cantSplit: true,
        tableHeader: true,
        children: headers.map((h, i) => makeCell(h, { header: true, width: colWidths[i] })),
      }),
      ...rows.map(row => new TableRow({
        cantSplit: true,
        children: row.map((c, i) => makeCell(c, { width: colWidths[i] })),
      })),
    ],
  });
}

// ── document content ──────────────────────────────────────────
const children = [];

// Title
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({ text: "Prospector — AI 原生货代客户开发工具", font: FONT, size: 36, bold: true, color: "1A1759" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({ text: "AI 创新大赛答辩稿  |  v5.3.0  |  2026-09-08", font: FONT, size: 20, color: "71717A" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 400 },
  children: [new TextRun({ text: "国际货代 / 外贸销售 AI 工作台", font: FONT, size: 20, bold: true, color: "4B3FE3" })],
}));

// ═══════ Q1 产品形态 ═══════
children.push(h1("一、产品形态"));
children.push(p("Prospector 是一款面向国际货代/外贸销售人员的 AI 原生桌面应用（Electron + React + TypeScript），版本 v5.3.0。产品定位是货代销售的\"一站式 AI 客户开发工作台\"，将七大功能整合到一个桌面应用中。"));

children.push(h2("功能模块"));
children.push(makeTable(
  ["功能模块", "说明"],
  [
    ["客户库", "联系人/公司管理，批量导入，标签分类"],
    ["AI 邮件撰写", "基于客户背景生成 EN/ES/PT 个性化冷邮件"],
    ["公司背调", "通过 Exa/Tavily 获取行业、进口活动、适配点"],
    ["批量发送", "多账号轮换、熔断器、时间窗口、日配额管理"],
    ["收件箱管理", "IMAP 拉取 + 自动分类（询盘/回复/退信/自动回复）"],
    ["CRM 管线", "看板视图、到期提醒、活动时间线、静默逾期标记"],
    ["运价看板", "局域网运价同步 → 本地镜像 → 离线查询"],
  ],
  [2400, 6960],
));

children.push(new Paragraph({ spacing: { before: 160 }, children: [] }));
children.push(p("核心特征：桌面端形态（Windows NSIS 安装包），本地 SQLite 存储，数据不上云（除配置的模型端点和搜索服务外）。AI Agent 贯穿全流程——20 个工具覆盖读/写/生成/搜索全链路，所有写操作需用户审批。", { bold: true, color: "1A1759" }));

// ═══════ Q2 工作流架构图 ═══════
children.push(h1("二、工作流架构图"));
children.push(p("系统采用五层垂直结构（紫色品牌节点为 Agent Harness 智能核心）："));

children.push(h2("五层架构"));
children.push(bulletBold("用户输入 → 前端 React 页面", "TanStack Router 路由，Ant Design 组件库，TanStack Query 数据获取"));
children.push(bulletBold("IPC 通信层", "Contract 统一命名（domain:action），Transport 薄路由（≤15 行），Preload 白名单暴露"));
children.push(bulletBold("Agent Harness 智能核心", "工具编排 · 策略门控 · 记忆注入 · 反射校验 · 审计日志"));
children.push(bulletBold("业务服务层", "Contact · Send · Inbox · CRM · Rates · Research · Campaign"));
children.push(bulletBold("SQLite 数据层", "Drizzle ORM · WAL 模式，11 张核心表覆盖完整业务域"));
children.push(bulletBold("外部服务", "LLM API · Exa/Tavily · IMAP/SMTP · 运价看板（局域网）"));

children.push(h2("Agent 单轮执行管线"));
children.push(p("用户消息"));
children.push(codeLine("→ 上下文锚点解析（contact:id / company:id / message:id）"));
children.push(codeLine("→ 记忆加载（工作记忆 30 条 + 工具事实注入 + 超限压缩摘要）"));
children.push(codeLine("→ Agent.run()（带工具定义的 LLM 调用）"));
children.push(codeLine("  → 工具调用 → 策略门控检查"));
children.push(codeLine("    → 读操作：工具缓存命中？→ 幂等检查 → 执行 → 审计日志"));
children.push(codeLine("    → 写操作：审批门控 → 前端动作卡片 → 用户确认 → 闭包执行"));
children.push(codeLine("  → 返回结果给 LLM，继续多轮"));
children.push(codeLine("→ 反射校验（数字溯源）"));
children.push(codeLine("→ 流式输出 → 前端渲染"));
children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

children.push(p("IPC 通道规模：17 个域、100+ 通道，Contract 统一命名（domain:action 格式），Transport 薄路由（≤15 行），Preload 白名单暴露。", { bold: true, color: "4B3FE3" }));

// ═══════ Q3 关键技术决策 ═══════
children.push(h1("三、关键技术决策"));

children.push(h2("决策一：Electron 桌面端而非 Web 应用"));
children.push(p("货代行业数据敏感性极高——客户联系方式、公司背调数据、邮件往来都是核心资产，必须留在本地。SMTP/IMAP 邮件协议需要本地网络环境，运价看板运行在局域网内。SQLite + WAL 模式提供零配置的本地并发读写。选择 Electron 是数据安全主权和部署便捷性的平衡。"));

children.push(h2("决策二：严格三层分离架构"));
children.push(bullet("Services 层禁止 import electron（纯逻辑可测试，Result<T> 返回值）"));
children.push(bullet("Transport 层 ≤15 行（仅校验 + 委托，禁止直接 DB 访问）"));
children.push(bullet("Contract 层统一 IPC 通道命名（domain:action，禁止连字符/下划线/驼峰）"));
children.push(p("确保业务逻辑与 Electron 运行时解耦，30+ 单元测试可直接验证服务层。"));

children.push(h2("决策三：OpenAI Agents SDK 驱动的 Agent 架构"));
children.push(p("选择 @openai/agents 而非自研 Agent 框架。核心设计是工具注册表（TOOL_MANIFEST）作为单一数据源——策略规则、UI 标签、审批要求、预算限制全部从 Manifest 派生。三级权限模型：L0 读（自动执行）/ L2 写（需审批）/ L3 删除（不注册为工具）。"));

children.push(h2("决策四：写操作审批门控 + 动作卡片模式"));
children.push(p("所有 sideEffect=write 的工具必须经用户审批。写操作以闭包形式注册在服务端，前端仅渲染动作卡片并传回 actionId，无法直接执行写操作。每次工具执行写入 agent_tool_calls 审计表。实现\"AI 建议、人类决策\"的安全范式。"));

children.push(h2("决策五：Drizzle ORM + better-sqlite3"));
children.push(p("类型安全 ORM（Zod schema → Drizzle schema），WAL 模式保证并发读写安全，迁移脚本幂等设计（列增加/重命名/数据回填自动执行）。11 张核心表覆盖完整业务域。"));

// ═══════ Q4 技术能力运用 ═══════
children.push(h1("四、技术能力运用"));

children.push(h2("AI / LLM 能力"));
children.push(makeTable(
  ["能力", "实现方式"],
  [
    ["Agent 工具调用", "20 个工具覆盖客户搜索、邮件撰写、运价查询、市场研究、CRM 跟进、发信任务等全场景"],
    ["多语言邮件生成", "基于客户国家/类型/跟进阶段，从句库 + 预设模板生成 EN/ES/PT 个性化冷邮件"],
    ["公司背调", "Exa/Tavily 搜索 → 行业/进口活动/适配点结构化输出"],
    ["收件箱智能分类", "规则引擎（退信/自动回复/询盘/回复）+ LLM 意图兜底"],
    ["每日 AI 建议", "AI 生成带 {slot} 占位符的模板，展示时填充实时数据快照"],
    ["航线运价研究", "多源检索 → 页面验证 → 交叉验证 → 可信度分级 → 结构化报告"],
    ["会话记忆", "工作记忆（30 条最近消息）+ 工具事实持久化（agent_facts）+ 超限压缩"],
  ],
  [2400, 6960],
));

children.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
children.push(h2("工程能力"));
children.push(makeTable(
  ["能力", "实现方式"],
  [
    ["类型安全", "TypeScript 5.6 严格模式 + noUncheckedIndexedAccess + Zod 4.5 运行时校验"],
    ["邮件引擎", "多账号轮换、熔断器（consecutiveFails / circuitOpenAt）、时间窗口（21:00-08:00）、分组延迟（300-600s）、日配额（1500 封）"],
    ["运价同步", "局域网看板 Python 服务器 → 标准化 JSON → 本地镜像表，离线可查"],
    ["端点管理", "多 Provider Profile（Agnes 2.5 Flash / DeepSeek），端点家族检测，思维链控制注入"],
    ["测试体系", "Vitest 30+ 单元测试 + 集成测试 + Agent Eval（agent-eval.test.ts）"],
    ["自动更新", "electron-updater + GitHub Releases"],
  ],
  [2400, 6960],
));

// ═══════ Q5 AI 原生创新点 ═══════
children.push(h1("五、AI 原生创新点和核心亮点"));

children.push(h2("创新点一：数字反射器（Reflector）"));
children.push(p("Agent 回答中出现的所有数字，必须能在工具输出中找到来源。不匹配时自动触发轻量级修正（chatJson），仍无法对齐时附加不确定性声明。解决 LLM\"数字幻觉\"行业痛点——在运价、客户数、邮件统计等场景中，一个编造的数字可能导致商业误判。"));

children.push(h2("创新点二：写操作审批门控 + 动作卡片"));
children.push(p("AI 不能直接执行任何写操作（删客户、发邮件、改 CRM 阶段）。写操作以闭包形式注册在服务端，前端仅渲染动作卡片，用户确认后服务端执行闭包，全程审计可追溯。\"AI 可信执行\"在 B2B 销售场景的工程化落地。"));

children.push(h2("创新点三：工具注册表单一数据源"));
children.push(p("TOOL_MANIFEST 是所有工具元数据的唯一来源——策略规则、UI 标签、审批要求、预算限制全部从 Manifest 派生。新增工具只需在 Manifest 注册一处，Harness 系统提示、前端 toolMeta、策略门控全链路自动生效。消除工具定义散落导致的不一致风险。"));

children.push(h2("创新点四：五分钟写操作幂等"));
children.push(p("conversationId + toolName + 参数hash → 5 分钟去重窗口，防止 Agent 在同一对话中重复执行相同写操作（如重复创建 CRM 跟进记录）。仅缓存成功结果，失败不幂等——允许重试。"));

children.push(h2("创新点五：每日 AI 建议卡片的模板化设计"));
children.push(p("AI 生成的是带 {slot} 占位符的模板而非硬编码数字，展示时实时填充当前数据快照。六大卡片组（查运价/看市场行情/管邮件/跟进客户/准备发信/账号与公司），每张卡片隐藏方法论前缀（如\"仅用本地运价镜像，不得虚构市场价格\"），将研究纪律编码进提示词。"));

children.push(h2("创新点六：工具事实记忆（Tool Facts）"));
children.push(p("工具执行结果不仅返回给 LLM，还持久化到 agent_facts 表。后续轮次中 Agent 可直接引用之前的工具结果，无需重新查询。超过工作记忆限制时旧消息被压缩为摘要，工具事实保持完整——降低 API 成本的同时保持上下文连续性。"));

children.push(h2("核心亮点总结"));
children.push(p("Prospector 不是\"AI 聊天 + CRM\"的简单叠加，而是将数字反射校验、写操作安全门控、工具事实记忆、模板化建议引擎、工具注册表单一数据源五大 AI 原生能力，深度嵌入货代销售从客户开发 → 邮件触达 → 收件管理 → CRM 跟进 → 运价决策的完整闭环。数据安全留在本地，AI 能力贯穿全流程。", { bold: true, color: "1A1759" }));

// ═══════ Q6 Agent 调用与鉴权 ═══════
children.push(h1("六、Agent 与业务服务层的调用行为与鉴权"));

children.push(h2("调用方式：进程内直接函数调用"));
children.push(p("Agent 工具层（tools.ts）直接 import 业务服务层函数，在同一个 Electron 主进程内以函数调用的方式执行。不经过 IPC、不经过网络、不经过任何中间认证层——因为 Agent 和业务服务运行在同一个进程里。"));

children.push(p("实际 import 示例：", { bold: true }));
children.push(codeLine("import { upsertContact, importContacts } from \"../contact.service\";"));
children.push(codeLine("import { getBody, markRead } from \"../inbox.service\";"));
children.push(codeLine("import { checkReminders, setStage } from \"../crm.service\";"));
children.push(codeLine("import { startQueue, getSendStatus } from \"../send.service\";"));
children.push(codeLine("import { listQuotes, countQuotes } from \"../rate-sync.service\";"));
children.push(codeLine("import { generateEmailDraft, searchCompany } from \"../ai.service\";"));
children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

children.push(h2("鉴权机制：代码级五层策略门控"));
children.push(p("Agent 与业务服务之间没有传统鉴权（没有 token、session、RBAC），而是用代码级硬约束实现等价安全控制链："));

children.push(makeTable(
  ["层级", "机制", "说明"],
  [
    ["第一层", "工具注册表单一数据源", "manifest.ts 登记 sideEffect（read/write），唯一事实源"],
    ["第二层", "策略层从 Manifest 派生", "判据只看 sideEffect===\"write\"，不看 requiresApproval 字段——判据只可加严不可放宽"],
    ["第三层", "构建时强制注入审批闸门", "buildHarnessTools() 统一扫描，对 write 类工具强制注入 needsApproval=async()=>true"],
    ["第四层", "SDK 中断流 + 用户审批", "needsApproval 返回 true → SDK 中断 → 前端动作卡片 → 用户确认 → resolveApproval 恢复"],
    ["第五层", "运行时防护", "预算守卫 + 熔断器 + 幂等去重 + 读缓存 + 审计日志"],
  ],
  [1000, 2800, 5560],
));

children.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
children.push(h2("为什么不用传统鉴权"));
children.push(p("Agent 不是外部调用方——它和业务服务在同一个进程内，本质上是应用自身的能力。传统鉴权解决\"外部不可信调用方验证身份\"的问题，而这里的问题是\"AI 模型的工具调用行为需要受控\"。用代码级策略门控比网络鉴权更直接、更难绕过：没有 token 可以泄露、没有 API 网关可以绕过、写操作的执行权始终在用户手里。"));

children.push(p("设计原则：判据只可加严不可放宽——审批门控的判据只看 sideEffect，不依赖各工具自觉实现。审核不靠\"自觉\"，靠代码级强制注入。", { bold: true, color: "1A1759" }));

// ═══════ Build ═══════
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: FONT, size: 22, color: "333333" } },
    },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: FONT, color: "1A1759" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0, keepNext: false, keepLines: false } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: FONT, color: "4B3FE3" },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1, keepNext: false, keepLines: false } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "Prospector AI 创新大赛答辩稿", font: FONT, size: 18, color: "A1A1AA" })],
      })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "第 ", font: FONT, size: 18, color: "A1A1AA" }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: "A1A1AA" }),
          new TextRun({ text: " 页", font: FONT, size: 18, color: "A1A1AA" }),
        ],
      })] }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("e:\\Agents Basement\\projects\\NEW\\docs\\答辩稿.docx", buffer);
  console.log("docx written: docs/答辩稿.docx");
});
