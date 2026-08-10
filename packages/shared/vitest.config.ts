/**
 * Vitest configuration for packages/shared, so `pnpm --filter @tm/shared test`
 * works standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the
 * aggregated root `pnpm test`.
 *
 * No aliases are needed: this package is the bottom of the dependency graph and
 * its tests import their subjects by relative path. The file still has to exist,
 * for the same reason apps/server's empty one does — without ANY vitest config
 * here, a run from this package's own cwd reaches the root ../../vitest.config.ts
 * by accident of vitest's config discovery rather than by design, and would then
 * be governed by aliases written for a different package.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({});
