/// <reference types="vite/client" />

// Pulls in the `window.api` typing defined by the preload bridge so every
// renderer file can call `window.api.invoke(...)` with full type-checking.
import '../../preload/index.d.ts';
