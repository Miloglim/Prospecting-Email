import { defineConfig } from 'electron-vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve('electron/main.js'),
          logger: resolve('electron/logger.js'),
          'modules/core/logger': resolve('electron/modules/core/logger.js'),
        },
        external: ['electron', 'electron-reloader'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: { index: resolve('electron/preload.js') },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: 'electron/renderer',
    build: {
      outDir: resolve('dist/renderer'),
      rollupOptions: {
        input: { index: resolve('electron/renderer/index.html') },
      },
    },
  },
});
