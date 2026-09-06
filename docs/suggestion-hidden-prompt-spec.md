# 首页建议卡：隐藏提示词优化

## 动机

首页六张「AI 建议行动」卡上的条目是人话短句（如「上海到桑托斯现在公开市场报多少」），点击后原样发给助手。短句缺少方法论约束，模型容易浅尝辄止（如调研时不交叉核对、不标注可信度）。目标：**卡上继续显示短句，点击后实际发送一份带方法论的专业化提示词**，用户无感但每轮回合的起点质量更高。

## 设计

### 提示词 = 分区方法论前缀 + 「检索目标：显示文本」

```
围绕指定业务目标检索多个可信公开来源，交叉核对信息，整理可用资源、关键结论、发布日期和来源链接。明确标注无法核实或可能过期的信息。

检索目标：上海到桑托斯现在公开市场报多少
```

- **六个分区各一份方法论前缀**（`GROUP_PROMPT`，与 `GROUP_BRIEF` 并列），内容与各分区工具的真实能力对齐：查运价=照实报台账不补数、看市场行情=多源交叉核对+标注可信度、管邮件/跟进客户=写入先确认、准备发信=只入队不自动发送、账号与公司=只依据公开信息。
- **显示文本即检索目标**：条目显示时的填槽结果（含今天的数字/港口名）原样拼进提示词，具体信息不丢。
- **点击时才拼装，纯函数派生**（`buildItemPrompt(title, text)`）：AI 批次与规则兜底批次、渲染端兜底卡一视同仁；不给 `agent_suggestions` 表加列、不改生成提示词、不增加模型产出被污染的面。

### 数据形状

`suggestions()` 返回的 `items` 由 `string[]` 改为 `Array<{ text: string; prompt: string }>`。渲染端：

- 卡片渲染 `q.text`（`title` 提示也用它），点击 `handleSend(q.prompt)`；
- 兜底常量 `CAPABILITIES` 同步改为对象形状，前缀文案与主进程 `GROUP_PROMPT` 一字不差（沿用现有「六组标题必须一致」的镜像约定）。

## 改动点

| 文件 | 改动 |
|---|---|
| `src/main/services/suggestion.service.ts` | 新增 `GROUP_PROMPT` 与 `buildItemPrompt`；`SuggestionGroup.items` 改对象形状，`suggestions()` 拼装 |
| `src/renderer/pages/assistant/AssistantPage.tsx` | `CAPABILITIES` 改对象形状；IPC 类型断言同步；点击发送 `prompt` |
| `tests/unit/suggestion-cards.test.ts` | 钉死：六分区前缀非空、拼装格式、检索目标=显示文本 |

## 验证

- 单测：`buildItemPrompt` 格式与六分区前缀齐备；
- `npm run typecheck` 通过；`npm test` 全绿；
- 实测：首页点一条建议，用户气泡显示的是完整方法论提示词，卡上文字不变。

## 不做的事

- 不让生成批次（模型）产出提示词——产出口径已有 5 条硬校验，再塞一列会放大跑偏面；
- 不动 `agent_suggestions` 表结构，历史批次无需回填。
