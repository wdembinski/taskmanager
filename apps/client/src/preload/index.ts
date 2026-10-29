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
 * We expose four things:
 *   - `window.api.invoke(channel, ...args)` — call an engine handler and await
 *     its reply (maps to ipcMain.handle in src/main/ipc.ts).
 *   - `window.api.on(channel, cb)` — subscribe to engine-pushed events, and get
 *     back an unsubscribe function.
 *   - `window.api.pathForFile(file)` — the one thing here that is about a FEATURE
 *     rather than about the boundary itself, and it is here only because Electron
 *     leaves no other door (see its comment below).
 *   - `window.api.boot` — the saved appearance the renderer's first frame paints with
 *     (see `readBoot` below).
 *
 * The types come from the shared IPC contract, so the UI gets full
 * autocomplete and type-checking on every call.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BootAppearance } from '@shared/canvas';
import type { IpcApi, IpcEvents } from '@shared/ipc';
import { ipcErrorMessage } from '@shared/ipcError';

/**
 * The saved appearance, font size and window material, read from main's `window:boot` once,
 * as this preload runs.
 *
 * Synchronous on purpose: the renderer root seeds its very first render from it, and an async
 * `invoke` cannot answer before React's first frame — that gap is exactly what used to paint a
 * guessed scheme and glass, then correct it. One tiny round trip before the page's scripts run
 * is the whole cost.
 *
 * Not `webPreferences.additionalArguments`: those are fixed when the window is created, so a
 * Ctrl+R after changing a setting would boot with the stale values and flash again. This read
 * runs on every load, so it is always current.
 *
 * `null` if main cannot answer (no listener, a throw there) — the renderer then falls back to
 * its own defaults and corrects itself from `settings:get`, as it did before this existed.
 */
function readBoot(): BootAppearance | null {
  try {
    return (ipcRenderer.sendSync('window:boot') as BootAppearance | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The typed API surface the renderer sees as `window.api`. */
const api = {
  /**
   * Request/response call to a main-process handler.
   *
   * A rejection is re-thrown with the engine's own sentence and nothing else. Electron
   * prefixes a handler's `throw` with `Error invoking remote method '<channel>': Error: `
   * on the way across, and the UI renders `e.message` directly — so a deliberate, helpful
   * refusal reached the human looking like a stack trace with the useful half at the end.
   * Unwrapped here rather than at each call site, because "remember to strip the prefix"
   * is a rule that holds until the next panel is written (see `@shared/ipcError`).
   */
  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]> {
    return (ipcRenderer.invoke(channel, ...args) as Promise<unknown>).catch((err: unknown) => {
      // `cause` keeps the original for the devtools console; the message is the human's.
      throw new Error(ipcErrorMessage(err), { cause: err });
    }) as ReturnType<IpcApi[K]>;
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

  /**
   * The absolute path of a file the user DROPPED on the window. `File.path` was removed in
   * Electron 32 and `webUtils` lives only in the privileged world, so this is the single
   * thing the bridge must know about a feature. Returns '' for a File with no path on disk.
   */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },

  /** The first frame's appearance — see {@link readBoot}. */
  boot: readBoot(),
};

// `exposeInMainWorld` is what actually publishes `api` onto the page's `window`.
// Because contextIsolation is on, this crosses a secure boundary; only cloneable
// data and the functions defined above are shared.
contextBridge.exposeInMainWorld('api', api);

/** Exported so the renderer can type `window.api` — see src/preload/index.d.ts. */
export type PreloadApi = typeof api;
