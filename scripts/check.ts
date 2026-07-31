import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "src", "main");
const errors: string[] = [];
const warnings: string[] = [];

function checkFile(filePath: string, content: string) {
  const rel = path.relative(SRC, filePath);

  // transport 不能 import db
  if (rel.includes("transport") && content.includes(`from "../db"`)) {
    errors.push(`${rel}: transport 层不能直接 import db`);
  }

  // transport 不能 import db/schema
  if (rel.includes("transport") && content.includes(`from "../db/schema`)) {
    errors.push(`${rel}: transport 层不能直接 import schema`);
  }

  // service 不能 import electron
  if (rel.includes("services") && content.includes(`from "electron"`)) {
    errors.push(`${rel}: service 层不能 import electron`);
  }

  // 非 transport 文件不能注册 IPC handler
  if (!rel.includes("transport") && !rel.includes("index.ts") && content.includes("ipcMain.handle")) {
    errors.push(`${rel}: 非 transport 文件不能注册 IPC handler`);
  }

  // console.log 残留
  if (content.match(/console\.log\s*\(/)) {
    warnings.push(`${rel}: 发现 console.log，应使用 Log.info`);
  }

  // 裸 throw 在 service 中
  if (rel.includes("services") && content.match(/\bthrow\s+/)) {
    warnings.push(`${rel}: service 中发现 throw，应使用 failResult`);
  }
}

function scan(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "migrations") {
      scan(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      checkFile(full, fs.readFileSync(full, "utf-8"));
    }
  }
}

scan(SRC);

// 也扫描 renderer
const rendererPath = path.resolve(__dirname, "..", "src", "renderer");
if (fs.existsSync(rendererPath)) {
  scan(rendererPath);
  // 检查 renderer 有没有直接 import main
  for (const entry of fs.readdirSync(rendererPath, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      const content = fs.readFileSync(path.join(entry.parentPath || rendererPath, entry.name), "utf-8");
      if (content.includes(`from "../main`) || content.includes(`from "../../main`)) {
        errors.push(`renderer/${entry.name}: 渲染进程不能 import src/main`);
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn("⚠️ 警告:\n" + warnings.join("\n"));
}

if (errors.length > 0) {
  console.error("\n❌ 架构违规:\n" + errors.join("\n"));
  process.exit(1);
}

console.log("✅ 架构边界检查通过");
