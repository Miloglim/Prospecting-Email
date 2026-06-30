# Prospecting Email — 公司背调 + 开发信生成工具

> 拉美开发信桌面工具 (Electron v1.1.0)。拖入客户表 → AI 背调 → 输出双语开发信 → 自动发送。
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


## 架构基底 (v1.1.0)

```
electron/modules/
├── core/               # 基础层 — 不依赖 Electron API
│   ├── contract.js     # 71条 IPC 通道常量 + ok()/fail() 响应助手
│   ├── logger.js       # 分级日志 (debug/info/warn/error)
│   ├── config.js       # 路径常量 + 代理配置
│   └── utils.js        # 纯函数
├── services/           # 业务层 — 不碰 IPC，deps 参数传入
│   ├── send-engine.js  # 发送引擎核心 (runSendBatch/_sendOne/buildContent)
│   └── history-store.js # 发送历史持久化
├── ipc/                # IPC 注册层 — 只做路由，调用 services
│   └── system-ipc.js   # 仪表盘/SMTP/配置/网络/签名/队列
├── send-ipc.js         # 发送控制 + 退信 IPC (126行，精简76%)
├── contacts-ipc.js / backcheck-ipc.js / template-ipc.js
renderer/modules/       # 按页面拆分，lucide 统一从 shared.js import
```

## 代码规范

- **IPC 契约优先** — 新通道先加 `contract.js` 常量 → preload.js → handler，三者双向验证
- **响应格式统一** — 逐步迁移到 `ok(data?)` / `fail(message)`，旧格式 `{ ok: true }` 可并存
- **日志用 `Log.xxx(ctx, msg, data)`** — 不裸调 `console.log`；`Log.error` 含完整 stack
- **`lucide` 统一 import** — 从 `shared.js` 导入，禁止各模块自行定义
- **配置键统一 `_seconds` 后缀** — 所有时间值配置键以 `_seconds` 结尾
- **发送引擎模块化** — `_loadConfig()` / `_buildContext()` / `_sendOne()` / `runSendBatch()`
- **config.json 无孤儿字段** — 删功能时同步清理 config。只保留 CFG_KEYS 中映射的字段
- **路径用 config.js** — 项目根路径从 `require('./modules/config').APP_ROOT` 取
- **开发模式判断** — `__dirname.includes('.asar')` 判断打包
- **状态聚合入口** — 同领域多字段状态（如公司选择/筛选/模板分配）必须通过单一模块（如 `company-state.js`）写入，禁止多文件直接操作 S.* 变量。读取随意，写入必须走聚合入口。

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


