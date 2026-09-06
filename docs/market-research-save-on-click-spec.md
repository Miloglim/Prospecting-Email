# 调研报告「点一下才落盘」

## 背景

联网调研（market_research）一成功就自动把报告写进 outputs/agent。用户两次不满意：

1. 「没经允许就擅自生成」——文件落盘没有任何确认；
2. 「还在显示正在处理就落盘了」——写文件发生在工具执行完的那一刻（回合中段），而「正在处理」要等模型写完最终总结才消失，文件必然抢跑。

同一现场还暴露第二个问题：工具结果显示成 `{"type":"text","text":"…"}` 裸 JSON。SDK（@openai/agents 0.17）的 `FunctionCallResultItem.output` 是联合类型，有时把工具返回的字符串包成 content part，主进程整包 `JSON.stringify` 后推给前端，表格卡与动作按钮全部解析失败。

## 设计

### 1. 管线不落盘（research.service）

`runResearchScene` 只成稿不写文件：删掉 `writeArtifact` 调用，返回类型收窄为 `Result<{ out: ResearchOutput }>`（report 正文留在 out 里）。

### 2. 保存走写动作卡（tools.ts market_research）

调研成功后用 `registerAction` 注册「保存调研报告」动作卡，随结果 `actions` 下发：

- 按钮文案「保存调研报告」；确认句 + 边界说明（存到 outputs/agent，不发邮件、不改数据）；diff 一行（未保存 → 文件名）；
- 执行闭包 = `writeArtifact(航线调研 <route>, md, out.report)`，回执带完整路径；
- 动作卡机制自带的安全语义照单全收：必须点击才执行、确认弹窗、30 分钟过期、重启失效、执行落 agent_tool_calls 审计（approval=user_clicked）。

### 3. 模型口径（notice / description）

- notice 改为「报告没有自动保存……正文不要声称文件已生成；用户想要文件时提示他点按钮」；
- 工具 description 的「自动落文件」改为「不自动落盘，用户点「保存调研报告」才写文件」。

### 4. 工具输出剥壳（harness.toolOutputText）

推前端前统一剥壳：字符串原样；`{type:"text",text}` 内容包取其 text（数组逐个拼接）；其余对象兜底序列化。流式与非流式两条出口共用。不剥壳则动作按钮/表格卡渲染不出来，本功能不成立。

## 改动点

| 文件 | 改动 |
|---|---|
| `src/main/services/research.service.ts` | 去掉 writeArtifact；返回收窄为 `{ out }` |
| `src/main/services/agent/tools.ts` | market_research 注册保存动作卡；notice / description 更新 |
| `src/main/services/agent/harness.ts` | 新增导出 `toolOutputText`，两条工具输出出口改用剥壳 |
| `tests/unit/research.test.ts` | 管线断言改为「一次 writeArtifact 都不许发生」 |
| `tests/unit/agent-output-unwrap.test.ts` | 剥壳行为钉死（字符串/内容包/数组/兜底） |

## 验证

- `npm run typecheck` 通过；全量 `npm test` 294 绿；
- 实测路径：问行情 → 表格卡 + 「保存调研报告」按钮出现，回合结束前无任何文件；点按钮 → 确认后文件落 outputs/agent，对话里出现带路径的回执。

## 不做的事

- 不改成 SDK 审批流（写动作卡本就是点击+确认，够用）；
- 报告内容结构（五段式）不动。
