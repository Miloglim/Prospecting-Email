# Prospecting Email — 公司背调 + 开发信生成工具

> Milogin's Prospector — 货代行业一站式客户开发工具 (v1.1.0)
> 拖入客户表 → AI 背调 → 输出定制双语开发信 → 自动发送。

---

## 💡 一句话

把跨境电商/货代客户名单变成定制化的西语/葡语开发信，并实现全自动化闭环发送。

---

## 🛠️ 已知陷阱与错题本 (Known Pitfalls)
> ⚠️ **CC 进化铁律**：CC（Claude Code）凡是执行报错、引发架构违规、或者被用户纠正错误时，必须在修复后，将教训**强制物理追加**到下表中！

| 犯错场景与时间 | 被抓到的教训（用中文大白话） | 后续如何绝对避免（物理拦截方案） |
| :--- | :--- | :--- |
| `showConfirm` 弹窗调用 | 在非 async 回调里盲目 `await` 会导致渲染进程彻底冻结。 | 改动后必须运行 `node --check` 验证语法，禁止越权。 |
| 路径常量配置 | `process.resourcesPath` 在开发模式下指向错误路径。 | 统一从 `require('./modules/config').APP_ROOT` 获取根路径。 |
| 配置键时间值命名 | 混用 `batch_pause_min` 和 `min_delay_seconds` 导致时间单位错乱。 | 所有涉及秒的时间配置键，必须强制以 `_seconds` 后缀结尾。 |
| **CC 写代码前不读 API 签名** | `deleteContact(id)` 写成 `deleteContact(email)`、preload API 名格式不符合现有模式、`getContacts()` 返回 `{ok,data}` 但直接当数组用。 | 每次写 IPC 调用前，必须先用 Grep 查目标函数的实际签名和已有调用点的参数格式。 |
| **新增模块目录未打包** | `electron/modules/auto-send/` 新增后，`npm run pack` 打出来的 asar 里缺少文件，因为 `electron-builder` 的 `files` 白名单没加 `tools/**`。 | 新增目录后，必须在 `package.json` 的 `build.files` 里确认是否覆盖；打包后用 `npx asar list xxx.asar \| findstr 新目录` 验证。 |
| **主进程→渲染进程数据格式不一致** | `webContents.send('inbox:nextFetch', rawNumber)` 发了裸数字，渲染层读 `data?.nextFetchAt` 取到 undefined。 | IPC 事件推送统一用 `{ key: value }` 对象格式，禁止发裸值。两边字段名对齐后用 Grep 双向校验。 |
| **模块加载顺序导致静默崩溃** | `require('./modules/auto-send/ipc')` 放在 `setupIPC()` 里，如果依赖链里任何模块报错，`require` 直接抛异常，Electron 窗口都没创建就崩了。 | 非核心模块的 `require` 必须包 `try-catch`，失败时 `Log.error` 但不阻塞启动。 |
| **Edit 工具匹配失败无告警** | Prettier 格式化后双引号、行尾空格变了，Edit 的 `old_string` 匹配不上，工具静默返回 error 但 CC 没检查就继续。 | Edit 调用后必须检查返回值，失败时立即 Read 目标文件确认实际内容，必要时用 Bash/Python 做替换。 |
| **Windows CRLF 导致字符串匹配失败** | `electron/preload.js` 使用 `\r\n` 行尾，Edit 工具用 `\n` 的 `old_string` 永远匹配不上。 | 跨平台文件编辑优先用 `sed` 或 Python；Edit 失败后先用 `cat -A` 检查不可见字符。 |
| **写完代码不实际运行** | 只跑 `node --check` 语法检查，不实际启动 app 验证功能。语法正确 ≠ 逻辑正确。 | 核心功能改动后，必须在 `npm run dev` 里实际触发一次目标功能，确认无报错再交付。 |
| **gitignore 忽略目录漏了占位文件（2026-07-11）** | 想忽略 `data/` 整个目录但保留 `.gitkeep`，写成 `data/` 会让 git 根本不进目录，`!data/.gitkeep` 例外失效，`git add data/.gitkeep` 直接报 ignored 错。 | 要忽略目录内容却保留占位文件时，用 `data/*` + `!data/.gitkeep`，绝不用 `data/`。 |

---

## 🚀 能做什么

| 功能 | 怎么触发 | 说明 |
|------|---------|------|
| 🔍 公司背调 | 「分析客户表」 | 逐家搜索官网/新闻/进口特征，输出背调报告 |
| ✍️ 生成开发信 | 「生成开发信」 | 基于背调生成双语（西语/葡语 + 英语）开发信 |
| 📧 自动发送 | `node send/send.js <file>` | SMTP 发送，模拟人工延迟，工作时间窗口控制 |
| 🗂️ 通用模板 | 「使用通用模板」 | 15 套预置模板（3 类客户 × 5 跟进阶段），从预设句库组装 |
| 📊 飞书对接 | 给 Token 即可 | 直接读取飞书多维表格中的客户表 |

---

## 📋 怎么用

### 1. 准备客户表
Excel/CSV，至少包含「公司名」列。额外的网站、国家、品类列能大幅提升背调精度。

### 2. 对 Claude Code (CC) 说
```text
分析客户表          → AI 逐家背调，输出报告
生成开发信          → 基于背调生成双语开发信
用通用模板发直客    → 从 15 套模板中选直客序列，组装发送
