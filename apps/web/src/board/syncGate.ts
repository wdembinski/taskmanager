/**
 * Whether the web board has enough of the mirror to show, and what to say while it doesn't.
 *
 * The rule, stated once: the board is shown from the first response whose `hasMore` is not
 * `true`, and from then on forever. That survives the paged first load (`lastPolledAt` is set
 * on page 1 while `hasMore` is still true, so gating on `lastPolledAt === null` alone would
 * reveal a half-filled board); it survives a server predating `hasMore` (`undefined !== true`
 * ⇒ ready); it survives an empty account; and because it latches, a later keepalive that
 * happens to page shows "syncing" in the status bar and does not pull the board away.
 */
export interface SyncProgress {
  /** A board read is in flight right now. */
  polling: boolean;
  /** The last response said `hasMore` — another page is already queued to follow. */
  draining: boolean;
  /** LATCHED — once true, never goes false again. See {@link boardIsReady}. */
  initialSyncComplete: boolean;
  failures: number;
  lastError: string | null;
}

export const EMPTY_SYNC_PROGRESS: SyncProgress = {
  polling: false,
  draining: false,
  initialSyncComplete: false,
  failures: 0,
  lastError: null,
};

/** Whether the mirror has enough of the board to show it. */
export function boardIsReady(p: SyncProgress): boolean {
  return p.initialSyncComplete;
}

/** What the curtain says while {@link boardIsReady} is still false. */
export function syncCurtainText(p: SyncProgress): { label: string; detail: string } {
  if (p.failures > 0) {
    return {
      label: 'Having trouble syncing',
      detail: p.lastError ?? 'Retrying in the background.',
    };
  }
  if (p.draining) {
    return {
      label: 'Loading your board',
      detail: 'Catching up on a large account — this can take a few seconds.',
    };
  }
  return {
    label: 'Loading your board',
    detail: 'This should only take a moment.',
  };
}

/** The status bar's "synced Ns ago" line — draining wins even after the board has latched
 *  ready, so a later paged catch-up reads as syncing without pulling the board away. */
export function syncStatusLabel(p: SyncProgress, lastPolledAt: number | null, now: number): string {
  if (lastPolledAt === null) return 'first sync pending';
  if (p.draining) return 'syncing…';
  return `synced ${describeAge(now - lastPolledAt)}`;
}

/** A duration in ms as the coarsest unit that still says something — `12s ago`, `3m ago`. */
export function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
