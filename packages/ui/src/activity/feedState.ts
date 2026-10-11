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
 *
 * This is the design step: contracts only, declared ambiently. The implementation and its
 * tests land in the next steps.
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

export declare const EMPTY_FEED: FeedState;

/** `(at DESC, id DESC)` order — the log's own keyset order, never a browser clock. */
export declare function compareActivity(a: ActivityRow, b: ActivityRow): number;

/** Union of `existing` and `incoming` deduped by id (incoming wins), sorted by `compareActivity`. */
export declare function mergeRows(
  existing: readonly ActivityRow[],
  incoming: readonly ActivityRow[],
): ActivityRow[];

/**
 * A load began. `seq` older than what is already applied is refused. `reset: true` (a
 * filter change or the feed's first open) blanks `rows`, `staged` and `nextCursor`;
 * `reset: false` (a poll, or "load older") keeps what is already on screen. Mirrors
 * `timelineLoadStarted`.
 */
export declare function feedLoadStarted(
  state: FeedState,
  seq: number,
  options: { reset: boolean },
): FeedState;

/** Whether an answer carrying `seq` is still the frontier `state` accepts. */
export declare function feedAccepts(state: FeedState, seq: number): boolean;

/**
 * A page answered. `mode: 'older'` (the initial load, or "load more") merges `page.rows`
 * into `rows` and advances `nextCursor` — it never touches `staged`. `mode: 'head'` (the
 * poll re-reading page one) updates rows already known — in `rows` or `staged` — in place;
 * genuinely new ids land in `rows` when the reader is at the top, or in `staged` while
 * scrolled away. Either way `nextCursor` is untouched: the head page's cursor is not the
 * bottom of what is loaded. An `seq` older than `state.applied` is refused (via
 * `feedAccepts`).
 */
export declare function feedPageArrived(
  state: FeedState,
  seq: number,
  page: ActivityPage,
  mode: 'older' | 'head',
): FeedState;

/**
 * Records whether the reader is scrolled away from the top. Never auto-applies `staged` —
 * the pill (`feedShowNew`) is the only way staged rows reach `rows`, so rows never jump
 * under the reader's pointer just because they scrolled back up.
 */
export declare function feedScrolled(state: FeedState, scrolledAway: boolean): FeedState;

/** The "N new" pill was clicked: merges `staged` into `rows` and clears `staged`. */
export declare function feedShowNew(state: FeedState): FeedState;

/** The "N new" pill's count. */
export declare function feedStagedCount(state: FeedState): number;

/** Whether `row` is newer than `seen` in the log's own `(at, id)` order. */
export declare function isNewerThan(row: ActivityRow, seen: ActivityCursor): boolean;

/**
 * The divider's position: the count of leading rows (in `rows`' own sorted order) newer
 * than `lastSeen`. Null when `lastSeen` is null (first visit — no divider) or no row is
 * newer (nothing happened since).
 */
export declare function feedDividerIndex(
  rows: readonly ActivityRow[],
  lastSeen: ActivityCursor | null,
): number | null;

/** The newest `(at, id)` across `rows` and `staged`, for the host to persist as "last seen". */
export declare function feedNewestCursor(state: FeedState): ActivityCursor | null;
