# 打包 + 上架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Prospecting Email 打包为 Windows `.exe` 安装包，内部团队双击即用。

**Architecture:** electron-builder + NSIS → 单文件安装包，排除 Puppeteer/飞书依赖，缺依赖时优雅降级，预配置 config 内置。

**Tech Stack:** electron-builder (打包), NSIS (安装器), Node.js (无需额外安装)

## Global Constraints

- 输出目录：`E:\Agents Basement\projects\product`
- 目标平台：仅 Windows (NSIS)
- 打包排除：`scrapling-service/`, `puppeteer`, `puppeteer-extra`
- config.json 预配置内置，团队成员无需手动配置
- API 设置页补齐 Tavily / Serper / Agnes 三项
- main.js 移除硬编码 AGNES_API_KEY

---

## 文件变更概览

| 文件 | 动作 | 内容 |
|------|------|------|
| `electron/renderer/index.html` | 修改 | API 卡片加 3 个输入框 |
| `electron/renderer/app.js` | 修改 | CFG_KEYS 加 3 条配置映射 |
| `electron/main.js` | 修改 | 硬编码移除 + 顶部 lazy require + 降级处理 |
| `package.json` | 修改 | 加 electron-builder 依赖和 build 配置 |
| `assets/icon.png` | 创建 | 应用图标（256×256） |

---

### Task 1: 补齐 API 配置缺口

**Files:**
- Modify: `electron/renderer/index.html` — 在 Exa Key 和翻译引擎之间插入 Tavily/Serper/Agnes 输入框
- Modify: `electron/renderer/app.js:3480-3492` — CFG_KEYS 新增 3 条
- Modify: `electron/main.js:29-33` — 移除硬编码，改为动态读取 config

**Interfaces:**
- Consumes: 现有 `loadSettingsIntoForm()` / `collectSettingsFromForm()` 通过 CFG_KEYS 映射自动读写
- Produces: `config.json` 中 `search.apiKey`, `search.serperKey`, `verify.agnesKey` 可通过设置页管理

---

- [ ] **Step 1: HTML — 在 API 卡片中插入 3 个新输入框**

在 `electron/renderer/index.html` 的 Exa AI Key 后面（`cfg-search-exa-key` 的 `</div>` 之后、`setting-section` 翻译引擎之前），插入：

```html
          <div class="setting-section"><h4><span data-icon="search"></span> Tavily</h4></div>
          <div class="form-group"><label>API Key</label><input type="password" id="cfg-search-tavily-key" placeholder="tvly-dev-..."></div>
          <div class="form-note">新闻动态搜索，用于背调报告的"近期动态"部分</div>
          <div class="form-quick"><a href="#" class="quick-link" data-url="https://tavily.com/"><span data-icon="external-link"></span> 获取 Tavily API Key</a></div>
          <div class="setting-section"><h4><span data-icon="search"></span> Serper (Google)</h4></div>
          <div class="form-group"><label>API Key</label><input type="password" id="cfg-search-serper-key" placeholder="2c0e..."></div>
          <div class="form-note">Google 搜索回退渠道，Exa 超时/无结果时自动启用</div>
          <div class="form-quick"><a href="#" class="quick-link" data-url="https://serper.dev/"><span data-icon="external-link"></span> 获取 Serper API Key</a></div>
          <div class="setting-section"><h4><span data-icon="check-circle"></span> Agnes AI（邮件验证）</h4></div>
          <div class="form-group"><label>API Key</label><input type="password" id="cfg-agnes-key" placeholder="sk-..."></div>
          <div class="form-note">AI 开发信质量检查（写作规范、垃圾词扫描），不填则跳过验证</div>
```

精确插入位置：在 `<!-- 飞书 -->` 之前、Exa AI 的 `</div>`（`cfg-search-exa-key` 所在 setting-card）之后。

- [ ] **Step 2: CFG_KEYS — 添加 3 条配置映射**

在 `electron/renderer/app.js` 的 `CFG_KEYS` 数组中，`cfg-search-exa-key` 之后插入：

```js
  { id: 'cfg-search-tavily-key', path: 'search.apiKey' },
  { id: 'cfg-search-serper-key', path: 'search.serperKey' },
  { id: 'cfg-agnes-key', path: 'verify.agnesKey' },
```

精确位置：`{ id: 'cfg-search-exa-key', path: 'search.exaKey' },` 行之后。

- [ ] **Step 3: main.js — 移除硬编码 AGNES_API_KEY**

`electron/main.js` 第 29-32 行，将：

```js
// ── Agnes 开发信验证 ─────────────────────────────────────────────────
const AGNES_API_KEY = 'sk-0vA9fyvTQt4mrlYnSu92daAmZnuZt5CiyBTOZ7jLq7xhKY42';
const AGNES_ENDPOINT = 'https://apihub.agnes-ai.com/v1/chat/completions';
```

改为：

```js
// ── Agnes 开发信验证 ─────────────────────────────────────────────────
const AGNES_ENDPOINT = 'https://apihub.agnes-ai.com/v1/chat/completions';
// ponytail: 从 config 读 key，打包时 config 预配置
function getAgnesKey() {
  try {
    const cfgPath = path.join(__dirname, '..', 'send', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.verify?.agnesKey || '';
    }
  } catch {}
  return '';
}
```

然后在 `verifyEmailWithAgnes` 函数内（约第 34 行），将使用 `AGNES_API_KEY` 的地方改为 `const apiKey = getAgnesKey();`，若为空则直接返回。

- [ ] **Step 4: 验证 — 启动 app 检查设置页**

启动命令：`npm start`

验证点：
- 设置页 API 卡片出现 Tavily / Serper / Agnes 三个新区域
- 每个区域有输入框 + 获取链接
- 输入 Key 后切换到其他页面再切回，值保持（自动保存生效）
- 无 JS console 报错

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/index.html electron/renderer/app.js electron/main.js
git commit -m "feat: API 设置补齐 Tavily/Serper/Agnes，移除硬编码 Agnes Key

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Puppeteer / Scrapling / 飞书 优雅降级

**Files:**
- Modify: `electron/main.js:7-14` — 顶部 require 改为 lazy
- Modify: `electron/main.js:25-27` — scrapling 启动逻辑加保护

**Interfaces:**
- Consumes: `callScraplingAPI()`, `startScraplingService()`, `ddgSearch()`, 飞书导入 handler
- Produces: 缺少依赖时函数返回 `false` / `null`，不抛异常，调用方已有 `try-catch` 自然降级

---

- [ ] **Step 1: main.js — puppeteer 改为 lazy require**

`electron/main.js` 第 11-13 行，将：

```js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
```

改为：

```js
// ponytail: lazy require，打包后无 puppeteer 时优雅降级
let _puppeteer = null;
function getPuppeteer() {
  if (_puppeteer !== null) return _puppeteer;
  try {
    const p = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    p.use(StealthPlugin());
    _puppeteer = p;
    return _puppeteer;
  } catch { _puppeteer = false; console.log('[降级] puppeteer 不可用，DDG 搜索已禁用'); return null; }
}
```

`ddgSearch` 函数中（约第 866 行），`puppeteer.launch(...)` 改为：

```js
const p = getPuppeteer();
if (!p) return '';  // 降级：无 Puppeteer 时跳过 DDG 搜索
browser = await p.launch({ ... });
```

- [ ] **Step 2: main.js — scrapling 启动加保护**

`startScraplingService` 函数开头（约第 98 行），在 `spawn` 调用之前，Python 不存在时直接 return：

```js
function startScraplingService() {
  return new Promise((resolve) => {
    // 先检查 health
    http.get(`http://127.0.0.1:${SCRAPLING_PORT}/health`, { timeout: 2000 }, (res) => {
      console.log('[scrapling] 服务已在运行');
      resolve(true);
    }).on('error', () => {
      const serviceDir = path.join(__dirname, '..', 'scrapling-service');
      const scriptPath = path.join(serviceDir, 'scrape_service.py');
      // ponytail: 打包后 scrapling-service 不存在时静默降级
      if (!fs.existsSync(scriptPath)) {
        console.log('[降级] scrapling-service 未安装，网页抓取功能不可用');
        resolve(false);
        return;
      }
      // ... 原有 spawn 逻辑不变
```

`callScraplingAPI` 函数开头加超时保护（已经有 timeout: 30000，无需改动）。

- [ ] **Step 3: 飞书导入按钮 — 运行时检测**

`electron/renderer/app.js` 中飞书导入按钮的点击处理（搜索 `feishu-import-btn`），开头加检测：

```js
document.getElementById('feishu-import-btn')?.addEventListener('click', async () => {
  // ponytail: 飞书 CLI 不可用时提示
  try {
    const { execSync } = require('child_process');
    execSync('lark-cli --version', { stdio: 'ignore', timeout: 3000 });
  } catch {
    alert('飞书 CLI 未安装。请联系管理员获取安装包。\n\n或使用拖入 Excel/CSV 文件导入。');
    return;
  }
  // ... 原有导入逻辑
});
```

- [ ] **Step 4: 验证 — 启动 app，确认无 crash**

启动命令：`npm start`

验证点：
- 开发环境 Puppeteer 正常，不该看到降级日志
- 切换到背调页面，点搜索，功能正常
- 飞书导入按钮正常（有 lark-cli 则导入，无则提示）
- console 无 `Cannot find module` 之类的 crash

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/renderer/app.js
git commit -m "feat: Puppeteer/Scrapling/飞书降级处理，缺依赖不崩溃

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: electron-builder 打包配置

**Files:**
- Modify: `package.json` — 加 build 脚本 + electron-builder devDep + build 配置块
- Create: `assets/icon.png` — 应用图标

**Interfaces:**
- Consumes: `package.json` 现有字段 (name, version, main, dependencies)
- Produces: `npm run build` → `E:\Agents Basement\projects\product\Prospecting Email Setup x.x.x.exe`

---

- [ ] **Step 1: 安装 electron-builder**

```bash
cd "E:\Agents Basement\projects\Prospecting Email"
npm install --save-dev electron-builder
```

- [ ] **Step 2: package.json — 加 build 配置和脚本**

在 `package.json` 中：

1. `scripts` 加 `"build": "electron-builder --win"`
2. 加顶层 `"build"` 配置块

```json
"scripts": {
  "start": "electron .",
  "build": "electron-builder --win"
},
"build": {
  "appId": "com.milogin.prospecting-email",
  "productName": "Prospecting Email",
  "directories": {
    "output": "../product"
  },
  "win": {
    "target": "nsis",
    "icon": "assets/icon.png"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true
  },
  "files": [
    "electron/**",
    "templates/**",
    "send/config.json",
    "send/signature.html",
    "node_modules/**",
    "assets/**",
    "package.json"
  ],
  "extraResources": [
    {
      "from": "send/config.json",
      "to": "send/config.json"
    }
  ]
}
```

- [ ] **Step 3: 创建应用图标**

用 Canvas 生成一个简单的 256×256 PNG 图标（或从现有素材中找），放到 `assets/icon.png`。

最简方案 — 在项目根目录跑一个生成脚本（一次性）：

```bash
node -e "
const { createCanvas } = require('canvas');
// 如果没有 canvas 模块，手动创建 assets/ 并放任意 icon.png
// 或从 https://placehold.co/256x256/2563eb/ffffff?text=PE 下载
"
```

> ponytail: Electron 必须有一个 `.png` 图标才能打包。如果没有 canvas 模块，最简单的办法是手动放一个 256×256 的 PNG 到 `assets/icon.png`。可以用 Windows 画图做一个，或从网上下载占位图标。

- [ ] **Step 4: 验证打包**

```bash
npm run build
```

验证点：
- 命令无报错
- `E:\Agents Basement\projects\product\` 下生成 `Prospecting Email Setup x.x.x.exe`
- 双击安装 → 桌面出现快捷方式 → 启动 app
- 设置页 SMTP/API 配置已预填
- 背调功能正常
- 发信功能正常（测试模式）

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json assets/icon.png
git commit -m "feat: electron-builder 打包配置，输出 NSIS 安装包

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 清理 + 最终验证

**Files:**
- 无代码改动，仅验证

- [ ] **Step 1: 确认 .gitignore 不遗漏**

检查 `dist/`, `out/`, `product/` 都在 `.gitignore` 中：

```bash
grep -E "dist|out|product" .gitignore
```

缺失则补充：
```
# 打包产物
product/
```

- [ ] **Step 2: 在另一台 Windows 上测试安装**

在没有开发环境的 Windows 电脑上：
1. 复制 `product/Prospecting Email Setup x.x.x.exe`
2. 双击安装
3. 启动 → 检查功能正常
4. 卸载 → 确认干净

- [ ] **Step 3: 打包 config 安全检查**

确认 `send/config.json` 中不存在个人真实密码/Key。如有，替换为内部统一账号或占位符。

- [ ] **Step 4: 最终 Commit + Tag**

```bash
git add -A
git commit -m "chore: 打包前清理，补 gitignore
Co-Authored-By: Claude <noreply@anthropic.com>"
git tag v1.5.0-beta1
git push --tags
```
