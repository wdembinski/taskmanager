/**
 * apps/web is a plain Vite + React app — no path aliases into sibling packages, unlike
 * apps/client's electron-vite config. `@tm/ui`, `@tm/cloud`, `@tm/shared` and `@tm/protocol`
 * are real workspace packages here (built by `tsup` to `dist/`, dual ESM/CJS `exports`),
 * resolved by Vite through node_modules exactly like any published dependency — see those
 * packages' own `package.json` and electron.vite.config.ts's comment on why apps/client,
 * alone, takes the source-alias shortcut instead.
 */
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The version this build shows in its status bar, read from **apps/client/package.json** —
 * the version of record (CONTRIBUTING.md §4). The desktop reads its equivalent at runtime
 * from `app:getInfo`; a browser bundle has no runtime to ask, so the number is baked in
 * here at build time.
 *
 * It used to read `./package.json`, one line above where it now reads the client's, under a
 * comment claiming that was "the same package.json the release bumps". It is not, and never
 * was: the release bumps apps/client alone, and every other workspace has been frozen at its
 * split-time version since v0.78.7 (see test/repo-invariants.test.ts). So the status bar
 * said v0.78.2 for eight releases while the desktop shipped v0.86.0 — a number that was
 * true of nothing and could not move, no matter how often the bundle was rebuilt.
 *
 * What this number means is "the version of the code this tab is running", not "the version
 * the desktop has installed" — a static bundle only changes when it is deployed. The two
 * therefore agree only if a bumped version reaches Static Web Apps, which is why
 * `.github/workflows/deploy.yml` watches this file's source, apps/client/package.json, as a
 * web input, and why release.yml redeploys after a bump commit of its own. The desktop's
 * own version is a separate fact and already has its own home in the UI: presence carries
 * it (`ClientPresence.appVersion`) and `ClientPicker` shows it per machine.
 */
const { version } = JSON.parse(
  readFileSync(new URL('../client/package.json', import.meta.url), 'utf8'),
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
