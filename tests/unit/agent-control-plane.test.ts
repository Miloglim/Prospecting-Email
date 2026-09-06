import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { applyConfigPatch, programConfigSnapshot } from "../../src/main/services/agent/tools";
import { APP_ROOT } from "../../src/main/config";

// ═══════════════════════════════════════════════════════════════════
// 控制面：配置补丁校验（docs/agent-control-plane-spec.md §2.2）
// 成功路径会写 send/config.json —— 测试先备份字节、跑完还原，绝不留痕。
// ═══════════════════════════════════════════════════════════════════

const CFG_FILE = path.join(APP_ROOT, "send", "config.json");

describe("applyConfigPatch — 配置补丁校验", () => {
  it("非法域拒绝并列出可用域", () => {
    const r = applyConfigPatch("endpoints", "url=http://x");
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("schedule/quota/test/crm/identity");
  });

  it("白名单外键拒绝（identity.company 是历史死字段，不开）", () => {
    const r = applyConfigPatch("identity", "company=某公司");
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("没有字段 company");
  });

  it("越界值拒绝（startHour=99）", () => {
    const r = applyConfigPatch("schedule", "startHour=99");
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("0-23");
  });

  it("布尔中文解析（开→true / 关→false，与当前值不同才生效）", () => {
    const backup = fs.readFileSync(CFG_FILE, "utf-8");
    try {
      const cur = JSON.parse(backup).schedule?.timeWindowEnabled ?? true;
      const target = cur ? "关" : "开";
      const r = applyConfigPatch("schedule", `timeWindowEnabled=${target}`);
      expect(r.success).toBe(true);
      expect(r.success ? r.data!.changed[0]!.to : null).toBe(!cur);
    } finally {
      fs.writeFileSync(CFG_FILE, backup, "utf-8");   // 还原
    }
  });

  it("无变化返回 noop 失败（不让模型空转）", () => {
    const c = JSON.parse(fs.readFileSync(CFG_FILE, "utf-8"));
    const cur = c.schedule?.startHour ?? 9;
    const r = applyConfigPatch("schedule", `startHour=${cur}`);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("没有需要修改的字段");
  });

  it("多行一次改两键成功且返回 before/after 差异（写前备份、跑完还原）", () => {
    const backup = fs.readFileSync(CFG_FILE, "utf-8");
    try {
      const r = applyConfigPatch("schedule", "groupSize=7\ngroupDelayMinSeconds=88");
      expect(r.success).toBe(true);
      const changed = r.success ? r.data!.changed : [];
      expect(changed.map(x => x.field)).toEqual(["groupSize", "groupDelayMinSeconds"]);
      expect(changed[0]).toEqual({ field: "groupSize", from: expect.anything(), to: 7 });
      // 落盘已生效
      const now = JSON.parse(fs.readFileSync(CFG_FILE, "utf-8"));
      expect(now.schedule.groupSize).toBe(7);
      expect(now.schedule.groupDelayMinSeconds).toBe(88);
    } finally {
      fs.writeFileSync(CFG_FILE, backup, "utf-8");   // 还原，不留测试痕迹
    }
  });

  it("快照永不带密钥（红线断言）", () => {
    const snap = JSON.stringify(programConfigSnapshot());
    expect(snap).not.toMatch(/apikey|api_key|token|secret/i);
    expect(snap).not.toContain(process.env.AGENT_API_KEY || "«no-key»");
  });
});
