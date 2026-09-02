// 一次性：把 KB 令牌安全写入真实项目 .env（走 upsertEnv，令牌来自环境变量，不硬编码），
// 然后跑一次真实连通探针。只打印状态码/判定，绝不回显令牌。
// 用法: KB_TOKEN_VALUE='kbtt_...' npx tsx scripts/kb-live-test.ts
import * as fs from "fs";
import * as path from "path";
import { APP_ROOT } from "../src/main/config";

async function main() {
  const token = (process.env.KB_TOKEN_VALUE || "").trim();
  if (!token) { console.error("缺少 KB_TOKEN_VALUE 环境变量"); process.exit(2); }

  const envFile = path.join(APP_ROOT, ".env");
  const has = fs.existsSync(envFile) ? /(^|\n)KB_BASE_URL=/.test(fs.readFileSync(envFile, "utf-8")) : false;

  const Kb = await import("../src/main/services/kb.service");
  // 复用应用同款落盘（若还没配过地址，则默认生产 KB 地址）
  Kb.setKbConfig({ token, baseUrl: has ? undefined : "https://kb.iyunquna.com" });

  const cfg = Kb.getKbConfig();
  console.log("生效端点:", cfg.endpoint);
  console.log("令牌预览:", cfg.tokenPreview);

  const t = await Kb.kbTestConnection(15_000);
  if (!t.success) { console.log("探针失败:", t.error); return; }
  console.log("探针结果:", JSON.stringify({ verdict: t.data.verdict, reachable: t.data.reachable, authed: t.data.authed, kbStatus: t.data.kbStatus, hint: t.data.hint }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
