import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app, safeStorage } from "electron";
import { Log } from "./logger";

// ── 主密钥管理（P0-1 凭据治理）──────────────────────────────────
// 目标：AES 密钥不再硬编码/可随安装包分发。
//  · 首选 Electron safeStorage（Windows = DPAPI，密钥绑定当前用户）：
//    随机 32 字节密钥 → safeStorage 加密后存 userData/master.key；
//  · safeStorage 不可用（极少数环境）→ 机器指纹派生密钥，不落盘、不进安装包；
//  · 旧密文（dev 硬编码密钥加密）由 account.service 的迁移函数一次性重封装。

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  return path.join(app.getPath("userData"), "master.key");
}

/** 获取（首次调用时创建）主密钥。须在 app ready 之后调用。 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const file = keyFilePath();

  // 已有密钥文件 → safeStorage 解密
  if (fs.existsSync(file)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const wrapped = fs.readFileSync(file); // safeStorage 密文按字节存取
        cachedKey = Buffer.from(safeStorage.decryptString(wrapped), "base64");
        if (cachedKey.length === 32) return cachedKey;
        Log.warn("secret", "master.key 长度异常，将重建密钥");
      } else {
        Log.error("secret", "master.key 存在但 safeStorage 不可用，旧密文将无法解密");
      }
    } catch (err) {
      Log.error("secret", `master.key 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 无可用密钥文件 → 生成新密钥
  if (safeStorage.isEncryptionAvailable()) {
    const fresh = crypto.randomBytes(32);
    fs.writeFileSync(file, safeStorage.encryptString(fresh.toString("base64")));
    Log.info("secret", "已生成新的主密钥（safeStorage/DPAPI 保护）");
    cachedKey = fresh;
    return cachedKey;
  }

  // 兜底：机器指纹派生（同机稳定、不随安装包分发、换机即失效）
  cachedKey = crypto.createHash("sha256")
    .update(`${os.hostname()}|${os.userInfo().username}|prospector-master-key`)
    .digest();
  Log.warn("secret", "safeStorage 不可用，改用机器指纹派生密钥（密文仅本机可解）");
  return cachedKey;
}
