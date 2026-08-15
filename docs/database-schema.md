# Prospector v4.0 — 数据库 Schema

## 概述
SQLite（sql.js 内存模式），Drizzle ORM，数据库文件 `data/prospector.db`。

---

## contacts — 联系人（核心表）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | 自增 | |
| `email` | TEXT UNIQUE NOT NULL | — | 唯一标识，收件箱匹配用此字段 |
| `company_id` | INTEGER | NULL | → `companies.id` |
| `first_name` | TEXT | NULL | |
| `last_name` | TEXT | NULL | |
| `title` | TEXT | NULL | 职位 |
| `phone` | TEXT | NULL | |
| `linkedin` | TEXT | NULL | LinkedIn URL |
| `country` | TEXT | NULL | |
| `client_type` | TEXT | NULL | `agent`(代理) / `direct`(直客) / NULL(未设置)。AI 背调自动识别，用户可改 |
| `stage` | TEXT | `"cold"` | 发送阶段：cold → f1 → f2 → f3 → f4 |
| `status` | TEXT | NULL | 联系人状态：reached(已触达) / replied(已回复) / autoreply(自动回复) / bounced(退信)。**已触达仅用户手动设置或改标签触发**；replied/autoreply/bounced 由收件箱自动检测覆盖 |
| `tags` | TEXT | NULL | CRM 标签，固定 6 值单选 JSON 数组（`["reaching"]` 等）；NULL=未设置。设标签且有值且状态≠已触达 → 状态覆盖为已触达 |
| `extra` | TEXT | `"{}"` | 扩展 JSON：提醒、偏好等 |
| `assignee` | TEXT | `""` | 负责人 |
| `source` | TEXT | `"manual"` | 来源：manual / import / search |
| `source_detail` | TEXT | NULL | 来源详情（搜索关键词、导入文件名等） |
| `created_at` | TEXT | CURRENT_TIMESTAMP | |
| `updated_at` | TEXT | CURRENT_TIMESTAMP | |

---

## companies — 公司

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | 公司名称 |
| `domain` | TEXT | 官网域名 |
| `industry` | TEXT | 行业 |
| `country` | TEXT | |
| `size` | TEXT | 规模 |
| `backcheck_data` | TEXT | AI 背调结果 JSON |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

---

## email_accounts — 发信账号

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | | |
| `email` | TEXT UNIQUE NOT NULL | | 邮箱地址 |
| `provider` | TEXT | `"smtp"` | |
| `smtp_host` | TEXT | | SMTP 服务器 |
| `smtp_port` | INTEGER | | 通常 465(SSL) 或 587(TLS) |
| `imap_host` | TEXT | | IMAP/POP3 服务器 |
| `imap_port` | INTEGER | | 993(IMAP) / 995(POP3) |
| `encrypted_pass` | TEXT NOT NULL | | AES-256-GCM 加密（格式: `iv:tag:ciphertext`） |
| `display_name` | TEXT | | 发件显示名 |
| `signature` | TEXT | | HTML 签名 |
| `consecutive_fails` | INTEGER | 0 | 连续发信失败次数 |
| `circuit_open_at` | TEXT | | 熔断开始时间 |
| `circuit_reset_after` | TEXT | | 熔断恢复时间 |
| `is_active` | INTEGER | 1 | 1=活跃 0=停用 |
| `created_at` | TEXT | | |

---

## inbox_messages — 收件箱/发件箱

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | | |
| `account_id` | INTEGER FK | | → `email_accounts.id` |
| `message_id` | TEXT | | IMAP envelope messageId 或 POP3 UID，**去重唯一键** |
| `from_email` | TEXT NOT NULL | | 来信=发件人 / 外发记录=收件人 |
| `from_name` | TEXT | | 来信=发件人名 / 外发记录=收件人名 |
| `subject` | TEXT | | |
| `body_preview` | TEXT | | 正文前 500 字符 |
| `classification` | TEXT | | sent / replied / bounce / autoreply / other |
| `matched_contact_id` | INTEGER | | → `contacts.id`，匹配到的联系人 |
| `is_read` | INTEGER | 0 | 是否已读（0/1） |
| `received_at` | TEXT NOT NULL | | 邮件时间（上海时区） |
| `raw_source` | TEXT | | 完整 HTML 正文 |
| `created_at` | TEXT | | 入库时间 |

### classification 枚举

| 值 | 含义 | 来源 |
|---|---|---|
| `sent` | 已发送（外发） | Sent 文件夹检测 |
| `replied` | 回复 | 收件箱分类 / 手动标记 |
| `bounce` | 退信 | 收件箱分类 / 手动标记 |
| `autoreply` | 自动回复 | 收件箱分类 / 手动标记 |
| `other` | 其他 | 无法归类 |

---

## interactions — 往来记录（时间线）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | | |
| `contact_id` | INTEGER FK | | → `contacts.id` |
| `type` | TEXT NOT NULL | | sent / replied / bounced / autoreply / note |
| `direction` | TEXT NOT NULL | | inbound / outbound / internal |
| `channel` | TEXT | `"email"` | email / manual |
| `subject` | TEXT | | 邮件主题 |
| `body_preview` | TEXT | | 正文片段（200 字符） |
| `message_id` | TEXT | | 去重 ID |
| `account_id` | INTEGER FK | | → `email_accounts.id` |
| `metadata` | TEXT | | 扩展 JSON |
| `created_at` | TEXT | | |

### type 枚举

| 值 | direction | 写入时机 |
|---|---|---|
| `sent` | outbound | Sent 检测：收件人匹配到联系人 |
| `replied` | inbound | 收件箱：分类为 replied 且匹配到联系人 |
| `bounced` | inbound | 收件箱：分类为 bounce 且匹配到联系人 |
| `note` | internal | CRM 跟进记录 / AI 总结写入跟进 |

---

## crm_stages — CRM 管线阶段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | | |
| `contact_id` | INTEGER FK UNIQUE | | → `contacts.id`，一个联系人一条管线 |
| `stage` | TEXT NOT NULL | | 阶段名称 |
| `notes` | TEXT | | 备注 |
| `reminder_at` | TEXT | | 提醒时间 |
| `reminder_note` | TEXT | | 提醒内容 |
| `updated_at` | TEXT | | |

---

## crm_relations — 联系人关系

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `contact_id_a` | INTEGER FK | → `contacts.id` |
| `contact_id_b` | INTEGER FK | → `contacts.id` |
| `relation_type` | TEXT NOT NULL | 关系类型 |
| `created_at` | TEXT | |

---

## templates — 邮件模板

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | | |
| `name` | TEXT NOT NULL | | 模板名称 |
| `language` | TEXT NOT NULL | | 语言 |
| `subject` | TEXT NOT NULL | | 邮件主题 |
| `body` | TEXT NOT NULL | | 邮件正文 |
| `category` | TEXT | | 分类 |
| `version` | INTEGER | 1 | 版本号 |
| `is_active` | INTEGER | 1 | 是否启用 |
| `created_at` | TEXT | | |
| `updated_at` | TEXT | | |

---

## 核心数据流

```
收件箱拉取（IMAP/POP3）
  │
  ├─→ mailparser 解析 ──→ 分类(bounce/replied/autoreply/other)
  │     │
  │     ├─→ 匹配 contacts.email ──→ matched_contact_id
  │     └─→ 退信/回复 ──→ 写入 interactions + 更新 contacts.status
  │
  ├─→ Sent 文件夹检测（仅 IMAP，后台不阻塞）
  │     │
  │     ├─→ 始终写入 inbox_messages（classification=sent）
  │     └─→ 收件人匹配联系人时 ──→ 写入 interactions（type=sent, direction=outbound）
  │     （发信不自动改 contacts.status — reached 仅用户手动设置）
  │
  └─→ data/inbox-deleted.json ──→ 防止已删除邮件重取

AI 背调（ai:backcheck）
  │
  ├─→ saveBackcheck ──→ upsert companies + 存 backcheck_data
  └─→ classifyClientType(公司名) ──→ 自动回写该公司所有联系人 client_type(agent/direct)

跟进记录
  │
  ├─→ 写入 interactions（type=note, direction=internal）
  └─→ 导出：export:notesToCsv → 查全部 note 生成 CSV
```

### 删除的冗余字段（v4.0 迁移）
`is_bounced` / `bounce_reason` → 退信状态用 `contacts.status="bounced"`，原因在 interactions
`last_sent_at` / `last_sent_acct` → 从未写入过，发信时间在 interactions `type=sent`
`followup_note` → 冗余副本，跟进记录统一在 interactions `type=note`
