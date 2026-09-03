# Prospector

> 国际货代 / 外贸销售的客户开发与跟进桌面工具 — 找客户、背调、写开发信、批量发信、追回复，一个窗口里闭环。

**当前版本 v5.0.0** · 下载与更新记录见 [Releases](https://github.com/Miloglim/Prospecting-Email/releases)。应用内置自动更新（每 4 小时检查一次）。

## 它做什么

- **客户库**：联系人 / 公司两级档案，支持批量导入（粘贴任意格式名单、邮箱签名即可，邮箱为唯一键）
- **AI 写开发信**：按客户背景生成 EN / ES / PT 草稿，可存进素材库复用
- **公司背调**：接入 Exa / Tavily 检索公开资料，产出主营品类、进口活跃度、货代契合点与风险
- **批量发信**：多邮箱账号轮换、发信时间窗、组间与同公司间隔暂停、每日限额、失败熔断与瞬态重试
- **收件箱**：IMAP 拉取并自动分类（询盘 / 回复 / 退信 / 自动回复），匹配回联系人，退信可一键处理
- **CRM 跟进**：管线看板、到期与逾期提醒、跟进时间线、沉默超期标红
- **运价库**：同步运价快照为本地镜像，可按航线 / 船司 / 柜型 / 目的港查询

## AI 助手

对话里可直接查数据、也能把结论落成业务动作（写操作一律弹确认并展示将改哪些字段，确认后仍留审计记录）：

- **只读**：运价、联系人、收件箱、邮件总结、到期提醒、队列进度、账号健康、公司背调、航线公开市场行情调研（多源检索 → 逐页核实 → 标注可信度 → 出带来源链接的报告）
- **生成**：开发信 / 跟进信 / 回信草稿
- **写入（需确认）**：记跟进、加入客户库、写公司档案、入队发送、标记已读与已流失
- **跨页联动**：联系人、邮件、运价、发送队列都有「问 AI」入口，带着当前对象跳转对话
- **模型可换**：设置 → 模型与端点，多档端点一键切换（保存即生效，无需重启），带真连通性测试；海外端点自动检测本地代理
- 能力回归由 25 张归因评测卡把关：`npm run eval:agent`

## 技术栈与架构

Electron + TypeScript + electron-vite · React + Ant Design + @ant-design/x + Tailwind · Drizzle ORM（运行时 better-sqlite3/WAL，测试用 sql.js）· @openai/agents · nodemailer / imapflow

```
src/main/services/     业务逻辑与数据访问（禁止 import electron）
src/main/transport/    IPC 路由（只做参数校验 + 调 service）
src/main/contract.ts   IPC 通道唯一事实源
src/renderer/          界面（页面、组件、事件订阅）
```

三档权限：`L0` 读自动放行 · `L2` 写必须人工确认 · `L3` 改删类不注册进工具表。模型 trace 全局禁用，业务数据不出本机（除所配置的模型端点与搜索服务）。

## 跑起来

```bash
npm install
npm run dev          # 开发（含界面热更新；主进程改动需重启）
npm test             # 单元与集成测试
npm run typecheck    # 类型检查
npm run build        # 三段构建（main / preload / renderer）
npm run pack         # 打 Windows 安装包 → ../dist-release
```

配置放项目根目录 `.env`（已 gitignore，密钥不入库）：

| 变量 | 用途 |
|---|---|
| `AGENT_API_BASE_URL` / `AGENT_API_KEY` / `AGENT_MODEL` | 对话与能力调用的生效端点（可由设置页写入） |
| `AGENT_THINKING` | 是否输出推理过程（影响首字速度） |
| `LIGHT_API_BASE_URL` / `LIGHT_KEY_ENV` / `LIGHT_MODEL` | 轻任务档（邮件总结、背调报告、会话压缩），不填则用主端点 |
| `EXA_API_KEY` / `TAVILY_API_KEY` | 联网检索源：公司背调与航线行情调研共用（都不配则这两类能力会明确报「未配置」） |
| `KB_BASE_URL` / `KB_TOKEN` / `KB_APPLICATION_ID` | 公司内网 KB 中转（可选） |
| `GH_TOKEN` / `GITHUB_TOKEN` | 读取 releases 与自动更新检查用（私有仓库或限流时需要） |

数据落在 `data/`、运行设置与端点档案在 `send/config.json`、`ai/providers.json`（均不入库）。

## 发信前的安全阀

设置里有**测试模式（dryRun）**：开启后真实外发被拦截并记为模拟发送，收件与库内操作照常。首次上生产建议按「全量 dryRun → 只发自己邮箱两三封 → 小配额」三步放量。发信账号在设置页可做真实 SMTP / IMAP 连通性校验（会区分密钥无效、超时、无法连接、握手失败）。

## 发版

`package.json` 改版本 → 提交 → 打 tag `vX.Y.Z` → 推代码与 tag → `npm run pack` → 建 Release，**必须挂上 `latest.yml`**（缺它自动更新不生效）。
