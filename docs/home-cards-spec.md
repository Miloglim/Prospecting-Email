# 首页功能卡规范（运价查询 + 自动开发信）

> 一句话：取消新会话页的「行动建议」气泡流，换成两张内置功能卡片——**运价查询**（填三个框 → 规范化查价进对话）、
> **自动开发信**（程序按联系人库+限额给出推荐群组 → 确认后跳发送中心做任务确定）。销售不打字也能用完这两条主链。

## 0.5 已拍板决策（2026-09-08，用户定）

1. **取消行动建议**：新会话空态的「想法气泡 + 换一批 + 一键采纳」整块下线，换成两张功能卡。后端建议流
   （suggestion.service / agent:suggestions）本期保留但不再被首页消费，死代码清理列 P2。
2. **运价查询 = 规范化提示词驱动 agent**：卡片弹窗收集 起运港/目的港/柜型/备注（用户键入），
   确认后把一段**程序拼装的固定流程提示词**发进会话，由 agent 调 quote_search 执行。
   标准化靠两头保证：提示词写死流程步骤（不反问、分层报数、表格原样贴、查不到明说）；
   quote_search 服务端已预计算 answer/两张表，模型只许照抄。
3. **自动开发信 = 确定性推荐，无模型参与**：群组规则是"agent 提前设置好的"——固定规则、可解释、零延迟：
   从未触达（status 空）+ 邮箱有效 + 剔占位邮箱 → **每公司只取 1 位**（资料齐全度优先：有语言/公司/国家/职位加分，
   同分取最早录入）→ 按齐全度降序取前 N；`N = min(候选数, 日限额剩余, 50)`。推荐结果弹窗里给全（名单 + 限额 + 理由），
   用户点**确定**才跳发送中心，最终发送与否仍由用户在发送界面确认（红线不破）。
4. **跳转带名单**：推荐群组经 localStorage 一次性交接给发送中心「新建任务」，选人器预选这批联系人并显示来源横幅；
   不经 hash 传大名单。
5. 首页即新会话页（`#/assistant` 空态）。问候语保留，气泡区换卡片。

## 1. 卡片一：运价查询

- 弹窗字段：起运港（可空=不限）、目的港（必填）、柜型（下拉 20GP/40GP/40HQ/40NOR，可空）、备注（可空，用户键入）。
- 确认 → `onSend(buildQuotePrompt(input))` 发进当前新会话；提示词为程序拼装的固定五步流程：
  ① 调 quote_search（pol/pod/container 照填）；② 先说航线归属，再分层报数（本港专属价在前、航线级适用价在后注明基本港）；
  ③ 同批带近 21 天舱位动态；④ 表格照工具返回原样贴、数字不改，查不到明说（区分「有过期价」与「没有」）；
  ⑤ 备注作为附加指令一并满足。
- 归一与语义理解全部在服务端（polExpansion/resolveQueryPod/航线展开），提示词不要求模型判断词性。

## 2. 卡片二：自动开发信

- 点击即调 `devLetter:recommend`（主进程确定性计算，无模型调用），弹窗展示：
  推荐名单（姓名/邮箱/公司/语言）、限额（今日已发/上限/剩余、可用账号数）、推荐理由四条。
- **确定** → 名单写入 localStorage（`dev-letter-preset`，一次性）→ 跳 `#/campaigns?tab=new`；
  CampaignList 挂载时取走预选名单显示来源横幅，用户在发送界面完成模板/发送模式的选择与最终确定。
- 红线：本卡片只产生"推荐 + 预选"，绝不入队、绝不发送。

## 3. 数据与接口

```ts
// src/main/services/dev-letter.service.ts（确定性规则，无模型）
export interface DevLetterContact { id: number; email: string; name: string; company: string | null; country: string | null; language: string | null }
export interface DevLetterRecommendation {
  contacts: DevLetterContact[];   // 推荐群组（已按规则排序、截断）
  groupSize: number;              // = contacts.length
  totalCandidates: number;        // 剔除后仍可用的冷客户总数
  companyCount: number;           // 涉及公司数
  quota: { dailyLimit: number; sentToday: number; remaining: number | null; accountCount: number };
  languages: Array<{ lang: string; n: number }>;  // 群内语言分布（展示模板匹配预期）
  reasons: string[];              // 给人看的推荐理由（逐条可解释）
}
export function recommendDevLetterGroup(now?: Date): Result<DevLetterRecommendation>
```
IPC：`devLetter:recommend`（contract 加组，preload 白名单自动生成）。

## 4. UI 与死代码边界

- AssistantPage 空态：问候语保留；骨架气泡/气泡/换一批/一键采纳（applyFeedAction）/suggestions 订阅与 FEED_FALLBACK 全部移除。
- 保留：`agent:suggestions`/`agent:dismissSuggestion` IPC 与 suggestion.service（P2 连根清理）。
- SendCenter 初始 tab 支持 hash 参数 `?tab=new|tasks|queue|history`。

## 5. 卡片三：今日邮箱概览（2026-09-08 追加）

点击卡片即出弹窗，**确定性统计、无模型调用**，主进程 `mail-brief.service.ts` 一次算完：

| 指标 | 口径（与既有页面同源，不养第二份） |
|---|---|
| 今日收信 | `inbox_messages.receivedAt` 落在**北京时间今日**（复用 `suggestion.service.beijingDay` 的日界）且 `classification != 'sent'`（NULL 算来信） |
| 其中未读 | 同上且 `isRead = 0`——未读真源就是 DB `isRead`（与收件箱列表同源），不引入本地名单 |
| 客户回复 / 自动回复 / 退信 / 其他来信 | `classification` 分类计数 |
| 询价 | `intent = 'price_inquiry'` |
| 今日我方发出 | `classification = 'sent'` 的当日条数 |
| 待你回复 | 今日 `replied` 中，该邮件之后**没有**再发往同一邮箱（`to`/`cc` 含其地址）的，最多 5 条并给出已等小时数 |
| 今日最新 | 最多 8 封（发件人/主题/分类/时间/未读点） |

- 弹窗顶部一句人话结论（例：今天来信 12 封，3 封客户回复里 2 封还没回，最久的已经等了 6 小时）+ 统计块 + 待回复清单 + 最新邮件。
- 两个出口：**让助手逐封看**（往会话发一条规范化总结提示词，走 `inbox_search`/`email_summarize`）；**去收件箱**（`#/inbox`）。
- IPC 挂既有 `IPC.INBOX.TODAY_BRIEF`（注册在 `inbox.ipc.ts`，不新增域、不动 `index.ts`），preload 白名单自动生成。
- 不做订阅/轮询：只在弹窗打开时算一次（react-query `enabled: open`）。

## 6. 红线

1. 自动开发信只做"推荐 + 预选 + 跳转"，入队/发送决策全部在发送界面由人完成。
2. 运价查询卡片只是规范化提问的入口，查价口径（两段查、分层、诚实定论）全部复用既有服务端，不新写一条查询链路。
3. 推荐规则确定性、可解释：不引入模型、不引入随机。
4. 今日邮箱概览是只读快照：不改已读状态、不触发抓取、不代发任何邮件。
