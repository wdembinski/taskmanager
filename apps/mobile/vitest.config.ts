/**
 * Vitest configuration for apps/mobile, so `pnpm --filter @tm/mobile test` works
 * standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the aggregated root
 * `pnpm test` — same reasoning as apps/web/vitest.config.ts, one app over.
 *
 * It extends vite.config.ts rather than replacing it, so the React plugin lands here too.
 */
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({}));
