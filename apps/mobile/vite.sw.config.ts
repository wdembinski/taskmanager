/**
 * A second, separate Vite build for the service worker (`src/sw/serviceWorker.ts`). It
 * cannot come out of the same config as `vite.config.ts`: the main entry needs
 * content-hashed filenames so `shouldHandle.ts`'s cache-first rule is safe
 * (`assets/index-<hash>.js`), while the service worker needs the OPPOSITE — a fixed
 * `sw.js` at the dist root, because `registerServiceWorker.ts` registers it by that exact
 * name on every visit, and a hashed name would mean re-registering by hand on every
 * deploy. One Rollup output config cannot emit both naming schemes for the same build.
 *
 * `emptyOutDir: false` because this build always runs second (see `package.json`'s
 * `build` script) and must not delete what the first `vite build` just wrote to `dist/`.
 *
 * No React plugin here — the service worker never touches JSX — and no `define` for
 * `__APP_VERSION__`, which `serviceWorker.ts` never reads either.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: 'src/sw/serviceWorker.ts',
      output: {
        entryFileNames: 'sw.js',
        // A classic (non-module) worker script: `registerServiceWorker.ts` registers it
        // with no `{ type: 'module' }`, so it works the same on every browser that can
        // install a WebAPK, not only ones with module-worker support.
        format: 'iife',
      },
    },
  },
});
