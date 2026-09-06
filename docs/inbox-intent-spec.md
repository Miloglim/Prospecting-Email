# 收信意图识别 + AI 兜底一级分类规范

日期：2026-09-06　状态：已实现

两级分类同一次 LLM 调用完成：一级（是否真人回复）只兜底规则给不出答案的 `other` 桶；
二级（回复意图）只作用于 `replied`。AI 永远只兜底、永不覆盖规则的高置信结论。

## 0. 红线

- **bounce 永远不交给 AI**：退信必须硬证据（协议码/退信机器人/主题短语），LLM 误判一封
  bounce 会乱改联系人状态。
- AI 判为 replied 时走 `classifyMessage` 同一写路径（联系人状态 + 往来记录），不另造写入。
- 手动改过分类/意图的邮件：人工意志优先——AI 只在 `intent IS NULL` 时落值，永不改写已存在的 intent。
- 不自动回复：识别只影响分类与展示，回复永远草稿 + 人工确认。

## 1. 存储

`inbox_messages` 加 `intent` 列（TEXT nullable）：`price_inquiry / schedule_request /
cooperation / follow_up / other`；null = 未识别。迁移照 v5.0.3 模式自动补列。

## 2. 分类器（intent.service）

- `classifyIntentRules(subject, body)`：关键词规则先行——
  询价（price/quote/rate/报价/价格/运价…）、船期（eta/etd/schedule/船期/舱位/开船…）、
  合作（cooperat/partnership/agency/合作/代理…）、跟进（thank/received/confirm/收到/谢谢…）。
  命中直接定档；全部落空 → null（交给 LLM）。规则命中零模型成本。
- `resolveIntent(id)`（单封，幂等）：
  - `classification='replied'` → 规则 → LLM 意图兜底；
  - `classification='other'` → 一次 LLM 同时问"是否真人业务回复 + 意图"；
    reply=true 且当前 classification 仍为 other → 走 classifyMessage(id,'replied')（AI 兜底一级分类）；
  - bounce/autoreply/sent 不进本流程。
- LLM 输出 JSON：`{"reply":true,"intent":"price_inquiry"}`；解析失败/超时 → 保持 null（宁缺勿错）。

## 3. 触发点

- **增量**：IMAP/POP3 落库后，`classification ∈ {replied, other}` 的新邮件 fire-and-forget
  异步识别（不阻塞收信；异常吞掉只记日志）。
- **存量重扫**：收件箱「其他」页按钮「AI 重扫未分类」→ IPC `inbox:aiRescanOther`
  （单批上限 50 封，串行调用，返回 scanned/promoted 计数）。手动触发，不静默跑。

## 4. 联动面

- **inbox_search（agent 工具）**：返回行带 `intent`；新增 `intentFilter` 参数——
  「有哪些询价没回」一句话可查。
- **email_summarize**：`intent=price_inquiry` 的邮件，总结附 notice + 起草动作提示
  「回复前先用 quote_search 查台账价」——识别→查价→草稿引用台账价一条链。
- **收件箱 UI**：回复行带意图徽标（询价/船期/合作/跟进，色标区分）；顶部意图筛选 chips
  （前端过滤，listInbox 已回全量行）；「其他」页放 AI 重扫按钮。

## 5. 不做的事

不自动回复；不做二级以上意图细分（五档够用）；不阻塞收信；不回填已有人工标记。
