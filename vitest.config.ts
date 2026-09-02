import { defineConfig } from "vitest/config";

// .trash/ 是运行时垃圾与临时快照目录（删除保护回收站、评测报告、离线验证时 checkout 出来的
// 索引树副本）。默认 include 会把副本里的 *.test.ts 一起扫进来跑，导致评测数字被污染
// （实测一次假「12%」就是这么来的）。永久排除。
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.trash/**", "**/*.bak"],
  },
});
