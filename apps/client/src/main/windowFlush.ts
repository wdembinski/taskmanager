/**
 * windowFlush — debouncing the window-geometry save, and knowing when to stop.
 *
 * A drag emits `move` per frame, so the geometry is written on a debounce; the value that
 * actually matters — the one the next launch reads — is flushed synchronously when the
 * window closes. That much is obvious. What is not obvious is the ORDER on quit.
 *
 * `app.quit()` closes the window and then tears the engine down, which closes the SQLite
 * handle. Two things can put a write on the wrong side of that line:
 *
 *   1. a `resize`/`move` the WM emits *while* the window is being destroyed, re-arming a
 *      timer that fires after `store.close()`; and
 *   2. a second `dispose()` — the close handler and the engine's own teardown both call
 *      it — writing again after the handle is gone.
 *
 * Either one throws `TypeError: The database connection is not open` out of a timer or an
 * event handler, i.e. nowhere a caller can catch it, which is how it reached the user as
 * an "Unexpected error" dialog on top of an auto-update restart.
 *
 * So the flusher carries its own disposed flag — a disposed flusher can never schedule
 * anything again — and asks `canWrite()` before every write, which is the one legitimate
 * racer left: a flush driven by an OS event whose timing we do not control. Note that
 * `read()` is called only when a write will actually happen: on a destroyed window
 * `getNormalBounds()` throws in its own right.
 *
 * Deliberately Electron-free and store-free (it takes plain callbacks) so it can be
 * unit-tested, in the style of `windowState.ts` / `authGate.ts`; `ipc.ts` supplies the
 * `BrowserWindow` and `Store` ends.
 */
import type { SavedWindowState } from './windowState';

export interface WindowStateFlusherDeps {
  /** Snapshot the geometry. Only called when a write will happen — see the header. */
  read: () => SavedWindowState;
  write: (state: SavedWindowState) => void;
  /** Is a write safe right now — window alive AND store open. */
  canWrite: () => boolean;
  /** Debounce window; 400ms, long enough to swallow a drag, short enough to survive a crash. */
  delayMs?: number;
}

export interface WindowStateFlusher {
  /** Debounced save. Inert once disposed, so teardown events cannot re-arm the timer. */
  schedule: () => void;
  /** Cancel the pending save and write once, synchronously. Idempotent. */
  dispose: () => void;
}

const DEFAULT_DELAY_MS = 400;

export function createWindowStateFlusher(deps: WindowStateFlusherDeps): WindowStateFlusher {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const persist = (): void => {
    if (!deps.canWrite()) return;
    deps.write(deps.read());
  };

  return {
    schedule(): void {
      if (disposed) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        persist();
      }, delayMs);
    },

    dispose(): void {
      clear();
      if (disposed) return;
      disposed = true;
      persist();
    },
  };
}
