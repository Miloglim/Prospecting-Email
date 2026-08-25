import * as path from "path";
import * as fs from "fs";

// ponytail: process.resourcesPath 是 Electron 扩展，Node 类型不含它

/** 获取应用根目录。
 *  ponytail: app 模块在 Electron 主进程运行时可用，非 Electron 测试环境用 __dirname 兜底 */
function getAppRoot(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return app.isPackaged
      ? app.getPath("userData")
      : path.resolve(__dirname, "..", "..");
  } catch {
    return path.resolve(__dirname, "..", "..");
  }
}

export const APP_ROOT = getAppRoot();

/** 资源根目录 */
export function getResourcesRoot(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return app.isPackaged
      ? path.join((process as unknown as Record<string, string>).resourcesPath || "", "assets")
      : path.resolve(__dirname, "..", "..", "assets");
  } catch {
    return path.resolve(__dirname, "..", "..", "assets");
  }
}

/** 数据库路径 */
export const DB_PATH = path.join(APP_ROOT, "data", "prospector.db");

/** send/config.json 路径 */
const CONFIG_PATH = path.join(APP_ROOT, "send", "config.json");

export interface SendSchedule {
  /** 时间窗口 */
  timeWindowEnabled: boolean;
  startHour: number;   // 北京时 9
  endHour: number;     // 北京时 8（次日）
  /** 每组人数上限（同公司超过 N 拆多组） */
  groupSize: number;
  /** 组间暂停区间（秒）— 模拟人工一批批发 */
  groupDelayMinSeconds: number;
  groupDelayMaxSeconds: number;
}

export interface RuntimeConfig {
  /** 通用设置 */
  general?: { closeAction?: "tray" | "quit" };
  /** 全局发信日限额（从首次真实发送起 24h 重置） */
  sendQuota?: { dailyLimit: number; firstSendAt: string | null; sentToday: number };
  /** 全局默认发件人名称（账号 displayName 优先） */
  fromName: string;
  /** 邮件正文中的自称（如 Zayne），用于正文落款 */
  bodyName: string;
  /** 正文署名，追加到每封邮件末尾 */
  signature: string;
  schedule: SendSchedule;
  /** 测试模式（发信测试用） */
  test: {
    email: string;      // 测试收件邮箱
    company: string;    // 测试用的公司名
    enabled: boolean;   // 启用测试模式（跳过发送时段限制）
    dryRun: boolean;    // 发信阻隔（流程完整但不实际发送）
  };
  /** CRM 客户跟进偏好 */
  crm: {
    /** 阶段 → 默认跟进间隔（天）*/
    followupDays: Record<string, number>;
    /** Dashboard 待办提前天数 */
    todoAdvanceDays: number;
    /** 自动归档天数（发信后 N 天无回复自动标记为 lost，0=禁用） */
    autoArchiveDays: number;
  };
  /** 预设句库自定义主题（key = `${clientType}.${lang}`，如 direct.EN） */
  sentenceSubjects?: Record<string, string>;
}

export const DEFAULT_SCHEDULE: SendSchedule = {
  timeWindowEnabled: true,
  startHour: 9,
  endHour: 8,
  groupSize: 20,
  groupDelayMinSeconds: 300,
  groupDelayMaxSeconds: 600,
};

const DEFAULT_CONFIG: RuntimeConfig = {
  fromName: "",
  bodyName: "",
  signature: "",
  schedule: DEFAULT_SCHEDULE,
  test: { email: "", company: "", enabled: false, dryRun: false },
  crm: {
    followupDays: { reaching: 3, quoting: 3, trial: 5, cooperating: 7, lost: 14, other: 7 },
    todoAdvanceDays: 2,
    autoArchiveDays: 30,
  },
};

export function loadConfig(): RuntimeConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    // ponytail: 首次运行返回默认配置，不抛异常
    return { ...DEFAULT_CONFIG, schedule: { ...DEFAULT_SCHEDULE }, test: { ...DEFAULT_CONFIG.test } };
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<RuntimeConfig>;
  // 兼容旧 config.json：缺失的新字段补默认值，避免 UI 读到 undefined
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    schedule: { ...DEFAULT_SCHEDULE, ...(raw.schedule || {}) },
    test: { ...DEFAULT_CONFIG.test, ...(raw.test || {}) },
    crm: { ...DEFAULT_CONFIG.crm, ...(raw.crm || {}), followupDays: { ...DEFAULT_CONFIG.crm.followupDays, ...(raw.crm?.followupDays || {}) } },
  };
}

export function saveConfig(config: RuntimeConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
