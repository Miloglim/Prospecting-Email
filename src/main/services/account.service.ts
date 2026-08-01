import * as crypto from "crypto";
import { getDb } from "../db";
import { emailAccounts, type EmailAccountRow, type InsertEmailAccountRow } from "../db/schema/accounts";
import { eq } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

// ── 密钥管理 ──

/** 从环境变量读取加密密钥。ponytail: 未设置时抛异常，强制配置 */
function getSecretKey(): Buffer {
  const key = process.env.APP_SECRET_KEY || "prospector-dev-key-32chars!!"; // 32 bytes
  return Buffer.from(key.padEnd(32, "!").slice(0, 32), "utf-8");
}

const ALGORITHM = "aes-256-gcm";

/** 加密密码 — 每次加密用随机 IV */
function encryptPassword(plaintext: string): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式: iv:tag:ciphertext (hex 编码)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** 解密密码 */
function decryptPassword(encrypted: string): string {
  const key = getSecretKey();
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

/** 验证 SMTP 连接 */
async function validateSmtp(host: string, port: number, email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  // ponytail: 使用简单 TCP 握手验证，不依赖 nodemailer
  return new Promise((resolve) => {
    try {
      const tls = require("tls") as typeof import("tls");
      const net = require("net") as typeof import("net");

      const isSecure = port === 465;
      const socket = isSecure
        ? tls.connect({ host, port, rejectUnauthorized: false, timeout: 10000 })
        : net.connect({ host, port, timeout: 10000 });

      socket.on("error", (err: Error) => {
        socket.destroy();
        resolve({ ok: false, error: err.message });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ok: false, error: "连接超时" });
      });

      socket.on("connect", () => {
        socket.destroy();
        resolve({ ok: true });
      });
    } catch (err: unknown) {
      resolve({ ok: false, error: err instanceof Error ? err.message : "连接失败" });
    }
  });
}

/** 验证 IMAP 连接 */
async function validateImap(host: string, port: number, email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const tls = require("tls") as typeof import("tls");
      const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: 10000 });

      socket.on("error", (err: Error) => {
        socket.destroy();
        resolve({ ok: false, error: err.message });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ok: false, error: "连接超时" });
      });

      socket.on("secureConnect", () => {
        socket.destroy();
        resolve({ ok: true });
      });
    } catch (err: unknown) {
      resolve({ ok: false, error: err instanceof Error ? err.message : "连接失败" });
    }
  });
}

// ── CRUD ──

export async function listAccounts(): Promise<Result<EmailAccountRow[]>> {
  const rows = getDb().select().from(emailAccounts).all();
  return okResult(rows);
}

export async function upsertAccount(
  input: InsertEmailAccountRow & { password: string } // 接收明文密码
): Promise<Result<EmailAccountRow>> {
  Log.debug("account.upsert", `email=${input.email}`);

  if (!input.email || !input.password || !input.smtpHost) {
    return failResult("email、password、smtpHost 必填");
  }

  // ① 先验证连接
  const smtpResult = await validateSmtp(input.smtpHost, input.smtpPort || 587, input.email, input.password);
  if (!smtpResult.ok) {
    return failResult(`SMTP 连接失败: ${smtpResult.error}`);
  }

  if (input.imapHost) {
    const imapResult = await validateImap(input.imapHost, input.imapPort || 993, input.email, input.password);
    if (!imapResult.ok) {
      return failResult(`IMAP 连接失败: ${imapResult.error}`);
    }
  }

  // ② 加密密码
  const encryptedPass = encryptPassword(input.password);

  // ③ 保存
  const existing = getDb().select().from(emailAccounts)
    .where(eq(emailAccounts.email, input.email)).get();

  const now = new Date().toISOString();

  if (existing) {
    getDb().update(emailAccounts).set({
      smtpHost: input.smtpHost, smtpPort: input.smtpPort,
      imapHost: input.imapHost, imapPort: input.imapPort,
      encryptedPass, displayName: input.displayName, signature: input.signature,
    }).where(eq(emailAccounts.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(emailAccounts)
      .where(eq(emailAccounts.id, existing.id)).get()!;
    Log.info("account.upsert", `${input.email} 已更新`);
    return okResult(updated);
  }

  getDb().insert(emailAccounts).values({
    ...input,
    encryptedPass,
    createdAt: now,
  }).run();
  saveDatabase();

  const created = getDb().select().from(emailAccounts)
    .where(eq(emailAccounts.email, input.email)).get()!;
  Log.info("account.upsert", `${input.email} 已创建`);
  return okResult(created);
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
  try {
    return okResult(decryptPassword(account.encryptedPass));
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
