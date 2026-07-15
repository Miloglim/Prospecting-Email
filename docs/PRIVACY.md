# 隐私与个人信息保护文档

> **最后更新**：2026-06-22
> **适用范围**：Milogin's Outreacher v1.3 及后续版本
> **合规目标**：商业化部署前完成隐私数据隔离，确保个人身份信息（PII）不进入版本控制

---

## 1. 数据分类

### 🔴 绝密级 — 严禁进入版本控制

| 类别 | 文件 | 内容 |
|------|------|------|
| SMTP 密码 | `send/config.json` | 邮箱登录密码 |
| IMAP 密码 | `send/config.json` | 退信检测邮箱密码 |
| API 密钥 | `send/config.json` | Tavily、Exa、有道翻译 API Key/Secret |
| 飞书 Base Token | `send/config.json` → `feishu.url` | 多维表格读写权限 |

**保护措施**：`send/config.json` 已加入 `.gitignore`，不提交。部署时通过环境变量注入或从加密存储读取。

---

### 🟠 敏感级 — 不应进入版本控制

| 文件 | 包含数据 | 当前状态 |
|------|----------|----------|
| `data/contacts.json` | 数千条客户邮箱、姓名、职位 | ❌ 已在 git 历史中 |
| `data/signatures.json` | 姓名、邮箱、手机号、公司名 | ❌ 已在 git 历史中 |
| `data/send-history.json` | 邮件跟踪元数据（不含正文） | ❌ 已在 git 历史中 |
| `send/send-log.json` | 收件人邮箱、发送时间、Message-ID | ✅ 已 ignore |
| `reports/*.md` | 公司背调报告（含邮箱、地址） | ⚠️ 部分 ignore |

**已修复**：`data/contacts.json`、`data/signatures.json`、`data/send-history.json`、`reports/` 已加入 `.gitignore`。

**历史清理**（新建项目仓库时执行）：
```bash
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch data/contacts.json data/signatures.json data/send-history.json" \
  --prune-empty --tag-name-filter cat -- --all
```

---

### 🟡 内部级 — 不宜公开

| 数据 | 位置 | 说明 |
|------|------|------|
| 邮箱地址 | `electron/main.js`、`docs/` | `zayne_jin@yqn.com` 等 |
| 手机号 | `data/signatures.json`、`electron/main.js` | `+86 18487665870` |
| 公司名 | 多处 | YQN Logistics Technology Group |

**保护措施**：部署前从源码中移除，改用配置文件占位符。

---

### 🟢 公开级 — 无隐私风险

| 数据 | 说明 |
|------|------|
| 模板句库 (`templates/general-templates.md`) | 通用营销话术 |
| 垃圾词黑名单 | 广告词过滤列表 |
| UI 代码 | 前端界面逻辑 |

---

## 2. 第三方服务与数据传输

| 服务 | 用途 | 传输数据 | 凭据存储 |
|------|------|----------|----------|
| SMTP (阿里企业邮箱) | 发送邮件 | 收件人、主题、正文 | `send/config.json` |
| IMAP (阿里企业邮箱) | 退信检测 | 邮箱登录 | `send/config.json` |
| Exa AI | 公司语义搜索 | 公司名 + 国家 | `send/config.json` |
| Tavily | 新闻/贸易搜索 | 公司名 + 关键词 | `send/config.json` |
| 有道翻译 | 报告翻译 | 报告文本 | `send/config.json` |
| 飞书多维表格 | 客户数据导入 | 表格字段内容 | Base Token |
| LinkedIn MCP | 决策人搜索 | 公司名 + 职位关键词 | MCP 外部管理 |
| Jina Reader | 网页抓取 | 目标 URL | 无 |

**数据传输原则**：仅向第三方发送执行业务所需的最小数据，不传输完整客户列表。

---

## 3. 本地存储

| 文件 | 路径 | 写入操作位置 |
|------|------|--------------|
| 联系人数据库 | `data/contacts.json` | `main.js:1661` |
| 发送历史 | `data/send-history.json` | `main.js:1856` |
| 发送日志 | `send/send-log.json` | `main.js:2323,2370,2382` |
| 退信日志 | `data/bounce-log.json` | `bounce-checker.js` |
| 邮件正文 | `send/bodies.json` | `main.js:saveBody()` |
| 配置 | `send/config.json` | 用户手动编辑 |

本地存储文件建议设置操作系统级权限（仅当前用户可读写）。

---

## 4. 安全配置清单

### TLS/SSL
- ⚠️ SMTP 和 IMAP 连接中 `rejectUnauthorized: false`（5 处），生产环境应改为 `true`
- 如有自签名证书问题，改用 CA 签名证书

### 邮件发送
- 使用 `zayne_jin@yqn.com` 阿里企业邮箱 SMTP（TLS 465 端口）
- 密码与 POP3/IMAP 共享

### .gitignore 覆盖
```
send/config.json
send/send-log.json
send/send-log-test.json
send/send-batch.json
data/contacts.json
data/signatures.json
data/send-history.json
data/backcheck-status.json
data/bounce-log.json
data/email-queue.json
data/template-overrides.json
reports/
```

---

## 5. 商业化前检查清单

- [ ] 清理 git 历史中的 `data/contacts.json`
- [ ] 清理 git 历史中的 `data/signatures.json`
- [ ] 移除源码中硬编码的个人邮箱和手机号
- [ ] `send/config.example.json` 使用占位符替代真实值
- [ ] 确认所有 `rejectUnauthorized: false` 是否需要修复
- [ ] 审查第三方 API 的数据传输合规性（GDPR/个保法）
- [ ] 确认 `.gitignore` 覆盖所有敏感数据文件
- [ ] 建立密钥轮换机制（API Key/密码定期更换）
- [ ] 制定数据备份和恢复策略
