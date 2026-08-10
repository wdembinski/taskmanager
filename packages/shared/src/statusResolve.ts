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
 * `heuristic` the status NAME decided — review (In Progress only) or blocked.
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
 * The names a workflow gives the status that means "this is stuck".
 *
 * Word-bounded on purpose. `\bblock` does not match "Unblocked", which is the one
 * neighbouring name that means the exact opposite — a substring test would send a
 * just-unblocked ticket straight back into BLOCKED.
 */
const BLOCKED_NAME =
  /\b(block(s|ed|er|ing)?|impediment|impeded|on hold|hold|waiting|awaiting|pause[ds]?|stall(ed|ing)?|stuck|parked|suspended)\b/i;

/** Whether a status NAME reads as "this is stuck". See {@link BLOCKED_NAME}. */
export function hasBlockedName(rawStatus: string): boolean {
  return BLOCKED_NAME.test(rawStatus);
}

/**
 * Whether a status means BLOCKED — the board's fourth column, which until now no JIRA
 * status could ever reach. Both clauses below are load-bearing.
 *
 * **Review wins over blocked.** "Waiting for review" and "Pending review" are legitimate
 * IN REVIEW destinations, already claimed by {@link isReviewishStatus} above — and IN
 * REVIEW exists precisely so those transitions are reachable. Without this clause the new
 * rule would steal them back, breaking the bug the review heuristic was written to fix.
 *
 * **Not gated to `In Progress`**, unlike the review heuristic. Plenty of schemes file
 * "Blocked" under To Do — a ticket nobody can start is not started — and that half is just
 * as wrong as the In-Progress half: dropping a card into IN PROGRESS transitioned the issue
 * to Blocked, and the sync then read Blocked's To Do category and snapped the card to TO DO.
 * `Done` is the one category excluded: a resolved ticket is not blocked, whatever the
 * workflow chose to call the resolution.
 */
export function isBlockedishStatus(rawStatus: string, category: JiraStatusCategory): boolean {
  return (
    category !== 'Done' && !isReviewishStatus(rawStatus, category) && hasBlockedName(rawStatus)
  );
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

  // **The map the app wrote itself may never speak for a blocked-ish name; the map the
  // human wrote always may.** The learned map is filled by a drag that "succeeded" — and
  // the bug is exactly that dragging a card into IN PROGRESS (or IN REVIEW) picked a
  // transition into Blocked and then remembered `{"Blocked": "in-progress"}` on the
  // authority of that drag. Every installation that hit the bug is carrying a poisoned
  // entry, and this refusal is what neutralises it in place: no migration, which would
  // have to GUESS the category the stored map does not carry, and no data destroyed —
  // the entry simply stops being consulted for a name that says blocked.
  const remembered = lookupStatusColumn(rawStatus, learned);
  if (remembered && !isBlockedishStatus(rawStatus, category)) {
    return { column: remembered, reason: 'learned' };
  }

  if (isReviewishStatus(rawStatus, category)) return { column: 'in-review', reason: 'heuristic' };

  // Between the review heuristic and the category fallback, and reusing `heuristic` rather
  // than adding a fifth reason: `STATUS_REASONS` is iterated as tier PRECEDENCE by
  // `pickTransition`, so a new entry would silently reorder that loop. The two heuristics
  // are one tier that differ in what they say, and the *label* is what becomes
  // column-aware.
  if (isBlockedishStatus(rawStatus, category)) return { column: 'blocked', reason: 'heuristic' };

  return { column: categoryToColumn(category), reason: 'category' };
}
