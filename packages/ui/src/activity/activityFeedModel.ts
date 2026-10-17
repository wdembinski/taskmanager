/**
 * The Activity feed's filter → query mapping, and the small pure helpers the row and
 * day-header rendering need — kept here, next to `feedState.ts`, so `ActivityFeed.tsx`
 * itself only has to wire IPC calls and state transitions, not decide what a row says or
 * which `ActivityQuery` a filter means. Pure and dependency-free; see
 * `activityFeedModel.test.ts` for the behaviour this file promises.
 */
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityKind,
  type ActivityOrigin,
  type ActivityOutcome,
  type ActivityQuery,
  type ActivityRow,
} from '@tm/shared/activity';

/** The feed's four toolbar kind buckets — coarser than {@link ActivityKind}. */
export type FeedKindGroup = 'runs' | 'merges' | 'gates' | 'moves';

/**
 * Which {@link ActivityKind}s each {@link FeedKindGroup} expands to. `trigger-fired` falls
 * under `runs` — F1's tracker automations start a run, same as a human or the chain does.
 */
export const KIND_GROUPS: Record<FeedKindGroup, readonly ActivityKind[]> = {
  runs: ['run-started', 'run-finished', 'trigger-fired'],
  merges: ['merge-landed', 'merge-conflict', 'merge-failed', 'release-published'],
  gates: ['parked', 'resumed', 'plan-presented', 'question-raised'],
  moves: ['status-moved', 'milestone-archived'],
};

/** Fixed order kind groups expand in, independent of the filter's own array order. */
const KIND_GROUP_ORDER: readonly FeedKindGroup[] = ['runs', 'merges', 'gates', 'moves'];

/** The four fixed origins a filter can select — never a `trigger:<id>` origin by itself. */
export type FixedOrigin = 'human' | 'chain' | 'auto-release' | 'resume';

/** The feed's toolbar selections. Controlled by the host; F2.10's tiles set it too. */
export interface FeedFilter {
  projectIds: string[];
  kindGroups: FeedKindGroup[];
  outcomes: ActivityOutcome[];
  origins: FixedOrigin[];
}

export const EMPTY_FEED_FILTER: FeedFilter = {
  projectIds: [],
  kindGroups: [],
  outcomes: [],
  origins: [],
};

/** `filter`'s kind groups, expanded to kinds in {@link KIND_GROUP_ORDER}, deduped. */
function expandKindGroups(groups: readonly FeedKindGroup[]): ActivityKind[] {
  const seen = new Set<ActivityKind>();
  const kinds: ActivityKind[] = [];
  for (const group of KIND_GROUP_ORDER) {
    if (!groups.includes(group)) continue;
    for (const kind of KIND_GROUPS[group]) {
      if (seen.has(kind)) continue;
      seen.add(kind);
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * Builds the `activity:list` request for `filter` over the window starting at
 * `sinceMs`. Empty filter arrays are never sent (an empty `ActivityQuery.kinds: []` would
 * mean "match nothing" to the store, not "no filter"). An outcome picked with no kind group
 * implies `kinds: ['run-finished']` — outcomes only exist on that kind — but a kind group
 * selection, once present, is left exactly as the filter set it. `limit` defaults to
 * {@link ACTIVITY_PAGE_SIZE}; `cursor` is only ever set when `options.cursor` is defined, so
 * a caller never has to special-case an explicit `cursor: undefined` reaching the IPC layer.
 */
export function feedQueryFor(
  filter: FeedFilter,
  options: { sinceMs: number; cursor?: string; limit?: number },
): ActivityQuery {
  const query: ActivityQuery = {
    sinceMs: options.sinceMs,
    limit: options.limit ?? ACTIVITY_PAGE_SIZE,
  };

  if (filter.projectIds.length > 0) {
    query.projectIds = [...filter.projectIds];
  }

  const kinds = expandKindGroups(filter.kindGroups);
  if (kinds.length > 0) {
    query.kinds = kinds;
  } else if (filter.outcomes.length > 0) {
    query.kinds = ['run-finished'];
  }

  if (filter.outcomes.length > 0) {
    query.outcomes = [...filter.outcomes];
  }

  if (filter.origins.length > 0) {
    query.origins = [...filter.origins];
  }

  if (options.cursor !== undefined) {
    query.cursor = options.cursor;
  }

  return query;
}

/** Whether `filter` selects nothing — the toolbar's "Clear filters" is enabled by this. */
export function feedFilterIsEmpty(filter: FeedFilter): boolean {
  return (
    filter.projectIds.length === 0 &&
    filter.kindGroups.length === 0 &&
    filter.outcomes.length === 0 &&
    filter.origins.length === 0
  );
}

/**
 * A stable string that changes if and only if {@link feedQueryFor} would build a different
 * query from `filter` — sorted and deduped, so reordering a toolbar selection (or a repeated
 * one) never triggers a reset reload by itself. The host re-reads page one with
 * `reset: true` whenever this key changes.
 */
export function feedFilterKey(filter: FeedFilter): string {
  const projectIds = [...new Set(filter.projectIds)].sort().join(',');
  const kinds = expandKindGroups(filter.kindGroups).join(',');
  const outcomes = [...new Set(filter.outcomes)].sort().join(',');
  const origins = [...new Set(filter.origins)].sort().join(',');
  return `${projectIds}|${kinds}|${outcomes}|${origins}`;
}

/** What clicking a row should do. */
export type FeedRowTarget =
  { kind: 'open'; taskId: string } | { kind: 'deleted' } | { kind: 'none' };

/**
 * `row.taskId === null` (a row with no card, e.g. a release) gives `'none'`. A task id not
 * in `liveTaskIds` (the card was deleted since this row was written) gives `'deleted'`.
 * Otherwise the row opens that card.
 */
export function rowTarget(row: ActivityRow, liveTaskIds: ReadonlySet<string>): FeedRowTarget {
  if (row.taskId === null) return { kind: 'none' };
  if (!liveTaskIds.has(row.taskId)) return { kind: 'deleted' };
  return { kind: 'open', taskId: row.taskId };
}

const BASE_SENTENCE: Record<ActivityKind, string> = {
  'run-started': 'Run started',
  'run-finished': 'Run finished',
  parked: 'Parked',
  resumed: 'Resumed',
  'plan-presented': 'Plan presented',
  'question-raised': 'Question raised',
  'merge-landed': 'Merged',
  'merge-conflict': 'Merge conflict',
  'merge-failed': 'Merge failed',
  'release-published': 'Released',
  'status-moved': 'Moved',
  'trigger-fired': 'Trigger fired',
  'milestone-archived': 'Milestone archived',
};

const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  empty: 'empty',
  'needs-input': 'needs input',
};

/**
 * A short label for a row's kind/outcome — the row's own text, next to its title snapshot.
 * `run-finished` appends the outcome ("Run finished — failed"); `release-published` and
 * `status-moved` read their version/from-to out of `detail` when present, falling back to
 * the bare verb when a backfilled row has none; `milestone-archived` says "auto-archived"
 * when the sweep (F14.10) did it rather than a human.
 */
export function rowSentence(row: ActivityRow): string {
  switch (row.kind) {
    case 'run-finished':
      return row.outcome ? `Run finished — ${OUTCOME_LABEL[row.outcome]}` : BASE_SENTENCE[row.kind];
    case 'release-published':
      return row.detail?.version ? `Released v${row.detail.version}` : BASE_SENTENCE[row.kind];
    case 'status-moved':
      return row.detail?.from && row.detail?.to
        ? `Moved ${row.detail.from} → ${row.detail.to}`
        : BASE_SENTENCE[row.kind];
    case 'milestone-archived':
      return row.detail?.reason === 'auto' ? 'Milestone auto-archived' : BASE_SENTENCE[row.kind];
    default:
      return BASE_SENTENCE[row.kind];
  }
}

/** The origin chip's text, or null for a row with no recorded origin. */
export function originLabel(origin: ActivityOrigin | null): string | null {
  if (origin === null) return null;
  switch (origin) {
    case 'human':
      return 'You';
    case 'chain':
      return 'Chain';
    case 'resume':
      return 'Resume';
    case 'auto-release':
      return 'Auto-release';
    default:
      return origin.startsWith('trigger:') ? 'Trigger' : null;
  }
}

/**
 * `costUsd` formatted for the row, or `'—'` for `null` ("unknown", see `ActivityRow.costUsd`)
 * — never `'$0.00'`, which would read as a priced run that happened to cost nothing.
 */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—';
  return costUsd < 1 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The local-day index `at` falls in, under a `tzOffsetMinutes` EAST of UTC (the opposite
 * sign of `Date#getTimezoneOffset()`) — same convention as `usage.ts`'s `bucketUsageDaily`,
 * so the viewer's own offset (not the desktop's) decides where midnight falls.
 */
function localDayIndex(at: number, tzOffsetMinutes: number): number {
  return Math.floor((at + tzOffsetMinutes * 60_000) / DAY_MS);
}

/** "Today" / "Yesterday" relative to `todayIndex`, else a locale-independent date. */
function dayLabel(index: number, todayIndex: number): string {
  if (index === todayIndex) return 'Today';
  if (index === todayIndex - 1) return 'Yesterday';
  const date = new Date(index * DAY_MS);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export interface FeedDayGroup {
  label: string;
  rows: ActivityRow[];
}

/**
 * Groups `rows` (assumed already sorted newest-first, as `FeedState.rows` is) into
 * consecutive runs sharing a local day, labelled Today / Yesterday / a date. The day
 * boundary is the **viewer's** offset (`options.tzOffsetMinutes`), not the desktop's or the
 * row's own clock — a web reader in a different timezone from their desktop sees "Today"
 * start at their own midnight.
 */
export function groupRowsByDay(
  rows: readonly ActivityRow[],
  options: { now: number; tzOffsetMinutes: number },
): FeedDayGroup[] {
  const todayIndex = localDayIndex(options.now, options.tzOffsetMinutes);
  const groups: { index: number; label: string; rows: ActivityRow[] }[] = [];

  for (const row of rows) {
    const index = localDayIndex(row.at, options.tzOffsetMinutes);
    const last = groups[groups.length - 1];
    if (last && last.index === index) {
      last.rows.push(row);
    } else {
      groups.push({ index, label: dayLabel(index, todayIndex), rows: [row] });
    }
  }

  return groups.map(({ label, rows: groupRows }) => ({ label, rows: groupRows }));
}
