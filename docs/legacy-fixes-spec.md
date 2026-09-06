# 工程遗留修复规范（调研韧性 / gaps 打码 / 详情时间线抄送 / SMTP 连接池）

日期：2026-09-06　状态：已实现

四项工程遗留一次修掉，范围与修法如下。改实现先改本规范。

## 1. 调研抓取韧性（research.service）

问题：FETCH_MAX=5、单源 12s 超时不重试、带真实价格的货代行情页因 tier 排序进不了抓取集，
撞上反爬（503/403）就整轮断粮，报告零数字。

修法：
- `FETCH_MAX` 5 → 8，`FETCH_TIMEOUT` 12s → 20s。
- `fetchPage` 允许重试一次（间隔 1.5s）：只对**瞬时失败**重试（网络异常、超时中止、HTTP 5xx、429）；
  HTTP 4xx（反爬/不存在）与「页面正文过短」不重试——再试也无意义。方法论注释第 4 条同步更新。
- 抓取集选择：tier 排序保底之外，**标题/摘要含行情信号**（运价/海运费/freight rate/报价等）的页面
  保底占 3 个名额——带价格的货代页不再被指数页挤出抓取集。
- 失败源照旧明说：抓取失败（含重试后仍失败）逐条进 gaps 与报告第 4 节。

## 2. gaps / dropped 数字打码（research.service）

问题：护栏只拦"结论"，聊天模型仍能从未核实摘要（gaps）和被剔除结论（dropped）里捞数字拼进回答
外发（桑托斯 6518/6500 事故根因之一）。

修法：
- 新增纯函数 `maskUnverified(text)`：≥100 的数字一律替换为 `×××`（年份 1900-2100 与 <100 的
  柜数/天数/百分比豁免，与 extractAmounts 口径一致）。
- 应用点：gaps 中「未核实（只拿到摘要）」行、dropped 全部行（含"数字 ××× 在引用资料里找不到"）。
  构造时打码 ⇒ `out.gaps`、`out.dropped` 与报告第 4 节同步打码，模型与用户看到一致。
- 已核实数据（rates/schedules/结论）不打码。

## 3. ContactDetail 时间线补抄送（contact.service + ContactDetail.tsx）

问题：CRM 看板时间线已读时合并邮件（含抄送），客户详情抽屉仍只读 interactions——同一联系人
两处时间线不一致，抄送邮件缺失。

修法：`getContactInteractions` 改为与 `crm.service.getDetail` 同一套读时合并规则：
- interactions 只取 note / bounced / autoreply（sent/replied 由邮件行覆盖，防双份）；
- 邮件取 inbox_messages（matchedContactId 或 relatedContactIds 含该联系人），抄送进去，
  bounce/autoreply 邮件行不重复进（由事件行表达）；方向/类型判定与 CRM 完全一致（cc 类型）；
- 按 createdAt 倒序限 80，前端渲染前 20 条；返回行增加 id / fromEmail 字段。
- 前端标签映射补 `cc: 抄送`（色 #0891b2，与 CRM 时间线一致）。

## 4. 发信 SMTP 连接池（send.ipc.ts）

问题：每发一封都新建 SMTP 连接（TCP+TLS+AUTH 全套握手），大批次整批耗时被握手放大。

修法：
- `sendBcc` 改用**按账号缓存**的 pooled transporter（`pool:true, maxConnections:1,
  maxMessages:100`，与全局串行发送模型匹配）。
- 缓存键 = 账号 id + host + port + 密码指纹：账号改配置/改密码后自动重建，不会用旧凭据硬发。
- 发送成功保留连接复用；发送失败**立即关闭并剔除**，下次重连新鲜连接——坏连接不会反复失败。
- 池化连接被服务端闲置掐断（Connection closed / socket 类错误）时：剔除后用新连接**原参数重试一次**，
  仍失败才计为发送失败——避免把空闲断连误记成账号连续失败（防误触熔断）。
- 不改发送语义：串行调度、熔断、审计全部不动，只换连接层。

## 5. 发送时段跟操作系统时区（2026-09-06 用户拍板）

问题：`inWindow` 用 UTC+8 偏移硬算"北京时"，时区语义写死，境外/出差场景窗口错位。

修法：
- `send.service.inWindow` 改 `new Date().getHours()`（本机时区），窗口判定跟操作系统走。
- config.ts 注释、设置页占位文案（"北京时"→"本地时"）与耗时推算注释同步更新。
- config.json 死字段（companyDelay/batchSize/batchPause/templateRotateGroups/singleRecipDelay）
  经全库核验已不存在，无需清理。
- 行为说明：本机时区在 UTC+8 时行为与旧版完全一致，无迁移问题。
