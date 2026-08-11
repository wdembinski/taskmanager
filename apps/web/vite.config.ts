/**
 * apps/web is a plain Vite + React app — no path aliases into sibling packages, unlike
 * apps/client's electron-vite config. `@tm/ui`, `@tm/shared` and `@tm/protocol` are real
 * workspace packages here (built by `tsup` to `dist/`, dual ESM/CJS `exports`), resolved by
 * Vite through node_modules exactly like any published dependency — see those packages'
 * own `package.json` and electron.vite.config.ts's comment on why apps/client, alone, takes
 * the source-alias shortcut instead.
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * This build's own version, for the status bar. The desktop reads its equivalent from
 * `app:getInfo`; a browser bundle has no runtime to ask, so the number is baked in at
 * build time from the same `package.json` the release bumps.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5175,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
