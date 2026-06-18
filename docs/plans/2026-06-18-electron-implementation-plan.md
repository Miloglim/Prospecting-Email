# Prospecting Email Electron 桌面应用 — 实现计划

**目标：** 将 Prospecting Email 工具包装为 Electron 桌面应用，覆盖导入 → 背调 → 组装 → 发送 → 追踪全流程
**架构：** Electron 主进程（nodemailer 发送 + 脚本桥接） + 渲染进程（5 页面 SPA）
**方案：** 发送逻辑完全重写到主进程，不依赖现有 send.js 脚本；模板系统 + 客户表导入逻辑也迁移到主进程

---

## 任务清单（共 11 个任务，按依赖排序）

---

### 任务 1：Electron 项目骨架

**文件：**
- 修改：`package.json`
- 创建：`electron/main.js`
- 创建：`electron/preload.js`

**步骤：**
1. `npm install electron --save-dev`
2. 在 `package.json` 添加 `"main": "electron/main.js"` 和 `"start": "electron ."`
3. 写 `main.js`：创建 BrowserWindow（1280×800），加载 `electron/renderer/index.html`
4. 写 `preload.js`：暴露 `window.electronAPI` 空对象（后续逐步填充）
5. `npm start` 验证空白窗口出现

**验证：** `npm start` → 空白 Electron 窗口打开，标题为 "Prospecting Email"

---

### 任务 2：渲染进程页面框架

**文件：**
- 创建：`electron/renderer/index.html`
- 创建：`electron/renderer/styles.css`
- 创建：`electron/renderer/app.js`

**步骤：**
1. `index.html`：左侧 `<nav>`（5 个导航项 + 设置）+ 右侧 `<main>`（5 个 `<section>`，默认显示仪表盘）
2. `styles.css`：CSS 变量定义色板（深蓝 #1a237e 主色）、左侧 200px 导航栏、右侧弹性内容区、系统字体栈
3. `app.js`：导航点击切换 section 显示/隐藏、当前选中高亮
4. 每个 section 填充占位标题

**验证：** 点击左侧 5 个导航项，右侧内容区随之切换，仪表盘默认显示

---

### 任务 3：仪表盘页面

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/styles.css`
- 修改：`electron/renderer/app.js`
- 修改：`electron/preload.js`
- 修改：`electron/main.js`

**步骤：**
1. HTML：4 个指标卡片（今日已发/剩余限额/队列待处理/SMTP 状态）+ 最近背调列表
2. CSS：卡片网格布局（2×2）+ 数字大字体 + 状态指示灯（绿/黄/红）
3. preload.js：暴露 `getDashboardStats()` → 主进程 IPC handler 读取 `send/send-log.json` 返回统计数据
4. main.js：注册 IPC handler `dashboard:getStats`，读取 send-log.json + config.json
5. app.js：页面加载时调用 `window.electronAPI.getDashboardStats()` 填充卡片

**验证：** 打开仪表盘 → 4 个指标卡片显示真实数据（基于现有 send-log.json），SMTP 指示灯绿色

---

### 任务 4：客户表导入页

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/styles.css`
- 修改：`electron/renderer/app.js`
- 修改：`electron/preload.js`
- 修改：`electron/main.js`
- `npm install xlsx --save`

**步骤：**
1. HTML：拖拽上传区（虚线框 + 提示文字）+ 飞书 Token 输入区（两个输入框 + 拉取按钮）+ 表格容器
2. CSS：拖拽区 hover 高亮、表格斑马纹、状态标签样式
3. preload.js：暴露 `importFile(filePath)` 和 `importFeishu(baseToken, tableId)`
4. main.js：IPC handler 用 `xlsx` 库解析 Excel/CSV → 返回行数组；飞书拉取用 `lark-cli` 子进程
5. 表格列：公司名 / 国家 / 品类 / 邮箱 / 背调状态
6. 表格支持行勾选（checkbox），为背调做准备

**验证：** 拖入一个 Excel 文件 → 表格显示所有行；勾选功能正常

---

### 任务 5：背调详情页

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/styles.css`
- 修改：`electron/renderer/app.js`
- 修改：`electron/preload.js`
- 修改：`electron/main.js`

**步骤：**
1. HTML：左侧公司列表（从客户表同步已勾选的公司）+ 右侧信息卡（官网/规模/品类/进口特征/近期动态/收件人邮箱）
2. CSS：列表选中高亮、信息卡字段标签 + 值排版
3. preload.js：暴露 `getBackcheckReports()` 读取 `reports/` 目录
4. main.js：IPC handler 扫描 `reports/` 目录下的 `.md` 文件，解析 YAML frontmatter 或 Markdown 结构化字段
5. 信息卡底部：「生成开发信」按钮 → 携带公司数据跳转到邮件工坊页
6. 公司列表项右侧显示状态图标（已背调 ✅ / 未背调 ⬜）

**验证：** 左侧显示已有背调报告的公司列表，点击公司 → 右侧显示完整信息卡

---

### 任务 6：邮件工坊 — 模板引擎加载

**文件：**
- 修改：`electron/main.js`
- 修改：`electron/preload.js`

**步骤：**
1. main.js 启动时解析 `templates/general-templates.md`：
   - 用正则提取 9 个句库的编号 + 西语 + 英语
   - 用正则提取 3 套主题行
   - 构建为 JS 对象：`{ hooks: [...], painPoints: { agent: [...], direct: [...], unlabeled: [...] }, proofs: {...}, ctas: [...], followUps: {...} }`
2. IPC handler `template:getLibrary` 返回完整句库对象
3. IPC handler `template:getSubjects(type)` 返回指定类型的主题行
4. preload.js 暴露 `getTemplateLibrary()` 和 `getSubjects(type)`

**验证：** 主进程启动日志输出 "模板库加载完成: 64 条句库, 3 套主题行"

---

### 任务 7：邮件工坊 — 组装区 + 预览区

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/styles.css`
- 修改：`electron/renderer/app.js`

**步骤：**
1. HTML 组装区（左侧 40%）：
   - 对象类型下拉框（代理/直客/未标签）
   - 跟进阶段下拉框（冷开发/F1/F2/F3/F4）
   - 4 个句库下拉框（Hook / 痛点 / 证明 / CTA），根据对象类型动态过滤选项
   - 衔接句下拉框（仅 F1-F4 显示）
   - hover 下拉选项时 tooltip 显示完整句子预览
2. HTML 预览区（右侧 60%）：
   - 主题行显示（只读）
   - 邮件正文实时渲染（西语/英语标签切换）
   - 垃圾词检测指示灯（绿色通过 / 红色警告 + 列出违规词）
3. CSS：左右分栏、下拉框样式、预览区模拟邮件客户端效果（白色卡片 + 等宽字体）
4. app.js：
   - 加载模板库 → 填充所有下拉框
   - 对象类型切换 → 过滤句库 + 更新主题行
   - 任何下拉框变化 → 实时重新组装邮件正文
   - 垃圾词实时检测函数（正则匹配黑名单）
5. 底部操作栏：「加入发送队列」按钮 + 「立即发送」按钮

**验证：** 
- 切换对象类型 → 句库下拉框内容变化 + 主题行更新
- 切换任何下拉框 → 右侧预览区实时更新完整双语邮件
- 输入垃圾词 → 指示灯变红并列出违规词

---

### 任务 8：邮件工坊 — 自定义编辑

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/app.js`

**步骤：**
1. 预览区正文变为可编辑 `<textarea>`（默认显示组装结果，可手动修改）
2. 「重置」按钮 → 恢复为当前句库选择对应的默认文本
3. 编辑后自动重新检测垃圾词
4. 加入队列时保存的是编辑后的文本

**验证：** 修改预览区正文文本 → 垃圾词检测重新触发 → 点击重置恢复默认

---

### 任务 9：发送引擎（主进程）

**文件：**
- 修改：`electron/main.js`
- 修改：`electron/preload.js`
- `npm install nodemailer --save`（已在 dependencies 中）

**步骤：**
1. main.js 中实现 `EmailSender` 类：
   ```
   class EmailSender {
     constructor(config)        // 从 send/config.json 读取 SMTP + 发送规则
     async sendOne(email)       // 单封发送，返回 { status, messageId, error }
     async sendBatch(emails)    // 批量发送，逐封调用 sendOne，每封 IPC 推送进度
     getStatus()                // 返回 { sent, failed, remaining, dailyLimit }
   }
   ```
2. 保留所有发送规则：
   - 随机延迟（45-120 秒）
   - 工作时间窗口（北京时间 19:00-03:00）
   - 每日限额（500 封）
   - 自动记录 send-log.json
3. IPC handler：
   - `send:start(emails)` → 启动批量发送，逐封 `send:progress` push
   - `send:pause()` → 暂停（完成当前封后停止）
   - `send:status()` → 返回当前状态
4. preload.js 暴露：`startSend(emails)`, `pauseSend()`, `getSendStatus()`, `onSendProgress(callback)`
5. `onSendProgress` 用 `ipcRenderer.on` 监听主进程推送

**验证：** 从渲染进程传入 3 封测试邮件 → 主进程逐封发送 → 渲染进程收到 3 次进度回调

---

### 任务 10：发送队列页

**文件：**
- 修改：`electron/renderer/index.html`
- 修改：`electron/renderer/styles.css`
- 修改：`electron/renderer/app.js`

**步骤：**
1. HTML：
   - 队列表格（公司 / 收件人 / 主题 / 状态图标 / 时间）
   - 进度条（已发送/总数）
   - 操作按钮（开始发送 / 暂停 / 清空已完成）
   - 失败记录折叠区
2. CSS：进度条动画、状态图标颜色（待发送 ⬜ / 发送中 🔄 / 已发送 ✅ / 失败 ❌）
3. app.js：
   - 加载时读取队列（内存数组 + 可选持久化到 send-batch.json）
   - 开始发送 → 调用 `window.electronAPI.startSend(queue)`
   - 监听 `onSendProgress` → 更新对应行状态 + 进度条
   - 发送完成 → 更新仪表盘数据
4. 支持从邮件工坊「加入发送队列」追加、支持手动删除队列项

**验证：** 
- 从邮件工坊加入 2 封 → 队列显示 2 封
- 开始发送 → 逐封状态更新 → 进度条前进
- 发送完成 → 仪表盘今日已发 +2

---

### 任务 11：系统托盘 + 应用生命周期

**文件：**
- 修改：`electron/main.js`

**步骤：**
1. 创建系统托盘图标 + 右键菜单（显示窗口 / 暂停发送 / 退出）
2. 关闭窗口 → 最小化到托盘（不退出），托盘提示 "Prospecting Email 正在后台运行"
3. 发送完成 → 托盘通知 "发送完成: 15/15"
4. 发送错误 → 托盘通知 "发送失败: XXX 公司 - 连接超时"
5. macOS 适配：Dock 图标 + 托盘（`app.dock.hide()` 可选）

**验证：** 
- 关闭窗口 → 应用仍在托盘运行
- 发送进行中关闭窗口 → 托盘图标显示进度
- 发送完成 → 托盘弹出通知

---

## 任务依赖图

```
任务 1 (骨架)
  └→ 任务 2 (页面框架)
       ├→ 任务 3 (仪表盘)
       ├→ 任务 4 (客户表)
       │    └→ 任务 5 (背调详情)
       ├→ 任务 6 (模板引擎)
       │    └→ 任务 7 (邮件工坊组装)
       │         └→ 任务 8 (自定义编辑)
       └→ 任务 9 (发送引擎)
            └→ 任务 10 (发送队列)
                 └→ 任务 11 (系统托盘)
```

可并行：任务 3、任务 4、任务 6 无依赖关系，可同时进行。
任务 9 独立于 UI，可与任务 6-8 并行。

---

## 技术选型

| 层 | 技术 |
|----|------|
| 框架 | Electron 33+ |
| UI | 原生 HTML/CSS/JS（无框架），CSS 变量 + Flexbox |
| Excel 解析 | `xlsx` 库 |
| 邮件发送 | `nodemailer`（已在 dependencies） |
| 模板解析 | 正则 + JS 对象（启动时解析 Markdown） |
| IPC | Electron `ipcMain` / `ipcRenderer` + `contextBridge` |
| 存储 | JSON 文件（send-log.json 不变）+ 内存队列 |
