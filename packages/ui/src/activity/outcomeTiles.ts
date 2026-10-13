/**
 * The Activity dashboard's tiles row — Running now · Needs you · Completed · Failed
 * (`docs/plan/feature-roadmap/F2-activity-dashboard.md`) — as pure mapping functions. Kept
 * out of `OutcomeTiles.tsx` for the same reason as `feedState.ts`: this repo has no DOM
 * test harness, so the only way to prove a click sets, toggles and switches the feed's
 * filter correctly is to test it as plain functions.
 *
 * A tile's badge count (`tileCount`) and what clicking it filters (`applyTile`) are
 * deliberately different data sources. `running`/`needsYou` are read live, off the
 * scheduler and attention list (see `buildActivityOverview` in `@tm/shared/activity`) — the
 * log has no "is still running" state — but clicking still needs *something* to filter the
 * feed by, so it falls back to the closest log kinds. `completed`/`failed` are read
 * straight off `ActivityOverview.outcomes`, which already folds the `empty` outcome into
 * `failed` — see `OutcomeCounts`.
 */
import type {
  ActivityKind,
  ActivityOutcome,
  ActivityOverview,
  ActivityQuery,
} from '@tm/shared/activity';
import type { FeedFilter, FeedKindGroup } from './activityFeedModel';

export const OUTCOME_TILES = ['running', 'needsYou', 'completed', 'failed'] as const;

export type OutcomeTile = (typeof OUTCOME_TILES)[number];

interface TileFilter {
  kinds?: readonly ActivityKind[];
  outcomes?: readonly ActivityOutcome[];
}

/**
 * Each tile's query filter, on exactly one dimension — `kinds` for the two tiles with no
 * outcome of their own, `outcomes` for the two read off finished runs. `failed` lists both
 * raw outcomes that bucket into `OutcomeCounts.failed`.
 */
const TILE_FILTERS: Record<OutcomeTile, TileFilter> = {
  running: { kinds: ['run-started'] },
  needsYou: { kinds: ['parked', 'question-raised', 'merge-conflict'] },
  completed: { outcomes: ['done'] },
  failed: { outcomes: ['failed', 'empty'] },
};

function sameSet<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  if (!a || a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((value) => bSet.has(value));
}

/**
 * A tile was clicked: sets `kinds`/`outcomes` to that tile's filter (clearing whichever of
 * the two the tile does not use) and leaves every other field — `projectIds`, `origins`,
 * `sinceMs`, `limit`, `cursor` — untouched. Clicking the already-active tile again toggles
 * it off, clearing both fields instead. The arrays assigned are always fresh copies, never
 * the shared {@link TILE_FILTERS} constants, so a caller mutating the query cannot corrupt
 * every future click.
 */
export function applyTile(query: ActivityQuery, tile: OutcomeTile): ActivityQuery {
  if (activeTile(query) === tile) {
    return { ...query, kinds: undefined, outcomes: undefined };
  }
  const filter = TILE_FILTERS[tile];
  return {
    ...query,
    kinds: filter.kinds ? [...filter.kinds] : undefined,
    outcomes: filter.outcomes ? [...filter.outcomes] : undefined,
  };
}

/**
 * Which tile, if any, `query` currently reflects — order-insensitive on both `kinds` and
 * `outcomes`. Null when neither field is set, when a field holds a filter no tile produces
 * (set by hand, or left over from the feed's own kind/outcome filters), or when both fields
 * are set at once — no tile's own filter ever touches both.
 */
export function activeTile(query: ActivityQuery): OutcomeTile | null {
  const hasKinds = (query.kinds?.length ?? 0) > 0;
  const hasOutcomes = (query.outcomes?.length ?? 0) > 0;
  if (hasKinds === hasOutcomes) return null;

  for (const tile of OUTCOME_TILES) {
    const filter = TILE_FILTERS[tile];
    if (filter.kinds && hasKinds && sameSet(query.kinds, filter.kinds)) return tile;
    if (filter.outcomes && hasOutcomes && sameSet(query.outcomes, filter.outcomes)) return tile;
  }
  return null;
}

/** The tile's badge count, read off the overview for the period the tiles row is showing. */
export function tileCount(overview: ActivityOverview, tile: OutcomeTile): number {
  switch (tile) {
    case 'running':
      return overview.running;
    case 'needsYou':
      return overview.needsYou;
    case 'completed':
      return overview.outcomes.done;
    case 'failed':
      return overview.outcomes.failed;
  }
}

interface FeedTileFilter {
  kindGroups?: readonly FeedKindGroup[];
  outcomes?: readonly ActivityOutcome[];
}

/**
 * Each tile's `FeedFilter` bridge (F2.13's design decisions in `F2-activity-dashboard.md`) —
 * coarser than {@link TILE_FILTERS} above, because `FeedFilter` can only express kind
 * GROUPS, not individual `ActivityKind`s. `running`/`needsYou` map to the `runs`/`gates`
 * groups rather than the exact kinds `applyTile` sets; `completed`/`failed` match
 * {@link TILE_FILTERS} exactly, since outcomes are not grouped at all.
 */
const FEED_TILE_FILTERS: Record<OutcomeTile, FeedTileFilter> = {
  running: { kindGroups: ['runs'] },
  needsYou: { kindGroups: ['gates'] },
  completed: { outcomes: ['done'] },
  failed: { outcomes: ['failed', 'empty'] },
};

/**
 * The Activity screen's own tile click: sets `filter.kindGroups`/`outcomes` to that tile's
 * `FeedFilter` bridge (clearing whichever of the two the tile does not use), or clears both
 * when the already-active tile is clicked again — the same toggle `applyTile` has, just
 * aimed at a `FeedFilter` instead of an `ActivityQuery`. `projectIds` and `origins` are
 * always left exactly as they were.
 */
export function applyTileToFeedFilter(filter: FeedFilter, tile: OutcomeTile): FeedFilter {
  if (activeFeedTile(filter) === tile) {
    return { ...filter, kindGroups: [], outcomes: [] };
  }
  const tileFilter = FEED_TILE_FILTERS[tile];
  return {
    ...filter,
    kindGroups: tileFilter.kindGroups ? [...tileFilter.kindGroups] : [],
    outcomes: tileFilter.outcomes ? [...tileFilter.outcomes] : [],
  };
}

/**
 * Which tile, if any, `filter` currently reflects — the `FeedFilter` counterpart of
 * {@link activeTile}, order-insensitive on both arrays. Null when neither field is set, when
 * a field holds a filter no tile produces (a hand-set toolbar selection), or when both are
 * set at once.
 */
export function activeFeedTile(filter: FeedFilter): OutcomeTile | null {
  const hasKindGroups = filter.kindGroups.length > 0;
  const hasOutcomes = filter.outcomes.length > 0;
  if (hasKindGroups === hasOutcomes) return null;

  for (const tile of OUTCOME_TILES) {
    const tileFilter = FEED_TILE_FILTERS[tile];
    if (
      tileFilter.kindGroups &&
      hasKindGroups &&
      sameSet(filter.kindGroups, tileFilter.kindGroups)
    ) {
      return tile;
    }
    if (tileFilter.outcomes && hasOutcomes && sameSet(filter.outcomes, tileFilter.outcomes)) {
      return tile;
    }
  }
  return null;
}
