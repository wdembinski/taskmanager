/**
 * Vitest configuration for apps/server, so `pnpm --filter @tm/server test`
 * works standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the
 * aggregated root `pnpm test`.
 *
 * Unlike apps/client/vitest.config.ts, no path aliases are needed here:
 * apps/server imports `@tm/shared`/`@tm/protocol` as real workspace packages
 * (resolved through node_modules, per their own `exports`), never as
 * `@shared`/`@protocol` source aliases — those only exist for apps/client's
 * electron-vite bundles. An empty config still matters, though: without ANY
 * vitest.config.ts here, running from this package's own cwd would pick up
 * the root ../../vitest.config.ts only by accident of vitest's config
 * discovery, not by design.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({});
