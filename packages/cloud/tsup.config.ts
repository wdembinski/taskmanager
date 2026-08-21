// tsup configuration for @tm/cloud — same no-barrel convention as packages/shared,
// packages/protocol and packages/ui (see packages/shared/tsup.config.ts for the full
// reasoning): every module is its own build entry, package.json's "./*" export maps
// straight onto dist/*, preserving the auth/, board/ and settings/ subdirectories.
//
// react/react-dom/Fluent are peerDependencies, externalized here for the same reason as
// packages/ui: a second React copy breaks hooks in the host app's tree.
//
// @tm/ui is ALSO external, and for a sharper reason than react: `useBoardExtras.ts` imports
// `useTransport` as a runtime VALUE, not just a type. Bundling a second copy of
// `@tm/ui/dist/transport.js` alongside the host's own import of `@tm/ui/transport` would
// create two separate `TransportContext` module instances — same shape, different identity
// — and `useContext` reading the wrong one fails at runtime with a green typecheck, not a
// build error. `@tm/ui` must never import `@tm/cloud` in return, or the two externals cycle.
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
    '@tm/ui',
    /^@tm\/ui\//,
  ],
});
