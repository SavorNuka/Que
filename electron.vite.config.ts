import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@main': resolve('src/main') },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        /**
         * MUST be CommonJS.
         *
         * Electron's docs are explicit: "ESM cannot be used in sandboxed
         * preload scripts" — they run as plain JavaScript with no ESM context.
         * Because package.json sets "type": "module", electron-vite would
         * otherwise emit index.mjs full of `import` statements, which silently
         * fails to load under sandbox: true. The symptom is a blank window:
         * window.que never gets defined and the first render throws.
         *
         * .cjs rather than .js so the extension is unambiguous regardless of
         * the package "type". Keep this in step with the preload path in
         * src/main/index.ts.
         */
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
