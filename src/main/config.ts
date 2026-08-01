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

export interface SMTPAccount {
  id: number;
  email: string;
  host: string;
  port: number;
  encryptedPass: string;
}

export interface SendSchedule {
  /** 时间窗口 */
  timeWindowEnabled: boolean;
  startHour: number;   // 北京时 9
  endHour: number;     // 北京时 8（次日）
  /** 组内单封间隔（秒） */
  minDelaySeconds: number;
  maxDelaySeconds: number;
  /** 公司组之间间隔（分钟）— 模拟人工"一批一批发" */
  companyDelayMinMinutes: number;
  companyDelayMaxMinutes: number;
  /** 单公司单联系人额外间隔（秒） */
  singleRecipDelayMinSeconds: number;
  singleRecipDelayMaxSeconds: number;
  /** 每 N 组换模板 */
  templateRotateGroups: number;
  /** 每批加队列数量 + 批间暂停 */
  batchSize: number;
  batchPauseMinSeconds: number;
  batchPauseMaxSeconds: number;
}

export interface RuntimeConfig {
  smtpAccounts: SMTPAccount[];
  schedule: SendSchedule;
}

export const DEFAULT_SCHEDULE: SendSchedule = {
  timeWindowEnabled: true,
  startHour: 9,
  endHour: 8,
  minDelaySeconds: 8,
  maxDelaySeconds: 16,
  companyDelayMinMinutes: 15,
  companyDelayMaxMinutes: 20,
  singleRecipDelayMinSeconds: 5,
  singleRecipDelayMaxSeconds: 10,
  templateRotateGroups: 3,
  batchSize: 12,
  batchPauseMinSeconds: 94,
  batchPauseMaxSeconds: 167,
};

const DEFAULT_CONFIG: RuntimeConfig = {
  smtpAccounts: [],
  schedule: DEFAULT_SCHEDULE,
};

export function loadConfig(): RuntimeConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    // ponytail: 首次运行返回默认配置，不抛异常
    return DEFAULT_CONFIG;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config: RuntimeConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
