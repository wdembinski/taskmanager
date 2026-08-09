/**
 * Vitest configuration.
 *
 * This is the one vitest instance for the whole workspace (all 99+ test files, across
 * apps/client and packages/shared) — deliberately NOT split per-package like apps/client's
 * own typecheck/build are. `pnpm test` at the repo root runs `vitest run` directly rather
 * than going through turbo, so it stays a single run the way it was before the workspace
 * restructuring.
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
