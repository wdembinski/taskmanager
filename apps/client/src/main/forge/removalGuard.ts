/**
 * A bound on how many cards ONE sync may take off the board, whichever tracker it syncs.
 *
 * This lived inside `jira/jiraSync.ts` until a second tracker appeared, and moving it is the
 * whole point: **a guard the second integration forgets to apply is not a guard.** Copying it
 * would have produced two versions of a rule whose value is that it is the same rule — one of
 * them would have been tuned, or fixed, or given a new dial, and nobody would have found out
 * until a board emptied.
 *
 * What it is NOT: a second opinion on any one removal. Every removal handed to it already has
 * an answer from the tracker behind it. This is a bound on how *wrong one sync* is allowed to
 * be — a credential that silently narrowed, a filter someone half-edited, a query saved with
 * a typo. The failure mode they share is *many cards at once*, and taking a third of a board
 * off in one poll is the kind of thing to stop and report rather than do and log.
 *
 * Pure: no DB, no Electron, no network.
 */
import type { TaskArchiveReason } from '@shared/model';

/**
 * Why the board is letting go of a card. Each one is a different question having answered.
 *
 * The same union the row stores and the Removed-cards list spells out — `TaskArchiveReason`
 * in `@shared/model` — because the reason a card left is carried all the way from the
 * reconciler's decision to the sentence the human reads, and two vocabularies that had to be
 * kept in step would eventually not be.
 */
export type ForgeRemovalReason = TaskArchiveReason;

/**
 * One card the board is letting go of. Carries the key and the title as well as the id,
 * because the caller has to be able to *tell the human what left* — an id alone is not
 * something anybody can check against a tracker.
 */
export interface ForgeRemoval {
  taskId: string;
  key: string;
  title: string;
  reason: ForgeRemovalReason;
}

/** What {@link guardRemovals} made of a removal set: what may go, what may not, and why. */
export interface RemovalGuardResult {
  removals: ForgeRemoval[];
  refused: ForgeRemoval[];
  warning: string | null;
}

/** Share of the board that may leave in one sync before the guard refuses the lot. */
export const DEFAULT_MAX_REMOVAL_FRACTION = 0.25;

/** Below this many removals the guard never fires — a four-card board is all fractions. */
export const DEFAULT_MIN_GUARDED_REMOVALS = 5;

export interface RemovalGuardOptions {
  /**
   * What to call the tracker in the warning — "JIRA", "GitHub". Only the sentence shown to
   * the human changes; the rule does not.
   *
   * Defaulted rather than required so the two dials below can be exercised on their own, and
   * defaulted to something tracker-NEUTRAL rather than to JIRA: a shared module that names
   * one integration when nobody told it which is how a GitHub board comes to be told to check
   * its JQL.
   */
  tracker?: string;
  /** What that tracker calls the thing to go and check — "JQL", "issue query". */
  queryName?: string;
  /** Share of the board that may leave in one sync before the guard refuses. Default 0.25. */
  maxRemovalFraction?: number;
  /** Removals below this count are never guarded — small boards are noisy. Default 5. */
  minGuardedRemovals?: number;
  /**
   * Whether the question itself changed since the last sync — the sprint rolled over, the
   * query was edited in Settings. Cards leaving is then expected, so the guard stands down;
   * it is there to catch a board shrinking while the question held still.
   */
  queryChanged?: boolean;
}

/**
 * Refuse a removal set that is too big a share of the board to believe.
 *
 * Two dials, and the second matters as much as the first: on a four-card board every honest
 * removal is a quarter of it, so nothing under {@link DEFAULT_MIN_GUARDED_REMOVALS} is
 * guarded at all.
 *
 * It stands down entirely when `queryChanged` — a new sprint, an edited query. The board is
 * *meant* to turn over then, and a guard that fires on the one expected mass removal would be
 * teaching the human to ignore it.
 *
 * All or nothing: a partial removal would leave the board in a state no question produced.
 */
export function guardRemovals(
  removals: readonly ForgeRemoval[],
  boardCount: number,
  opts: RemovalGuardOptions = {},
): RemovalGuardResult {
  const allowed: RemovalGuardResult = { removals: [...removals], refused: [], warning: null };
  if (opts.queryChanged) return allowed;

  const fraction = opts.maxRemovalFraction ?? DEFAULT_MAX_REMOVAL_FRACTION;
  const floor = opts.minGuardedRemovals ?? DEFAULT_MIN_GUARDED_REMOVALS;
  if (removals.length < floor) return allowed;
  if (removals.length <= boardCount * fraction) return allowed;

  const pct = Math.round(fraction * 100);
  const tracker = opts.tracker ?? 'the tracker';
  const queryName = opts.queryName ?? 'query';
  return {
    removals: [],
    refused: [...removals],
    warning:
      `Kept ${removals.length} of ${boardCount} ${tracker} cards that ${tracker} says have ` +
      `left the query — more than ${pct}% of the board in one sync. Nothing was removed. ` +
      `Check the board's ${queryName} and that ${tracker} is answering it in full.`,
  };
}
