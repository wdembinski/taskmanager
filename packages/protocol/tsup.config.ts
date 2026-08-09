// tsup configuration for @tm/protocol — mirrors packages/shared/tsup.config.ts (see its
// comment for the full reasoning). Same convention: no barrel, each module its own build
// entry, package.json's "./*" export maps straight onto dist/*. apps/server and apps/web
// resolve through this build, the way they do for @tm/shared; apps/client instead gets a
// @protocol/* path alias onto this package's SOURCE (see tsconfig.base.json), the same
// deal @shared/* already gets, once a later step wires it into electron.vite.config.ts.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/*.ts', '!src/*.test.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
