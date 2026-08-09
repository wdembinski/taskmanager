/**
 * Ambient type declaration that tells the renderer's TypeScript what
 * `window.api` is. Without this, the UI would see `window.api` as `any` (or an
 * error). It simply attaches the preload's exported `PreloadApi` type to the
 * global `Window` interface.
 */
import type { PreloadApi } from './index';

declare global {
  interface Window {
    api: PreloadApi;
  }
}

export {};
