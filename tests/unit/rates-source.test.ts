import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// 运价台账地址来源（规范 docs/rates-remote-source-spec.md §4）
// 用户口径：公网地址只是「不在公司网时给远程读数用」，程序内置默认必须走局域网
// （报价截图只在局域网那台机器上）。优先级：env > 设置页自定义 url > 设置页选的源 > 内置局域网。
// 这条测试锁的是「默认值不许被改成公网」——上次就是因为改默认值，截图全成了死链。
// ═══════════════════════════════════════════════════════════════════

const cfgHolder: { rates?: { source?: string; url?: string } } = {};

vi.mock("../../src/main/db", () => ({
  getDb: () => null, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", () => ({
  APP_ROOT: ".", DB_PATH: "test.db",
  loadConfig: () => ({ rates: cfgHolder.rates }),
  saveConfig: () => {},
}));

const { remoteBase, LAN_BASE, REMOTE_BASE } = await import("../../src/main/services/rate-sync.service");

describe("运价台账地址来源", () => {
  const savedEnv = process.env.RATES_REMOTE_URL;
  beforeEach(() => { delete process.env.RATES_REMOTE_URL; cfgHolder.rates = undefined; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RATES_REMOTE_URL;
    else process.env.RATES_REMOTE_URL = savedEnv;
  });

  it("什么都不配 = 内置局域网（默认值不许漂成公网）", () => {
    expect(remoteBase()).toBe(LAN_BASE);
    expect(LAN_BASE).toBe("http://192.168.189.229:8788");
    expect(REMOTE_BASE).toBe("https://l5ruag9m.qwenwork.host");
  });

  it("设置页选公网镜像 → 用公网地址；选回局域网 → 立刻回来（无需重启）", () => {
    cfgHolder.rates = { source: "remote" };
    expect(remoteBase()).toBe(REMOTE_BASE);
    cfgHolder.rates = { source: "lan" };
    expect(remoteBase()).toBe(LAN_BASE);
  });

  it("自定义 url 优先于 source，尾斜杠去掉", () => {
    cfgHolder.rates = { source: "lan", url: "http://10.0.0.7:8788/" };
    expect(remoteBase()).toBe("http://10.0.0.7:8788");
  });

  it("环境变量优先级最高（换网络环境/临时调试不改配置）", () => {
    cfgHolder.rates = { source: "lan", url: "http://10.0.0.7:8788" };
    process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";
    expect(remoteBase()).toBe("http://127.0.0.1:9");
  });

  it("配置读不到（异常/首启）也回落内置局域网，不抛", () => {
    cfgHolder.rates = undefined;
    expect(() => remoteBase()).not.toThrow();
    expect(remoteBase()).toBe(LAN_BASE);
  });
});
