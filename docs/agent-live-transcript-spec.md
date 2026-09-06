# Agent 现场存活 + 实时思考可视化（设计规范）

> 本文件是这轮改造的契约。代码实现必须与本文一致；改实现前先改这里。
> 起因：切到别的页面再切回来，正在流式生成的聊天气泡整个不见了；用户看不到 agent 此刻在干什么。

## 0. 现场诊断（先讲清为什么会没）

1. 回合的全部现场（用户气泡、流式中的 AI 气泡、过程卡、清单、审批卡）只存在于 `AssistantPage` 的 `useState` 里。
2. 路由换页 = 该组件卸载（`router.tsx` 无 keep-alive），组件内注册的 6 个 `window.api.on("agent:*")` 监听器在 cleanup 里全部注销。
3. 主进程侧回合照常在跑（`runtime` 按会话独立、推送器 `makePush()` 在 `registerAgentIPC()` 里只建一次），但渲染层没有监听者 → 事件被丢弃。
4. AI 正文只在回合结束时才 `appendMessage` 落库（`agent.service.ts` 中 DONE 之后），所以切回来重新 `loadConversation` 从库里读，读到的必然不含在途回答 → 气泡消失，最终答案也要等再切一次才看得到。
5. 附带两处同源缺陷：
   - 事件不带 `messageId`，切回后无从续接在途气泡；
   - 旧代码不校验事件里的 `conversationId`，切到别的会话时，后台会话的 chunk 会画进前台会话的气泡（串台）；
   - 切会话一律 `agent:stop`，与「随时回来看」直接冲突。

## 1. 目标 / 非目标

**G1** 换页、切会话、深链跳转，回合照常跑；回来看到完整现场并继续逐字生长。
**G2** 进行中的一切可视化：思考逐字流、工具步骤点亮、任务清单推进、回答逐字，且离开页面时不丢。
**G3** 事件严格按 `conversationId` 归属，多会话并行不串台。
**G4** 一个字的 DB schema 都不改，`agent_messages` 的落库时机保持现状（DONE 才落正文）。

非目标：应用重启后恢复半截回合（运行态本就随进程失效）；多窗口；把推理过程落库。

## 2. 方案：把回合现场从组件里搬出来（模块级会话流水 store）

新文件 `src/renderer/hooks/useAgentTranscript.ts`：store 单例 + `useConvState(key)`（`useSyncExternalStore`）。
`src/renderer/lib/agent-route.ts`（新）：`gotoConversation(id)` 与 `CONVS_CHANGED` 从 `Sidebar.tsx` 迁到这里，Sidebar 原位 re-export，避免 store ↔ 组件环引用。

### 2.1 形状

```ts
type Key = string;                      // 真实 conversationId，或 NEW（尚未落 id 的新草稿）
interface ConvState {
  id?: string;                          // NEW 条目在首轮发送时定住
  messages: Msg[];                      // 回合现场（唯一渲染来源）
  sending: boolean;                     // per-conversation，不再是页面级
  loaded: boolean;                      // DB 历史是否已装进 messages
  loading: boolean;                     // 历史读取中（骨架屏）
  approval: ApprovalReq | null;         // 待确认写操作：切页回来还能点，不再等 150s 看门狗
  budgetAsk: boolean; queued: string | null;
  sessionUsage: { input: number; output: number } | null;
  followUps: string[]; doneActions: Record<string, string>;
  // 回合内部计数（不渲染）
  turnUser: string; turnText: string; turnTools: string[];
  flushGen: number; followGen: number;
  liveReasoning: string | null;         // 正在逐字生长的思考卡 key
}
```

`ConvState` 一律 copy-on-write 产出新引用，订阅方拿到的快照在未变更期间恒定，符合 `useSyncExternalStore` 的要求。

### 2.2 监听器只注册一次，永不注销

`ensureListening()` 在首次 `open()/send()` 时挂上 `agent:chunk|done|error|toolCall|plan|approval` 六个通道，之后组件卸载也不摘。每个事件先按 `data.conversationId` 定位条目（没有就建一条，绝不丢事件），再改那份 `ConvState`。这是 G1 的着力点：页面在不在，现场都在。

### 2.3 生命周期

- `open(key)`：有缓存 → 直接沿用（**切页回来即命中这一条**）；无缓存 → `agent:getConversation` 装历史并 `loaded=true`。不再无条件清空、不再 `agent:stop`。
- 孤儿兜底：若某条目是先收到事件才建起来的（`loaded=false`），`open` 读到 DB 历史后按「丢弃 messages 里首条 user 及其之前的部分、保留在途尾部」合并；回合已结束则整段以 DB 历史为准。
- `send(key, text, ctx)`：新草稿先定 `id=crypto.randomUUID()` 并把条目从 `NEW` 改键到真实 id（**在 invoke 之前**，事件不可能早于这一步）→ `gotoConversation(id)` → 推 user 气泡 + 流式 AI 骨架 → `invoke("agent:chat")`。
- `done` / `error`：只落 `sending=false`、给在途气泡封口（`streaming/loading=false`），**绝不清 messages**；排队输入续发、`capped` 请示卡、追问引导照旧；广播 `CONVS_CHANGED` 刷导航栏。
- `drop(id)`：会话删除时由 Sidebar 调用，清缓存条目。
- 缓存上限 20 条（LRU，运行中的条目不淘汰），防内存无界。

### 2.4 组件残留的本地态

`AssistantPage` 只留与「这一屏」有关的东西：输入框内容、上下文 chip（随 hash 的 `ctx` 派生）、写入动作确认弹窗、滚动跟随、端点状态横幅。回合现场一律从 store 取。

## 3. 实时思考可视化

### 3.1 主进程（`src/main/services/agent/harness.ts`，流式分支）

- SDK 的 chat-completions 适配器把每个原始 chunk 以 `{type:'model', event: chunk}` 透传成 `raw_model_stream_event`，但只消费 `delta.content`；`delta.reasoning`（OpenAI 方言）被它自己攒着、等整段回答结束才合成一个 reasoning item，`delta.reasoning_content`（DeepSeek / Qwen / vLLM 网关常见键）则直接丢掉 → 今天看到的是「思考突然一整块出现」，甚至完全没有。
- 实现：在该分支补读 `(data.event ?? data)?.choices?.[0]?.delta` 的 `reasoning ?? reasoning_content`，缓冲后按 **≥120ms** 或遇到边界事件（正文增量 / 工具调用 / 回合结束）合并推送：
  `EVENTS.AGENT_TOOL_CALL { conversationId, tool:"reasoning", status:"reasoning_delta", delta }`
  复用既有通道，不动 `events.ts` 与 preload 白名单。
- 既有的 `status:"reasoning"`（整块，来自 `reasoning_item_created`）保留，用作「封口」：把该思考卡定稿、`liveReasoning` 归零。
- **实测（生效端点 `api.agnes-ai.cn/v1` · `agnes-2.5-flash`，`enable_thinking:true`）**：推理确实逐字回，`delta.reasoning_content` 151 片 / 234 字，首片 +2.7s，正文首片 +3.8s → 上面的增量通道在这台端点上是真能动的，不是纸面设计。
- 但「看不到思考」的真正原因在配置层：`AGENT_THINKING` 未开 → 请求带 `enable_thinking:false` → 端点一个字都不回。而 `thinking` 此前在界面上**没有入口**（`ai:profileThinking` 这条 IPC 通了却没人调），且 `providers.json` 没有 active 指针时改档案的 thinking 不落 `.env`。本轮补两处：设置 → 模型与端点 的表里加「思考」开关；`setProfileThinking` 在档案逐字等于生效端点（无 active 指针的收编那份）时同样落地。
- google 族端点走非流式分支（为保 `thought_signature`），拿不到逐字推理，也不伪造思考 —— 这是端点方言限制，规范内承认现状。

### 3.2 渲染层

- `reasoning_delta`：有未封口的思考卡 → 追加 `detail`；没有 → 在流式气泡前插一张新的 `chip.kind="reasoning"` 卡并记作 `liveReasoning`。
- 未封口期间该卡展开显示尾部 400 字并带光标 `▍`，封口后回到普通思考条目（头部 400 字）。
- 回合进行中：`ProcessChain` 继续摊开（现有 `live` 行为）、`calling → done` 按 `callId` 原地点亮、清单随 `agent:plan` 刷新、折叠头「正在处理 N 步 · Xs」每秒一跳 —— 这些现在都随切页存活。
- 导航栏：正在跑回合的会话行加一枚呼吸点（`useRunningConvIds()` 从 store 派生），用户在任何页面都能看出「agent 还在干活」。
- 会话 token 角标 tooltip 去掉「切会话清零」（现在是按会话持久累计）。

## 4. 行为变更与代价（明确记账）

- **切会话不再中断生成**：后台会话会继续跑完并继续计费（原先是立刻 stop）。换来的是回来能看到完整结果。停止只在当前会话点「停止」时生效。
- 多会话并行回合是主进程本来就支持的（`runtime` 按会话独立），本轮只是不再由 UI 主动掐断。
- 现场在渲染层内存里，切换页面不丢；应用重启仍丢（与现状一致）。

## 5. 红线（不动）

AI 永不触发群发开始；写工具 `needsApproval` 逐次确认；副作用分级只加严不豁免；工具调用必审计；静默看门狗 150s 与幂等守卫照旧（`reasoning_delta` 属真实产出，参与续命）。

## 6. 同轮落地：首页「AI 建议行动」= 每天一批预设（`suggestion.service.ts` + 表 `agent_suggestions`）

那六张卡原来是写死文案，任何时候打开都一模一样。现在的形状（用户定的）：**agent 每天看一遍程序数据状况生成一批建议模板，每个分区最多 8 条；每次进新对话走骨架，从当天批次随机抽两条上卡。**

- **为什么不存成品句子**：句子里写死「9 封未读」，一小时后变 12 封就成了假话。所以条目存**带 `{slot}` 占位的模板**（如「{inbox.unread} 封未读里最值得回的三封」），读出来时才按当天快照填槽 —— 「每天一批」与「数字永远新鲜」由此不打架。
- **填不上就不出现**：槽值为 0 / 空的槽不进表，引用它的模板直接跳过，不会出现「0 封未读要不要总结」这种废话建议。
- **现状快照** `readSnapshot()`：台账总条数 / 过期条数 / 条目最多的目的港 / 距上次同步天数、未读封数与近 7 天询盘数 / 最新一封未读的来自主与主题、逾期**人数** / 今天到期人数 / 最长沉默**天数** / 逾期最久的联系人、队列待发组数与收件人数 / 失败组数、账号启用数与健康数 / 故障邮箱、联系人总数与冷启动数。全本地 SQL、毫秒级不花钱；任一块取数失败只让建议变笼统，不炸首屏。
- **读路径** `suggestions()`（IPC `agent:suggestions`）：只读当天批次 + 填槽 + 每区随机两条，不碰模型；某区当天没条目就用本地规则版模板顶上（`RULE_TEMPLATES`，同样带槽），所以**卡片永远有内容、首屏永远不等模型**。连着两次进首页尽量给不同的一批。
- **生成路径** `ensureBatch()`：应用启动后 30s、以及当天还没有 ai 批次时后台跑一次，六区各产 6–8 条模板，过准入就整批替换当天行（表只留最近 7 天）。生成失败或产出不合规 → 安静留用规则版，不报错。
- **变化触发** `signalsMoved()` + `shouldRegenerate()`：一天一批会漏掉「当天下午才出现的新重点」，所以在每次读库时顺手比一次**数据指纹**（`fingerprint(Snapshot)`，全用已读到的快照字段，零额外查询）。命中以下任一条才算变了：台账总条数或过期条数变了 / 台账今天刚同步过、未读 +3、待发组数 +5、出现新的发送失败、逾期从 0 变有或 +3、故障账号出现、健康账号变少。
- **两道闸**：两次生成至少隔 30 分钟（`MIN_GAP_MS`），当天累计最多 6 次（`MAX_TRIES_PER_DAY`，失败的尝试也计数，端点故障时不反复烧）。状态记在 `data/suggestion-state.json`（`{day, tries, lastAt, fp}`，与 `imap-state.json` 同款小状态文件）。
- **新批次不当面替换**：重排只写库，下一次进空态才生效 —— 顺带保证「同一次看到的两条不会中途变字」。
- **实测**（生效端点 agnes-2.5-flash、仿真快照）：一整批 1407 token 入 / 884 出，1.1s（曾见 19–23s 的端点波动，正因如此才必须后台生成 + 首屏只读库）。按上面的闸，日常约 1 次/天，数据活跃的日子 2–4 次，封顶 6 次/天。
- **准入校验** `parseBatch(raw, values)`：六区标题一字不差、每区 ≥5 条且截到 8 条、**句子里不许有裸数字**（数量必须走槽位；20GP / 40HQ 这类行业固定写法例外）、**槽名必须在白名单内**、长度按**填完之后**算（8–26 字；一个 `{quotes.topPod}` 就占 15 字符，按模板原文量会把正常产出整批误杀 —— 实测踩过）。存在的理由是实测到的三类乱来：自己拿 `132-12` 算出「能用 120 条」、把「逾期 5 位」写成「逾期 5 天」、把 `Santos` 翻成「桑托斯」（台账按原文匹配，翻了就查不到）。
- **每组口径边界** `GROUP_BRIEF`：提示词里限定每区只能引用与本区相关的槽位，且只能是本区真做得到的动作（防串数据、防给做不到的事出题）。
- **实测**（生效端点 agnes-2.5-flash、仿真快照）：一整批 1407 token 入 / 884 出，1.1s（曾见 19–23s 的端点波动，正因如此才必须后台生成 + 首屏只读库）。
- 六个分区标题必须与前端兜底常量 `CAPABILITIES`、表里的 `group_name` 一字不差（以 `GROUP_TITLES` 为准）。

## 7. 验收

- 单测 `tests/unit/agent-transcript-store.test.ts`（node 环境，stub `window.api`）：
  ① 事件按 `conversationId` 分流，不串台；② 无订阅者（模拟切页）时事件仍累积、重挂后现场完整；
  ③ `reasoning_delta` 累积 + 整块封口为一张卡；④ `done` 不清场，排队输入仍自动续发；⑤ `NEW` 条目改键到真实 id 后事件能接上。
- 手测：问一个会调工具的问题 → 中途切到「客户」页 → 切回，气泡还在并继续长；切到另一会话再回来同样；后台会话在导航栏有呼吸点。
- `npm run typecheck` + `npm test` + `npm run build` 全绿。
