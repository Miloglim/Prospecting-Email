## 新建 shared-contracts 契约项目

### 位置
`E:\Agents Basement\projects\shared-contracts\`（与 Prospecting Email 同级）

### 目录结构
```
shared-contracts/
├── package.json                  # "shared-contracts" v1.0.0
├── index.js                      # 主入口：聚合导出
├── src/
│   ├── channels.js               # IPC 通道名全集（16 个域，~108 条通道）
│   ├── response.js               # ok() / fail() 统一响应构建
│   ├── api.js                    # CRM Center REST API 端点定义
│   ├── events.js                 # WebSocket 事件类型常量
│   └── types.js                  # JSDoc 请求/响应类型定义
├── cli/
│   ├── validate.js               # 合规检测器入口
│   ├── scanners/
│   │   ├── scan-channels.js      # 扫描 IPC handler，对比契约
│   │   ├── scan-responses.js     # 扫描返回格式一致性
│   │   ├── scan-writes.js        # 扫描多模块写入冲突
│   │   └── scan-contract.js      # 对比现有 contract.js 的遗漏
│   └── reporter.js               # 格式化报告输出
├── test/
│   ├── channels.test.js          # 通道命名规范自检
│   └── response.test.js          # 响应格式自检
└── README.md
```

### 核心模块

| 模块 | 内容 | 解决的问题 |
|------|------|-----------|
| `channels.js` | 补全遗漏的 ~38 条通道 + 新增 `COMPANIES`/`DATA`/`AUTO_SEND` 域 | 契约不完整 |
| `response.js` | `ok()` / `fail()` 改成 `{ ok: true, data }` 格式，与所有现有 handler 对齐 | 响应格式混乱 |
| `api.js` | CRM Center 的 REST API 端点常量 | 为 CRM Center 打地基 |
| `events.js` | WebSocket 事件类型常量 | 为 CRM Center 打地基 |

### 合规检测 CLI（`validate.js`）
只读扫描器，不修改 Prospector 任何代码。输出：
- 通道覆盖报告（遗漏/未用）
- 响应格式报告（裸返回/非标准格式）
- 写入冲突报告（多模块写同一文件）
- 潜在 Bug 报告

### 与 Prospector 的集成
- `npm link shared-contracts` → 渐进式逐文件替换 `require("./modules/core/contract")` 为 `require("shared-contracts")`
- 旧的 contract.js 自然废弃，不做一次性大替换

### 实施分 5 个阶段
1. 骨架搭建（30min）
2. 常量定义（1h）
3. 合规 CLI（2h）
4. 扫描验证（30min）
5. Prospector 集成（30min）

总计约 4-5 小时