// tsup configuration for @tm/shared.
//
// There is no single barrel export here — every module (model.ts, settings.ts, ipc.ts, …)
// is imported individually as `@shared/<name>` from 300+ call sites in apps/client, a
// convention this package keeps rather than collapsing into one index.ts. So each source
// file is its own build entry, and package.json's "exports" maps "./*" to "dist/*" to
// match.
//
// apps/client itself never resolves through this build: its `@shared/*` path alias points
// straight at src/ (see tsconfig.base.json), so a plain path alias survives its Vite/
// electron-vite bundling. This build exists for apps/server (nest build / ts-jest) and
// apps/web (Vite), which cannot resolve a bare path alias into a sibling package's sources.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/*.ts', '!src/*.test.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
