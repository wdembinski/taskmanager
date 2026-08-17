/**
 * Vitest configuration for packages/cloud, so `pnpm --filter @tm/cloud test` works
 * standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the aggregated root
 * `pnpm test`.
 *
 * This package's sources import `@tm/shared/*` and `@tm/protocol/*` as real workspace
 * dependencies — resolved through node_modules against those packages' `exports`, i.e.
 * their BUILT dist/ — so a standalone run needs `pnpm --filter @tm/shared build` and
 * `pnpm --filter @tm/protocol build` to have happened first. turbo.json's `test` task
 * declares that as `dependsOn: ["^build"]`; running this script directly, outside turbo,
 * does not get it for free.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({});
