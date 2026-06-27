# Prospecting Email — 公司背调 + 开发信生成工具

> 拉美开发信桌面工具 (Electron v1.3)。拖入客户表 → AI 背调 → 输出双语开发信 → 自动发送。
> 默认市场：墨西哥、巴西、智利、秘鲁、哥伦比亚（西语/葡语）。

## 故障排查

出问题先看 `logs/app-YYYY-MM-DD.log`，不要盲读代码。

| 查什么 | 搜什么 |
|--------|--------|
| 背调失败 | 搜公司名 |
| 发送异常 | `ERROR\|FATAL\|发信` |
| API 超时 | `agent-reach\|scrapling\|timeout` |
| 启动崩溃 | `FATAL` |

## 背调搜索渠道

| 优先级 | 平台 | 用途 | 调用方式 |
|--------|------|------|----------|
| P0 | Exa AI | 语义搜索 | `mcporter call 'exa.web_search_exa(query: "<公司名> <国家> company profile", numResults: 5)'` |
| P0 | Jina Reader | 官网抓取 | `curl -s "https://r.jina.ai/<URL>" -H "Accept: text/markdown"` |
| P0 | WebSearch | 补充搜索 | Claude Code 内置 |
| P1 | Tavily | 新闻动态 | `tvly search --topic news "<公司名>"` |
| P1 | LinkedIn | 决策人/招聘 | `mcporter call 'linkedin.search_people(keyword: "<公司名> procurement OR compras", limit: 10)'` |

## 写作约束

- 🈲 代理不提本地仓库/本地团队
- 🈲 同一封不同时出现船东名 + 具体运价
- 🈲 不对海外客户用 digital/AI/平台等技术词汇
- 🈲 不用最高级/紧迫词/夸大承诺/价格诱饵
- ✅ 西语在前，英语在后
- ✅ 第二人称，不教客户做事
- ✅ CTA 是「给」不是「要」

## 代码规范

- **配置键统一 `_seconds` 后缀** — 所有时间值配置键以 `_seconds` 结尾
- **发送引擎模块化** — `_loadConfig()` / `_buildContext()` / `_sendOne()` / `runSendBatch()`，新增功能沿用此结构
- **渲染进程按功能域拆分** — `app.js` 超 800 行时按 shared/send/workshop/contacts/backcheck/settings 拆为 6 个 ES module（规划见 `docs/p2-renderer-split.md`）
- **IPC 有增必查** — 加新 IPC 通道时，preload.js + main handler 双向验证
- **config.json 无孤儿字段** — 删功能时同步清理 config。只保留 CFG_KEYS 中映射的字段
- **路径用 config.js** — 项目根路径从 `require('./modules/config').APP_ROOT` 取，不自己推导
- **开发模式判断** — `__dirname.includes('.asar')` 判断打包，不依赖 `process.resourcesPath`

## 已知陷阱

| 陷阱 | 教训 | 预防 |
|------|------|------|
| `confirm()` → `showConfirm()` | `await` 加在非 async 回调里 → 整个渲染进程冻结 | 改完用 `node --check` 验证语法；grep 所有调用点 |
| logger 路径 | `process.resourcesPath` 开发模式指向 `node_modules/electron/dist` | 用 `__dirname.includes('.asar')` 判断 |
| 配置键无 `_seconds` 后缀 | `batch_pause_min` vs `min_delay_seconds` 不一致 | 新时间配置键一律 `_seconds` |
| 批处理/多规则混在 `runSendBatch` | 修一个模式影响另一个 | 提取 `_buildContext()` 做参数分流 |

## 工作方式

1. **始终启用 ponytail** — 删比加好，标准库优先，不造轮子
2. **产品级代码** — 目标商业化。不写临时代码，加功能前先整理
3. **有序列表 = 方案讨论** — 用户列 `1. 2. 3.` 时只设计不动代码
4. **命名纠偏** — 回复中标注 `[用户叫法]` → 正确组件名
5. **说人话** — 简明清晰，少用术语

## 参考文档

| 文件 | 内容 |
|------|------|
| `docs/email-writing-rules.md` | 写作准则 + 拉美文化适配 |
| `docs/backcheck-rules.md` | 开发价值评分规则 |
| `templates/general-templates.md` | 模板句库 + 垃圾词黑名单 |
| `docs/p2-renderer-split.md` | 渲染进程拆分方案 |
