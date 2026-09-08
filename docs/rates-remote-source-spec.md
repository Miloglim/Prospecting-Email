# 运价库远程源规范（多端局域网读取）

日期：2026-09-06　状态：已实现

背景：钉钉权限只在公司电脑（千问办公心跳拉取 → 写库 → board_server :8788 局域网 HTTP），
Prospector 及分发给同事的副本都没有钉钉权限。运价数据的获取统一改为：
**Prospector 从远程 HTTP 服务拉取 → 归一化 → 本地镜像**，本地镜像仍是全部查询路径
（RateBoard / quote_search）的唯一读源——下游零改动。

## 1. 数据流

```
钉钉台账(公司电脑心跳) → board_server :8788 → Prospector sync() ─┬─ rate_quotes 镜像（运价）
                                                                  └─ space_records 镜像（舱位）
                                              ├─ RateBoard
                                              └─ quote_search（查价时同批附带相关舱位）
```

- **本地镜像语义不变**：归一化柜型/有效期、全量刷新、includeExpired 过滤全部照旧。
- **定时节奏**：启动后 5 秒首拉 + 每 `RATES_REMOTE_MINUTES` 分钟轮询（**默认 240 分钟 = 4 小时**），
  外加手动「同步台账」按钮；数据新鲜度上限 = 心跳入库节奏。

## 2. 远程接口约定（board_server 侧）

- `GET /api/rates?limit=500&offset=0` → `{ok, total, rows}`，rows 为全字段行
  （消息原文/有效期/来源群）。不带 status 过滤——**过期与否由本地镜像的
  valid_to 判断**，与 quote_search 口径一致。
- 分页拉全量（安全上限 20000 行）；`record_id` 作稳定键。

## 3. 字段映射（别名容错，纯函数可单测）

远程行字段名与本地 schema 不完全一致，按别名取值：
`container_type|container_raw|container → containerRaw`、`freight_usd|ocean_usd → oceanUsd`、
`pod_raw|pod → podRaw`；其余（pol/lane/carrier/free_days/shortfall(_fee)/note/source_group/
sender/msg_time/image_name/record_id）同名直取。数值容忍字符串带千分位。
- **柜型归一 / 有效期解析复用现有 `normalizeContainer` / `parseValidity`**；
  远程若已给 `valid_from/valid_to` 则直采，缺了才本地解析。
- `record_id` 缺失按 `remote-{offset+序号}` 兜底。

## 4. 源选择与配置（2026-09-06 用户拍板：完全替换，不留快照路径）

- **远程源是唯一来源**：`sync()` 一律走远程拉取，原「快照文件」链路（data/rates-snapshot.json、
  dws 字段映射、parseSnapshot）整体移除。
- **服务地址可切换，内置默认 = 公司局域网**（2026-09-08 用户拍板：公网地址只是「不在公司网时给远程读数用」，
  程序内置必须走局域网——**报价截图只在局域网那台机器上**，公网 host 的 `/images/` 未部署，
  实测 404 且服务端对每张图自标 `missing: true`）。
  优先级（高→低）：
  1. `RATES_REMOTE_URL` 环境变量（换网络环境/临时调试，界面上不出现）；
  2. `config.rates.url` 自定义地址（运维逃生口，设置页切换时会清空它）；
  3. `config.rates.source`：`lan`（默认，`http://192.168.189.229:8788`）/ `remote`（`https://l5ruag9m.qwenwork.host`）；
  4. 兜底 `LAN_BASE`（配置读不到也不抛）。
  解析函数 `remoteBase()` **每次现算**，改完即生效、不用重启；`LAN_BASE` / `REMOTE_BASE` 为导出常量，
  禁止在别处再写死地址（截图 URL、工作台跳转、探测、同步全部经 `remoteBase()`）。
- **设置页切换卡**（设置 → API 与服务 → 运价台账）：分段按钮「公司局域网 / 公网镜像」，
  切换即保存并**自动重新同步**（不给用户留「保存 + 测试连接」两步），显示当前地址、镜像条数与上次同步时间。
  同步失败不删旧镜像，只提示「已切到 X，但这次没同步上」。
- **离线建表脚本同口径**：`scripts/build-rates-standard.py` 的 `IMAGES_BASE` 默认也是局域网，
  换源同样走 `RATES_REMOTE_URL`。（此前它写死过公网地址，生成的 938 条截图链接全是死链。）
- 定时同步：启动后 5 秒首拉 + 每 4 小时轮询（默认 240 分钟，`RATES_REMOTE_MINUTES` 可覆盖）；
  同步中防重入；自动同步失败只记日志，手动同步失败才弹提示。

## 5. UI（RateBoard / 仪表盘运价卡）

- 来源状态：显示「远程库 {host} · 上次同步时间」；同步异常时给红标 + lastError 摘要。
- 同步按钮改名「同步运价库」。快照相关文案全部移除。
- 连接失败提示（手动同步时）：一句话指因（公司电脑开机/服务启动/同一局域网），细节进日志。

## 6. 安全与边界

- 拉取失败不动本地镜像（先全量拉完、后删旧插新）；失败保留上次同步的数据并报错。
- 单条远程行字段残缺（无目的港等）跳过，不阻塞整批。
- **两张镜像各自独立成败**：运价拉不到 = 整体失败（界面提示）；舱位拉不到或返回 0 行 = 只记日志、
  保留旧 `space_records`，不阻断运价刷新——舱位是附带信息，不该拖垮主链路。
- **两表 status 字面量不同**：运价「当前生效 / 已被覆盖」，舱位「当前有效 / 已被覆盖」。
  舱位带 `status=当前有效` 拉不到任何行时，退回不带 status 再拉一次、在本地剔掉「已被覆盖」，
  防服务端字面量变更把舱位镜像清空。
- 联动清理：快照链路死代码（SNAPSHOT_PATH / dws 字段表 / cellText / parseSnapshot）已删；
  `data/rates-snapshot.json` 不再被读取，可留可删。
