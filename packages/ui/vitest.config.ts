/**
 * Vitest configuration for packages/ui, so `pnpm --filter @tm/ui test` works
 * standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the aggregated root
 * `pnpm test`.
 *
 * This package's sources import `@tm/shared/*` as a real workspace dependency
 * — resolved through node_modules against that package's `exports`, i.e. its
 * BUILT dist/ — so a standalone run needs `pnpm --filter @tm/shared build` to
 * have happened first. turbo.json's `test` task declares that as
 * `dependsOn: ["^build"]`; running this script directly, outside turbo, does not
 * get it for free. Deliberately NOT aliased to packages/shared/src: apps/web and
 * apps/server consume this package as a built artifact, and a source alias here
 * would test code that no consumer actually loads.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({});
