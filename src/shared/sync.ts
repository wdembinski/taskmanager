/**
 * When each external tracker was last pulled, and when the next pull is due.
 *
 * The board is a mirror of things that live somewhere else, and until now it said nothing
 * about how *stale* that mirror was. A card could be five seconds old or five minutes old
 * and looked identical, so the honest answer to "is this current?" was to press Sync and
 * watch — which is the question a status bar exists to answer without being asked.
 *
 * Deliberately a LIST rather than two named fields. JIRA and GitLab are what exist today,
 * but the shape of the integration is "a tracker with a poll interval", and a third one
 * should light up in the status bar by being added to this array — not by another pair of
 * fields threaded through the IPC layer, the footer and its styles.
 */

/** Which tracker this is. Extend as integrations are added — the UI is driven by the list. */
export type SyncServiceId = 'jira' | 'gitlab';

export interface ServiceSyncState {
  id: SyncServiceId;
  /** What to call it in a tooltip: "JIRA", "GitLab". */
  label: string;
  /**
   * Whether the integration is switched on at all. A disabled service is omitted from the
   * status bar entirely rather than shown as a dead ring — an indicator for something you
   * have turned off is noise pretending to be information.
   */
  enabled: boolean;
  /**
   * The poll interval in ms, or 0 when automatic polling is off. Zero is not "broken": the
   * manual Sync button still works, and the ring then simply shows age with nothing to
   * count down to.
   */
  intervalMs: number;
  /** Epoch ms the last sync COMPLETED, or null if none has since the app started. */
  lastSyncAt: number | null;
  /** True while a sync is in flight, so the ring can say "now" instead of guessing. */
  syncing: boolean;
  /**
   * What went wrong on the last attempt, or null. Carried so a service that has quietly
   * stopped working shows it here rather than only in the log — a ring that never fills is
   * indistinguishable from one nobody is watching.
   */
  error: string | null;
}

/**
 * How far through the wait we are, as 0…1 — **1 just after a sync, falling to 0 as the next
 * one comes due.** The ring drains rather than fills, which is the way round the user asked
 * for and the more legible one: a nearly-empty ring means "about to refresh", and empty
 * means the request has gone out.
 *
 * Pure, and takes `now`, so the renderer can tick it on a local timer without a round trip
 * per second and the tests need no clock.
 *
 * Returns 1 when there is nothing to count down to (no interval, or nothing synced yet):
 * a full ring reads as "not waiting on anything", which is exactly the case.
 */
export function syncRemaining(state: ServiceSyncState, now: number): number {
  if (state.intervalMs <= 0 || state.lastSyncAt === null) return 1;
  const elapsed = now - state.lastSyncAt;
  if (elapsed <= 0) return 1;
  const left = 1 - elapsed / state.intervalMs;
  // Clamped rather than allowed to go negative: a poll that is late (a slow sync, a sleeping
  // laptop) should sit at empty, not wind backwards through a second lap.
  return left <= 0 ? 0 : left;
}

/** "just now", "2m ago", "1h 5m ago" — how stale the mirror is, in words. */
export function syncAgeLabel(lastSyncAt: number | null, now: number): string {
  if (lastSyncAt === null) return 'not synced yet';
  const seconds = Math.max(0, Math.round((now - lastSyncAt) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

/** "next in 3m" / "next in 45s", or null when nothing is scheduled. */
export function nextSyncLabel(state: ServiceSyncState, now: number): string | null {
  if (state.intervalMs <= 0 || state.lastSyncAt === null) return null;
  const ms = state.lastSyncAt + state.intervalMs - now;
  if (ms <= 0) return 'due now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `next in ${seconds}s`;
  return `next in ${Math.round(seconds / 60)}m`;
}

/** The whole tooltip for one service, so the bar and any future surface agree. */
export function syncTooltip(state: ServiceSyncState, now: number): string {
  if (state.syncing) return `${state.label} — syncing now`;
  const parts = [`${state.label} — synced ${syncAgeLabel(state.lastSyncAt, now)}`];
  const next = nextSyncLabel(state, now);
  if (next) parts.push(next);
  else if (state.intervalMs <= 0) parts.push('auto-sync off');
  if (state.error) parts.push(`last attempt failed: ${state.error}`);
  return parts.join(' · ');
}
