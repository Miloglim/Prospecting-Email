# 打包 + 上架规划 — 设计方案

> 目标：将 Prospecting Email（拉美开发信桌面工具）打包为 `.exe` 安装包，供内部团队使用。
> 输出目录：`E:\Agents Basement\projects\product`

## 1. 范围

### 打包包含

| 模块 | 说明 |
|------|------|
| electron/ | 主进程 + 渲染进程 + preload |
| templates/ | 15 套邮件模板 + 句库 |
| send/config.json | 预配置（SMTP/API Keys/发送规则） |
| send/signature.html | 签名模板 |
| node_modules/（剔除后） | 仅保留打包时需要的依赖 |

### 打包排除

| 模块 | 原因 |
|------|------|
| scrapling-service/ | 依赖 Puppeteer（~350MB），暂不打包 |
| puppeteer / puppeteer-extra | 同上 |
| 飞书导入功能 | 依赖 lark-cli，内部工具暂不需要 |
| reports/ | 运行时生成 |
| logs/ | 运行时生成 |
| data/（不含 config） | 运行时数据 |

### 降级策略

以下功能在缺少依赖时优雅跳过，不报 crash：

- 网页抓取（scrapling/Puppeteer）：回退至 cheerio 直连
- 飞书导入：按钮灰掉 + tooltip"需要安装飞书 CLI"
- Agnes 邮件验证：API 调用失败时返回"未校验"

## 2. 打包工具链

| 项 | 选型 | 理由 |
|----|------|------|
| 打包器 | electron-builder | 社区主流，NSIS 集成好 |
| 安装包格式 | NSIS (.exe) | Windows 原生，双击安装 |
| 包大小 | ~200MB | 剔除 Puppeteer 后显著减小 |

### package.json 改动

```json
{
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win"
  },
  "build": {
    "appId": "com.milogin.prospecting-email",
    "productName": "Prospecting Email",
    "directories": { "output": "../product" },
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
      "node_modules/**"
    ],
    "extraResources": []
  }
}
```

## 3. 上架 / 分发路径

### 当前阶段（内部测试）

```
源码构建 → .exe 安装包 → 放在共享文件夹/飞书群文件
```

- 无签名 → Windows SmartScreen 会弹警告，点"仍要运行"即可
- 无自动更新 → 新版本手动替换

### 后期可选的升级路径

| 阶段 | 动作 | 门槛 |
|------|------|------|
| **现在** | 共享文件夹分发 .exe | 零 |
| **中期** | 代码签名证书（~$300/年）→ 去掉 SmartScreen 警告 | 钱 |
| **中期** | 加 autoUpdater（electron-updater + GitHub Releases） | 半天开发 |
| **远期** | 上 Microsoft Store / 官网下载页 | 审核 + 签名 |

## 4. 安全注意事项

### 打包前必须处理

- [ ] `config.json` 中的真实密码/API Key 替换为占位符或内部统一账号
- [ ] `main.js:30` 硬编码的 `AGNES_API_KEY` 移到 config
- [ ] `.exe` 中的 `config.json` 以明文存储 — 内部工具可接受，但需告知团队

### 不建议做的事情

- 不要把个人 API Key 打包进分发的 .exe（会产生费用归属问题）
- 不要把个人邮箱密码打包进去

## 5. 补充修复（顺手修）

### API 配置缺口

当前设置页漏了以下配置项，打包前补上：

| 配置项 | config 路径 | 代码引用位置 |
|--------|-------------|--------------|
| Tavily API Key | `search.apiKey` | main.js:1027, 1543 |
| Serper API Key | `search.serperKey` | main.js:1074-1078 |
| Agnes API Key | `verify.agnesKey`（新路径） | main.js:30（当前硬编码） |

### HTML 新增字段

在 `#page-settings` 的 API 卡片中增加：

```html
<div class="form-group"><label>Tavily API Key</label><input type="password" id="cfg-search-tavily-key"></div>
<div class="form-group"><label>Serper API Key</label><input type="password" id="cfg-search-serper-key"></div>
<div class="form-group"><label>Agnes AI Key</label><input type="password" id="cfg-agnes-key"></div>
```

### CFG_KEYS 新增

```js
{ id: 'cfg-search-tavily-key', path: 'search.apiKey' },
{ id: 'cfg-search-serper-key', path: 'search.serperKey' },
{ id: 'cfg-agnes-key', path: 'verify.agnesKey' },
```

### main.js 改动

```js
// 改前（硬编码）
const AGNES_API_KEY = 'sk-...';

// 改后（读 config）
function getAgnesKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'send', 'config.json'), 'utf-8'));
    return cfg.verify?.agnesKey || '';
  } catch { return ''; }
}
```

## 6. 缺失项

- [ ] 应用图标（`assets/icon.png`，至少 256×256）
- [ ] 安装后首次启动引导（可选，当前 config 预配置即可用）

## 7. 实施步骤

1. 补 API 配置缺口（HTML + CFG_KEYS + main.js 硬编码移除）
2. 加 electron-builder 依赖和打包配置
3. 处理 Puppeteer/飞书降级（try-catch 包裹）
4. 创建应用图标
5. 执行 `npm run build` → 验证 .exe 可运行
6. 在另一台 Windows 上安装测试
