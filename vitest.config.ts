/**
 * Vitest configuration for the aggregated `pnpm test` at the repo root — every
 * test file in the workspace (apps/client, apps/server, apps/web, and
 * packages/shared, packages/protocol, packages/ui), run as one `vitest run`
 * rather than through turbo, the way it worked before the workspace
 * restructuring. Each of those six packages also carries its own
 * vitest.config.ts for `pnpm --filter <pkg> test` — cwd is that package there,
 * so this root config never comes into play.
 *
 * The root script is `turbo run build --filter=./packages/* && vitest run`, not
 * `turbo run test`: `vitest run` GLOBS the tree, so a new package's suites are
 * collected by existing, whereas a turbo fan-out depends on every package
 * having a `test` script and exits 0 in silence for any that does not. The
 * build prefix supplies the one thing a bare `vitest run` was missing — the
 * built `dist` under each library package, which is what `@tm/...` specifiers
 * resolve to (docs/plan/phase25-gate-report.md §3.2, §5.2).
 *
 * Which is why the `@tm/*` PACKAGE names are deliberately absent from the
 * aliases below. apps/server, apps/web and packages/ui import them as real
 * workspace packages, resolved through each package's `exports` to its built
 * dist/; aliasing them to source here would make this run test code no consumer
 * actually loads, and would silently paper over a missing build.
 *
 * The app is built by electron-vite (see apps/client/electron.vite.config.ts), which
 * defines the `@shared` / `@renderer` path aliases per bundle. Vitest doesn't read that
 * config, so we mirror the aliases here — otherwise a test that imports a runtime VALUE
 * (not just a type) from `@shared/*` fails to resolve. Type-only `@shared` imports are
 * erased and never needed this, which is why it only surfaced once real constants moved
 * into shared.
 *
 * `@protocol` mirrors the same deal for packages/protocol, and `@ui` for packages/ui,
 * added alongside `@shared` in tsconfig.base.json — see that file's `paths`.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('packages/shared/src'),
      '@protocol': resolve('packages/protocol/src'),
      '@ui': resolve('packages/ui/src'),
      '@renderer': resolve('apps/client/src/renderer/src'),
    },
  },
});
