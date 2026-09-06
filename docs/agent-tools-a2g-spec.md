# Agent 工具面补强规范（A/B/C 三档）

日期：2026-09-06　状态：已实现

来源：用户实测转录（「沉默最久的客户」「删除 no.email 联系人」两问）暴露的能力缺口。
诊断结论：一半的"弱"来自工具面（程序有功能但 agent 没工具 / 问题形状与工具不吻合），
不是模型档位。本规范按严重度分三档修。

## A 档：bug 修复（不动业务）

### A1. 数字复核（reflector / agent.service）三处翻车

问题：
- 用户输入里出现过的数字（如用户自己说"8714 个联系人"）被当编造数字纠正成「若干」；
- 自纠成功时把**整篇答案**附在文末再发一遍（用户看到同一答案两遍）；
- 自纠失败时偶尔只剩裸标题「数字复核更正（…）」没有正文。

修法：
- `reflectOnNumbers` 增加 `exempt` 参数（用户输入原文），从用户消息里收集数字池并入
  回溯池 —— 用户给的数字天然可信，不进校验射程。
- 自纠成功的产物：**替换** answer 全文（history 落库用替换后的），推送端只发一行
  `（已按工具数据更正：原 X → 现 Y）` 样式的短提示，不再整篇重发。
- 自纠失败仍走文末附注（现行行为），附注永远带 bad 列表，不出现空更正。

### A2. search_contacts 返回补 total / complete

问题：只回 10-50 行不带总数 → 模型推断"库里远少于 8714"（实际库里就是 8714）。
quote_search 已修过同类坑（total + complete 提示），联系人工具对齐。

修法：返回 `{ results, total, count, complete?, notice? }`：
- `total` = 满足关键词条件的真总数（COUNT 查询）；
- `count` = 本批返回行数；
- `total === count` → `complete:true` + "已全部返回，直接作答"提示；
- 空结果提示保持不变。

## B 档：search_contacts 补"最近跟进时间 + 沉默排序"

问题：「沉默最久的客户」需要按最近跟进时间排序，工具不支持 → 模型翻 5 页空转。

修法（同一工具加参数，不新增工具）：
- 返回行新增 `lastFollowupAt`（读时合并口径：interactions ∪ inbox 邮件取较新者，
  与 listPipeline"最近跟进"同源；无记录 → null）。
- 新增可选参数 `sortBy: "stale"`（按最近跟进时间升序 = 沉默最久优先）与 `limit`（≤50）。
- **stale 排序走单条 SQL 聚合**（CTE：interactions ∪ inbox 各按联系人取 MAX，合并后再取 MAX，
  LEFT JOIN 联系人，`ORDER BY (last_at IS NULL) DESC, last_at ASC LIMIT ?`）。
  曾实现为"JS 侧先取 400 行再合并排序"——宽泛查询时 400 名开外的人被漏掉，排序不完整，
  已弃用。SQL 版全库 8714 行实测 16ms，无性能顾虑。
- 非排序路径保持 drizzle 查询 + 分块合并 lastFollowupAt（≤50 行，JS 合并足够）。
- 排序语义：从未被跟进（last_at IS NULL）排最前 = 沉默最久；其次按最近跟进时间升序。
- 配套 notice：沉默天数 = now - lastFollowupAt 的天数（模型只许照抄，不许自己算）。

## C 档：delete_contacts 写工具（破坏性操作）

问题：IPC 早有 `contacts:deleteBatch`（级联清 interactions/CRM 关系/解绑 inbox/
清空壳公司），但 agent 无工具 → 模型说"程序没有删除功能"，还编造了危险绕行
（导出重导会换全量 id 错配往来记录）。

修法：
- 新增 `delete_contacts` 写工具：`requiresApproval: true`，`autoApprovable` 永不 true。
- 参数：`query`（与 search_contacts 同词法）+ 可选 `emailSuffix`（按邮箱后缀过滤，
  如 `no.email`）——本次实测需求即后缀类批量清理。
- 执行流程：先按条件查出命中名单（**不在执行时再查一遍**，approval 闭包里用同一批
  ids，防确认间隙数据变化）→ 命中 0 人直接空结果返回；>500 人拒绝并提示分批。
- 确认卡内容：命中 N 人（列前 5 个样例：id/姓名/邮箱）、级联影响说明
  （往来记录一并删除、收件箱邮件保留但解绑、空壳公司自动清理、**不可恢复**）、
  建议语「建议先在客户页导出一份备份」。
- 审计：approval=user_confirmed / user_rejected 照常落 agent_tool_calls。
- 级联删除复用 contact.service 的 `deleteContactCascade`，单次 saveDatabase
  （沿用 deleteBatch 的批量落盘模式，不逐条落盘）。
- 执行后失效缓存（search_contacts / reminders_due）。

### C 附带：report_gap 收紧绕行话术

问题：模型登记缺口时自由发挥编造绕行路径（"去 CRM 后台操作"——不存在的东西）。

修法：report_gap 的工具 notice 明示「workaround 只允许描述已真实存在的功能或
「在 XX 页面手动操作」，不要发明本产品没有的系统或功能」。
