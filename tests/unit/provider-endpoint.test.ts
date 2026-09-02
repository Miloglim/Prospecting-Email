import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════
// 模型端点 Profile + 生效端点解析 单测
// 关键契约：密钥只进 .env（测试写临时文件，绝不碰项目 .env）；
// 激活=写指针不复制密钥；解析优先级 指针 > AGENT_API_KEY > 未配置。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-test-"));
const ENV_FILE = path.join(tmp, ".env");
const STORE_FILE = path.join(tmp, "providers.json");

process.env.QW_ENV_PATH = ENV_FILE;
process.env.AI_PROVIDERS_PATH = STORE_FILE;

const KEYS = ["AGENT_API_BASE_URL", "AGENT_MODEL", "AGENT_KEY_ENV", "AGENT_API_KEY", "AGENT_THINKING", "DEEPSEEK_API_KEY"];
for (const k of KEYS) delete process.env[k];

const { readActiveEndpoint, endpointFamily, thinkingExtras } = await import("../../src/main/services/endpoint.service");
const { parseProxyServer } = await import("../../src/main/net-proxy");
const { upsertEnv, readEnvFile } = await import("../../src/main/env-store");
const Prov = await import("../../src/main/services/provider.service");

beforeAll(() => {
  fs.writeFileSync(ENV_FILE, "", "utf-8");
});

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  try { fs.rmSync(STORE_FILE, { force: true }); } catch { /* 单测环境 */ }
  fs.writeFileSync(ENV_FILE, "", "utf-8");
});

describe("生效端点解析（endpoint.service）", () => {
  it("指针密钥优先于 legacy AGENT_API_KEY，来源标 profile", () => {
    process.env.AGENT_API_BASE_URL = "https://a.example/v1";
    process.env.AGENT_API_KEY = "sk-legacy";
    process.env.AGENT_KEY_ENV = "PROVIDER_KEY_B";
    process.env.PROVIDER_KEY_B = "sk-new";
    const e = readActiveEndpoint();
    expect(e.apiKey).toBe("sk-new");
    expect(e.source).toBe("profile");
    delete process.env.PROVIDER_KEY_B;
    delete process.env.AGENT_KEY_ENV;
    expect(readActiveEndpoint().source).toBe("legacy");
  });

  it("base 或 key 缺失 → source none / isLive false", () => {
    process.env.AGENT_API_BASE_URL = "https://a.example/v1";
    expect(readActiveEndpoint().source).toBe("none");
  });
});

describe("env-store", () => {
  it("写入后可被 readEnvFile 读回；空值即删除该行", () => {
    upsertEnv("DEEPSEEK_API_KEY", "sk-abc");
    expect(readEnvFile().DEEPSEEK_API_KEY).toBe("sk-abc");
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-abc");
    upsertEnv("DEEPSEEK_API_KEY", "");
    expect(readEnvFile().DEEPSEEK_API_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe("provider.service 端点管理", () => {
  it("Base URL 必须带协议，模型名可先空（未填测试会给明确提示）", () => {
    expect(Prov.upsertProfile({ name: "坏", baseUrl: "api.example.com/v1", model: "m" }).success).toBe(false);
    const ok = Prov.upsertProfile({ name: "A", baseUrl: "https://a.example/v1", model: "model-a" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.keyEnv).toMatch(/^PROVIDER_KEY_/);
  });

  it("密钥写在 profile 自己的 env 变量里，列表与状态永不回传密钥值", () => {
    const p = Prov.upsertProfile({ name: "B", baseUrl: "https://b.example/v1", model: "model-b" });
    if (!p.success) throw new Error("upsert 失败");
    expect(Prov.setProfileKey(p.data.id, "sk-secret-1").success).toBe(true);
    expect(readEnvFile()[p.data.keyEnv]).toBe("sk-secret-1");

    const list = Prov.listProfiles();
    expect(list.success && list.data[0]!.hasKey).toBe(true);
    expect(JSON.stringify(list)).not.toContain("sk-secret-1");
    const status = Prov.getEndpointStatus();
    expect(JSON.stringify(status)).not.toContain("sk-secret-1");
  });

  it("激活 = 写指针与生效参数，不复制密钥；再切走也不会留下旧密钥副本", () => {
    const a = Prov.upsertProfile({ name: "A", baseUrl: "https://a.example/v1", model: "model-a" });
    const b = Prov.upsertProfile({ name: "B", baseUrl: "https://b.example/v1", model: "model-b" });
    if (!a.success || !b.success) throw new Error("upsert 失败");
    Prov.setProfileKey(a.data.id, "sk-A");
    Prov.setProfileKey(b.data.id, "sk-B");

    const act = Prov.activateProfile(a.data.id);
    expect(act.success).toBe(true);
    expect(process.env.AGENT_API_BASE_URL).toBe("https://a.example/v1");
    expect(process.env.AGENT_MODEL).toBe("model-a");
    expect(process.env.AGENT_KEY_ENV).toBe(a.data.keyEnv);
    expect(readActiveEndpoint().apiKey).toBe("sk-A");
    // 关键：没有把密钥抄成第二份
    expect(process.env.AGENT_API_KEY).toBeUndefined();

    expect(Prov.activateProfile(b.data.id).success).toBe(true);
    expect(readActiveEndpoint().apiKey).toBe("sk-B");
    expect(readActiveEndpoint().model).toBe("model-b");
    expect(process.env.AGENT_API_KEY).toBeUndefined();
  });

  it("没配密钥的端点不能激活（而不是悄悄切过去变成 401）", () => {
    const p = Prov.upsertProfile({ name: "空", baseUrl: "https://c.example/v1", model: "m" });
    if (!p.success) throw new Error("upsert 失败");
    const r = Prov.activateProfile(p.data.id);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("密钥");
  });

  it("删除端点连带清掉它在 .env 里的密钥，避免孤儿密钥", () => {
    const p = Prov.upsertProfile({ name: "D", baseUrl: "https://d.example/v1", model: "m" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "sk-D");
    expect(Prov.deleteProfile(p.data.id).success).toBe(true);
    expect(readEnvFile()[p.data.keyEnv]).toBeUndefined();
    const left = Prov.listProfiles();
    expect(left.success && left.data).toHaveLength(0);
  });

  it("classifyHttp 把 401/404/429/400(模型名) 归成人话", () => {
    expect(Prov.classifyHttp(401, "").kind).toBe("auth");
    expect(Prov.classifyHttp(404, "").kind).toBe("model");
    expect(Prov.classifyHttp(429, "").kind).toBe("rate");
    const bad = Prov.classifyHttp(400, '{"error":"model name cannot be empty"}');
    expect(bad.kind).toBe("model");
    expect(Prov.classifyHttp(500, "boom").kind).toBe("server");
  });

  it("测试未填模型名的端点：直接给人话提示，不发请求", async () => {
    const p = Prov.upsertProfile({ name: "无模型", baseUrl: "https://e.example/v1", model: "" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "sk-E");
    const r = await Prov.testProfile(p.data.id);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ok).toBe(false);
      expect(r.data.kind).toBe("model");
    }
  });
});

describe("出网代理自动检测", () => {
  it("解析注册表 ProxyServer 的两种写法", () => {
    expect(parseProxyServer("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7890;ftp=127.0.0.1:7890"))
      .toBe("http://127.0.0.1:7890");
    expect(parseProxyServer("")).toBe("");
    // 没有端口 / 只有 socks 之类不可直接当 http 代理用的写法 → 不采用（宁可直连）
    expect(parseProxyServer("proxy.example.com")).toBe("");
    expect(parseProxyServer("socks=127.0.0.1:1080")).toBe("");
  });
});

describe("端点族识别与思考参数方言", () => {
  it("按域名识别 google / ollama / openai / compat", () => {
    expect(endpointFamily("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("google");
    expect(endpointFamily("http://localhost:11434/v1")).toBe("ollama");
    expect(endpointFamily("https://api.openai.com/v1")).toBe("openai");
    expect(endpointFamily("https://apihub.agnes-ai.com/v1")).toBe("compat");
  });

  it("google 族一律不注入扩展字段（顶层 google/thinking_budget 会被兼容层判 400）", () => {
    // 这条曾经把 24 张卡全打挂：给 Gemini 塞了 google.thinking_config → Invalid JSON payload
    expect(thinkingExtras("google", false)).toEqual({});
    expect(thinkingExtras("google", true)).toEqual({});
    expect(thinkingExtras("openai", false)).toEqual({});
    expect(thinkingExtras("openai", false).chat_template_kwargs).toBeUndefined();
  });

  it("Ollama 与 vLLM/agnes 各自用自己认的键", () => {
    expect(thinkingExtras("ollama", true)).toEqual({ chat_template_kwargs: { thinking: true } });
    expect(thinkingExtras("compat", false)).toEqual({ chat_template_kwargs: { enable_thinking: false, thinking: false } });
  });
});
