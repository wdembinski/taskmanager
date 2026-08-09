/**
 * apps/web is a plain Vite + React app — no path aliases into sibling packages, unlike
 * apps/client's electron-vite config. `@tm/ui`, `@tm/shared` and `@tm/protocol` are real
 * workspace packages here (built by `tsup` to `dist/`, dual ESM/CJS `exports`), resolved by
 * Vite through node_modules exactly like any published dependency — see those packages'
 * own `package.json` and electron.vite.config.ts's comment on why apps/client, alone, takes
 * the source-alias shortcut instead.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
