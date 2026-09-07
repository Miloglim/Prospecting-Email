# Agent 架构改造规范（Arch Refactor Spec）

> 上游：架构审查报告（会话内交付，13 项问题）。本规范是落地依据：现状 → 目标 → 核心代码改动 → 验收。
> 执行约定：严格按本规范实现；实现与规范冲突时，先改规范再改代码。

## 0. 目标与红线

**目标**：把「工具清单四处维护、解析正则散落、结果形状不一、异常靠文本正则识别」的补丁面收敛掉，并为记忆/反思/规划补齐承载结构。分四期，期期可独立验收、可独立回滚。

**红线（任何一期都不得突破）**：
1. 写工具人工审批链路不动；`needsApproval` 只能加严不能豁免。原 `autoApprovable`（会话级豁免）
   已于 2026-09-07 连根删除——所有 write 工具每次确认，闸门统一由注册表在
   `buildHarnessTools` 返回处派生（细则见 `agent-control-plane-spec.md` 红线 1、2）。
2. 不新增任何"发送/触发群发"能力；后台任务服务维持只读红线。
3. 重构必须**减少**重复名单，禁止引入第五份工具清单。
4. 模型可见的工具返回契约（notice/say/complete 等字段名）只能增补、不得改名，弱模型对措辞敏感。

## 1. 分期与推荐批次

| 项 | 内容 | 触碰面 | 模型契约 | 建议 |
|---|---|---|---|---|
| 0a | 过程卡失败态 | 渲染端 + harness 事件 | 无 | 首批 |
| 0b | 回合输出 token 上限 | harness fetch 注入 | 无 | 首批 |
| 1A | 工具注册表（单一事实源） | tools/policy/harness/renderer | 无 | 首批 |
| 1B | Parser 抽取 | tools + 新文件 | 无 | 首批 |
| 1C | 统一结果包络 | 全部 17 工具 + resultBrief | 有（增补式） | 二批 |
| 2 | 记忆接口 + agent_facts | agent.service + 新表 | 有（历史注入变多） | 二批后评估 |
| 3 | 回合管线 + AgentProfile + Planner | agent.service/harness | 小 | 三批 |

**首批 = 0a + 0b + 1A + 1B**：纯收敛、不改模型契约、各自有单测锚点。二批起另行放行。

---

## 2. 首批改动

### 2.1【0a】过程卡失败态：失败的调用不再显示"已XX"+绿勾

**现状**：SDK 把参数校验/执行失败的错误文本当作 `tool_output` 回给模型，harness 原样推 `status:"done"`（`harness.ts:544-555`），渲染端一律画绿勾"已{动词}"（`AssistantPage.tsx:630-644`）——于是出现"已导出文件"下面跟着 `InvalidToolInputError` 的自相矛盾。

**目标**：失败的过程卡 = 红/灰叉 + "{动词}失败"，展开可见错误摘要。实时流与历史回放（审计回放）两条路都要覆盖。

**核心改动**：

1) `harness.ts` 推 `tool_output` 事件时带上失败标记（复用 `noteToolOutcome` 同款判定）：

```ts
// harness.ts streamRun / collectRunResult 两处 tool_output 分支
import { isToolRuntimeError } from "./tools";
o.push(EVENTS.AGENT_TOOL_CALL, {
  conversationId: o.conversationId, tool: name, callId: ri.callId, status: "done",
  result: out.slice(0, RESULT_CAP),
  failed: isToolRuntimeError(out),   // 新增
});
```

2) `useAgentTranscript.ts`：`Msg.chip` 增 `failed?: boolean`；`onToolCall` done 分支透传 `d.failed`；`mapHistory` 回放时按审计行的 `error` 列判定：

```ts
chip: {
  kind: "done", tool: m.toolName,
  args: fmtChipArgs(m.argsJson), brief: resultBrief(m.resultJson), detail: m.resultJson,
  failed: !!m.error,   // 审计行带 error = 这次没办成
}
```

（`getMessages` 的 tool 行需回带 `error` 列：`MessageDto` 加 `error?`，`agent.service.ts:385-391` 的 merged 组装处带上。）

3) `AssistantPage.tsx` chainItems 的 done 分支：

```tsx
const failed = !!c.failed;
return {
  key: m.key,
  icon: failed
    ? <CloseCircleOutlined style={{ fontSize: 10, color: "#ff4d4f" }} />
    : <CheckCircleOutlined style={{ fontSize: 10, color: "#52c41a" }} />,
  title: <span className="text-[12px] text-gray-500">
    {failed ? `${toolLabel(c.tool)}失败` : `已${toolLabel(c.tool)}`}
  </span>,
  // description/footer 不变
  status: failed ? "error" : "success",
};
```

**验收**：新单测覆盖 `mapHistory` 对带 error 审计行的 `failed` 判定；手工验证：构造一次 `InvalidToolInputError`（或临时在只读工具里 throw）→ 卡片显示"{动词}失败"红叉，历史回放一致。

### 2.2【0b】回合输出 token 上限：工具参数 JSON 不再被截断

**现状**：实测 `export_artifact` 大正文把工具参数 JSON 撑到端点输出上限被截断 → `Invalid JSON input for tool`，同参重试到熔断都拦不住（该校验发生在 execute 之前，`gate()` 够不着）。harness 未设置任何输出上限，全看端点默认值。

**目标**：给每个请求显式注入足够大的输出上限，从根上消掉"参数被截断"这类故障。

**核心改动**：`harness.ts` `makeClient` 的 fetch 包装里（现在注入 `thinkingExtras` 的同一位置）：

```ts
const MAX_OUT = Number(process.env.AGENT_MAX_OUTPUT_TOKENS || 16384);
Object.assign(body, extras);
// 按端点族选字段名，端点已自带则不覆盖
const capKey = endpointFamily(baseUrl) === "google" ? "max_completion_tokens" : "max_tokens";
if (body.max_tokens == null && body.max_completion_tokens == null) body[capKey] = MAX_OUT;
```

**风险与备注**：个别网关对未知字段报 400——按 `endpointFamily` 分流已覆盖已知族（google/openai 风格用 `max_completion_tokens`，vLLM/compat 用 `max_tokens`）；若 agnes 拒绝 `max_tokens`，把 agnes 并入 `max_completion_tokens` 分支。上线后观察一轮真实对话的 usage，确认输出不再贴着上限跑。

**验收**：`AGENT_DEBUG_BODY=1` 跑一次含工具调用的对话，`last-request.json` 里能看到 cap 字段；构造一次大导出（长 markdown 走 export_artifact）不再复现 `Invalid JSON input for tool`。

### 2.3【1A】工具注册表：一份元数据，派生四处清单

**现状**：同一个工具的元数据分散在四处手工对齐——
- `policy.ts:18-43` `TOOL_SPECS`（副作用/审批/预算）
- `harness.ts:27-109` `AGENT_INSTRUCTIONS` 内逐条罗列工具与路由
- `AssistantPage.tsx:27-45` `TOOL_LABELS`（UI 中文名）
- `useAgentTranscript.ts:145-158` `FOLLOW_UPS`（追问引导）

**目标**：新增唯一事实源 `manifest.ts`，四处全部派生；新增工具只改一处。

**核心改动**：

1) 新文件 `src/main/services/agent/manifest.ts`：

```ts
import type { ToolSpec } from "./policy";

export interface ToolMeta {
  name: string;
  /** UI 中文名（原 TOOL_LABELS） */
  label: string;
  /** 一句话"何时用我"，拼进系统提示词（原 AGENT_INSTRUCTIONS 里的工具罗列） */
  route: string;
  /** 追问引导（原 FOLLOW_UPS，可省） */
  followUps?: string[];
  spec: ToolSpec;
}

/** 唯一工具清单：预算/审批/标签/路由/引导全部从此派生，禁止在别处再维护一份 */
export const TOOL_MANIFEST: ToolMeta[] = [
  { name: "search_contacts", label: "检索联系人", route: "…", followUps: [...], spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 5 } },
  // …17 条，数值从现有 TOOL_SPECS/TOOL_LABELS/FOLLOW_UPS/AGENT_INSTRUCTIONS 逐条搬运，不得改写语义
];

export const toolMeta = (name: string): ToolMeta | undefined =>
  TOOL_MANIFEST.find(m => m.name === name);
```

2) `policy.ts`：删除 `TOOL_SPECS` 字面量，改为派生：

```ts
import { TOOL_MANIFEST } from "./manifest";
export const TOOL_SPECS: Record<string, ToolSpec> =
  Object.fromEntries(TOOL_MANIFEST.map(m => [m.name, m.spec]));
```

3) `harness.ts`：`AGENT_INSTRUCTIONS` 中**仅**删除"你已接入本地数据工具：·…"那段逐条罗列（约 :31-42），替换为派生：

```ts
const toolList = TOOL_MANIFEST.map(m => `· ${m.name}：${m.route}`).join("\n");
// instructions = 前缀规则 + "你已接入本地数据工具：\n" + toolList + 其余跨工具纪律
```

**注意**：跨工具的路由纪律（台账价 vs 市场价、未读意图路由、数字硬校验等）不属于单工具 route，保留原文不动。

4) `tools.ts` `buildHarnessTools`：写工具的 `needsApproval: true`（:568/:1251/:1354）改为从 manifest 派生，消掉硬编码：

```ts
needsApproval: toolMeta("record_followup")!.spec.requiresApproval, // 三处
```

5) 渲染端两份名单改由 IPC 取：`contract.ts` agent 组加 `agent:toolMeta`（preload 白名单随组自动生成）；`agent.ipc.ts` 返回 `{ labels: Record<string,string>, followUps: Record<string,string[]> }`；`AssistantPage.tsx` 的 `TOOL_LABELS` 与 `useAgentTranscript.ts` 的 `FOLLOW_UPS` 改为模块级缓存的异步加载，未就绪时回退 `name` 本身（与现有 `toolLabel` 的兜底一致）。

**验收**：
- 新单测 `tests/unit/agent-manifest.test.ts`：① manifest 与 `buildHarnessTools` 返回的工具名集合一致；② 所有 `sideEffect:"write"` 项 `requiresApproval===true`；③ `send_queue_add`/`import_contacts` 的 `autoApprovable===false`；④ label 无重复。
- 现有 `agent-policy.test.ts` 全绿。
- 全仓 grep：`TOOL_SPECS` 字面量、`TOOL_LABELS` 字面量、`FOLLOW_UPS` 字面量各只剩零处（派生处除外）。

### 2.4【1B】Parser 抽取：SUBJECT 拆分只写一遍

**现状**：`/^SUBJECT:\s*(.+)\s*$/im` + 切正文这套解析在 `tools.ts:543`（search_contacts 批量动作）、`:1056`（generate_draft）、`:1191`（reminders_due 批量动作）复制了三份；渲染端 `TemplateList.tsx:369` 还有一个变体。

**目标**：主进程三处收敛为一个纯函数；渲染端变体记录在案（跨 bundle 不强行共享，见备注）。

**核心改动**：新文件 `src/main/services/agent/parser.ts`：

```ts
/** 草稿输出约定：SUBJECT: 行 + 正文。解析失败给安全兜底，不抛错。 */
export function parseDraft(raw: string, fallbackSubject: string): { subject: string; body: string } {
  const text = String(raw ?? "").trim();
  const m = /^SUBJECT:\s*(.+)\s*$/im.exec(text);
  const subject = (m?.[1] ?? fallbackSubject).trim().slice(0, 150);
  const body = (m ? text.slice(m.index + m[0].length) : text).replace(/^\s+/, "").trim();
  return { subject, body };
}
```

三处调用点改为 `const { subject, body } = parseDraft(raw, \`Following up — ${companyName || name}\`);`，各自的兜底主题文案保持原样传入。

**备注**：`TemplateList.tsx:369` 在渲染端、与主进程不共享 bundle，本期不动，只在该函数旁加注释"与 agent/parser.ts parseDraft 同源，改动需同步"。

**验收**：新单测 `tests/unit/agent-parser.test.ts`：有 SUBJECT 行 / 无 SUBJECT 行 / 只有 SUBJECT / 空串四种输入；现有 `agent-p2.test.ts` 等涉及草稿的用例全绿。

---

## 3. 二批改动（另行放行）

### 3.1【1C】统一结果包络

**现状**：读工具返回 `{total,…,notice}` JSON，写工具成功返回裸中文字符串，失败有的返回 `{error,notice}`、有的返回 `"失败：…"`；`isToolRuntimeError` 靠文本正则识别失败（`tools.ts:80-82`）。

**目标**：所有工具一律返回统一包络的 JSON 字符串：

```ts
{
  ok: boolean,
  // 成功：原有业务字段原样平铺（total/quotes/messages/subject/body…），不改名
  say?: string, notice?: string, complete?: boolean, actions?: AnyAction[],
  // 失败：
  error?: { code: string, message: string },   // code 如 "not_found" | "ambiguous" | "budget_exhausted"
}
```

要点：
- 成功路径 = 现有 JSON 上加 `ok:true`（增补，不破坏模型已认识的字段）。
- 所有裸字符串返回（`"失败：…"`、`"已为…记录跟进。"`、`"导出失败：…"` 等）改包络；给人看的文案进 `notice`/`say`。
- `isToolRuntimeError` 增补结构化判定：先尝试 `JSON.parse` 后查 `ok===false`，正则仅作 SDK 层兜底。
- 渲染端 `resultBrief` 按包络取数；熔断计数改吃 `ok===false`，不再依赖措辞。

**验收**：每个工具至少一条"失败分支返回包络"的单测；`agent-tools-inbox.test.ts`、`agent-args.test.ts` 全绿；prompt 中引用的字段名（notice/say/complete）未改名。

### 3.2【2】记忆接口 + agent_facts

**现状**：`loadHistory/appendMessage/summarizeEarlier` 是 `agent.service.ts` 私有函数；工具结果从不进入后续回合的记忆（下一轮模型看不到上一轮查过什么，只能重查）；无跨会话记忆；运行态散落为 6+ 个模块级 Map。

**目标**：
1. 新 `src/main/services/agent/memory.ts`：`loadConversation(convId)`（接管现有三级加载）、`rememberToolFacts(convId, facts)`、`recallFacts(convId)`。
2. 新表 `agent_facts(id, conversation_id, tool_name, fact, created_at)`（`db/schema/agent.ts` + `db/index.ts` 迁移）：`audit()` 落库时从结果里抽一行事实（`say` 或 `total` 摘要，≤120 字）写入。
3. `loadConversation` 把本会话最近若干条 facts 以"【系统注入·此前工具查询结果摘要】"注入历史，减少重复检索。
4. 运行态 Map 不强行合并（它们是纯运行态缓存），但在各自文件头注释明确"运行态缓存，非记忆"，记忆读写只走 memory.ts。

**验收**：二次提问"另外两个客户的沟通记录"类场景不再全量重查（人工验证 + facts 表有数据）；历史注入后 30 条窗口语义不变。

### 3.3【反思最小版】数字回溯校验

`reflector.ts`：回合收尾时抽取最终文本中的数字，与本回合各工具结果（audit 已留痕）做回溯；回溯不过 → 追加一轮"更正指令"让模型自纠（最多一次），仍不过则在文末附"部分数字未取到工具依据"。复用 `research.service.ts` 的 `unverifiableNumbers` 纯函数。先做规则版，不引入额外 LLM 调用。

## 4. 三批改动（视前两批结果再议）

- **回合管线**：`chat()` 拆为 `loadMemory → runTurn → reflect → persist → emit` 五步独立函数。
- **AgentProfile**：`{ name, instructions, toolNames, maxTurns }`，`runHarnessTurn(profile, options)`，现助手为默认 profile。
- **Planner**：`update_plan` 升级为结构化步骤（id/依赖/状态），harness 按工具结果回写状态；调研/批量已有的"代码化管线"保留为受控子规划。

## 5. 复核清单（终审 MAX 对账用）

1. 全仓不存在第二份工具清单（grep `TOOL_SPECS`/`TOOL_LABELS`/`FOLLOW_UPS` 字面量）。
2. `needsApproval` 只从 manifest 派生，源码无硬编码 `needsApproval: true`。
3. 失败工具卡实时流与历史回放均显示失败态；绿勾只给真成功。
4. 请求体携带输出上限字段；大导出不复现 `Invalid JSON input for tool`。
5. `SUBJECT` 正则在主进程只存在于 `parser.ts`。
6. 红线：写工具审批链路、`autoApprovable:false` 两项、"发送"能力缺失性，与改造前一致。
7. `npm run typecheck`、`npm test`（25 文件基线 + 新增）、`npm run build` 全绿；未引入 lint 豁免。
8. 未产生新的"文本正则识别结构化状态"逻辑（只减不增）。

---

## 6. 落地记录（2026-09-04 全部实施完毕）

### 新增/修改文件
- 新增：`agent/manifest.ts`（注册表）、`agent/parser.ts`、`agent/memory.ts`、`agent/reflector.ts`、`renderer/lib/tool-meta.ts`
- 修改：`agent/harness.ts`、`agent/tools.ts`、`agent/policy.ts`、`agent/idempotency.ts`、`agent.service.ts`、`contract.ts`、`transport/agent.ipc.ts`、`db/index.ts`、`db/schema/agent.ts`、`AssistantPage.tsx`、`useAgentTranscript.ts`、`SettingsPage.tsx`
- 新增测试：`agent-manifest.test.ts`、`agent-parser.test.ts`、`agent-memory.test.ts`、`agent-reflector.test.ts`
- 终验：typecheck 净、29 文件 272 用例全绿、build 通过。

### 与原规范的偏差（先改规范再改代码，记录在此）
1. **§3.3 反思的实现方式**：规范写"追加一轮带更正指令的完整回合"。实际落地为**轻任务端点的定向自纠**（把对不上的数量 + 本轮已采集的工具证据交给轻任务小请求，只许改数字不许重写）。理由：完整重跑会重新流式一遍、可能再触发写工具审批，成本与风险都高；证据已经在手里，定向校对更准更省。纠后仍过一次回溯校验，不过则文末附注。
2. **§4 Planner 的"代码回写步骤状态"未实现**：`normalizePlan` 已给每步稳定 `id`（文本哈希），但步骤状态仍由模型全量重发为准。理由：代码按工具结果猜步骤归属容易错配，模型本来就是清单的权威来源；稳定 id 已足够渲染端做跨快照识别。
3. **§3.1 包络与流控的边界**：`gate` 的预算/熔断返回（`budget_exhausted`/`tool_suspended`）**不进包络**——它们是流控不是失败，不带 `ok` 字段，`isEnvelopeFailure` 天然不命中，避免把流控当失败喂熔断。
4. **失败判定的双通道分工**（§2.2 的延伸）：`isToolRuntimeError` 只管 SDK 层文本错误（execute 之前），`isEnvelopeFailure` 只管我们包络的 `ok:false`（execute 之内）。两者集合不相交，熔断不会双重计数。
5. **渲染端保留两处非清单的回退**：`DEFAULT_FOLLOW_UPS`（注册表未就绪时的默认引导，两句通用语，不是工具清单）与 `reasoning` 伪通道的"思考"特判（思考不是工具，不进注册表）。
6. **复查时多抓出一份清单**：设置页审计卡还藏着第三份工具名映射 `AUDIT_TOOL_LABELS`，已一并改为注册表缓存取（规范 §2.3 当时只点了两份）。
7. **测试阶段再抓一份漂移**（2026-09-04 实测）：评测沙箱（`tests/eval`）手抄了一份建表 DDL，落后生产迁移（缺 `inbox_messages.to` 列），导致 live 评测 27 卡全灭。修法同「单一事实源」原则：建表 SQL 抽成 `db/schema-sql.ts` 的 `BASE_SCHEMA_SQL`，生产 `runMigrations` 与评测沙箱共用；评测卡集同步升级支持多轮对话（记忆注入验证）与失败标记采集（失败卡链路验证）。
8. **流控返回改入失败包络**（修订偏差 3）：live 评测实锤 budget/熔断提示不带 `ok:false` 时，harness 失败计数被清零、熔断第二道闸对重试风暴失效（`export_artifact`/`start_batch_task` 各 10 连击）。现在 `budget_exhausted`/`tool_suspended` 一律 `failOut`，模型无视引导继续调会在 2 次内被熔断掐断。失败卡 UI 会如实显示——这是特性：流控触发本身就该被看见。
9. **csv 导出协议简化**（arch-export 实测根因）：弱模型手拼嵌套 JSON 数组（rows 二维表）极易把**参数 JSON 本身**写坏（`Invalid JSON input for tool`，发生在 SDK 内部 JSON.parse，schema 宽松化/提示词/熔断全救不了，实测同参重试 10+ 次）。修法不是修模型是改协议：`export_artifact` 参数收敛为 `title/format/content` 三个扁平字符串，csv 一律在 content 里写多行 TSV 文本，解析交给 `parser.parseTsv`（容错全角空格、空行）。配套系统提示词新增"Invalid JSON → 换更简单参数结构，禁止原样重试"。修复后该卡 30s 一步通过、零重试。

### 复核清单核对结果
1 ✅ 全仓无第二份工具清单（grep 验证，含设置页第三份）。
2 ✅ `needsApproval` 全部从 `toolMeta(...).spec.requiresApproval` 派生，源码无硬编码。
3 ✅ 失败工具卡实时流（`failed` 标记）与历史回放（审计 `error` 列）口径一致。
4 ✅ 请求体按端点族注入 `max_tokens`/`max_completion_tokens`（`AGENT_MAX_OUTPUT_TOKENS` 可调，默认 16384）。
5 ✅ 主进程 `SUBJECT` 正则只剩 `parser.ts` 一处（渲染端 TemplateList 变体已注释同源提示）。
6 ✅ 写审批链路、两项 `autoApprovable:false`、无发送能力——改造前后一致。
7 ✅ typecheck / 272 用例 / build 全绿，无 lint 豁免。
8 ✅ 结构化状态判定只减不增（包络 `ok` 替代部分文本正则场景；SDK 文本正则保留为唯一兜底）。
