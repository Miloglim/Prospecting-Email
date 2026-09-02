import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════
// KB http-dispatch 中转客户端 单测
// 关键契约（对应教程最容易翻车的点）：
//  · 两层鉴权绝不串位：X-API-Key 只能进中转 body.headers，外层只有 Bearer<KB令牌>；
//  · url 模式与 application_id+path 模式二选一，路径自动补斜杠；
//  · 错误码分层（KB 层 vs 业务透传）+ 写操作 502/504 禁盲目重试（须回查）；
//  · 令牌只进 .env，配置读取永不回传明文；
//  · 用 mock fetch 抓取真实出站请求，端到端验证上面几条。
// 测试写临时 .env，绝不碰项目 .env。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-test-"));
const ENV_FILE = path.join(tmp, ".env");
process.env.QW_ENV_PATH = ENV_FILE;

const KEYS = ["KB_BASE_URL", "KB_TOKEN", "KB_APPLICATION_ID"];
for (const k of KEYS) delete process.env[k];

const Kb = await import("../../src/main/services/kb.service");

beforeAll(() => { fs.writeFileSync(ENV_FILE, "", "utf-8"); });
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  fs.writeFileSync(ENV_FILE, "", "utf-8");
  vi.unstubAllGlobals();
});

describe("buildDispatchRequest · 请求体组装", () => {
  const cfg = { baseUrl: "https://kb.example.com/", token: "kbtt_secret_abc123" };

  it("url 模式：method/url/query/body 落位，内网鉴权进 body.headers，外层只有 Bearer+Content-Type", () => {
    const r = Kb.buildDispatchRequest(cfg, {
      method: "GET",
      url: "https://inner/orders/search",
      query: { order_no: "SO123" },
      innerHeaders: { "X-API-Key": "inner-key-xyz" },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.endpoint).toBe("https://kb.example.com/api/http-dispatch");
    expect(r.data.payload.method).toBe("GET");
    expect(r.data.payload.url).toBe("https://inner/orders/search");
    expect(r.data.payload.query).toEqual({ order_no: "SO123" });
    expect(r.data.payload.headers).toEqual({ "X-API-Key": "inner-key-xyz" });
    // 两层鉴权分离：内网密钥不得出现在外层头
    expect(r.data.outerHeaders.Authorization).toBe("Bearer kbtt_secret_abc123");
    expect(r.data.outerHeaders["Content-Type"]).toBe("application/json");
    expect(r.data.outerHeaders["X-API-Key"]).toBeUndefined();
    // 只给了 url，就不该有 application_id
    expect(r.data.payload.application_id).toBeUndefined();
  });

  it("application_id 模式：application_id + path（自动补前导斜杠），不带 url", () => {
    const r = Kb.buildDispatchRequest(cfg, {
      method: "POST", applicationId: "app-001", path: "orders/notes",
      body: { note: "hi" },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.payload.application_id).toBe("app-001");
    expect(r.data.payload.path).toBe("/orders/notes");
    expect(r.data.payload.url).toBeUndefined();
    expect(r.data.payload.body).toEqual({ note: "hi" });
  });

  it("url 与 application_id 互斥 / 皆缺 / method 非法 / url 协议非法 均拦截", () => {
    expect(Kb.buildDispatchRequest(cfg, { method: "GET", url: "https://a", applicationId: "app", path: "/p" }).success).toBe(false);
    expect(Kb.buildDispatchRequest(cfg, { method: "GET" }).success).toBe(false);
    expect(Kb.buildDispatchRequest(cfg, { method: "DELETE" as never, url: "https://a" }).success).toBe(false);
    expect(Kb.buildDispatchRequest(cfg, { method: "GET", url: "inner.example/p" }).success).toBe(false); // 缺协议
  });

  it("baseUrl / 令牌缺失拦截；写操作标记：POST 默认 true、GET 默认 false、可显式覆盖", () => {
    expect(Kb.buildDispatchRequest({ baseUrl: "", token: "t" }, { method: "GET", url: "https://a" }).success).toBe(false);
    expect(Kb.buildDispatchRequest({ baseUrl: "https://kb", token: "" }, { method: "GET", url: "https://a" }).success).toBe(false);
    const post = Kb.buildDispatchRequest(cfg, { method: "POST", url: "https://a", body: {} });
    const get = Kb.buildDispatchRequest(cfg, { method: "GET", url: "https://a" });
    expect(post.success && post.data.writeOperation).toBe(true);
    expect(get.success && get.data.writeOperation).toBe(false);
    const override = Kb.buildDispatchRequest(cfg, { method: "GET", url: "https://a", writeOperation: true });
    expect(override.success && override.data.writeOperation).toBe(true);
  });
});

describe("classifyResponse · 错误分层与幂等策略", () => {
  it("2xx 成功", () => {
    const v = Kb.classifyResponse(200, '{"code":0}', { writeOperation: false });
    expect(v.ok).toBe(true);
    expect(v.layer).toBe("none");
  });

  it("401 → KB 层，提示重申请令牌，读操作也不盲目重试", () => {
    const v = Kb.classifyResponse(401, "", { writeOperation: false });
    expect(v.layer).toBe("kb");
    expect(v.hint).toContain("令牌");
    expect(v.retriable).toBe(false);
  });

  it("502/504 读操作可重试；写操作禁重试并给回查提示", () => {
    const readGw = Kb.classifyResponse(502, "", { writeOperation: false });
    expect(readGw.retriable).toBe(true);
    expect(readGw.layer).toBe("kb");

    const write502 = Kb.classifyResponse(502, "", { writeOperation: true });
    expect(write502.retriable).toBe(false);
    expect(write502.hint).toContain("严禁直接重试");

    const write504 = Kb.classifyResponse(504, "", { writeOperation: true });
    expect(write504.retriable).toBe(false);
  });

  it("内网业务 500 透传归 business 层；网络中断归 network", () => {
    expect(Kb.classifyResponse(500, '{"code":500}', { writeOperation: false }).layer).toBe("business");
    const net = Kb.classifyResponse(0, "timeout", { writeOperation: true, networkFailure: true });
    expect(net.layer).toBe("network");
    expect(net.retriable).toBe(false); // 写操作结果未知 → 禁重试
  });

  it("坏 JSON 回落原文，不抛异常", () => {
    const v = Kb.classifyResponse(200, "not-json", { writeOperation: false });
    expect(v.ok).toBe(true);
    expect(v.data).toBe("not-json");
  });
});

describe("配置只进 .env、永不回传明文令牌", () => {
  it("setKbConfig 落盘后 getKbConfig 只给预览态", () => {
    const r = Kb.setKbConfig({ baseUrl: "https://kb.example.com", token: "kbtt_super_secret_value", applicationId: "app-9" });
    expect(r.success).toBe(true);
    const cfg = Kb.getKbConfig();
    expect(cfg.baseUrl).toBe("https://kb.example.com");
    expect(cfg.hasToken).toBe(true);
    expect(cfg.tokenPreview).not.toContain("super_secret_value"); // 脱敏
    expect(JSON.stringify(cfg)).not.toContain("kbtt_super_secret_value"); // 全对象都不含明文
    expect(cfg.endpoint).toBe("https://kb.example.com/api/http-dispatch");
  });
});

describe("kbDispatch · mock fetch 抓取真实出站请求（端到端）", () => {
  beforeEach(() => {
    Kb.setKbConfig({ baseUrl: "https://kb.example.com", token: "kbtt_live_token" });
  });

  it("外层头带真实 Bearer、内网 X-API-Key 只在 body；中转 path/method 正确", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: 200, async text() { return JSON.stringify({ ok: true }); } } as unknown as Response;
    }));

    const r = await Kb.kbDispatch({
      method: "POST",
      url: "http://inner/orders/notes",
      innerHeaders: { "X-API-Key": "inner-key", "Content-Type": "application/json" },
      body: { order_no: "SO1", note: "x" },
    });

    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    const captured = calls[0]!;
    if (!r.success) return;

    // 打到 KB 中转入口，且是 POST（把任务交给 KB）
    expect(captured.url).toBe("https://kb.example.com/api/http-dispatch");
    expect((captured.init as { method: string }).method).toBe("POST");

    const headers = (captured.init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer kbtt_live_token");
    expect(headers["X-API-Key"]).toBeUndefined(); // 内网密钥没漏到外层

    const body = JSON.parse((captured.init as { body: string }).body);
    expect(body.method).toBe("POST");
    expect(body.url).toBe("http://inner/orders/notes");
    expect(body.headers["X-API-Key"]).toBe("inner-key"); // 内网鉴权在 body 内
    expect(body.body).toEqual({ order_no: "SO1", note: "x" });

    expect(r.data.ok).toBe(true);
  });

  it("超时/网络异常 → 归 network，写操作禁重试（不抛异常）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("boom"), { name: "TypeError" }); }));
    const r = await Kb.kbDispatch({ method: "POST", url: "http://inner/write", body: { x: 1 } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.layer).toBe("network");
    expect(r.data.retriable).toBe(false);
  });
});

describe("kbTestConnection · 连通性/鉴权判定", () => {
  const fakeRes = (status: number) => ({ status, async text() { return ""; } }) as unknown as Response;

  it("未配置 baseUrl → 直接失败", async () => {
    const r = await Kb.kbTestConnection();
    expect(r.success).toBe(false);
  });

  it("网络不可达 → unreachable", async () => {
    Kb.setKbConfig({ baseUrl: "https://kb.example.com", token: "kbtt_x" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const r = await Kb.kbTestConnection();
    expect(r.success && r.data.verdict).toBe("unreachable");
  });

  it("KB 回 401 → auth_failed", async () => {
    Kb.setKbConfig({ baseUrl: "https://kb.example.com", token: "kbtt_x" });
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(401)));
    const r = await Kb.kbTestConnection();
    expect(r.success && r.data.verdict).toBe("auth_failed");
    expect(r.success && r.data.authed).toBe(false);
  });

  it("KB 回 400 → connected（鉴权已过，缺 url 属预期）", async () => {
    Kb.setKbConfig({ baseUrl: "https://kb.example.com", token: "kbtt_x" });
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(400)));
    const r = await Kb.kbTestConnection();
    expect(r.success && r.data.verdict).toBe("connected");
    expect(r.success && r.data.authed).toBe(true);
  });
});
