/**
 * Vitest configuration for apps/client, run standalone via
 * `pnpm --filter claude-orchestrator test` (CONTRIBUTING.md, RELEASE.md §1).
 *
 * The root ../../vitest.config.ts covers the aggregated `pnpm test` at the
 * repo root, but that config only applies when vitest's cwd IS the repo
 * root — `pnpm --filter` runs this package's own "test" script with cwd set
 * to apps/client, where vitest never sees the root config at all. Without a
 * config here, any test importing a runtime VALUE (not just a type) from
 * `@shared/*` fails to resolve, because `@shared` is a source-only path
 * alias (see ../../electron.vite.config.ts), not the `@tm/shared` package
 * name. Mirrors the same aliases as the root config and electron-vite's
 * three bundles, just resolved from apps/client instead of the repo root.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('../../packages/shared/src'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
});
