/**
 * Vitest configuration for the aggregated `pnpm test` at the repo root (all
 * 99+ test files, across apps/client and packages/shared), run as one
 * `vitest run` rather than through turbo, the way it worked before the
 * workspace restructuring. apps/client also carries its own
 * apps/client/vitest.config.ts with the same aliases, for
 * `pnpm --filter claude-orchestrator test` — cwd is apps/client there, so
 * this root config never comes into play; without its own config, any
 * standalone run fails to resolve `@shared/*`.
 *
 * The app is built by electron-vite (see apps/client/electron.vite.config.ts), which
 * defines the `@shared` / `@renderer` path aliases per bundle. Vitest doesn't read that
 * config, so we mirror the aliases here — otherwise a test that imports a runtime VALUE
 * (not just a type) from `@shared/*` fails to resolve. Type-only `@shared` imports are
 * erased and never needed this, which is why it only surfaced once real constants moved
 * into shared.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('packages/shared/src'),
      '@renderer': resolve('apps/client/src/renderer/src'),
    },
  },
});
