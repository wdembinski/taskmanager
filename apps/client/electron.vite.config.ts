/**
 * electron-vite build configuration.
 *
 * An Electron app is really THREE separate JavaScript bundles that run in
 * different places, so we configure each one independently:
 *
 *   1. `main`     — the Node.js "backend" of the desktop app. Full OS access.
 *                   This is where our orchestration engine (spawning Claude,
 *                   the scheduler, SQLite, the usage-limit gate) lives.
 *   2. `preload`  — a tiny, security-sensitive bridge script that runs with a
 *                   foot in both worlds. It is the ONLY place allowed to expose
 *                   a controlled API to the web page (see src/preload/index.ts).
 *   3. `renderer` — the actual UI: a normal React web app (Fluent UI) that runs
 *                   inside a sandboxed Chromium window with NO direct Node access.
 *
 * electron-vite compiles all three from TypeScript and gives us fast hot-reload
 * during `npm run dev`. Output goes to ./out (see package.json "main").
 */
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps node_modules (e.g. the Claude SDK, better-sqlite3)
    // as external `require`s instead of bundling them — required for native modules.
    plugins: [externalizeDepsPlugin()],
    resolve: {
      // @shared points at packages/shared's SOURCE, not its tsup dist/ — electron-vite
      // bundles it directly, same as any other file in this app. The package build
      // (dist + dual ESM/CJS exports) exists for apps/server and apps/web, which cannot
      // resolve a bare path alias into a sibling package's sources.
      alias: { '@shared': resolve('../../packages/shared/src') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('../../packages/shared/src') },
    },
  },
  renderer: {
    // The renderer is a plain Vite + React app.
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('../../packages/shared/src'),
      },
    },
    plugins: [react()],
  },
});
