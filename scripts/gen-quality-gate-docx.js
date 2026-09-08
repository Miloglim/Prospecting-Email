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

function quote(text) {
  return new Paragraph({
    spacing: { after: 120, before: 60 },
    indent: { left: 360 },
    children: [new TextRun({ text, font: FONT, size: 20, italics: true, color: "71717A" })],
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
  children: [new TextRun({ text: "Prospector 质量保障体系", font: FONT, size: 36, bold: true, color: "1A1759" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({ text: "代码审查与质量门禁  |  AI 创新大赛答辩材料  |  2026-09-08", font: FONT, size: 20, color: "71717A" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 400 },
  children: [new TextRun({ text: "机器审判为主 · 人类守三个高危区", font: FONT, size: 20, bold: true, color: "4B3FE3" })],
}));

// ═══════ 一、审查模式 ═══════
children.push(h1("一、审查模式：机器审判为主，人类守关键边界"));
children.push(p("单人 + AI 协作的项目没有传统 peer review，审查体系的设计目标很明确：把\"资深工程师的审查直觉\"固化成机器可执行的规则。"));

children.push(h2("三层结构替代传统 Review"));
children.push(makeTable(
  ["审查层", "执行者", "审查内容"],
  [
    ["机器审查", "check.ts + tsc + ESLint", "架构边界、类型、风格 — 客观规则全自动"],
    ["结构锁测试", "Vitest 52 个测试文件", "关键安全机制的真实行为，不是元数据"],
    ["人类终审", "开发者", "只审三个高危区：DB schema、IPC 通道、新增 npm 依赖"],
  ],
  [1800, 2800, 4760],
));

children.push(new Paragraph({ spacing: { before: 160 }, children: [] }));
children.push(p("AI 协作边界由 CLAUDE.md 约束：AI 可自主修 TS 错误、补测试、调 UI；但动 schema、IPC 通道、新增依赖必须先问人。八个禁止模式（transport 碰 DB、service import electron 等）全部来自真实事故沉淀。"));

// ═══════ 二、五道门禁 ═══════
children.push(h1("二、五道门禁，任何一道不过即阻断"));

children.push(h2("门 1 · 架构边界扫描（自写，最独特）"));
children.push(p("scripts/check.ts 扫描全部源码，机器判定分层违规，违规直接 exit(1)："));
children.push(bullet("transport 层不得 import db"));
children.push(bullet("service 层不得 import electron"));
children.push(bullet("ipcMain.handle 只能出现在 transport"));
children.push(bullet("IPC 通道名必须 domain:action 格式"));
children.push(bullet("service 层不得残留 throw，必须返回 Result<T>"));
children.push(p("分层架构不是靠口头约定，是靠编译门禁。", { bold: true, color: "1A1759" }));

children.push(h2("门 2 · 类型检查"));
children.push(p("tsc --noEmit，TypeScript 5.6 严格模式 + noUncheckedIndexedAccess，零类型逃逸。"));

children.push(h2("门 3 · ESLint"));
children.push(p("风格一致性、未用变量、禁 console.log 残留。"));

children.push(h2("门 4 · 单元 + 集成测试"));
children.push(p("52 个单元测试文件 + 集成测试，覆盖策略派生、审批闸门、反射器、记忆加载、运价归一化、发信分配、退信匹配等核心逻辑，加 send-pipeline.test.ts 发信全链路集成测试。"));

children.push(h2("门 5 · CI 服务器复验"));
children.push(p("GitHub Actions 在 push/PR 时 ubuntu 上重跑 typecheck + 全部单测。精巧细节：npm ci --ignore-scripts 跳过 electron 原生编译——单测走 lazy require 不加载原生绑定，CI 秒级完成，无需下载 200MB electron 二进制。"));
children.push(codeLine("name: CI"));
children.push(codeLine("on: [push, pull_request]"));
children.push(codeLine("steps:"));
children.push(codeLine("  - run: npm ci --ignore-scripts"));
children.push(codeLine("  - run: npm run typecheck"));
children.push(codeLine("  - run: npm test"));
children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

children.push(p("旁路：eval:agent 行为评估（发布前连真实 LLM 端点），活体评测 Agent 真实行为——fu-* 卡验证写工具不静默执行、反射器数字溯源。", { bold: true, color: "4B3FE3" }));

// ═══════ 三、结构锁测试哲学 ═══════
children.push(h1("三、结构锁测试哲学：锁真实行为，不锁元数据"));
children.push(p("agent-approval-gate.test.ts 是整个测试体系的代表作。它体现的审查哲学：测试不是验证代码写了什么，而是验证运行时真实发生了什么。"));

children.push(h2("两次真实事故（测试文件头部注释记录）"));
children.push(bulletBold("事故一：元数据与行为脱节", "export_artifact 在注册表标成 write/需审批，但工具定义忘了接 needsApproval——SDK 判定不需要审批，文件静默落盘，用户没看到任何审批卡片"));
children.push(bulletBold("事故二：测试全绿的静默失效", "旧测试只断言注册表元数据（是否标 write），元数据确实标了，测试照样全绿——安全机制静默消失却测不出来"));

children.push(h2("四条断言（按 SDK 运行时方式真实调用 needsApproval）"));
children.push(makeTable(
  ["#", "断言", "拦截什么"],
  [
    ["1", "工具集合与注册表名单完全一致", "漏登记 = 漏审批，闸门射程外不放行"],
    ["2", "每个 write 工具的 needsApproval 被真实调用后返回 true 且是函数", "元数据/行为脱节（事故一复发时当场变红）"],
    ["3", "读工具运行时解析不得为 true", "审批过度扩散"],
    ["4", "点名回归：export_artifact 与 start_batch_task 必须先问", "历史事故永久性回归锁"],
  ],
  [600, 4200, 4560],
));

// ═══════ 四、事故案例深挖 ═══════
children.push(h1("四、事故案例深挖：export_artifact 静默落盘事故"));

children.push(h2("事故本质：两份记录不同步"));
children.push(p("系统里关于\"export_artifact 要不要审批\"存在两份记录："));
children.push(bulletBold("声明层（元数据）", "manifest.ts 注册表 spec.sideEffect=\"write\" — 纸面声明，当时是正确的"));
children.push(bulletBold("行为层（运行时）", "SDK 真正检查的是工具对象上的 needsApproval 属性 — SDK 不看注册表，只认这个标志"));
children.push(p("事故时注册表改了，工具对象没接线：SDK 检查 needsApproval 得到 undefined → 判定\"不需要\" → 直接执行 → 文件落盘。全程无报错、无异常、无告警——安全机制静默消失。"));

children.push(h2("三层修复"));
children.push(makeTable(
  ["层级", "措施", "位置"],
  [
    ["根因修复", "统一闸门：所有工具构建完后统一扫描，注册表标 write 的强制注入 needsApproval（闸门只加严不放宽）", "tools.ts buildHarnessTools 返回处"],
    ["结构锁测试", "按 SDK 运行时调用方式真实调用 needsApproval 并断言解析值 + 点名回归", "agent-approval-gate.test.ts"],
    ["执行时兜底", "预算门 + 幂等去重（5 分钟）+ agent_tool_calls 审计留痕", "gate / lookupIdempotent / audit"],
  ],
  [1400, 5000, 2960],
));

children.push(new Paragraph({ spacing: { before: 160 }, children: [] }));
children.push(p("修复后代码（tools.ts 第 2730-2747 行）："));
children.push(codeLine("// needsApproval 一律由注册表派生：登记为 sideEffect:\"write\" 就必须人工确认。"));
children.push(codeLine("// 各工具不再自己写一份——漏写不再是「静默执行」的成因"));
children.push(codeLine("for (const t of tools) {"));
children.push(codeLine("  if (requiresApprovalOf(name)) t.needsApproval = async () => true;"));
children.push(codeLine("}"));
children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
children.push(p("\"漏写\"这个失效模式从此在结构上不可能——不需要记得接线，闸门自动接线，且只可能加严（置真），绝不可能把任何工具置成免审批。"));

children.push(h2("现场验证：结构锁测试 4/4 通过"));
children.push(p("答辩现场实跑 npx vitest run tests/unit/agent-approval-gate.test.ts，结果："));
children.push(codeLine("Test Files  1 passed (1)"));
children.push(codeLine("Tests       4 passed (4)"));
children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
children.push(p("结果含义：当前代码里，审批闸门在运行时真实生效——不是注册表里的一句声明，而是被机器按 SDK 的调用方式验证过的事实。假如当年的脱节还在（needsApproval 为 undefined），第 2 条断言当场变红，CI 直接挂掉，文件不可能静默落盘。", { bold: true, color: "1A1759" }));

// ═══════ 五、交付清单与陷阱表 ═══════
children.push(h1("五、交付清单与已知陷阱表"));
children.push(p("CLAUDE.md 维护六项交付清单："));
children.push(bullet("check 过（架构边界扫描）"));
children.push(bullet("typecheck 过（零类型错误）"));
children.push(bullet("lint 过（风格一致）"));
children.push(bullet("单测过（52 文件全绿）"));
children.push(bullet("无 console.log 残留"));
children.push(bullet("commit 说明完整"));
children.push(p("另有一张已知陷阱表持续沉淀事故教训——每个陷阱最终变成 check 规则或测试断言。例如工具参数宽容归一化的设计来自实测记录：\"实测 flash 把 contactId 发成 '1' 后原样重试 5 次撞满 max turns\"。上线事故在下个迭代变成 eval 用例或 check 规则——审查体系随事故持续变严。"));

// ═══════ 六、总结 ═══════
children.push(h1("六、总结"));
children.push(p("审查质量不依赖人的警觉性：分层规则交给 check.ts、安全行为交给结构锁测试、回归防线交给 52 个单测和 CI，人类只保留 schema/IPC/依赖三个不可逆决策的终审权。", { bold: true, color: "1A1759" }));
children.push(p("一句话：机器审可自动化的部分，人审不可逆的部分。"));

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
        children: [new TextRun({ text: "Prospector 质量保障体系 — 答辩材料", font: FONT, size: 18, color: "A1A1AA" })],
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
  fs.writeFileSync("e:\\Agents Basement\\projects\\NEW\\docs\\质量门禁答辩.docx", buffer);
  console.log("docx written: docs/质量门禁答辩.docx");
});
