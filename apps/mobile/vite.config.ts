/**
 * apps/mobile is a plain Vite + React app, same shape as apps/web's own config (that
 * file's header explains why: `@tm/ui`, `@tm/cloud`, `@tm/shared` and `@tm/protocol` are
 * real workspace packages here, resolved by Vite through node_modules per their own
 * `exports`, unlike apps/client's source-alias shortcut).
 *
 * Port is apps/web's own plus one, so both dev servers can run side by side.
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * This build's own version, for the status bar. Baked in at build time from this
 * package's own `package.json`, exactly as apps/web's does — see that file's comment.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5176,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
