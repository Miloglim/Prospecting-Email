import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@main": resolve("src/main") },
    },
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["better-sqlite3"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@preload": resolve("src/preload") },
    },
    build: {
      outDir: "dist/preload",
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      // "@" → src/renderer：shadcn 生态标准别名，组件从 shadcn 站点复制后可直接运行
      alias: { "@renderer": resolve("src/renderer"), "@": resolve("src/renderer") },
    },
    // 运行时写入的文件会让 Vite dev 触发 full-reload、把整个 SPA 重置（改 KB / API key 写 .env 即如此）。
    // 这些都不进模块图、也不需要 HMR，让 dev 服务器忽略它们。打包版无此监视器，本就不受影响。
    server: {
      watch: {
        ignored: ["**/.env", "**/.env.*", "**/data/**", "**/send/**", "**/logs/**", "**/ai/providers.json"],
      },
    },
    build: {
      outDir: "dist/renderer",
    },
  },
});
