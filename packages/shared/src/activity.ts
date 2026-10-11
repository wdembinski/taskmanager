/**
 * The activity vocabulary and query contract for the cross-board, chronological log F2
 * (`docs/plan/feature-roadmap/F2-activity-dashboard.md`) records and reads. Pure types and
 * logic only — the desktop store (F2.4) owns the `activity_log` table and reads these TEXT
 * columns back through the type guards below, and the IPC layer (F2.9) is the one caller
 * that turns a malformed cursor into an error.
 *
 * Fixed here, ahead of either of those:
 * - `ActivityOutcome` has no `cancelled`/`in-review` — those are board columns, not run
 *   outcomes. `empty` (the engine's own "said success, did nothing" verdict) counts as
 *   `failed` everywhere outcomes are summarized.
 * - A cursor is opaque to every caller but this file: `(at, id)` is an implementation detail
 *   of `(at DESC, id DESC)` keyset paging, never a page number a caller could compute itself.
 * - `summarizeOutcomes` returns a plain object (no `Map`/`Set`), so the result survives a
 *   JSON round trip over the relay unchanged.
 */
import type { AttentionItem } from './attention';
import type { ActiveRun } from './scheduler';

/**
 * Every kind of row the log records. `trigger-fired` is reserved for F1 (a tracker-fired
 * automation) — F2 is buildable before F1, so nothing here emits it yet.
 */
export const ACTIVITY_KINDS = [
  'run-started',
  'run-finished',
  'parked',
  'resumed',
  'plan-presented',
  'question-raised',
  'merge-landed',
  'merge-conflict',
  'merge-failed',
  'release-published',
  'status-moved',
  'trigger-fired',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Whether a string read back from the `kind` TEXT column is a value this file knows. */
export function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * How a `run-finished` row ended. `empty` is the engine's own verdict that a run claimed
 * success but did nothing — see `summarizeOutcomes` for why it is counted as `failed`.
 */
export const ACTIVITY_OUTCOMES = ['done', 'failed', 'stopped', 'empty', 'needs-input'] as const;

export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Whether a string read back from the `outcome` TEXT column is a value this file knows. */
export function isActivityOutcome(value: string): value is ActivityOutcome {
  return (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * What started a run (or, for non-run kinds, whose action the row records): a human on the
 * board, the chain runner advancing a plan's steps, an auto-release publish, a gate resume,
 * or a tracker automation firing (`trigger:<automation id>`, F1).
 */
export type ActivityOrigin = 'human' | 'chain' | 'auto-release' | 'resume' | `trigger:${string}`;

const FIXED_ACTIVITY_ORIGINS = ['human', 'chain', 'auto-release', 'resume'] as const;

/**
 * Whether a string read back from the `origin` TEXT column is a value this file knows —
 * one of the four fixed origins, or `trigger:` followed by a non-empty id.
 */
export function isActivityOrigin(value: string): value is ActivityOrigin {
  if ((FIXED_ACTIVITY_ORIGINS as readonly string[]).includes(value)) return true;
  return value.startsWith('trigger:') && value.length > 'trigger:'.length;
}

/**
 * The small, kind-specific extras a row carries — a limit's `reason`, a merge's `branch`, a
 * release's `version`, a move's `from`/`to` column, or `backfilled` marking a row the
 * one-shot backfill (F2.5) derived from older tables rather than recorded live. Every field
 * is optional because no single kind uses all of them.
 */
export interface ActivityDetail {
  reason?: string;
  branch?: string;
  version?: string;
  from?: string;
  to?: string;
  backfilled?: boolean;
}

/** One row of the activity log, as read back from `activity_log`. */
export interface ActivityRow {
  id: number;
  at: number;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  kind: ActivityKind;
  /** Set only when `kind` is `run-finished`; null on every other kind. */
  outcome: ActivityOutcome | null;
  origin: ActivityOrigin | null;
  /**
   * The card's title at the moment this row was written — a snapshot, not a live lookup, so
   * a card that is later renamed or deleted still reads sensibly in the feed.
   */
  title: string;
  /**
   * Cost in USD, or null for **unknown** — never `0`. A run whose cost genuinely rounds to
   * nothing is indistinguishable from one the engine never priced at all, so this column
   * never guesses one for the other.
   */
  costUsd: number | null;
  detail: ActivityDetail | null;
}

/** A page request against the log: a time window, optional filters, and a keyset cursor. */
export interface ActivityQuery {
  sinceMs: number;
  untilMs?: number;
  projectIds?: string[];
  kinds?: ActivityKind[];
  outcomes?: ActivityOutcome[];
  origins?: ActivityOrigin[];
  cursor?: string;
  limit: number;
}

/**
 * The upper bound on `ActivityQuery.limit` (F2.9) — one `activity:list` page can never be
 * asked to carry more rows than this, relayed args included.
 */
export const ACTIVITY_PAGE_MAX = 200;

/**
 * The one sentence a cursor `decodeCursor` rejects answers with, wherever the rejection
 * happens — a stale link, a page bookmarked across a retention sweep, or a payload someone
 * hand-edited. The feed has moved on; there is nothing to resume from.
 */
const STALE_CURSOR_MESSAGE = 'This activity page is out of date — reload the feed';

/**
 * Validates and clamps an `activity:list` request before it reaches the store: `limit` is
 * clamped to `[1, ACTIVITY_PAGE_MAX]`, defaulting to `ACTIVITY_PAGE_SIZE` when it is missing
 * or not a finite number (relayed args are untrusted); a `cursor` that `decodeCursor` would
 * reject throws {@link STALE_CURSOR_MESSAGE} here, rather than the store's own generic
 * "invalid activity cursor" — this is the IPC-layer translation this file's own docstring
 * promises.
 */
export function normalizeActivityQuery(query: ActivityQuery): ActivityQuery {
  if (query.cursor !== undefined && decodeCursor(query.cursor) === null) {
    throw new Error(STALE_CURSOR_MESSAGE);
  }
  const limit = Number.isFinite(query.limit)
    ? Math.min(ACTIVITY_PAGE_MAX, Math.max(1, Math.floor(query.limit)))
    : ACTIVITY_PAGE_SIZE;
  return { ...query, limit };
}

/** One of the activity dashboard's three fixed trailing windows. */
export const ACTIVITY_PERIODS = ['24h', '7d', '30d'] as const;

export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

/** Whether a string is one of {@link ACTIVITY_PERIODS} — the IPC layer's own untrusted input. */
export function isActivityPeriod(value: string): value is ActivityPeriod {
  return (ACTIVITY_PERIODS as readonly string[]).includes(value);
}

const HOUR_MS = 60 * 60 * 1000;

/** How far back each {@link ActivityPeriod} reaches, in ms. */
export const ACTIVITY_PERIOD_MS: Record<ActivityPeriod, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/**
 * The activity dashboard's headline tile for one trailing window: how many runs are live
 * right now, how many need a human, and the outcome counts over the window — plain data,
 * JSON-safe over the relay.
 */
export interface ActivityOverview {
  period: ActivityPeriod;
  sinceMs: number;
  running: number;
  needsYou: number;
  outcomes: OutcomeCounts;
  byProject: Record<string, OutcomeCounts>;
}

/**
 * Builds {@link ActivityOverview} from the engine's live state: `running` is the count of
 * DISTINCT task ids in `activeRuns` (a task never has two live runs at once, but nothing here
 * assumes that), `needsYou` is simply how many items are in the attention inbox, and the
 * outcome counts are handed in whole, already computed by `store.countOutcomes` (F2.4) over
 * the window — this function only assembles the tile, so the handler that calls it stays a
 * one-liner.
 */
export function buildActivityOverview(input: {
  period: ActivityPeriod;
  now: number;
  activeRuns: readonly ActiveRun[];
  attention: readonly AttentionItem[];
  outcomes: { total: OutcomeCounts; byProject: Record<string, OutcomeCounts> };
}): ActivityOverview {
  return {
    period: input.period,
    sinceMs: input.now - ACTIVITY_PERIOD_MS[input.period],
    running: new Set(input.activeRuns.map((run) => run.taskId)).size,
    needsYou: input.attention.length,
    outcomes: input.outcomes.total,
    byProject: input.outcomes.byProject,
  };
}

/** One page of the log, plus the cursor for the next (older) page, or null at the end. */
export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
}

/** The feed's default page size. */
export const ACTIVITY_PAGE_SIZE = 50;

/**
 * The keyset position a page ends on: the `(at, id)` of its last row. The next page holds
 * rows strictly older in `(at DESC, id DESC)` order — never a row already seen, even if new
 * rows have landed at the top since the first page was read.
 */
export interface ActivityCursor {
  at: number;
  id: number;
}

/** Encodes a cursor as an opaque, URL-safe string. Callers must treat the result as opaque. */
export function encodeCursor(cursor: ActivityCursor): string {
  return toBase64Url(`${cursor.at}.${cursor.id}`);
}

/**
 * Decodes a cursor produced by {@link encodeCursor}, or returns null for anything else —
 * never throws. Rejects: a non-string, a string that fails base64url decoding, a decoded
 * shape other than `digits.digits`, an `at`/`id` beyond `Number.MAX_SAFE_INTEGER`, and an
 * `id` below 1 (row ids start at 1). The caller (the IPC layer, F2.9) turns null into its
 * own error — this file only ever reports "not a valid cursor".
 */
export function decodeCursor(value: unknown): ActivityCursor | null {
  if (typeof value !== 'string') return null;

  let decoded: string;
  try {
    decoded = atob(fromBase64Url(value));
  } catch {
    return null;
  }

  const match = /^(\d+)\.(\d+)$/.exec(decoded);
  if (!match) return null;

  const at = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(id)) return null;
  if (id < 1) return null;

  return { at, id };
}

function toBase64Url(raw: string): string {
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  return encoded.replace(/-/g, '+').replace(/_/g, '/');
}

/** Outcome tile counts: `failed` already folds in `empty` (see {@link ACTIVITY_OUTCOMES}). */
export interface OutcomeCounts {
  done: number;
  failed: number;
  stopped: number;
  needsInput: number;
}

function emptyCounts(): OutcomeCounts {
  return { done: 0, failed: 0, stopped: 0, needsInput: 0 };
}

function bump(counts: OutcomeCounts, outcome: ActivityOutcome): void {
  switch (outcome) {
    case 'done':
      counts.done++;
      break;
    case 'failed':
    case 'empty':
      counts.failed++;
      break;
    case 'stopped':
      counts.stopped++;
      break;
    case 'needs-input':
      counts.needsInput++;
      break;
  }
}

type FinishedRow = ActivityRow & { outcome: ActivityOutcome };

function isFinishedRow(row: ActivityRow): row is FinishedRow {
  return row.kind === 'run-finished' && row.outcome !== null;
}

/**
 * Tile counts over a set of rows: totals, and the same shape per project. Only
 * `run-finished` rows with an outcome are counted — a `parked`/`merge-failed`/etc. row
 * never moves these numbers.
 *
 * A run counts once, at its final outcome, however many `run-finished` rows it produced
 * (the settle path can fire more than once — see `settled-run-resurrection-trap`): rows are
 * grouped by `runId` and only the latest by `(at, id)` is kept, regardless of input order. A
 * row with no `runId` is counted on its own — nothing to deduplicate it against.
 *
 * A row with a null `projectId` counts in `total` only; it has nowhere to go in `byProject`.
 */
export function summarizeOutcomes(rows: readonly ActivityRow[]): {
  total: OutcomeCounts;
  byProject: Record<string, OutcomeCounts>;
} {
  const finished = rows.filter(isFinishedRow);

  const latestByRun = new Map<string, FinishedRow>();
  const unattributed: FinishedRow[] = [];
  for (const row of finished) {
    if (row.runId === null) {
      unattributed.push(row);
      continue;
    }
    const current = latestByRun.get(row.runId);
    if (!current || row.at > current.at || (row.at === current.at && row.id > current.id)) {
      latestByRun.set(row.runId, row);
    }
  }

  const total = emptyCounts();
  const byProject: Record<string, OutcomeCounts> = {};
  for (const row of [...latestByRun.values(), ...unattributed]) {
    bump(total, row.outcome);
    if (row.projectId !== null) {
      byProject[row.projectId] ??= emptyCounts();
      bump(byProject[row.projectId], row.outcome);
    }
  }
  return { total, byProject };
}
