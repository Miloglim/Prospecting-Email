import { describe, it, expect } from "vitest";
import { extractFact } from "../../src/main/services/agent/memory";

describe("extractFact（工具事实抽取）", () => {
  it("优先取 say", () => {
    expect(extractFact("inbox_search", { ok: true, say: "共 5 封匹配" })).toBe("共 5 封匹配");
  });

  it("产物名入事实", () => {
    expect(extractFact("export_artifact", { ok: true, artifact: { name: "询盘汇总.md" } })).toBe("已导出文件「询盘汇总.md」");
  });

  it("后台任务总数入事实", () => {
    expect(extractFact("start_batch_task", { ok: true, task: { total: 8 } })).toBe("已启动后台任务（共 8 项）");
  });

  it("提醒数入事实", () => {
    expect(extractFact("reminders_due", { ok: true, dueCount: 3, overdueCount: 2 })).toBe("到期 3 · 逾期 2 条跟进提醒");
  });

  it("账号健康入事实", () => {
    expect(extractFact("accounts_status", { ok: true, healthy: 2, enabled: 3 })).toBe("发信账号 2/3 健康");
  });

  it("失败包络不记事实", () => {
    expect(extractFact("record_followup", { ok: false, error: { code: "not_found", message: "找不到" } })).toBeNull();
  });

  it("没有跨轮价值的结果不记", () => {
    expect(extractFact("update_plan", { ok: true, notice: "清单已更新" })).toBeNull();
  });

  it("JSON 字符串结果也能解析", () => {
    expect(extractFact("quote_search", JSON.stringify({ ok: true, say: "共 12 条" }))).toBe("共 12 条");
  });
});
