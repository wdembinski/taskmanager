/**
 * The Activity feed's list behaviour, kept as a pure state machine — this repo has no DOM
 * test harness (no jsdom, no testing-library), so the only way to prove paging, staging and
 * the "since you were away" divider are correct is to pull them out of the component and
 * test them as plain functions. Same shape as `taskTimeline.ts` and `agentActivity.ts`.
 *
 * `applied` is the sequence number of the newest load this state has accepted anything from.
 * `feedLoadStarted` mints the new frontier; every other transition that carries a `seq`
 * (via `feedAccepts`) refuses an answer older than it — a poll or "load more" that lost a
 * race against a newer load, or a filter change the reader has already moved on from. A
 * refused transition is a no-op: it returns the exact SAME state object, so callers (and
 * tests) can tell "nothing changed" from "something changed to equal values" with `===`.
 *
 * Rows that arrive while the reader is scrolled away from the top never jump into `rows` —
 * they land in `staged`, and only `feedShowNew` (the "N new" pill) ever moves them across.
 * Nothing in this file auto-applies staged rows; see `feedScrolled`.
 */
import type { ActivityCursor, ActivityPage, ActivityRow } from '@tm/shared/activity';

export interface FeedState {
  /** The newest load sequence number this state has accepted anything from. */
  applied: number;
  /** Shown rows, sorted `(at DESC, id DESC)`, unique by id. */
  rows: readonly ActivityRow[];
  /** Rows that arrived while scrolled away from the top; the UI shows only the count. */
  staged: readonly ActivityRow[];
  /** The older-page cursor from the last `'older'` page, or null at the end of history. */
  nextCursor: string | null;
  loading: boolean;
  /** True while the reader is not at the top of the feed. */
  scrolledAway: boolean;
}

export const EMPTY_FEED: FeedState = {
  applied: 0,
  rows: [],
  staged: [],
  nextCursor: null,
  loading: false,
  scrolledAway: false,
};

/** `(at DESC, id DESC)` order — the log's own keyset order, never a browser clock. */
export function compareActivity(a: ActivityRow, b: ActivityRow): number {
  if (a.at !== b.at) return b.at - a.at;
  return b.id - a.id;
}

/** Union of `existing` and `incoming` deduped by id (incoming wins), sorted by `compareActivity`. */
export function mergeRows(
  existing: readonly ActivityRow[],
  incoming: readonly ActivityRow[],
): ActivityRow[] {
  const byId = new Map<number, ActivityRow>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(compareActivity);
}

/**
 * A load began. `seq` older than what is already applied is refused. `reset: true` (a
 * filter change or the feed's first open) blanks `rows`, `staged` and `nextCursor`;
 * `reset: false` (a poll, or "load older") keeps what is already on screen. Mirrors
 * `timelineLoadStarted`.
 */
export function feedLoadStarted(
  state: FeedState,
  seq: number,
  options: { reset: boolean },
): FeedState {
  if (seq < state.applied) return state;
  return {
    ...state,
    applied: seq,
    rows: options.reset ? [] : state.rows,
    staged: options.reset ? [] : state.staged,
    nextCursor: options.reset ? null : state.nextCursor,
    loading: true,
  };
}

/** Whether an answer carrying `seq` is still the frontier `state` accepts. */
export function feedAccepts(state: FeedState, seq: number): boolean {
  return seq >= state.applied;
}

/**
 * A page answered. `mode: 'older'` (the initial load, or "load more") merges `page.rows`
 * into `rows` and advances `nextCursor` — it never touches `staged`. `mode: 'head'` (the
 * poll re-reading page one) updates rows already known — in `rows` or `staged` — in place;
 * genuinely new ids land in `rows` when the reader is at the top, or in `staged` while
 * scrolled away. Either way `nextCursor` is untouched: the head page's cursor is not the
 * bottom of what is loaded. An `seq` older than `state.applied` is refused (via
 * `feedAccepts`).
 */
export function feedPageArrived(
  state: FeedState,
  seq: number,
  page: ActivityPage,
  mode: 'older' | 'head',
): FeedState {
  if (!feedAccepts(state, seq)) return state;

  if (mode === 'older') {
    return {
      ...state,
      rows: mergeRows(state.rows, page.rows),
      nextCursor: page.nextCursor,
      loading: false,
    };
  }

  const rowIds = new Set(state.rows.map((r) => r.id));
  const stagedIds = new Set(state.staged.map((r) => r.id));
  const toRows: ActivityRow[] = [];
  const toStaged: ActivityRow[] = [];

  for (const r of page.rows) {
    if (rowIds.has(r.id)) {
      toRows.push(r);
    } else if (stagedIds.has(r.id)) {
      toStaged.push(r);
    } else if (state.scrolledAway) {
      toStaged.push(r);
    } else {
      toRows.push(r);
    }
  }

  return {
    ...state,
    rows: mergeRows(state.rows, toRows),
    staged: mergeRows(state.staged, toStaged),
    loading: false,
  };
}

/**
 * Records whether the reader is scrolled away from the top. Never auto-applies `staged` —
 * the pill (`feedShowNew`) is the only way staged rows reach `rows`, so rows never jump
 * under the reader's pointer just because they scrolled back up.
 */
export function feedScrolled(state: FeedState, scrolledAway: boolean): FeedState {
  return { ...state, scrolledAway };
}

/** The "N new" pill was clicked: merges `staged` into `rows` and clears `staged`. */
export function feedShowNew(state: FeedState): FeedState {
  return { ...state, rows: mergeRows(state.rows, state.staged), staged: [] };
}

/** The "N new" pill's count. */
export function feedStagedCount(state: FeedState): number {
  return state.staged.length;
}

/** Whether `row` is newer than `seen` in the log's own `(at, id)` order. */
export function isNewerThan(row: ActivityRow, seen: ActivityCursor): boolean {
  if (row.at !== seen.at) return row.at > seen.at;
  return row.id > seen.id;
}

/**
 * The divider's position: the count of leading rows (in `rows`' own sorted order) newer
 * than `lastSeen`. Null when `lastSeen` is null (first visit — no divider) or no row is
 * newer (nothing happened since).
 */
export function feedDividerIndex(
  rows: readonly ActivityRow[],
  lastSeen: ActivityCursor | null,
): number | null {
  if (lastSeen === null) return null;
  let count = 0;
  for (const row of rows) {
    if (!isNewerThan(row, lastSeen)) break;
    count++;
  }
  return count === 0 ? null : count;
}

/** The newest `(at, id)` across `rows` and `staged`, for the host to persist as "last seen". */
export function feedNewestCursor(state: FeedState): ActivityCursor | null {
  const newest = mergeRows(state.rows, state.staged)[0];
  return newest ? { at: newest.at, id: newest.id } : null;
}
