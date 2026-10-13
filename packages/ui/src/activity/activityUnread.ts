/**
 * The Activity tab's unread badge (F2.13), as a pure function of the rows since last-seen —
 * kept out of `App.tsx` for the same reason every other activity rule lives in a `.ts` file
 * next to its component: this repo has no DOM test harness, so a badge count that lived
 * inline could only ever be eyeballed.
 *
 * The forward-only cursor comparison itself lives in `@tm/shared/activity`
 * (`laterActivityCursor`), not here — the desktop's `activity:setLastSeen` handler needs the
 * exact same rule, and a package in `apps/client` cannot import from `@tm/ui`. This file
 * re-exports it as `laterCursor` so callers in this package spell it the same way the design
 * decisions in `F2-activity-dashboard.md` do.
 */
import { laterActivityCursor, type ActivityCursor, type ActivityRow } from '@tm/shared/activity';
import { isNewerThan } from './feedState';

export { laterActivityCursor as laterCursor };

/** A total order on two cursors in `(at, id)` order: negative, zero or positive. */
export function compareCursor(a: ActivityCursor, b: ActivityCursor): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id - b.id;
}

/**
 * Whether `row` should count toward the unread badge at all, independent of whether it is
 * newer than last-seen. The one exclusion: your own column move — `status-moved` with origin
 * `human` — is not news, because you are the one who just made it. The same move made by the
 * chain (origin `chain`) still counts; only the human-driven one is excluded.
 */
export function countsAsUnread(row: ActivityRow): boolean {
  return !(row.kind === 'status-moved' && row.origin === 'human');
}

/**
 * The badge's count: 0 on a null `lastSeen` (first visit — no baseline, the same reading the
 * feed's own divider gives), otherwise how many of `rows` are both newer than `lastSeen`
 * ({@link isNewerThan}, from `feedState.ts`) and {@link countsAsUnread}.
 */
export function unreadActivityCount(
  rows: readonly ActivityRow[],
  lastSeen: ActivityCursor | null,
): number {
  if (lastSeen === null) return 0;
  let count = 0;
  for (const row of rows) {
    if (isNewerThan(row, lastSeen) && countsAsUnread(row)) count++;
  }
  return count;
}
