/**
 * Vitest configuration for packages/protocol, so `pnpm --filter @tm/protocol test`
 * works standalone (CONTRIBUTING.md, RELEASE.md §1) in addition to the aggregated
 * root `pnpm test`.
 *
 * No aliases: cadence.test.ts imports its subject by relative path, and the one
 * cross-package import this package has (`@tm/shared`) is a real workspace
 * dependency resolved through node_modules, never a source alias. Empty and
 * explicit beats absent — see packages/shared/vitest.config.ts for why the file
 * exists at all.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({});
