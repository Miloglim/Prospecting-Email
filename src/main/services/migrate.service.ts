// ── 旧 PE → 4.0 配置迁移 ─────────────────────────────────────────────
// 只迁移用户设置：发信账号（SMTP/IMAP，密码 AES 加密）、发件人名称、正文署名、发送调度。
// 不迁移业务数据（联系人/公司/收件箱/历史）——用户在另一个工具管理客户数据。
// 不迁移外部 API 密钥（DeepSeek/Exa 等）——提示手动配置 .env。
// 迁移前备份 4.0 数据库（账号表）。

import * as fs from "fs";
import * as path from "path";
import { getDb, getSqlJsDb, saveDatabase } from "../db";
import { DB_PATH } from "../config";
import { eq } from "drizzle-orm";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { emailAccounts } from "../db/schema/accounts";
import { encryptPassword } from "./account.service";
import { loadConfig, saveConfig, DEFAULT_SCHEDULE, type SendSchedule, type RuntimeConfig } from "../config";

// ── 类型 ──

export interface MigrationPreview {
  legacyDir: string;
  configFound: boolean;
  accounts: number;        // 旧配置里可迁移的账号数
  accountsExisting: number; // 4.0 已有账号数（同名会跳过）
  fromName: boolean;
  signature: boolean;
  schedule: boolean;
  apiKeysDetected: string[];
  configFields: Array<{ legacy: string; target: string; value?: string }>;
}

export interface MigrationReport {
  importedAccounts: number;
  skippedAccounts: number;
  importedConfig: string[];
  backupPath: string | null;
}

// ── 读取旧配置 ──

interface LegacyAccount {
  id?: string; label?: string; active?: number | boolean;
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string };
  imap?: { host?: string; port?: number; user?: string; pass?: string };
}

interface LegacyConfig {
  sender?: { name?: string; email?: string; phone?: string; website?: string; bodyName?: string };
  signature?: { text?: string };
  schedule?: Record<string, unknown>;
  smtpAccounts?: LegacyAccount[];
  imap?: { host?: string; user?: string; pass?: string };
  search?: { apiKey?: string; provider?: string; serperKey?: string; exaKey?: string };
  translate?: { deepseek?: { apiKey?: string } };
  verify?: { agnesKey?: string };
  [k: string]: unknown;
}

function readLegacyConfig(dir: string): LegacyConfig | null {
  try {
    const p = path.join(dir, "send", "config.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as LegacyConfig;
  } catch (err: unknown) {
    Log.error("migrate.config", "读取旧配置失败", err instanceof Error ? err.stack : String(err));
    return null;
  }
}

function hasNonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

// ── 自动探测旧 PE 目录 ──
// 候选: %APPDATA% 下旧打包版目录 + 旧源码目录。按配置存在性排序。

export interface LegacyDirCandidate {
  dir: string;
  hasConfig: boolean;
}

export function detectLegacyDirs(): Result<LegacyDirCandidate[]> {
  const appData = process.env.APPDATA || "";
  const candidates: string[] = [];
  if (appData) {
    for (const name of ["outreacher", "prospecting-email", "prospecting-email-send", "prospecting-email-send-dev"]) {
      candidates.push(path.join(appData, name));
    }
  }
  candidates.push(path.join(__dirname, "..", "..", "..", "Prospecting Email"));

  const found: LegacyDirCandidate[] = [];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const hasConfig = fs.existsSync(path.join(dir, "send", "config.json"));
      if (hasConfig) found.push({ dir, hasConfig });
    } catch { /* 跳过异常目录 */ }
  }
  return okResult(found);
}

// 旧调度 → 4.0 调度
function mapSchedule(old?: Record<string, unknown>): SendSchedule {
  const s = { ...DEFAULT_SCHEDULE };
  if (!old) return s;
  const num = (k: string): number | undefined => {
    const v = old[k];
    return typeof v === "number" && !isNaN(v) ? v : undefined;
  };
  const bool = (k: string): boolean | undefined => typeof old[k] === "boolean" ? old[k] as boolean : undefined;

  const startHour = num("start_hour_beijing");
  const endHour = num("end_hour_beijing");
  if (startHour !== undefined) s.startHour = startHour;
  if (endHour !== undefined) s.endHour = endHour;

  const tw = bool("time_window_enabled");
  if (tw !== undefined) s.timeWindowEnabled = tw;

  const cdMin = num("company_delay_min_seconds");
  const cdMax = num("company_delay_max_seconds");
  if (cdMin !== undefined) s.companyDelayMinMinutes = Math.max(1, Math.round(cdMin / 60));
  if (cdMax !== undefined) s.companyDelayMaxMinutes = Math.max(1, Math.round(cdMax / 60));

  const srMin = num("single_recip_delay_min_seconds");
  const srMax = num("single_recip_delay_max_seconds");
  if (srMin !== undefined) s.singleRecipDelayMinSeconds = srMin;
  if (srMax !== undefined) s.singleRecipDelayMaxSeconds = srMax;

  const bpMin = num("batch_pause_min_seconds") ?? num("batch_pause_min");
  const bpMax = num("batch_pause_max_seconds") ?? num("batch_pause_max");
  if (bpMin !== undefined) s.batchPauseMinSeconds = bpMin;
  if (bpMax !== undefined) s.batchPauseMaxSeconds = bpMax;

  const tr = num("template_rotate_groups");
  if (tr !== undefined) s.templateRotateGroups = tr;

  const bs = num("batch_size");
  if (bs !== undefined) s.batchSize = bs;

  return s;
}

// ── 预览 ──

export function previewMigration(dir: string): Result<MigrationPreview> {
  const trimmed = dir.trim();
  if (!trimmed) return failResult("请选择旧 PE 目录");

  const cfg = readLegacyConfig(trimmed);
  if (!cfg) return failResult(`目录 ${trimmed} 下找不到 send/config.json`);

  const migrateableAccounts = (cfg.smtpAccounts || [])
    .filter(a => a?.smtp?.user && hasNonEmpty(a.smtp.user));

  const apiKeysDetected: string[] = [];
  if (hasNonEmpty(cfg.search?.apiKey)) apiKeysDetected.push("search.apiKey");
  if (hasNonEmpty(cfg.search?.serperKey)) apiKeysDetected.push("search.serperKey");
  if (hasNonEmpty(cfg.search?.exaKey)) apiKeysDetected.push("search.exaKey");
  if (hasNonEmpty(cfg.translate?.deepseek?.apiKey)) apiKeysDetected.push("translate.deepseek.apiKey");
  if (hasNonEmpty(cfg.verify?.agnesKey)) apiKeysDetected.push("verify.agnesKey");

  const db = getDb();
  const accountsExisting = db.select().from(emailAccounts).all().length;

  const configFields: MigrationPreview["configFields"] = [
    { legacy: "sender.name", target: "发件人名称", value: cfg.sender?.name ? "已检测" : "-" },
    { legacy: "signature.text", target: "正文署名", value: cfg.signature?.text ? "已检测" : "-" },
    { legacy: "schedule.*", target: "发送规则", value: cfg.schedule ? "已检测" : "-" },
    { legacy: "smtpAccounts[].smtp.user", target: "发信账号", value: migrateableAccounts.length ? `${migrateableAccounts.length} 个账号` : "-" },
    { legacy: "smtpAccounts[].smtp.pass", target: "账号密码（AES 加密）", value: migrateableAccounts.some(a => hasNonEmpty(a.smtp?.pass)) ? "已检测（将加密迁移）" : "-" },
  ];

  return okResult({
    legacyDir: trimmed,
    configFound: true,
    accounts: migrateableAccounts.length,
    accountsExisting,
    fromName: hasNonEmpty(cfg.sender?.name),
    signature: hasNonEmpty(cfg.signature?.text),
    schedule: !!cfg.schedule,
    apiKeysDetected,
    configFields,
  });
}

// ── 执行迁移（只迁配置）──

export function runMigration(dir: string): Result<MigrationReport> {
  const trimmed = dir.trim();
  if (!trimmed) return failResult("请选择旧 PE 目录");

  // 备份
  let backupPath: string | null = null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backupPath = `${DB_PATH}.bak-${stamp}`;
    fs.copyFileSync(DB_PATH, backupPath);
    Log.info("migrate", `已备份数据库 → ${backupPath}`);
  } catch (err: unknown) {
    Log.error("migrate.backup", "备份失败", err instanceof Error ? err.stack : String(err));
    return failResult("备份数据库失败，已中止迁移");
  }

  const cfg = readLegacyConfig(trimmed);
  if (!cfg) return failResult(`目录 ${trimmed} 下找不到 send/config.json`);

  const db = getDb();
  let importedAccounts = 0;
  let skippedAccounts = 0;

  // 1. 账号（密码 AES 加密，按 email 判重）
  for (const a of (cfg.smtpAccounts || [])) {
    if (!a?.smtp?.user || !hasNonEmpty(a.smtp.user)) continue;
    const existing = db.select().from(emailAccounts)
      .where(eq(emailAccounts.email, a.smtp.user)).all();
    if (existing.length > 0) { skippedAccounts++; continue; }

    const encrypted = encryptPassword(a.smtp.pass || "");
    db.insert(emailAccounts).values({
      email: a.smtp.user,
      provider: "smtp",
      smtpHost: a.smtp.host || null,
      smtpPort: a.smtp.port || 587,
      imapHost: a.imap?.host || cfg.imap?.host || null,
      imapPort: a.imap?.port || (a.imap?.host ? 993 : null),
      encryptedPass: encrypted,
      displayName: a.label || null,
      isActive: a.active === undefined ? 1 : a.active ? 1 : 0,
    }).run();
    importedAccounts++;
  }

  // 2. 发件人名称 / 署名 / 调度
  const importedConfig: string[] = [];
  const cur = loadConfig();
  const patch: Partial<RuntimeConfig> = {};
  if (hasNonEmpty(cfg.sender?.name)) { patch.fromName = cfg.sender!.name!; importedConfig.push("发件人名称"); }
  if (hasNonEmpty(cfg.signature?.text)) { patch.signature = cfg.signature!.text!; importedConfig.push("正文署名"); }
  if (cfg.schedule) { patch.schedule = mapSchedule(cfg.schedule); importedConfig.push("发送规则"); }
  if (Object.keys(patch).length > 0) {
    saveConfig({ ...cur, ...patch });
  }

  saveDatabase();
  Log.info("migrate", `配置迁移完成: ${importedAccounts} 账号, ${importedConfig.join("/")}`);

  return okResult({ importedAccounts, skippedAccounts, importedConfig, backupPath });
}
