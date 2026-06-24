# Prospecting Email — 公司背调 + 开发信生成工具

> 拉美开发信桌面工具 (Electron v1.3)。拖入客户表 → AI 背调 → 输出双语开发信 → 自动发送。
> 默认市场：墨西哥、巴西、智利、秘鲁、哥伦比亚、阿根廷（西语/葡语）。

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
| P2 | Twitter | 社媒评价 | `twitter search "<公司名>" -n 10`（需先登录） |
| P2 | Reddit | 行业讨论 | `opencli reddit search "<公司名>" -f yaml`（需安装） |

## 开发价值评分

**评分基于证据，不靠猜。** 信号分 A-F 六级：

### 正向信号

| 级别 | 信号 | 分值 | 搜什么 |
|------|------|:--:|--------|
| A | 招标/RFQ | +3 | `"公司名" RFQ / tender / licitación / bidding` |
| B | 物流招聘 | +2~3 | 单个岗 +2，≥3 个同时招 +3；搜 `logistics manager / customs compliance / supply chain` |
| C | 中国进口 | +1~2 | 有记录 +1，占比 >40% 或年 >200 票 +2 |
| D | 关务复杂 | +1 | IMMEX / OEA / bonded warehouse / recinto fiscalizado |
| E | 扩张中 | +1 | `expansion / new plant / investment / 扩建` |
| F | 决策人可达 | +1 | 具名 logistics/supply chain/compras 负责人 |

### 负向信号

| 信号 | 分值 |
|------|:--:|
| 内部/自建物流网络 | -3 |
| 超大型集团 + 无物流招聘 | -1 |

### 优先级

```
A(招标) > B(多岗招聘) > C+D(高依赖+关务) > C(有进口) > E(扩张)
```

| 分 | 行动 |
|:--:|------|
| 1-2 | 不开发 / 观察 |
| 3 | 可尝试 |
| 4 | 优先开发 |
| 5 | 立即开发 |

## 写作约束

- 🈲 代理不提本地仓库/本地团队
- 🈲 同一封不同时出现船东名 + 具体运价
- 🈲 不对海外客户用 digital/AI/平台等技术词汇
- 🈲 不用最高级/紧迫词/夸大承诺/价格诱饵（垃圾词黑名单见模板文件）
- ✅ 西语在前，英语在后
- ✅ 第二人称，不教客户做事
- ✅ CTA 是「给」不是「要」

## 参考文档

| 文件 | 内容 |
|------|------|
| `docs/email-writing-rules.md` | 写作准则 + 拉美文化适配 |
| `docs/email-standard.md` | 邮件排版规范 |
| `docs/company-data.md` | YQN 公司数据（写信用数字来源） |
| `templates/general-templates.md` | 15 套通用模板 + 句库 + 垃圾词黑名单 |
