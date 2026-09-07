# Agent 控制面补强规范（第一层：程序可编程驱动）

日期：2026-09-07　状态：设计+核心代码已给，待实现
执行者：flash 模型会话。本规范含可直接粘贴的核心代码；flash 只需完成「接线+测试」清单。

## 0. 目标与红线

目标：让 agent 从「业务助手」变成「能读、能改程序本身的操作员」——
读全部运行配置、按需拉邮件全文、经审批改配置、读全联系人档案（含偏好）并写回。

红线（继承 harness 既有红线，一条都不能破）：
1. **【2026-09-07 修订】所有 `sideEffect: "write"` 工具每次都人工确认，零豁免。**
   原「低风险写工具可勾『本会话内不再询问』」的会话豁免机制已连根删除：`ToolSpec` 不再
   有 `autoApprovable` 字段，`canAutoApprove()` / `rememberAutoApprove()` / 审批卡上的勾选
   全部不存在。**判据只可加严、不可豁免**——代码里不留"下次把它改回 true"的旋钮。
2. **审批闸门统一收口在 `buildHarnessTools` 返回处**：工具的 `needsApproval` 一律由注册表
   （manifest）派生并强制覆盖，禁止依赖每个工具各自手写。漏手写不再是漏洞成因——
   结构锁测试 `tests/unit/agent-approval-gate.test.ts` 会断言「write 工具 needsApproval 必为
   true、read 工具不得为 true」。（历史教训：`export_artifact` 曾把注册表改成 write/需审批，
   但工具定义没接 `needsApproval`，SDK 不中断，元数据与真实行为脱节且测试全绿。）
3. **写盘=生成，同样先询问**：`export_artifact`、以及会在收尾时自动产出文件的
   `start_batch_task` 均登记为 `write` + 需审批；批量任务的产物文件由"启动任务"这一次
   审批覆盖，不再单独弹层。
4. 不新增任何发送/触发群发能力。
5. **密钥与端点绝不进 agent 视野**：read 工具不返回 apiKey/令牌；update 工具不接受
   endpoints/检索源密钥/KB 令牌这类域（要改去设置页人工改）。
6. 工具参数保持扁平：改配置用「domain + key=value 行文本」单字段传，不传嵌套 JSON
   （弱模型必写坏，既有约定）。
7. 模型可见返回契约只增不改（notice/say/complete 字段名沿用）。

## 1. 新增工具清单（4 个）+ 1 处补字段

| 工具 | 副作用 | 审批 | 预算/轮 | 用途 |
|---|---|---|---|---|
| `read_program_config` | read | 否 | 2 | 聚合读全部运行配置（时段/限额/测试模式/身份/CRM 参数/账号/生效端点） |
| `update_program_config` | write | **是（每次确认）** | 2 | 按域改配置：schedule/quota/test/crm/identity(仅 fromName) |
| `update_contact` | write | 是（每次确认） | 4 | 改联系人白名单字段（职位/电话/国家/客户类型/标签/偏好备注） |
| `email_read_full` | read | 否 | 3 | 按 id 拉邮件全文+收件人/抄送/附件名（懒加载 IMAP 原文） |
| `search_contacts` 补字段 | — | — | — | 返回行补 `title`/`tags`/`extra`（偏好可读） |

manifest 登记（照抄进 TOOL_MANIFEST，位置跟在 delete_contacts 后）：

```ts
{
  name: "read_program_config", label: "读取程序配置",
  route: "读取程序运行配置（发信时段/限额/测试模式/身份档案/CRM 参数/账号/生效端点）；用户问程序怎么配的、为什么这个点不发信，先查它；",
  spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 2 },
},
{
  name: "update_program_config", label: "修改程序配置",
  route: "修改程序配置（写、每次确认）；用户说「把发信窗口改成…」「限额调到…」时用；",
  spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 2 },
},
{
  name: "update_contact", label: "更新联系人资料",
  route: "更新联系人档案字段（职位/电话/国家/客户类型/标签/偏好备注，写、需确认）；",
  followUps: ["把刚才邮件里提到的偏好也记进 TA 的档案"],
  spec: { sideEffect: "write", requiresApproval: true, budgetPerTurn: 4 },
},
{
  name: "email_read_full", label: "读取邮件全文",
  route: "按 id 读取一封邮件的完整正文与收发信息（用户要原文/全文/导出前先看全文时用）；",
  spec: { sideEffect: "read", requiresApproval: false, budgetPerTurn: 3 },
},
```

`buildHarnessTools` 的返回数组里追加这四个工具变量名（照现有顺序风格）。
系统提示词工具段由 manifest 派生，**不需要改提示词**。

## 2. 核心代码（tools.ts 内新增，可直接粘贴）

### 2.1 配置快照（read_program_config 的数据源，纯函数便于单测）

```ts
// ── 控制面：配置快照与受控补丁 ──────────────────────────────────
// 密钥/端点/检索源令牌永不进快照（红线 3）。
export function programConfigSnapshot() {
  const c = loadConfig();
  const ep = readActiveEndpoint();
  const accounts = getDb().select({
    email: emailAccounts.email, displayName: emailAccounts.displayName,
    isActive: emailAccounts.isActive, lastFetchError: emailAccounts.lastFetchError,
  }).from(emailAccounts).all();
  return {
    schedule: {
      timeWindowEnabled: c.schedule.timeWindowEnabled,
      startHour: c.schedule.startHour, endHour: c.schedule.endHour,
      groupSize: c.schedule.groupSize,
      groupDelayMinSeconds: c.schedule.groupDelayMinSeconds,
      groupDelayMaxSeconds: c.schedule.groupDelayMaxSeconds,
    },
    sendQuota: c.sendQuota ?? null,
    testMode: { enabled: c.test.enabled, dryRun: c.test.dryRun },
    identity: { ...readIdentity() },   // 仅 fromName 可配；公司身份恒定
    crm: { ...c.crm },
    accounts: accounts.map(a => ({
      email: a.email, displayName: a.displayName || null,
      isActive: !!a.isActive, lastFetchError: a.lastFetchError || null,
    })),
    endpoint: { model: ep.model || null, baseUrl: ep.baseUrl || null, family: endpointFamily(ep) },
  };
}
```

### 2.2 配置补丁（update_program_config 的执行体核心）

```ts
/** 域 → 字段白名单与校验器；不在表里的键一律拒绝（防弱模型瞎传） */
const CONFIG_PATCHERS: Record<string, Record<string, (v: string) => number | boolean | string>> = {
  schedule: {
    timeWindowEnabled: parseBool, startHour: intIn(0, 23), endHour: intIn(0, 23),
    groupSize: intIn(1, 500), groupDelayMinSeconds: intIn(0, 86_400), groupDelayMaxSeconds: intIn(0, 86_400),
  },
  quota: { dailyLimit: intIn(1, 100_000) },
  test: { enabled: parseBool, dryRun: parseBool, email: strMax(80), company: strMax(80) },
  crm: {
    "followupDays.reaching": intIn(1, 365), "followupDays.quoting": intIn(1, 365),
    "followupDays.trial": intIn(1, 365), "followupDays.cooperating": intIn(1, 365),
    "followupDays.lost": intIn(1, 365), "followupDays.other": intIn(1, 365),
    todoAdvanceDays: intIn(0, 60), autoArchiveDays: intIn(0, 365),
  },
  // 注意：config.json 里的 identity{company/title/business/persona} 是历史死字段，
  // readIdentity() 只认 fromName（公司身份写死在 identity.ts）——白名单只开 fromName。
  identity: { fromName: strMax(40) },
};

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "是", "开", "on"].includes(s)) return true;
  if (["false", "0", "no", "否", "关", "off"].includes(s)) return false;
  throw new Error(`不是布尔值：${v}`);
}
function intIn(min: number, max: number) {
  return (v: string): number => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`需 ${min}-${max} 的整数，收到 ${v}`);
    return n;
  };
}
function strMax(max: number) {
  return (v: string): string => {
    const s = v.trim();
    if (s.length > max) throw new Error(`超过 ${max} 字`);
    return s;
  };
}

/**
 * 应用配置补丁。kvs = 多行 "key=value"（弱模型友好，不传嵌套 JSON）。
 * 返回 before/after 差异供确认卡与回答展示；任一行非法 → 整批拒绝（不半改）。
 */
export function applyConfigPatch(domain: string, kvs: string):
  Result<{ changed: Array<{ field: string; from: unknown; to: unknown }> }> {
  const patchers = CONFIG_PATCHERS[domain];
  if (!patchers) {
    return failResult(`不支持的配置域「${domain}」，可用：${Object.keys(CONFIG_PATCHERS).join("/")}`);
  }
  const c = loadConfig();
  const target: Record<string, unknown> =
    domain === "schedule" ? { ...c.schedule } :
    domain === "quota" ? { ...(c.sendQuota ?? { dailyLimit: 1500, firstSendAt: null, sentToday: 0 }) } :
    domain === "test" ? { ...c.test } :
    domain === "crm" ? { ...c.crm, followupDays: { ...c.crm.followupDays } } :
    { ...readIdentity() };
  const changed: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const line of kvs.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) return failResult(`行格式应为 key=value：${t}`);
    const key = t.slice(0, eq).trim();
    const raw = t.slice(eq + 1).trim();
    const p = patchers[key];
    if (!p) return failResult(`「${domain}」没有字段 ${key}，可用：${Object.keys(patchers).join("/")}`);
    let val: unknown;
    try { val = p(raw); } catch (e) { return failResult(e instanceof Error ? e.message : String(e)); }
    const from = key.includes(".")
      ? (target[key.split(".")[0]!] as Record<string, unknown>)[key.split(".")[1]!]
      : target[key];
    if (from === val) continue;
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      (target[a!] as Record<string, unknown>)[b!] = val;
    } else target[key] = val;
    changed.push({ field: key, from, to: val });
  }
  if (!changed.length) return failResult("没有需要修改的字段（值与当前一致或 kvs 为空）");
  // 落盘
  if (domain === "schedule") c.schedule = target as typeof c.schedule;
  else if (domain === "quota") c.sendQuota = target as typeof c.sendQuota;
  else if (domain === "test") c.test = target as typeof c.test;
  else if (domain === "crm") c.crm = target as typeof c.crm;
  else {
    c.fromName = String(target.fromName ?? c.fromName);
  }
  saveConfig(c);
  return okResult({ changed });
}
```

### 2.3 四个工具的 execute（骨架照抄，notice 文案不许改风格）

```ts
const readProgramConfig = tool({
  name: "read_program_config",
  description: "读取程序当前运行配置：发信时段/组间暂停/每组人数、日限额、测试模式、身份档案、"
    + "CRM 跟进天数、发信账号清单、生效端点（不含任何密钥）。用户问「程序怎么配的/为什么这个点不发/"
    + "限额多少」时必须先调本工具，禁止凭印象回答。要改配置用 update_program_config。",
  parameters: z.object({}),
  execute: async () => {
    const gateNote = gate(ctx, "read_program_config");
    if (gateNote) return gateNote;
    const snap = programConfigSnapshot();
    audit(ctx, "read_program_config", "read", undefined, snap, "auto");
    return finishRead(ctx, "read_program_config", {}, okOut({
      config: snap,
      notice: "这是只读快照。用户要改配置时调用 update_program_config（会弹确认），不要自己承诺已改。",
    }));
  },
});

const updateProgramConfig = tool({
  name: "update_program_config",
  description: "修改程序配置（写操作，执行前弹人工确认，永不豁免）。"
    + "domain 取 schedule/quota/test/crm/identity；kvs 为多行 key=value（如 \"startHour=9\\nendHour=18\"）。"
    + "字段白名单：schedule=timeWindowEnabled/startHour/endHour/groupSize/groupDelayMinSeconds/groupDelayMaxSeconds；"
    + "quota=dailyLimit；test=enabled/dryRun；crm=followupDays.<阶段>/todoAdvanceDays/autoArchiveDays；"
    + "identity=fromName（公司身份恒定不可改）。"
    + "端点/密钥/检索源不在本工具射程——用户要改那些，引导去设置页。"
    + "先 read_program_config 拿现值，只传要改的键；确认被拒则如实告知未改。",
  parameters: z.object({
    domain: z.string().describe("配置域：schedule/quota/test/crm/identity"),
    kvs: z.string().describe("多行 key=value，只写要改的键"),
  }),
  needsApproval: toolMeta("update_program_config")!.spec.requiresApproval,
  execute: async (args) => {
    const gateNote = gate(ctx, "update_program_config");
    if (gateNote) return gateNote;
    const r = applyConfigPatch(String(args.domain ?? "").trim(), String(args.kvs ?? ""));
    if (!r.success) {
      audit(ctx, "update_program_config", "write", args, undefined, "approved", r.error);
      return failOut("invalid_patch", r.error);
    }
    audit(ctx, "update_program_config", "write", args, r.data, "approved");
    return okOut({
      changed: r.data.changed,
      say: `已修改 ${r.data.changed.length} 项配置：` +
        r.data.changed.map(x => `${x.field} ${String(x.from)} → ${String(x.to)}`).join("；"),
      notice: "配置即时生效，无需重启。若用户问为什么，说明改的是哪个域。",
    });
  },
});

const updateContact = tool({
  name: "update_contact",
  description: "更新一位联系人的档案字段（写操作，需确认）。可改：title/phone/country/clientType"
    + "(agent|direct)/tags(逗号分隔)/preference(偏好备注，追加进 extra.preferences 数组)。"
    + "定位用 contactId 或 contact（邮箱/姓名/公司名）。不改 status/stage（状态由收信与 CRM 管）。"
    + "从邮件里读到的客户偏好（语种/航线/柜型习惯）应落到 preference，别只写跟进流水。",
  parameters: z.object({
    contactId: optInt().describe("联系人 id（有它就不必填 contact）"),
    contact: optStr(80).describe("邮箱/姓名/公司名任一"),
    title: optStr(60), phone: optStr(40), country: optStr(40),
    clientType: optStr(10).describe("agent 或 direct"),
    tags: optStr(120).describe("逗号分隔标签，如 reaching,重点"),
    preference: optStr(200).describe("偏好备注，追加写入 extra.preferences"),
  }),
  needsApproval: toolMeta("update_contact")!.spec.requiresApproval,
  execute: async (args) => {
    const gateNote = gate(ctx, "update_contact");
    if (gateNote) return gateNote;
    const target = pickTarget(args);
    if (!target.ok) {
      const why = target.why === "ambiguous"
        ? `「${args.contact}」匹配到多位联系人，请用 contactId 指定：${candidatesText(target.candidates)}`
        : `库里找不到「${args.contact ?? `#${args.contactId}`}」`;
      audit(ctx, "update_contact", "write", args, undefined, "approved", why);
      return failOut(target.why, why);
    }
    const id = target.person.id;
    const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
    if (!row) return failOut("notfound", "联系人已不存在");
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const changed: string[] = [];
    if (args.title != null) { set.title = args.title; changed.push(`职位→${args.title}`); }
    if (args.phone != null) { set.phone = args.phone; changed.push(`电话→${args.phone}`); }
    if (args.country != null) { set.country = args.country; changed.push(`国家→${args.country}`); }
    if (args.clientType != null) {
      if (!["agent", "direct"].includes(args.clientType)) return failOut("invalid", "clientType 只能是 agent 或 direct");
      set.clientType = args.clientType; changed.push(`客户类型→${args.clientType}`);
    }
    if (args.tags != null) {
      const arr = args.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
      set.tags = JSON.stringify(arr); changed.push(`标签→${arr.join("/") || "清空"}`);
    }
    if (args.preference != null) {
      let extra: Record<string, unknown> = {};
      try { extra = JSON.parse(row.extra || "{}"); } catch { /* 坏 JSON 当空 */ }
      const prefs = Array.isArray(extra.preferences) ? extra.preferences as string[] : [];
      if (!prefs.includes(args.preference)) prefs.push(args.preference);
      extra.preferences = prefs.slice(-10);
      set.extra = JSON.stringify(extra); changed.push("偏好已追加");
    }
    if (!changed.length) return failOut("noop", "没有要改的字段");
    getDb().update(contacts).set(set).where(eq(contacts.id, id)).run();
    saveDatabase();
    invalidateCache("update_contact");
    audit(ctx, "update_contact", "write", args, { id, changed }, "approved");
    return okOut({ id, changed, say: `已更新联系人 #${id}：${changed.join("；")}` });
  },
});

const emailReadFull = tool({
  name: "email_read_full",
  description: "按 messageId 读取一封邮件的完整信息：全文正文（懒加载，含 IMAP 原文）、"
    + "发件人/收件人/抄送、时间、分类、意图、附件文件名。用户要「原文/全文/完整内容」时用；"
    + "只要摘要用 email_summarize。正文超长会截断并标注。",
  parameters: z.object({ messageId: z.number().int().describe("inbox_search 返回的 id") }),
  execute: async (args) => {
    const gateNote = gate(ctx, "email_read_full");
    if (gateNote) return gateNote;
    const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
    if (!row) return failOut("not_found", `邮件 #${args.messageId} 不存在，先 inbox_search 拿 id`);
    const bodyR = await getBody(args.messageId);
    const full = bodyR.success ? bodyR.data : (row.bodyPreview || "");
    const CAP = 12_000;
    audit(ctx, "email_read_full", "read", args, { id: row.id, len: full.length }, "auto");
    return finishRead(ctx, "email_read_full", args, okOut({
      id: row.id, from: row.fromEmail, fromName: row.fromName,
      to: row.to || null, cc: row.cc || null, subject: row.subject,
      receivedAt: row.receivedAt, classification: row.classification, intent: row.intent || null,
      attachments: row.imageName ? [row.imageName] : [],
      body: full.slice(0, CAP),
      ...(full.length > CAP ? { notice: `正文共 ${full.length} 字，已截断到 ${CAP} 字；要存档用 export_artifact。` } : {}),
    }));
  },
});
```

### 2.4 search_contacts 补字段（改现有 select 与映射，两行）

select 里加 `title: contacts.title, tags: contacts.tags, extra: contacts.extra`；
`out` 映射里加：

```ts
title: r.title, tags: parseTagsArr(r.tags), preferences: (() => {
  try { const e = JSON.parse(r.extra || "{}"); return Array.isArray(e.preferences) ? e.preferences : []; }
  catch { return []; }
})(),
```

（`parseTagsArr` 在 contact.service 是模块内函数未导出——在 tools.ts 本地实现一个同款：
`const tagsArr = (s: string | null) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; } catch { return []; } };`）

## 3. flash 的接线清单（按序做，做完一项勾一项）

1. tools.ts：粘贴 2.1/2.2 两个导出函数 + 2.3 四个 tool 定义；导入补
   `loadConfig, saveConfig`（../config）、`readActiveEndpoint, endpointFamily`（../endpoint.service）、
   `readIdentity`（已有）、`getBody`（已有）。
2. tools.ts：`buildHarnessTools` 返回数组追加四个工具。
3. manifest.ts：TOOL_MANIFEST 追加第 1 节四条登记。
4. 2.4 的 search_contacts 补字段。
5. 测试 tests/unit/agent-control-plane.test.ts（新文件，至少 6 例）：
   - applyConfigPatch：非法域拒绝；白名单外键拒绝（含 identity.company——死字段不开）；
     越界值拒绝（startHour=99）；布尔中文解析（"开"→true）；无变化返回 noop 失败；
     多行一次改两键成功且返回 diff。
   - update_contact：noop（不传字段）失败；tags 逗号切分落 JSON；preference 追加不重复。
   - email_read_full：id 不存在给 not_found 引导语。
   - read_program_config：快照不含 apiKey/令牌（字符串断言）。
6. `npx tsc --noEmit` 干净；`npm test` 全绿。
7. 手工验收（dev 里问 agent）：
   - 「现在发信窗口几点到几点？」→ 应先调 read_program_config 再答；
   - 「把组间暂停改成 60 到 120 秒」→ 弹确认卡，确认后 read 回来是新值；
   - 「把这封邮件原文给我」→ email_read_full 回全文；
   - 「这个客户偏好葡萄牙语，记到档案里」→ update_contact 弹确认，落 extra.preferences。

## 4. 不做的事（防 flash 发散）

- 不做 UI（配置修改的可视化仍走设置页；agent 改完设置页下次打开自然读到新值）。
- 不碰 endpoints/密钥/KB/检索源配置。
- 不给 update_contact 开 status/stage 修改（状态语义归收信引擎与 CRM）。
- 不加新 IPC 通道（全部在主进程工具层内完成，零渲染端改动）。
