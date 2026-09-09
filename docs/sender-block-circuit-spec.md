# 发信受阻熔断（sender-block circuit）— 设计规范

落地日期：2026-09-08　关联：`docs/smart-send-spec.md`（止损）、`docs/bounce-multi-match-spec.md`（退信匹配）

## 1. 背景与实测证据

用户 2026-09-08 17:43 收到阿里云投递系统的退信通知：

```
收信地址 zambia@transitex.co.zm
退信原因 您发送的邮件被系统反垃圾拦截……建议调整邮件内容或发信频率后重新发送
参考信息 ESO_LOCAL_SPAM: spamed by local spam engine
```

同一小时内 `no-reply@mailsupport.aliyun.com` 连发 8 封同族通知（北京 17:33–17:43，账号 #1），
**程序的发信熔断从头到尾没有触发过**：库实测 `email_accounts.consecutive_fails=0`、
`circuit_open_at=null`（两个账号都是）。2026-08-06 凌晨也发生过同族 12 封，同样没触发。

根因（证据链）：

1. 这是**服务商收下单信之后本地反垃圾拦截**发出的异步通知，SMTP 那一步是成功的；
   而失败计数与熔断的唯一写点在 `send.service.runBatchLoop` 的 SMTP 失败分支 → 永远不沾。
2. 退信走的是收信链路：`classify=bounce` → `markAsBounced(联系人)` + `bounced` 事件 + 发信任务止损，
   全程不碰 `email_accounts` 的健康字段 → 账号侧零感知，程序继续按原节奏撞墙。
3. 潜在二次伤害：这类通知正文里挂着「无法发送到 <一串收件地址>」，用户一点开正文，
   `backfillMatchFromBody → recordBounceMatches` 就会把这些地址整批标成「邮箱退信」——
   但收件人没坏，坏的是我们的内容与发信频率。库实测该路径目前命中 0 次（461 封通知都没点开过），
   属于必须堵掉的定时炸弹，而不是需要回滚的存量。
4. 既有洞：`buildQueue/buildAdaptiveQueue/buildDynamicQueue/startQueue/resumeQueue` 选号只看
   `is_active=1`，不看 `circuit_open_at` —— 即便某账号熔断过，下一批照样被排进轮换。

## 2. 判据：只管「针对性拦截」这一类

用户明确要求：**其他样式的退信照旧按硬退信处理，不用管**。所以判据宁缺勿滥，只认
「服务商自己说把我方内容/频率拦下了」的明确文案与错误码（大小写不敏感，命中其一即可）：

| 族 | 判据 |
|---|---|
| 阿里云投递 | `ESO_LOCAL_SPAM`、`spamed by local spam engine`、`系统反垃圾拦截`、`建议调整邮件内容或发信频率` |
| 通用反垃圾拦截 | `blocked by spam`、`spam content`、`content rejected`、`suspected spam`、`junk mail filter` |
| 通用限流 | `rate limit`、`too many messages`、`too frequent`、`throttl`、`发送频率过高`、`发信频率` |
| 信誉/黑名单 | `blacklist`、`black list`、`DNSBL`、`Spamhaus`、`blocked due to your reputation`、`IP 已被列入黑名单` |

不命中的情形（保持现状，绝不接管）：只有「无法发送到 / user unknown / 550 5.1.1 / mailbox full」
等收件人侧原因的退信；判不准的一律按普通退信走。**分类字段仍是 `bounce`**（它在收件箱里
确实是一封退信通知），改变的只是「这条退信该记在谁头上」。

## 3. 数据模型

- 新表 `send_block_events`：`id / account_id / message_id(唯一，幂等键) / code / excerpt / occurred_at`。
  滚动窗口计数与审计的唯一源；一封通知最多记一次。
- `email_accounts` 新增 `circuit_reason text`（`sender_block` | `smtp_fail`），
  熔断态沿用既有 `circuit_open_at` + `circuit_reset_after`（= 开启时刻 +24h）。

## 4. 触发与处置

命中判据 → 写 `send_block_events` → 按账号统计**滚动 30 分钟**内封数：

- 计数 `< 3`：只记账号事件（设置页可见），不动批次。
- 计数 `≥ 3` 且该账号未处于熔断：
  1. 该账号置熔断（`circuit_open_at=now`、`circuit_reset_after=now+24h`、`circuit_reason='sender_block'`）；
  2. **暂停整个批次**（`pauseSend('sender_block')`，不取消、不丢队列——域名与账号信誉是共享资产，
     换账号继续猛发只会把第二个账号一起拖进去）；
  3. 推 `accounts:circuitChanged`（带 reason/count），队列页与设置页据此呈现；
  4. 联系人**不标退信**、不写 `bounced` 事件、不发信任务止损。

熔断账号一律从选号中剔除（第 5 节），所以新批次/恢复批次都不会再排到它。

## 5. 选号口径唯一化

`selectableAccountIds()` = `is_active=1` 且熔断未生效（`circuit_open_at` 为空，或已过
`circuit_reset_after`）。`buildQueue` / `buildAdaptiveQueue` / `buildDynamicQueue` /
`startQueue` / `resumeQueue` / `accountStats` 全部走它——不留第二份口径。

## 6. 恢复

- **手动一键**：设置页账号卡「解除熔断」（显式点击才写盘），清 `circuit_open_at/circuit_reset_after/circuit_reason` 与 `consecutive_fails`；
- **自动过期**：24h 后 `circuit_reset_after` 到期，选号自然放行，不需要额外定时器；
- 暂停的批次由用户点「恢复」继续（沿用现有 `send:resume` 人工闸门，程序永不自动恢复发信）。

## 7. 呈现

- 队列页：`SendStatus.pausedReason='sender_block'` 时顶部横幅显示
  「发信被服务商反垃圾拦截（30 分钟内 N 封）— 已暂停整批，调整内容/降低频率后点恢复」；
- 设置页账号卡：熔断原因标签 + 一键解除；
- agent `accounts_status`：熔断口径改为「有效熔断」（含 24h 过期），原因如实带出，
  不再把已过期账号报成「发信熔断中」。

## 8. 红线

- 接管判据只窄不宽：不命中标判据的退信一律走原硬退信链路；
- 绝不因这类退信改联系人状态或止损发信任务；
- 熔断与暂停只「停」不「发」：程序永不自动恢复群发（沿用 AI 永不触发群发开始的铁律）。

## 9. 测试钉

1. 判据：阿里云 `ESO_LOCAL_SPAM` 样本命中；只有「无法发送到 + 5xx」的硬退信样本不命中；
   限流文案（rate limit / 发信频率）命中。
2. 窗口计数：30 分钟内第 3 封触发，第 1、2 封只记账号事件；同 `message_id` 重复记录幂等。
3. 触发后：账号进入有效熔断、批次转 `pausedReason='sender_block'`、联系人未被标 bounced、未写 bounced 事件。
4. 选号：熔断账号（未过期）被 `selectableAccountIds()` 剔除；过 `circuit_reset_after` 后回归。
5. 一键解除：清干净三字段 + 计数归零。
