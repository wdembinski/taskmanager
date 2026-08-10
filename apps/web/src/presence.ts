/**
 * The release trigger the whole adaptive-cadence design hangs on (docs/plan/README.md's "Two
 * latencies this design cannot avoid" — the "slowing down" one). `board/browserFocusSignal.ts`
 * already tells `BoardPoller` when this tab is merely visible, which is the right (coarser) bar
 * for "does this session's own poll cadence need to speed up" — two tabs open side by side
 * should both count as live even if only one has the window's actual keyboard focus. Presence
 * is a stricter question — "is a human looking at THIS session right now" — so a released beat
 * here means what it says: `document.visibilityState === 'visible'` AND `document.hasFocus()`,
 * not visibility alone.
 *
 * Two responsibilities:
 *
 *  - **Beat immediately on becoming focused.** The regular poll loop (`BoardPoller`) already
 *    carries `X-TM-Focus` on every request, so a focused tab that is already polling needs no
 *    extra request for that — but the tick that made this tab focused may be up to
 *    `CADENCE_MS.idle` away (this session was on the idle tier), and the whole point of
 *    reporting focus is to not wait that long to say so. One `POST /v1/presence` the instant
 *    focus flips true closes that gap without waiting for the next scheduled poll.
 *  - **Release on the way out**, via `navigator.sendBeacon` rather than `fetch`: a beacon is
 *    queued by the browser and delivered even if this tab is torn down a moment later, which an
 *    in-flight `fetch` is not guaranteed to be. Firing it on `blur` and `visibilitychange`-to-
 *    hidden (in addition to `pagehide`) turns the ~90s `PRESENCE_TTL_MS` backstop into an
 *    immediate cadence drop for the common case — closing a tab, switching away — while the TTL
 *    still covers what a beacon can't: a crashed tab or a lost network. `sendBeacon` cannot
 *    carry an `Authorization` header, so this one request goes out unauthenticated; if the
 *    server rejects it, that is no worse than the beacon never arriving at all — the TTL still
 *    catches it.
 */
import type { PresenceRequest } from '@tm/protocol/wire';
import type { FocusSignal } from './board/BoardPoller';

/**
 * Stricter than `board/browserFocusSignal.ts`'s `createBrowserFocusSignal` — see this file's
 * own header for why presence needs `document.hasFocus()` on top of tab visibility.
 */
export function createPresenceFocusSignal(
  doc: Document = document,
  win: Window = window,
): FocusSignal {
  const listeners = new Set<(focused: boolean) => void>();
  let focused = doc.visibilityState === 'visible' && doc.hasFocus();

  const recompute = (): void => {
    const next = doc.visibilityState === 'visible' && doc.hasFocus();
    if (next === focused) return;
    focused = next;
    for (const cb of listeners) cb(focused);
  };

  doc.addEventListener('visibilitychange', recompute);
  win.addEventListener('focus', recompute);
  win.addEventListener('blur', recompute);

  return {
    isFocused: () => focused,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export interface PresenceHeartbeatDeps {
  apiBase: string;
  clientId: string;
  focus: FocusSignal;
  /** A bearer access token for the on-focus beat, or null when not signed in — that beat is
   *  then just skipped, exactly like a `BoardPoller` tick with no token: the next successful
   *  poll or focus change tries again. */
  getAccessToken: () => Promise<string | null>;
  win?: Window;
  fetchImpl?: typeof fetch;
  /** Defaults to `navigator.sendBeacon`. Injectable because this repo's tests run with no
   *  `navigator` (see `board/clientId.test.ts`'s own fake-`Storage` pattern for why — no jsdom
   *  by default here). */
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

function presenceBody(clientId: string, focused: boolean): PresenceRequest {
  return { clientId, focused };
}

export class PresenceHeartbeat {
  private disposed = false;
  private readonly win: Window;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly deps: PresenceHeartbeatDeps) {
    this.win = deps.win ?? window;
    this.unsubscribeFocus = deps.focus.onChange((focused) => {
      if (focused) void this.beat();
      else this.release();
    });
    this.win.addEventListener('pagehide', this.handlePageHide);
    if (deps.focus.isFocused()) void this.beat();
  }

  private readonly handlePageHide = (): void => this.release();

  /** The on-focus beat — a normal authenticated request, not a beacon: this fires while the
   *  tab is alive, so there is no unload race to guard against here. */
  private async beat(): Promise<void> {
    if (this.disposed) return;
    const token = await this.deps.getAccessToken();
    if (!token || this.disposed) return;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      await fetchImpl(`${this.deps.apiBase}/v1/presence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(presenceBody(this.deps.clientId, true)),
      });
    } catch {
      // Best-effort: the next focus change or poll tick tries again — nothing here blocks the
      // board from working in the meantime.
    }
  }

  /** The release beat — `sendBeacon`, not `fetch`: see this file's own header for why. */
  private release(): void {
    if (this.disposed) return;
    const send = this.deps.sendBeacon ?? ((url, data) => navigator.sendBeacon(url, data));
    const blob = new Blob([JSON.stringify(presenceBody(this.deps.clientId, false))], {
      type: 'application/json',
    });
    send(`${this.deps.apiBase}/v1/presence`, blob);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFocus();
    this.win.removeEventListener('pagehide', this.handlePageHide);
  }
}
