# Agent P2 设计规范（产物卡 / 排队输入 / 后台长任务）

> 本文件是 P2 三件套的契约。代码实现必须与本文一致；改实现前先改这里。

## 0. 通用约定（沿用现有红线，不重复发明）

- 分层：service 层不 import electron；`agent.ipc.ts`（transport）调用 service；`shell` 调用例外地放在 transport。
- 事件：全部走 `src/main/events.ts` 的 `EVENTS` 常量；preload 白名单由 `EVENTS` + `contract` 自动推导，**不改 preload**。
- 工具入参：宽进严出 —— 条数/长度在代码里钳制，状态/枚举词做同义词归一，不用 `.max()`/`.enum()` 硬拒（zod 拒绝早于预算守卫，模型会当成接口故障重试到 max turns）。
- 工具调用必审计（`audit()` 落 `agent_tool_calls`）；幂等用 `lookupIdempotent/rememberResult`。
- **红线：AI 永不触发群发开始；后台任务只读（外部搜索 + 本地生成文本 + 落盘产物），不含任何入队/发送动作。**
- UI 文案：简洁，无括号注解、无角标；过程=灰字细行，产物=独立卡片；新卡复用既有圆角白卡样式（`border-gray-200 rounded-lg bg-white`）。

## 1. 产物卡（export_artifact）

### 后端
- `artifact.service.ts`（新）：落盘目录 `<APP_ROOT>/outputs/agent/`；
  - `slugify(title)`：保留中英文/数字/连字符，钳 40 字；
  - `writeArtifact(title, format, content) → Result<ArtifactMeta>`：自动 mkdir，同名 `-2/-3` 递增；
  - `ArtifactMeta = { name, path, sizeBytes, format: "md" | "csv" }`；
  - `isInsideArtifactDir(path)`：打开前校验，拒绝目录外路径。
- 工具 `export_artifact`（policy：`read` / 免审批 / 预算 2）：
  - 入参 `{ title, format?(md|csv，其它值归一 md), content?(md 正文), rows?(csv 二维数组) }`；
  - 钳制：title≤40 字、content≤64KB、rows≤500 行 × 20 列、单元格≤200 字；
  - csv 由 rows 生成（首行表头，字段含逗号/引号/换行按 RFC4180 加引号）；
  - 幂等键 = `conversationId + title + format + content/rows 的 md5`；
  - 返回 JSON：`{ artifact: ArtifactMeta }`（按钮由前端卡片自带，不走 actions）。
- IPC：`agent:openPath` `{ path }` → `isInsideArtifactDir` 校验 → `shell.showItemInFolder`。

### 前端
- `parseResult` 识别 `o.artifact`（含 `path` 字符串）→ `ArtifactDto`；`chipHasArtifact` 将其判为产物（不折叠）。
- 新组件 `FileCard`：文件名 + 格式徽标 + 大小（KB）+ 两按钮「打开位置」（invoke `agent:openPath`）、「复制路径」（clipboard，成功变「已复制」1.6s）。
- `TOOL_LABELS` 增 `export_artifact: "导出文件"`。
- `resultBrief` 增 artifact 分支：`已生成 <文件名>`。

## 2. 排队输入（纯前端）

- 单槽队列：运行中再提交 → 覆盖式排队 1 条（不做多条），输入框上方显示可取消的「已排队 · 截断 24 字」标签。
- 触发通道：Sender 保留 `loading={sending}`（停止键不丢）；用 `onKeyDown` 在 `sending && Enter && !shift` 时 `preventDefault` 并入队（Sender 的提交按钮在 loading 下不可点，键盘是唯一入口，符合预期）。
- 斜杠命令不参与排队：运行中输 `/` 提示「等这轮答完再用命令」。
- 自动发送：`agent:done` 且队列非空 → 清空队列后 `setTimeout 120ms` 经 `sendRef` 发出（等 `sending` 落定）。
- 清空时机：`agent:error`、手动停止、切换会话 —— 三处都清。
- 审批等待不触发自动发送（续跑的 done 会自然到达，队列保持等待即可——但 error/stop 语义下仍清）。

## 3. 后台长任务（start_batch_task + bg-task.service）

### 数据契约
- `BgTask`：`{ id, conversationId, kind: "backcheck" | "draft", title, items: BgTaskItem[], state: "running" | "done" | "failed" | "cancelled", artifact?: ArtifactMeta, startedAt, finishedAt? }`；
  `BgTaskItem = { label, state: "pending" | "running" | "done" | "failed", note? }`。
- 事件 `EVENTS.AGENT_TASK = "agent:task"`，payload `{ conversationId, taskId, task: 快照 }`，每步全量推送。
- IPC（contract AGENT 组）：
  - `agent:getTask` `{ taskId }` → 快照（不存在返回失败）；
  - `agent:cancelTask` `{ taskId }` → 置取消标志（当前项做完即停）。
- 纯内存注册表：重启后任务失效；前端取不到快照时卡片显示「已中断（应用重启）」。

### 服务行为（`bg-task.service.ts`）
- `normalizeBatchItems(raw)`（导出纯函数，可单测）：丢弃无名条目，name≤40 字，country≤20 字，整体钳 10 家。
- `startTask(push, {conversationId, kind, companies})`：
  - kind 归一（`draft/开发信/写信` → draft，其余 → backcheck）；
  - 空列表返回失败；`title` 按 kind 生成（「批量背调 N 家公司」/「批量开发信草稿 N 家」）。
  - 串行循环：项间 `delay 2s`；每步前后推送快照；单项失败不中断整批（标 failed + note）。
  - backcheck = `searchCompany` → `generateBackcheckReport`（复用 ai.service，与 company_backcheck 同源）；无搜索命中记 failed。
  - draft = `generateEmailDraft({language:"EN", companyName, contactName:""})`。
  - 收尾：≥1 项成功 → 汇总 md 落盘 `outputs/agent`（挂 `task.artifact`）；全部失败 → `state=failed` 无产物；取消 → `cancelled`。
- 红线：本服务不引用 send.service；不写任何业务表。

### 工具
- `start_batch_task`（policy：`read` / 免审批 / 预算 1）：入参 `{ kind?, companies: [{name, country?}] }`；
  经 `ToolCtx.push`（types.ts 的 ToolCtx 增加可选 `push` 字段，harness 注入）调 `startTask`；
  返回 `{ task: {taskId, title, total}, notice }`，提示模型「后台任务已启动，界面有进度卡，可继续回答其它问题」。

### 前端
- `Msg.task?: { taskId: string }`；`parseResult` 识别 `o.task?.taskId` → 判为产物不折叠。
- 新组件 `TaskCard({ taskId })`：
  - 挂载先 `agent:getTask` 取快照，再订阅 `agent:task`（仅处理同 taskId 的推送）；
  - 渲染：标题、`done/total`、逐项状态图标（同 PlanCard 三态 + failed 红叉）、失败项显示 note；
  - running 时右侧「取消」按钮（invoke `agent:cancelTask`）；
  - 终态且有 `artifact` → 「打开位置」按钮；取不到快照 → 灰字「已中断（应用重启）」。
- `TOOL_LABELS` 增 `start_batch_task: "启动后台任务"`。

## 4. 提示词（harness AGENT_INSTRUCTIONS 增量）

- 工具清单行补：`export_artifact`（导出文件）、`start_batch_task`（批量后台任务）。
- 用法约束：
  - 用户说「导出/生成文件/整理成表」→ `export_artifact` 落盘，全文不进对话正文；
  - ≥3 家公司的「都背调一遍/各写一封」→ `start_batch_task`，告知进度卡可见、不阻塞对话；单家公司仍走 `company_backcheck` / `generate_draft`。

## 5. 测试与验收

- 单测新增：`normalizeBatchItems`（钳制/归一/脏输入）、`slugify` + csv 引号转义、policy 新条目（两工具 read/免审批；`canAutoApprove` 对它们为 false）。
- 全量：`npm run typecheck` + `npm test` + `npm run build` 三绿。
- 手测清单：
  1. 「把未读邮件总结导出成表」→ 出现文件卡，打开位置可弹窗；
  2. 运行中敲下一句回车 → 出现「已排队」标签，答完自动发出；停止则清空；
  3. 「给这三家公司都做背调」→ 出任务卡逐项点亮，中途可取消，完成后有汇总文件卡。
