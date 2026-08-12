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
 *
 * {@link resolveGitHubColumn} is the same contract for GitHub issues, which have no workflow
 * at all: the sync and the drag both call it, for the same reason and against the same
 * failure. It is a separate function rather than a flag because what there is to resolve is
 * genuinely different — see its own docstring.
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

/** Which board column a GitHub issue lands in, which label said so, and which tier decided. */
export interface GitHubColumnResolution extends StatusResolution {
  /**
   * The label that decided the column, or null when the issue's own open/closed state did.
   *
   * Carried out of the resolver rather than re-derived by the caller because it is what the
   * card's `externalStatus` shows: "the thing this board is calling the issue's status".
   */
  label: string | null;
}

/**
 * Resolve a GitHub issue to a board column, and say which tier decided.
 *
 * The same discipline as {@link resolveStatusColumn} and for the reason this file's header
 * gives — one resolver, called by both the sync and the move, so a drag and the poll that
 * follows it cannot disagree forever. What differs is what there is to resolve. A JIRA issue
 * has a workflow status, one value, and the map's keys ARE those values. A GitHub issue has
 * two independent things: it is open or closed, and it wears labels. Everything between "not
 * started" and "finished" is a convention the repository invented, which is almost always a
 * label — so the map is the *only* way a GitHub issue reaches IN PROGRESS, IN REVIEW or
 * BLOCKED at all.
 *
 * **`closed ⇒ done` is asked first, and it wins.** That is the one place this departs from
 * the JIRA resolver's precedence, and the orthogonality above is why: a JIRA status cannot
 * be both "Done" and "In Review", but a GitHub issue is very often closed while still
 * wearing the `in review` label somebody added a week ago — nothing removes a label when you
 * close an issue. Letting a stale label outrank the close would leave a card the human
 * finished on github.com sitting in IN REVIEW forever, and would undo a drag into DONE on
 * the very next poll. Labels decide among OPEN issues, which is the only place they are
 * ambiguous, and there the user's map beats the one the app taught itself, exactly as on
 * JIRA.
 *
 * The tiers, in precedence order:
 *
 *   `category`  the issue is closed ⇒ DONE.
 *   `explicit`  the first label the user mapped in Settings.
 *   `learned`   the first label the app mapped itself, after a drag applied it.
 *   `category`  nothing said otherwise; the issue is open ⇒ TO DO.
 *
 * Reusing `category` for the state tier rather than inventing a fifth {@link StatusReason}
 * is deliberate: `STATUS_REASONS` is iterated as tier PRECEDENCE by the JIRA transition
 * picker, so a new member would silently reorder that loop. `heuristic` is simply never
 * returned here — GitHub has no status names to read.
 *
 * Labels are matched case-insensitively, the same as every other map in this file, and in
 * the issue's own label order so that a repository with two mapped labels on one issue gets
 * a stable answer rather than one that depends on `Object.keys`.
 */
export function resolveGitHubColumn(
  labels: readonly string[],
  state: string,
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): GitHubColumnResolution {
  // Anything that is not literally `open` is closed. GitHub only has the two, and reading
  // an unexpected third as "open" would park a finished issue in TO DO — the direction that
  // hides work rather than the one that shows it.
  if (state !== 'open') return { column: 'done', reason: 'category', label: null };

  for (const label of labels) {
    const explicit = lookupStatusColumn(label, map);
    if (explicit) return { column: explicit, reason: 'explicit', label };
  }
  for (const label of labels) {
    const remembered = lookupStatusColumn(label, learned);
    if (remembered) return { column: remembered, reason: 'learned', label };
  }
  return { column: 'todo', reason: 'category', label: null };
}

/**
 * The label a mapped GitHub issue is NOT already spending on its column — the first one the
 * maps say nothing about, which is what the card shows as its chip.
 *
 * Showing the deciding label there would draw the same fact twice: the column the card sits
 * in already says "in review", so a chip repeating it is a wasted line on the board's
 * narrowest surface.
 */
export function firstUnmappedLabel(
  labels: readonly string[],
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): string | null {
  for (const label of labels) {
    if (lookupStatusColumn(label, map) || lookupStatusColumn(label, learned)) continue;
    return label;
  }
  return null;
}
