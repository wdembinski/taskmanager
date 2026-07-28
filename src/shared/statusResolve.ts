/**
 * One answer to "which board column does this JIRA status mean, and why".
 *
 * This exists because the two halves of a move used to disagree. Dragging a card into
 * IN REVIEW picked a transition by a NAME heuristic (any `indeterminate` transition
 * called something-review), which needs no configuration — so the drag worked and the
 * ticket really did move. But the sync that followed resolved the status by the map
 * alone, and the map is empty out of the box, so the issue's category (`In Progress`,
 * which is where JIRA files every review status) sent the card straight back to IN
 * PROGRESS. The ticket said In Review and the board said In Progress, and every sync
 * re-asserted the wrong one.
 *
 * The fix is not a second heuristic in the sync — it is one resolver both paths call,
 * so they cannot drift again. Pure: no React, no Electron, no DB.
 */
import type { BoardColumn, JiraStatusCategory } from './model';
import { categoryToColumn, lookupStatusColumn } from './board';

/**
 * Why a status landed where it did — the tiers, in precedence order.
 *
 * `explicit`  the user mapped this status name in Settings.
 * `learned`   we mapped it ourselves after a drag transitioned an issue into it.
 * `heuristic` an In-Progress-category status whose NAME says review.
 * `category`  nothing said otherwise; JIRA's own category decided.
 *
 * Surfaced in the UI (the status-map viewer), which is the point: an unexplained
 * column is exactly how the bug above stayed invisible.
 */
export type StatusReason = 'explicit' | 'learned' | 'heuristic' | 'category';

export interface StatusResolution {
  column: BoardColumn;
  reason: StatusReason;
}

/** The tiers in precedence order — the viewer and the transition picker both iterate this. */
export const STATUS_REASONS: readonly StatusReason[] = [
  'explicit',
  'learned',
  'heuristic',
  'category',
];

/**
 * Whether a status name reads as "someone is reviewing this".
 *
 * Gated on the `In Progress` category on purpose: a To-Do-category "Ready for review"
 * has not been picked up by anyone, and a Done-category "Reviewed" is finished. Only
 * the indeterminate middle is ambiguous, and that ambiguity is the whole problem —
 * JIRA files "In Review" alongside the status that means "being written".
 */
export function isReviewishStatus(rawStatus: string, category: JiraStatusCategory): boolean {
  return category === 'In Progress' && /review/i.test(rawStatus);
}

/**
 * Resolve a JIRA status name (plus its category) to a board column, and say which tier
 * decided. Both maps are matched case-insensitively by {@link lookupStatusColumn}.
 */
export function resolveStatusColumn(
  rawStatus: string,
  category: JiraStatusCategory,
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): StatusResolution {
  const explicit = lookupStatusColumn(rawStatus, map);
  if (explicit) return { column: explicit, reason: 'explicit' };

  const remembered = lookupStatusColumn(rawStatus, learned);
  if (remembered) return { column: remembered, reason: 'learned' };

  if (isReviewishStatus(rawStatus, category)) return { column: 'in-review', reason: 'heuristic' };

  return { column: categoryToColumn(category), reason: 'category' };
}
