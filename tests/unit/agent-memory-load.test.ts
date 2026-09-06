import { describe, it, expect, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 记忆加载机制（memory.ts）：近端原文 + 中段摘要 + 已查事实注入的顺序与封顶。
// 沙箱内存库 + 摘要端点打桩（不走真实模型，机制验证要确定性）。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
let chatOk = true;

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => { /* 内存库 */ },
  getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/services/ai.service", () => ({
  chat: async () => (chatOk
    ? { success: true, data: "要点摘要TEST" }
    : { success: false, error: "端点不可用" }),
}));

const memory = await import("../../src/main/services/agent/memory");

const DDL = `
CREATE TABLE agent_conversations (
  id text PRIMARY KEY NOT NULL, title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  role text NOT NULL, content text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_facts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  tool_name text NOT NULL, fact text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function newSandbox(): Promise<Driz> {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  return db;
}

function seedMessages(db: Driz, convId: string, n: number): void {
  const rows = Array.from({ length: n }, (_, i) => ({
    conversationId: convId,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `消息${i + 1}`,
    createdAt: new Date(Date.now() + i * 1000).toISOString(),
  }));
  db.insert(schema.agentMessages).values(rows).run();
}

function seedFacts(db: Driz, convId: string, facts: Array<[string, string]>): void {
  db.insert(schema.agentFacts).values(facts.map(([toolName, fact]) => ({ conversationId: convId, toolName, fact }))).run();
}

describe("loadConversation（记忆加载）", () => {
  it("短会话：无摘要，有事实则先注入事实块", async () => {
    const db = await newSandbox();
    seedMessages(db, "c1", 4);
    seedFacts(db, "c1", [["quote_search", "共 6 条"]]);
    const msgs = await memory.loadConversation("c1");
    expect(msgs).toHaveLength(5);
    expect(msgs[0]!.content).toContain("【系统注入·本会话已查过的数据】");
    expect(msgs[0]!.content).toContain("quote_search：共 6 条");
    expect(msgs[1]!.content).toBe("消息1");
  });

  it("无事实不注入（短对话零噪音）", async () => {
    const db = await newSandbox();
    seedMessages(db, "c2", 3);
    const msgs = await memory.loadConversation("c2");
    expect(msgs).toHaveLength(3);
    expect(msgs.some(m => m.content.includes("系统注入"))).toBe(false);
  });

  it("超 30 条：摘要 + 事实 + 近端 30 条的顺序", async () => {
    chatOk = true;
    const db = await newSandbox();
    seedMessages(db, "c3", 35);
    seedFacts(db, "c3", [["quote_search", "共 6 条"], ["reminders_due", "到期 1 · 逾期 1 条跟进提醒"]]);
    const msgs = await memory.loadConversation("c3");
    expect(msgs).toHaveLength(32);   // 1 摘要 + 1 事实 + 30 近端
    expect(msgs[0]!.content).toContain("此前对话摘要");
    expect(msgs[0]!.content).toContain("要点摘要TEST");
    expect(msgs[1]!.content).toContain("本会话已查过的数据");
    expect(msgs[1]!.content).toContain("到期 1 · 逾期 1 条跟进提醒");
    // 近端 = 最后 30 条（消息6..消息35）
    expect(msgs[2]!.content).toBe("消息6");
    expect(msgs[31]!.content).toBe("消息35");
  });

  it("事实注入封顶 12 条（表里再多也不撑爆上下文）", async () => {
    const db = await newSandbox();
    seedMessages(db, "c4", 2);
    seedFacts(db, "c4", Array.from({ length: 15 }, (_, i) => [`tool_${i}`, `事实${i}`] as [string, string]));
    const msgs = await memory.loadConversation("c4");
    const block = msgs[0]!.content;
    expect((block.match(/· /g) ?? []).length).toBe(12);
    // 取的是最近 12 条（事实3..事实14），最旧的被丢掉
    expect(block).not.toContain("事实2：");
    expect(block).toContain("事实14");
  });

  it("摘要端点失败 → 占位兜底，不阻塞对话", async () => {
    chatOk = false;
    const db = await newSandbox();
    seedMessages(db, "c5", 35);
    const msgs = await memory.loadConversation("c5");
    expect(msgs).toHaveLength(31);   // 1 占位摘要 + 30 近端
    expect(msgs[0]!.content).toContain("压缩失败已省略");
  });
});
