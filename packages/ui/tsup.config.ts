// tsup configuration for @tm/ui — same no-barrel convention as packages/shared and
// packages/protocol (see packages/shared/tsup.config.ts for the full reasoning): every
// module is its own build entry, package.json's "./*" export maps straight onto dist/*,
// preserving the board/ and chat/ subdirectories.
//
// apps/client never resolves through this build: its `@ui/*` path alias points straight
// at src/ (see electron.vite.config.ts), same as `@shared/*` and `@protocol/*`. This
// build exists for apps/web, which cannot resolve a bare path alias into a sibling
// package's sources.
//
// react/react-dom/Fluent are peerDependencies (this package renders into the host app's
// own React tree, and a second React copy breaks hooks) — externalized here so the build
// doesn't bundle them.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.{ts,tsx}', '!src/**/*.test.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@fluentui/react-components',
    '@fluentui/react-icons',
  ],
});
