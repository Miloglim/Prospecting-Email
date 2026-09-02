import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════════
// 动作卡注册表（写入类动作的服务端一侧）单测
// 红线：必须用户点击才执行、一次性的（执行即失效）、过期即作废、全程落审计。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const DDL = `
CREATE TABLE agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL, tool_name text NOT NULL,
  side_effect text NOT NULL, args_json text, result_json text, approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

const { registerAction, executeAction, hasAction, dropActionsForConversation } =
  await import("../../src/main/services/agent/actions");
const { okResult, failResult } = await import("../../src/main/errors");

function newSandbox(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  return db;
}

const base = {
  conversationId: "conv-1",
  toolName: "company_backcheck",
  label: "写入公司档案",
  confirm: "把背调结论写入「ACME」",
  diff: [{ field: "backcheck", label: "背调结论", from: "无", to: "进口商（评分 4）" }],
};

describe("agent 动作卡注册表", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    vi.useRealTimers();
  });

  it("注册只返回可序列化卡片视图，执行闭包不出主进程", () => {
    const card = registerAction({ ...base, run: async () => okResult("已更新公司档案 #7") });
    expect(card.kind).toBe("write");
    expect(card.id).toBeTruthy();
    expect(card.label).toBe("写入公司档案");
    expect(card.diff).toHaveLength(1);
    // 卡片对象上没有 run（前端拿不到也调不到）
    expect(Object.keys(card)).not.toContain("run");
  });

  it("未执行前不写库；点击才执行并落 user_clicked 审计", async () => {
    let ran = 0;
    const card = registerAction({ ...base, run: async () => { ran++; return okResult("已更新公司档案 #7"); } });
    expect(h.db.select().from(schema.agentToolCalls).all()).toHaveLength(0);
    expect(ran).toBe(0);

    const r = await executeAction(card.id);
    expect(r.success).toBe(true);
    expect(ran).toBe(1);
    if (r.success) {
      expect(r.data.message).toBe("已更新公司档案 #7");
      expect(r.data.target).toBeUndefined();
    }
    const rows = h.db.select().from(schema.agentToolCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approval).toBe("user_clicked");
    expect(rows[0]!.sideEffect).toBe("write");
    expect(rows[0]!.toolName).toBe("company_backcheck");
  });

  it("一次性：同一 actionId 重复执行被拒（防双击重复写入）", async () => {
    let ran = 0;
    const card = registerAction({ ...base, run: async () => { ran++; return okResult("ok"); } });
    expect((await executeAction(card.id)).success).toBe(true);
    const again = await executeAction(card.id);
    expect(again.success).toBe(false);
    expect(ran).toBe(1);
    if (!again.success) expect(again.error).toContain("过期");
  });

  it("执行失败也留痕（error 落审计），且动作同样失效", async () => {
    const card = registerAction({ ...base, run: async () => failResult("公司已被删除") });
    const r = await executeAction(card.id);
    expect(r.success).toBe(false);
    const rows = h.db.select().from(schema.agentToolCalls).all();
    expect(rows[0]!.error).toBe("公司已被删除");
    expect(hasAction(card.id)).toBe(false);
  });

  it("超过 30 分钟自动过期，注册新动作时顺带清理", async () => {
    const card = registerAction({ ...base, run: async () => okResult("ok") });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    registerAction({ ...base, run: async () => okResult("另一个") });
    expect(hasAction(card.id)).toBe(false);
    const r = await executeAction(card.id);
    expect(r.success).toBe(false);
    vi.useRealTimers();
  });

  it("删除会话时该会话的待执行动作一并作废", async () => {
    // 注册表是模块级单例，跨用例累积 → 用独立会话 id 断言，避免耦合其他用例的残留
    const a = registerAction({ ...base, conversationId: "conv-drop-a", run: async () => okResult("ok") });
    const b = registerAction({ ...base, conversationId: "conv-drop-b", run: async () => okResult("ok") });
    expect(dropActionsForConversation("conv-drop-a")).toBe(1);
    expect(hasAction(a.id)).toBe(false);
    expect(hasAction(b.id)).toBe(true);
  });
});
