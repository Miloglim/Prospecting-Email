import * as crypto from "crypto";
import { getDb, saveDatabase } from "../db";
import { emailAccounts, type EmailAccountRow, type InsertEmailAccountRow } from "../db/schema/accounts";
import { eq } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { getMasterKey } from "../secret-store";

// ── 密钥管理（P0-1）────────────────────────────────────────────
// 主密钥来自 secret-store（safeStorage/DPAPI 或机器指纹派生），不再硬编码。
// LEGACY_KEY 仅用于一次性迁移旧密文 —— 迁移完成后旧密钥对已重封装的数据不再有效，
// 即便随 asar 泄露也解不出迁移后的密文。
const LEGACY_KEY = Buffer.from("prospector-dev-key-32chars!!".padEnd(32, "!").slice(0, 32), "utf-8");

const ALGORITHM = "aes-256-gcm";

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式: iv:tag:ciphertext (hex 编码)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptWith(key: Buffer, encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("无效的加密格式");
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

/** 加密密码 — 主密钥（safeStorage 保护）+ 随机 IV */
export function encryptPassword(plaintext: string): string {
  return encryptWith(getMasterKey(), plaintext);
}

/** 解密密码 — 主密钥优先，失败回落旧密钥（迁移前的存量密文） */
function decryptPassword(encrypted: string): string {
  try {
    return decryptWith(getMasterKey(), encrypted);
  } catch {
    return decryptWith(LEGACY_KEY, encrypted);
  }
}

/** 启动迁移：把旧密钥加密的存量密文重封装为主密钥（幂等，调用一次即可） */
export function migrateAccountPasswords(): void {
  const rows = getDb().select().from(emailAccounts).all();
  let migrated = 0;
  for (const r of rows) {
    const raw = r.encryptedPass;
    if (!raw || !raw.includes(":")) continue; // 明文旧行由 getDecryptedPassword 兼容读取
    try {
      decryptWith(getMasterKey(), raw);
      continue; // 已是新密钥
    } catch { /* 需要迁移 */ }
    try {
      const plain = decryptWith(LEGACY_KEY, raw);
      getDb().update(emailAccounts)
        .set({ encryptedPass: encryptWith(getMasterKey(), plain) })
        .where(eq(emailAccounts.id, r.id)).run();
      migrated++;
    } catch {
      Log.error("account.migrate", `账号 ${r.email} 密文既非本机密钥也非旧密钥，无法迁移`);
    }
  }
  if (migrated > 0) {
    saveDatabase();
    Log.info("account.migrate", `${migrated} 个账号密文已迁移至 safeStorage 主密钥`);
  }
}

// ── 验证器 ──

interface ValidateInput {
  email: string;
  smtpHost: string; smtpPort: number;
  imapHost?: string; imapPort?: number;
  password: string; // 明文（保存前验证用）
}

interface ValidateResult {
  smtpOk: boolean; smtpError?: string;
  imapOk: boolean; imapError?: string;
}

/** 把 nodemailer / imapflow 的原始报错归类成人话，重点区分"认证失败(授权码错)" */
function classifyMailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: string | number; hostname?: string; message?: string };
  const msg = e?.message || String(err);
  const code = e?.code || "";
  // 认证失败：nodemailer EAUTH / imapflow AuthenticationFailed / SMTP 535
  if (code === "EAUTH" || /authenticat|invalid\s+(login|credentials?)|AUTHENTICATIONFAILED|password|\b535\b|LOGIN failed|\[ALERT\].*login/i.test(msg)) {
    return "认证失败：密码或第三方客户端授权码不正确/已失效";
  }
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(msg)) return "连接超时";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo|EAI_AGAIN|socket hang up/i.test(msg + code)) {
    return `无法连接服务器${e?.hostname ? `（${e.hostname}）` : ""}`;
  }
  if (/certificate|self-signed|unable to verify|SSL|TLS|handshake/i.test(msg)) {
    return `加密握手失败：${msg}`;
  }
  return msg;
}

/** 验证 SMTP：真实建立连接并 AUTH LOGIN 认证（不只是 TCP 握手） */
async function validateSmtp(host: string, port: number, email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const nodemailer = require("nodemailer") as typeof import("nodemailer");
    const transporter = nodemailer.createTransport({
      host, port,
      secure: port === 465,
      requireTLS: port !== 465,        // 587/25 强制 STARTTLS
      auth: { user: email, pass: password },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: { rejectUnauthorized: true }, // P0-3：证书校验开启
    });
    await transporter.verify();         // 完整 EHLO + AUTH 流程，凭据错即抛
    transporter.close();
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: classifyMailError(err) };
  }
}

/** 验证 IMAP：真实 LOGIN（不只是 TLS 握手） */
async function validateImap(host: string, port: number, email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  let client: import("imapflow").ImapFlow | null = null;
  try {
    const imapflow = require("imapflow") as typeof import("imapflow");
    client = new imapflow.ImapFlow({
      host, port, secure: (port || 993) === 993,
      auth: { user: email, pass: password },
      logger: false,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: { rejectUnauthorized: true }, // P0-3：证书校验开启
    });
    await client.connect();              // 触发 IMAP LOGIN，认证失败即抛
    await client.logout();
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: classifyMailError(err) };
  } finally {
    try { client?.close(); } catch { /* 已关闭 */ }
  }
}

// ── CRUD ──

export type AccountProjection = Omit<EmailAccountRow, "encryptedPass">;

/** 账号列表（P0-1 投影：密文不出主进程） */
export async function listAccounts(): Promise<Result<AccountProjection[]>> {
  const rows = getDb().select().from(emailAccounts).all();
  return okResult(rows.map(({ encryptedPass: _omit, ...rest }) => rest));
}

export async function upsertAccount(
  input: InsertEmailAccountRow & { password?: string; id?: number }
): Promise<Result<AccountProjection>> {
  const isEdit = !!input.id;
  Log.debug("account.upsert", `email=${input.email} isEdit=${isEdit}`);

  if (!input.email || !input.smtpHost) return failResult("email、smtpHost 必填");
  if (!isEdit && !input.password) return failResult("新增时密码必填");

  // ponytail: 编辑模式无密码 → 跳过验证，保留原密码；有密码 → 重新验证+加密
  if (!isEdit || input.password) {
    const pass = input.password!;
    const smtpResult = await validateSmtp(input.smtpHost, input.smtpPort || 587, input.email, pass);
    if (!smtpResult.ok) return failResult(`SMTP 连接失败: ${smtpResult.error}`);

    if (input.imapHost) {
      const imapResult = await validateImap(input.imapHost, input.imapPort || 993, input.email, pass);
      if (!imapResult.ok) return failResult(`IMAP 连接失败: ${imapResult.error}`);
    }
  }

  // 加密密码（编辑无密码则保留原值）
  const encryptedPass = input.password ? encryptPassword(input.password) : undefined;

  const existing = isEdit
    ? getDb().select().from(emailAccounts).where(eq(emailAccounts.id, input.id!)).get()
    : getDb().select().from(emailAccounts).where(eq(emailAccounts.email, input.email)).get();

  const now = new Date().toISOString();

  if (existing) {
    const updateData: Record<string, unknown> = {
      smtpHost: input.smtpHost, smtpPort: input.smtpPort,
      imapHost: input.imapHost, imapPort: input.imapPort,
      displayName: input.displayName, signature: input.signature,
    };
    if (encryptedPass) updateData.encryptedPass = encryptedPass;
    getDb().update(emailAccounts).set(updateData).where(eq(emailAccounts.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(emailAccounts)
      .where(eq(emailAccounts.id, existing.id)).get()!;
    Log.info("account.upsert", `${input.email} 已更新`);
    const { encryptedPass: _u, ...updatedRest } = updated;
    return okResult(updatedRest);
  }

  getDb().insert(emailAccounts).values({
    ...input,
    encryptedPass: encryptedPass!,
    createdAt: now,
  }).run();
  saveDatabase();

  const created = getDb().select().from(emailAccounts)
    .where(eq(emailAccounts.email, input.email)).get()!;
  Log.info("account.upsert", `${input.email} 已创建`);
  const { encryptedPass: _c, ...createdRest } = created;
  return okResult(createdRest);
}

export async function deleteAccount(id: number): Promise<Result<void>> {
  Log.debug("account.delete", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");

  const existing = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, id)).get();
  if (!existing) return failResult("账号不存在");

  getDb().delete(emailAccounts).where(eq(emailAccounts.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}

/** 获取解密后的密码（仅 internal 使用，不暴露到 IPC） */
export function getDecryptedPassword(id: number): Result<string> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, id)).get();
  if (!account) return failResult("账号不存在");
  const raw = account.encryptedPass;
  // ponytail: 旧格式（非 iv:tag:ciphertext）当明文，兼容加密引入前的账号
  if (!raw.includes(":")) return okResult(raw);
  try {
    return okResult(decryptPassword(raw));
  } catch (err: unknown) {
    return failResult("解密失败", err);
  }
}

/** 验证已有账号的连通性 */
export async function validateAccount(id: number): Promise<Result<ValidateResult>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, id)).get();
  if (!account) return failResult("账号不存在");

  const password = getDecryptedPassword(id);
  if (!password.success) return failResult(password.error);

  const smtpOk = account.smtpHost
    ? await validateSmtp(account.smtpHost, account.smtpPort || 587, account.email, password.data)
    : { ok: false, error: "未配置 SMTP" };

  const imapOk = account.imapHost
    ? await validateImap(account.imapHost, account.imapPort || 993, account.email, password.data)
    : { ok: false, error: "未配置 IMAP" };

  return okResult({ smtpOk: smtpOk.ok, smtpError: smtpOk.error, imapOk: imapOk.ok, imapError: imapOk.error });
}
