// 通用：把某个密钥经环境变量安全写入项目根 .env（走 upsertEnv，值不落代码/不打印）。
// 用法: KEY_NAME=GEMINI_API_KEY KEY_VALUE='xxxx' npx tsx scripts/store-key.ts
import { upsertEnv, readEnvFile } from "../src/main/env-store";

const name = (process.env.KEY_NAME || "").trim();
const value = (process.env.KEY_VALUE || "").trim();
if (!name || !value) { console.error("需要 KEY_NAME 与 KEY_VALUE 环境变量"); process.exit(2); }

upsertEnv(name, value);
const stored = (readEnvFile()[name] || "").trim();
const preview = stored.length > 10 ? `${stored.slice(0, 5)}…${stored.slice(-4)}` : "(已存但异常短)";
console.log(`已写入 ${name}=${preview} 到 .env（长度 ${stored.length}）`);
