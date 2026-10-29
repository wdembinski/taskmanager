/**
 * Ambient type declaration that tells the renderer's TypeScript what
 * `window.api` is. Without this, the UI would see `window.api` as `any` (or an
 * error). It simply attaches the preload's exported `PreloadApi` type to the
 * global `Window` interface.
 *
 * `logPerf` is optional here even though the preload always defines it: the headless
 * harnesses (`scripts/lib/apiStub.mjs`) stand in for `window.api` without it, so the
 * renderer has to check before calling it.
 */
import type { PreloadApi } from './index';

declare global {
  interface Window {
    api: Omit<PreloadApi, 'logPerf'> & Partial<Pick<PreloadApi, 'logPerf'>>;
  }
}

export {};
