/**
 * The sprint the board is showing, if it is showing exactly one.
 *
 * With the "Current sprint" filter on, every card carries the same chip, so the chip
 * stops distinguishing anything and becomes the same word repeated down the column. The
 * name belongs in the status bar instead — said once, for the whole board.
 *
 * The interesting case is the one that makes this a function rather than
 * `tasks[0].externalSprint`: a card left over from a sprint that has just closed, or a
 * JQL that spans two boards. Then the cards disagree, and the bar must say NOTHING
 * rather than pick one — a status bar naming a sprint the board isn't actually showing
 * is worse than a status bar saying nothing.
 *
 * Pure, so that rule is testable.
 */
import type { Task } from '@tm/shared/model';

/**
 * The single sprint name shared by every JIRA card on the board, or null when there
 * are none, when some card has no sprint, or when they disagree.
 *
 * Non-JIRA cards are ignored: an ad-hoc card on the personal board has no sprint and
 * never will, so letting it veto the name would mean the bar cleared itself the moment
 * you added a note to yourself. A GitHub card is the same case and is skipped for the same
 * reason — a sprint is a JIRA Software field, and GitHub has nothing that means it.
 */
export function currentSprintName(tasks: readonly Task[]): string | null {
  let name: string | null = null;
  for (const task of tasks) {
    if (task.externalSource !== 'jira') continue;
    const sprint = task.externalSprint?.trim();
    // A JIRA card with no sprint is a disagreement too — it is on the board and it is
    // not in the sprint we were about to name.
    if (!sprint) return null;
    if (name === null) name = sprint;
    else if (name !== sprint) return null;
  }
  return name;
}
