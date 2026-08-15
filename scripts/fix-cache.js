// 监听 electron-builder Cache 目录，自动修复 winCodeSign 提取失败（符号链接权限）
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CACHE = path.join(process.env.HOME || process.env.USERPROFILE || "~",
  "AppData", "Local", "electron-builder", "Cache", "winCodeSign");

console.log("[fix-cache] Watching:", CACHE);

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

const SEVENZA = path.join(__dirname, "..", "node_modules", "7zip-bin", "win", "x64", "7za.exe");

// Fix a single cache directory
function fix(dir) {
  const libDir = path.join(dir, "darwin", "10.12", "lib");
  if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
  const crypto = path.join(libDir, "libcrypto.dylib");
  const ssl = path.join(libDir, "libssl.dylib");
  if (!fs.existsSync(crypto)) fs.writeFileSync(crypto, "");
  if (!fs.existsSync(ssl)) fs.writeFileSync(ssl, "");
}

// Fix existing
fs.readdirSync(CACHE).forEach(f => {
  const full = path.join(CACHE, f);
  if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "rcedit-x64.exe"))) {
    fix(full);
  }
});

// Watch for new 7z files and auto-extract + fix
fs.watch(CACHE, (_event, filename) => {
  if (!filename || !filename.endsWith(".7z")) return;
  const base = filename.replace(".7z", "");
  const dir = path.join(CACHE, base);
  if (fs.existsSync(dir)) return; // already extracted

  console.log("[fix-cache] Extracting:", filename);
  try {
    // Extract without -snld (skip symlinks)
    execSync(`"${SEVENZA}" x -y -bd "${path.join(CACHE, filename)}" -o"${dir}"`, {
      stdio: "pipe", timeout: 30000,
    });
    fix(dir);
    console.log("[fix-cache] Fixed:", base);
  } catch (e) {
    // Extraction might fail, but try to fix partial extraction
    try { fix(dir); } catch {}
  }
});

console.log("[fix-cache] Ready. Press Ctrl+C to stop.");
process.on("SIGINT", () => process.exit(0));
