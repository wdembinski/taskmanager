/**
 * When the trackers were last pulled, and when the next pull is due.
 *
 * The board is a mirror of things that live somewhere else, and until this existed it said
 * nothing about how *stale* that mirror was. A card could be five seconds old or five
 * minutes old and looked identical, so the honest answer to "is this current?" was to press
 * Sync and watch — which is the question a status bar exists to answer without being asked.
 *
 * **One clock, many services.** Every integration shares a single interval and a single
 * timer (see `main/syncPoller.ts`), so there is one countdown and one ring rather than one
 * per tracker. The per-service rows survive underneath it because they still differ in the
 * ways worth knowing: whether the integration is on at all, and whether its last attempt
 * failed while the others succeeded.
 *
 * `services` is deliberately a LIST. JIRA and GitLab are what exist today, but the shape of
 * the integration is "a tracker that gets refreshed", and a third one should appear in the
 * tooltip by being added to the array — not by threading another pair of fields through the
 * IPC layer, the status bar and its styles.
 */

/** Which tracker a row describes. Extend as integrations are added. */
export type SyncServiceId = 'jira' | 'gitlab';

export interface ServiceSyncState {
  id: SyncServiceId;
  /** What to call it in the tooltip: "JIRA", "GitLab". */
  label: string;
  /**
   * Whether the integration is switched on. A disabled service is left out of the tooltip
   * rather than listed as idle — a line about something you have turned off is noise
   * pretending to be information.
   */
  enabled: boolean;
  /** Epoch ms this service's last SUCCESSFUL sync finished, or null if none this run. */
  lastSyncAt: number | null;
  /**
   * What went wrong on its last attempt, or null. Carried so a service that has quietly
   * stopped working shows it here rather than only in the log — with one shared ring, a
   * single broken tracker would otherwise be invisible behind the others succeeding.
   */
  error: string | null;
}

export interface SyncState {
  /** The one interval every service shares, in ms. 0 = automatic sync is off. */
  intervalMs: number;
  /**
   * Epoch ms the last sweep finished — the clock the ring counts down from. The newest of
   * the services' own timestamps, so a sweep in which one tracker failed still counts as
   * having happened for the ones that did not.
   */
  lastSyncAt: number | null;
  /** True while a sweep is in flight, so the ring can say "now" instead of guessing. */
  syncing: boolean;
  services: ServiceSyncState[];
}

/**
 * How far through the wait we are, as 0…1 — **1 just after a sync, falling to 0 as the next
 * one comes due.** The ring drains rather than fills, which is the more legible way round: a
 * nearly-empty ring means "about to refresh", and empty means the request has gone out. A
 * filling ring has to be read against a remembered starting point to mean anything.
 *
 * Pure, and takes `now`, so the renderer can tick it on a local timer without a round trip
 * per second and the tests need no clock.
 *
 * Returns 1 when there is nothing to count down to (no interval, or nothing synced yet): a
 * full ring reads as "not waiting on anything", which is exactly the case.
 */
export function syncRemaining(state: SyncState, now: number): number {
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
export function nextSyncLabel(state: SyncState, now: number): string | null {
  if (state.intervalMs <= 0 || state.lastSyncAt === null) return null;
  const ms = state.lastSyncAt + state.intervalMs - now;
  if (ms <= 0) return 'due now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `next in ${seconds}s`;
  return `next in ${Math.round(seconds / 60)}m`;
}

/**
 * The whole tooltip: the shared clock on the first line, then a line per enabled service.
 *
 * The per-service lines are what a single ring would otherwise cost you. One clock is right
 * — they are refreshed together — but "GitLab's token expired three hours ago" is not a fact
 * the shared line can carry, and it is the fact you most need.
 */
export function syncTooltip(state: SyncState, now: number): string {
  const head = state.syncing
    ? 'Syncing now'
    : [`Synced ${syncAgeLabel(state.lastSyncAt, now)}`, nextSyncLabel(state, now) ?? 'auto-sync off']
        .join(' · ');

  const lines = state.services
    .filter((s) => s.enabled)
    .map((s) =>
      s.error
        ? `${s.label} — failed: ${s.error}`
        : `${s.label} — ${syncAgeLabel(s.lastSyncAt, now)}`,
    );

  return [head, ...lines].join('\n');
}
