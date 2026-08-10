/**
 * Vitest configuration for apps/web, so `pnpm --filter @tm/web test` works
 * standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the aggregated root
 * `pnpm test`.
 *
 * Like apps/server's, this needs no path aliases: apps/web imports `@tm/ui`,
 * `@tm/shared` and `@tm/protocol` as real workspace packages resolved through
 * node_modules per their own `exports` (see vite.config.ts's header on why this
 * app, unlike apps/client, takes no source-alias shortcut). It is written out
 * anyway because a standalone run previously worked only by vitest falling back
 * to discovering ./vite.config.ts — which happens to carry the React plugin, so
 * it worked, but by accident of discovery order rather than by design. Its two
 * siblings both made the same thing explicit; this closes the gap.
 *
 * It extends vite.config.ts rather than replacing it, so the React plugin the
 * fallback used to supply is still there.
 */
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({}));
