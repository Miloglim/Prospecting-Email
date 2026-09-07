# 新对话「行动建议」信息流规范

> 状态：已放行（2026-09-07，取舍决议见 §11）
> 一句话：六卡 12 条 → 单列 3–4 条实时建议流。候选全部本地生成、事件驱动热更新、文案由数据直接拼装；LLM 每日批生成机制退役。

## 1. 背景与问题

现状（suggestion.service.ts + AssistantPage 空态六卡）：

- 六分区 × 每卡 2 条 = 12 条建议，栅格卡片展示
- 文案两层：LLM 每天生成一批模板存 `agent_suggestions`，展示时填槽保鲜；规则版模板兜底
- 已有变化触发重排：fingerprint 比对 + 30 分钟冷却 + 每日 6 次上限

三个问题：

1. **选择过载**：12 条里大部分与「此刻」无关，销售用户不会扫完，等于没有重点
2. **不够热**：模板批每天一次、重排有 30 分钟冷却；新邮件到达、运价刷新、队列变化都不会即时反映到建议上
3. **缺「可同步资讯」方向**：运价镜像每 4 小时全量刷新，但「哪条价变了、值得同步给哪个客户」从来没被算过——这是销售最想要的那类建议

硬约束来源（实测教训）：模板 + 槽位机制表达不了「MSC 美西线 40HQ 降到 $2800」这类结构化事实——槽位只有数字和人名称呼，装不下「船司 + 航线 + 柜型 + 降幅」。**建议文案必须由数据直接拼装**，这决定了 LLM 模板层退役。

## 2. 目标

1. 空态只出现 3–4 条建议，每条都「此刻可办」
2. 数据一变（新邮件 / 运价刷新 / 队列变化 / 跟进写入 / 上下文锚点变化），建议流 ≤1s 就地更新，**零模型调用**
3. 四个方向桶：跟进发信 / 邮件 / 可同步资讯 / 兜底探索
4. 点击即发送（保留 GROUP_PROMPT 方法论前缀机制，按桶映射）

## 3. 信息架构

```
数据事件 ──debounce 500ms──▶ collectCandidates(四桶生成器)
                                    │
                                    ▼
                              score(紧迫+价值+新鲜)
                                    │
                                    ▼
                        select(总3–4条 · 同桶≤2 · ctx置顶)
                                    │
                                    ▼
                 push SUGGESTIONS_CHANGED ──▶ 渲染端按 key diff 就地更新
```

- **候选生成器**：纯函数，每桶一组；输入 = 扩展快照（Snapshot + ratesDiff + ctx），输出 `Candidate[]`
- **Candidate**：`{ bucket, key(去重/记忆用), text(展示文案), prompt(前缀+目标), tone, score, href? }`
- **tone**：`urgent`(红) / `mail`(蓝) / `intel`(绿) / `neutral`(灰)，驱动 chip 状态色条
- **选取约束**：总 3–4 条；同桶 ≤2；urgent 优先；ctx 命中置顶；同分比新鲜度
- **分数** = 紧迫度(0–40) + 价值(0–40) + 新鲜度(0–20)

## 4. 四桶候选清单

### A. 跟进发信（bucket=followup，前缀=「跟进客户」）

| 候选 | 触发口径 | 文案（本地拼装） | 分 |
|---|---|---|---|
| 逾期最久 | checkReminders().overdue 按 staleDays 降序取第一 | 「{name}」沉默 {staleDays} 天了，先处理他 | 紧迫 30+staleDays 封顶 40 |
| 今天到期 | dueToday > 0 | 今天有 {n} 位该跟进，帮我排个顺序 | 紧迫 25 |
| 队列卡住 | pendingGroups > 0 且存在 delayReason=window | 队列 {n} 组在等发送时段，看看安排 | 紧迫 15 |
| 发送失败 | send.failed > 0 | {n} 组发送失败，查下原因要不要重试 | 紧迫 35，tone=urgent |

### B. 邮件（bucket=mail，前缀=「管邮件」）

| 候选 | 触发口径 | 文案 | 分 |
|---|---|---|---|
| 未回询盘 | inbound（classification=replied 且 matchedContactId 非空）之后无同联系人 outbound（interactions type IN (sent,replied) 且 created_at 晚于该邮件）→ 取最近一封 | {from} 的「{subject}」还没回，以运去哪身份起草回复 | 紧迫 30 + 距今衰减，价值 +10（matchedContact 阶段 reached/replied） |
| 新到未读 | unread > 0 且最新一封 receivedAt 距今 < 2h | {n} 封未读，最新是 {who} 的「{subject}」 | 紧迫 20 |
| 退信待处理 | 未归档 bounce n > 0 | {n} 封退信要处理 | 紧迫 35，tone=urgent |

「未回询盘」SQL 口径（实现时落 CTE）：

```sql
SELECT i.* FROM inbox_messages i
WHERE i.classification='replied' AND i.matched_contact_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM interactions t
    WHERE t.contact_id = i.matched_contact_id
      AND t.type IN ('sent','replied')
      AND t.created_at > i.received_at)
ORDER BY i.received_at DESC LIMIT 1
```

### C. 可同步资讯（bucket=intel，前缀=「查运价」）——新方向

数据源 = rates diff（§6）+ 舱位表。

| 候选 | 触发口径 | 文案 | 分 |
|---|---|---|---|
| 降价 | 同 pod+carrier+container 新价 < 旧价，取降幅最大一条 | {pod} {carrier} {container} 降到 ${new}（原 ${old}），可以同步给客户 | 价值 30+降幅比×10 |
| 新增航线 | 新 record_id 且该 pod 旧批没有 | 台账新上 {pod} 航线 {n} 条报价 | 价值 20 |
| 即将过期 | valid_to ≤ 7 天 | {pod} 的 {n} 条报价 {days} 天后过期，要不要先锁价 | 紧迫 = 8-days |
| 临近截关 | space_records cutoff/etd ≤ 3 天 | {pod} {vessel} {etd} 开船，还剩 {boxQty} 舱位 | 紧迫 = 5-days |

「相关客户」匹配（v1 从简）：降价/新增航线的 pod 若能对上某联系人的国家或历史询盘航线（interactions.subject/body_preview LIKE pod），文案带上「可以给 {name} 同步」；对不上就退化为「可以同步给客户」，**不做智能推荐、不猜**。

### D. 兜底预备库（bucket=static，tone=neutral）——explore 桶已砍（§11a），首轮验收后按用户反馈恢复为「预备库补齐」

`PREPARED_POOL`：9 条常青能力入口（总结未读 / 今天跟进谁 / 台账覆盖航线 / 近 7 天询盘 / 沉默最久客户 / 冷启动开发信 / 最便宜报价 / 账号健康 / 队列状态），全部带各自方法论前缀、不依赖任何数据。

补齐规则（`padWithPool`）：真实候选选取后不足 **MIN_ITEMS=3** 条时从预备库补到 3 条，真实条目恒排前面；轮换起点按 `(已选数+rotate) % 池长` 错开，避免每次都补同几条；候选全空（新装机器）= 纯预备库 3 条。数据丰富的正常路径（≥3 条真实候选）永远轮不到预备库上场。

## 5. 热更新机制

- **触发点（实现定案：内部 nudge()，不新增渲染端事件）**：`suggestion-bus.ts` 导出零依赖的 `nudge()`，以下位置数据落地后调用——inbox.ipc 两处 newMail 推送旁、send.service 的 SEND_PROGRESS push 口、crm.service addNote/setReminder、contact.service upsertContact（更新与新建两出口）、rate-sync sync() 成功算完 diff 后。RATES_SYNCED 不进 EVENTS（渲染端只认 SUGGESTIONS_CHANGED 一个口）
- **主进程**：bus 内 debounce 500ms → 重算 feed（ctx-less 全局版）→ JSON 与上次推送相同就不推；变了推 `EVENTS.SUGGESTIONS_CHANGED`（全量 3–4 条，渲染端按 key 复用 DOM）
- **渲染端**：仅空态（showCards）订阅；推送到达时「换一批」页码归零；带 ctx 锚点的会话收到事件后**重拉**（置顶在服务端算），无锚点直接用推送载荷；会话有消息后不订不打扰
- **成本**：全链路本地 SQL + 字符串拼装，单次重算毫秒级，零模型调用、无冷却概念——冷却/每日上限/指纹比对整套机制随 LLM 批生成一起退役

## 6. rates diff（intel 桶的原料）

sync() 现在是**全量删旧插新**（`db.delete(rateQuotes)` → 批量 insert），所以 diff 必须在删除前算：

1. delete 前读旧批 `(pod_raw, carrier, container, ocean_usd, valid_to)` 进内存
2. 与新批对比，**对齐键 = pod+船司+柜型 元组，不是 record_id**（record_id 是服务端 content_key，内容一变键就变，按它对齐会把降价误判成「新增+消失」）：降价 = 同元组新批最低价 < 旧批最低价；新增 = 新批出现了旧批没有的 pod（按 pod 聚合条数）；即将过期 = valid_to 距今 ≤7 天（按 pod 聚合，天数 = 纯日期差）；临截关 = 舱位 cutoff/etd 距今 ≤3 天（parseFlexDate 保守解析，解不出跳过不猜）
3. 结果存模块态 `lastRatesDiff` + `data/rates-diff.json`（带 syncedAt；重启后 24h 内仍可用，超 24h 视为陈旧不展示）
4. 同一 diff 不重复推荐：feed 项被点击或忽略后记 `dismissedKeys`（当天有效，按北京时间日切），当天不再出

## 7. UI 规格（首轮验收后按用户反馈定案：布局与旧版一致，建议区 = 豆包式想法气泡）

**布局骨架与旧版六卡时代一字不差**：居中大 Logo（44px）+「Hi，我是 Prospector 助手」标题 + 能力副标题 + 底部快捷命令提示。只有中间的建议区从卡片栅格换成气泡流。

```
              ◆ (DiamondLogo 44)
        Hi，我是 Prospector 助手
  已接入运价 / 邮件 / 客户 / 跟进 / 发信 11 项能力…

     早上好。今天 2 位客户逾期没跟进、3 封未读，运价镜像刚更新。

   ( ● 「Juan Garcia」沉默 9 天了，先处理他 )      ← 红点呼吸，自然宽度
  ( ● GCRA 的「Re: Logistics…」还没回，起草回复 )   ← 蓝点
      ( ● SANTOS MSC 40HQ 降到 $2800… )           ← 绿点
                换一批 ( hover 才显示 )

  输入 / 唤出快捷命令 · 多步任务会亮出任务清单 · …
```

- **想法气泡**：`flex-wrap` 居中流式排布，**自然宽度、不排整齐**（豆包式）；pill 形态（rounded-full），白底 + 极浅边框（gray-200/80）+ 1px 级微阴影；hover 边框转 teal、底色 teal 4%；文案 13px gray-700，超长 truncate（max-w 420px）
- **tone 圆点**：气泡内左侧 1.5px 小圆点（红 urgent / 蓝 mail / 绿 intel / 灰 static），替代原色条方案；urgent 圆点呼吸（2s ease-in-out，opacity 0.55↔1）
- **动效**：气泡入场淡入 + 上移 4px（180ms，逐条错开 45ms）
- **问候行**：本地拼装居中一行（13px gray-500），只报有值的项；全空则「今天收件箱很干净」
- **骨架（用户明确要求保留）**：**每次切换会话都回骨架态**（feed 在 [key] effect 里清空重拉），4 个错落宽度（220/168/264/190px）的 pill 骨架，与真气泡同款形态，填内容时不推版面；拉取是本地 SQL 毫秒级，骨架一闪即过——「得快」与「要有骨架」由此兼顾
- **换一批**：hover 气泡区才显示（12px gray-400，items≥3 才出现）；rotate 页码 +1 重拉，服务端从同候选池跳过已选批次取下一组；池子轮空停在上一批再由预备库补齐；热更新推送到达时页码归零
- **点击气泡** = 先 `agent:dismissSuggestion(key)`（当天不再推荐同一条）再 handleSend(prompt)；带 href 的气泡 hover 露出「查看」小链接（stopPropagation，只跳转不发送）
- **空态降级**：真实候选不足 3 条 → 预备库补齐（§4D）；连 IPC 都不通 → 渲染层 FEED_FALLBACK（2 条极简气泡）
- **窄屏**：气泡流自然换行，全宽居中，不做栅格

## 8. LLM 批生成退役

- **删除（已执行）**：buildBatchPrompt / parseBatch / generate / ensureBatch / regenerateBatch / shouldRegenerate / signalsMoved / fingerprint / GenState / suggestion-state.json 读写 / agent_suggestions 表读写 / MAX_PER_GROUP、PICK_PER_GROUP、pickTwo / SLOTS、slotValues、fillTemplate / RULE_TEMPLATES、ruleBatches / GROUP_TITLES、SuggestionGroup / readSnapshot（取数改为 gatherReminders/gatherSend/gatherMail/gatherRelated 四个独立采集器，单块失败只让候选变少）/ index.ts 启动 30s ensureBatch
- **保留（已执行）**：GROUP_PROMPT（5 个前缀：查运价/管邮件/跟进客户/准备发信/账号与公司，候选按 prefix 字段取用；末位为预备库的账号健康条目恢复）、beijingDay（dismissed 日切复用）
- **agent_suggestions 表**：停写不删表（历史留着），代码引用已清干净
- **CAPABILITIES 常量（渲染层）**：已删；换成极简 FEED_FALLBACK（2 条静态气泡，只防「连 IPC 都不通」的极端情况，不重复维护方法论前缀——正常空数据路径由主进程 PREPARED_POOL 补齐兜底）
- 渲染端 `agent:suggestions` 拉取从「切到新对话时一次」改为「空态期间拉取 + 订阅 suggestions:changed 热更新」

## 9. IPC 契约

```ts
// agent:suggestions(ctx?: string, rotate?: number) 返回 & SUGGESTIONS_CHANGED 推送（推送恒为 ctx-less、rotate=0 的全局版），同形态
interface SuggestionFeed {
  greeting: string;
  items: Array<{
    key: string;        // 去重/dismissed 记忆用（跨重算稳定）
    text: string;       // chip 文案
    prompt: string;     // 点击发送的完整提示词（前缀+检索目标）
    tone: "urgent" | "mail" | "intel" | "neutral";
    bucket: "followup" | "mail" | "intel" | "static";
    href?: string;      // 可选：跳转查看（联系人详情/队列/收件箱）
    contactId?: number; // ctx 锚点命中时服务端置顶用
  }>;
}
// agent:dismissSuggestion(key: string) → okResult(true)：chip 点击后当天不再推荐同一条
```

EVENTS 加 `SUGGESTIONS_CHANGED: "suggestions:changed"`（preload 白名单由常量推导，加常量即可）。

## 10. 验收

**单测**（种子库 + sql.js，沿用 agent-tools-inbox 的沙箱模式）：

1. 四桶候选生成器各自的触发口径（构造逾期/未回/diff/截关种子）
2. 选取约束：总 3–4、同桶 ≤2、urgent 优先、ctx 置顶、dismissedKeys 当天不重复
3. rates diff：新增/降价/即将过期三类判定 + 全量替换时序（delete 前取旧批）
4. debounce 合并：同秒多事件只重算一次；内容没变不推送
5. 「未回询盘」SQL：有 outbound 跟进的联系人不出候选

**手测**：

1. 发一封测试邮件 → 空态建议 ≤1s 出现「未回」chip
2. 手动改一条运价再触发同步 → 出现降价 chip，文案数字与镜像一致
3. 从联系人详情深链进新对话 → 该客户相关 chip 置顶
4. 点击 chip → 发送的 prompt 带对应桶的方法论前缀
5. 回合开始后建议流消失，回合结束回到空态时按最新数据重建

## 11. 取舍决议（2026-09-07 放行时定案）

a) **explore 兜底桶：砍掉**。前三桶凑不满 3 条就有几条给几条；全库真空走 §7 空态降级（静态能力介绍 chip）
b) **dismissedKeys 记忆时长：当天**（北京时间日切），落 data/suggestion-dismissed.json 防重启丢失
c) **形态：开场气泡**（§7 规格）
d) **intel 桶「相关客户」匹配：确定性规则增强版**——pod 命中「最近 30 天有往来邮件（主题/正文含该港或航线）或国家匹配」的联系人，取最近往来那位，chip 带 href 跳联系人；对不上退化文案「可以同步给客户」。不猜、不编、不用模型
e) **LLM 批生成：彻底退役，不留润色层**。问候语与 chip 文案全部本地拼装
