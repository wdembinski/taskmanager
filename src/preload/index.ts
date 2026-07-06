/**
 * PRELOAD bridge — the single, security-controlled doorway between the web UI
 * and the Node engine.
 *
 * The renderer (React app) runs sandboxed with NO access to Node, the file
 * system, or the OS. That is good for security but it still needs SOME way to
 * ask the engine to do things. Electron's answer is `contextBridge`: this script
 * runs with privileges and exposes a small, explicit object onto `window`. The
 * UI can only ever call the methods we deliberately list here — nothing more.
 *
 * We expose two things:
 *   - `window.api.invoke(channel, ...args)` — call an engine handler and await
 *     its reply (maps to ipcMain.handle in src/main/ipc.ts).
 *   - `window.api.on(channel, cb)` — subscribe to engine-pushed events, and get
 *     back an unsubscribe function.
 *
 * The types come from the shared IPC contract, so the UI gets full
 * autocomplete and type-checking on every call.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi, IpcEvents } from '@shared/ipc';

/** The typed API surface the renderer sees as `window.api`. */
const api = {
  /** Request/response call to a main-process handler. */
  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]> {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<IpcApi[K]>;
  },

  /**
   * Subscribe to an engine-pushed event. Returns an unsubscribe function so
   * React components can clean up in a useEffect teardown.
   */
  on<K extends keyof IpcEvents>(channel: K, callback: (payload: IpcEvents[K]) => void): () => void {
    const listener = (_event: unknown, payload: IpcEvents[K]): void => callback(payload);
    ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
    return () => ipcRenderer.removeListener(channel, listener as never);
  },
};

// `exposeInMainWorld` is what actually publishes `api` onto the page's `window`.
// Because contextIsolation is on, this crosses a secure boundary; only cloneable
// data and the functions defined above are shared.
contextBridge.exposeInMainWorld('api', api);

/** Exported so the renderer can type `window.api` — see src/preload/index.d.ts. */
export type PreloadApi = typeof api;
