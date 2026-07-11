/**
 * Vitest configuration.
 *
 * The app is built by electron-vite (see electron.vite.config.ts), which defines the
 * `@shared` / `@renderer` path aliases per bundle. Vitest doesn't read that config, so
 * we mirror the aliases here — otherwise a test that imports a runtime VALUE (not just a
 * type) from `@shared/*` fails to resolve. Type-only `@shared` imports are erased and
 * never needed this, which is why it only surfaced once real constants moved into shared.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
});
