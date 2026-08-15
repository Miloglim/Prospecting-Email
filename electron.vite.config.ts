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
      alias: { "@renderer": resolve("src/renderer") },
    },
    build: {
      outDir: "dist/renderer",
    },
  },
});
