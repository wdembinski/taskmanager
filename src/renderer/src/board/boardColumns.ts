/**
 * Board column view helpers for the My Tasks Kanban. The pure status↔column↔category
 * mapping lives in `@shared/board` (shared with the main process); this module adds
 * the renderer-only concerns: display metadata and the "Show Done" toggle.
 */
import type { BoardColumn, Task } from '@shared/model';
import { chainNeedsAttention } from '@shared/board';
import { priorityRank } from '@shared/priority';
import type { MergeRequest } from '@shared/mergeRequest';

export type { BoardColumn } from '@shared/model';
export {
  categoryFromKey,
  categoryToColumn,
  columnForStatus,
  columnForTask,
  statusForColumn,
} from '@shared/board';

/** Display metadata for each column, in left-to-right board order. */
export const COLUMN_META: ReadonlyArray<{ column: BoardColumn; label: string; order: number }> = [
  { column: 'todo', label: 'TO DO', order: 0 },
  { column: 'in-progress', label: 'IN PROGRESS', order: 1 },
  { column: 'in-review', label: 'IN REVIEW', order: 2 },
  { column: 'blocked', label: 'BLOCKED', order: 3 },
  { column: 'done', label: 'DONE', order: 4 },
];

/** The columns to render, honoring the "Show Done" toggle. */
export function visibleColumns(showDone: boolean): BoardColumn[] {
  return COLUMN_META.filter((c) => showDone || c.column !== 'done').map((c) => c.column);
}

/** A card as the board renders it: the card itself plus the steps that travel with it. */
export interface BoardCard {
  task: Task;
  /** This card's subtasks in execution order; empty for an ordinary card. */
  subtasks: Task[];
  /**
   * The merge requests filed under this card. Carried on the CARD rather than the task
   * because `issueToTask` rebuilds the whole task literal on every JIRA sync, so an
   * array hung there would be clobbered on every poll.
   */
  mergeRequests: MergeRequest[];
}

/**
 * Split a board's flat task list into cards-with-their-steps.
 *
 * A subtask lives on the same board as its parent, but it is never a card of its own:
 * whatever its own status, it renders inside the parent's card, so a card's steps always
 * travel with the card between columns. Steps are ordered by `order` (the sequence the
 * runner executes them in). A step whose parent isn't on this board is orphaned — it is
 * promoted to a top-level card rather than dropped, so it can never become invisible.
 */
export function groupSubtasks(
  tasks: readonly Task[],
  mrsByTask: ReadonlyMap<string, MergeRequest[]> = new Map(),
): BoardCard[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    const parentId = task.parentTaskId;
    if (!parentId || !ids.has(parentId)) continue;
    const list = children.get(parentId);
    if (list) list.push(task);
    else children.set(parentId, [task]);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  return tasks
    .filter((t) => !t.parentTaskId || !ids.has(t.parentTaskId))
    .map((task) => ({
      task,
      subtasks: children.get(task.id) ?? [],
      mergeRequests: mrsByTask.get(task.id) ?? [],
    }));
}

/**
 * The order cards sit in within a column:
 *
 *   1. **cards that want you** — an unread ticket comment, this card's agent parked on
 *      a question, or a step that has failed/stopped the chain. These outrank even the
 *      top-priority card, because a card that is waiting on you is costing time right
 *      now while a high-priority card is only *going* to;
 *   2. then **priority**, most urgent first (unprioritised sinks to the bottom);
 *   3. then `order`, which is where the card sat before any of this existed — a stable
 *      tiebreak, so cards of equal rank never shuffle between renders.
 *
 * "Wants you" is deliberately `chainNeedsAttention`, the same predicate that draws the
 * card's orange ring, so the loudest card is always the top one — the board would be
 * lying if the two disagreed.
 */
export function sortCards(cards: readonly BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => {
    const attention =
      Number(chainNeedsAttention(b.task, b.subtasks, b.mergeRequests)) -
      Number(chainNeedsAttention(a.task, a.subtasks, a.mergeRequests));
    if (attention !== 0) return attention;
    const priority = priorityRank(b.task.externalPriority) - priorityRank(a.task.externalPriority);
    if (priority !== 0) return priority;
    return a.task.order - b.task.order;
  });
}

/**
 * A card's step progress, for the "3/6" caption — done steps over total. `failed`,
 * `stopped` and `cancelled` steps are NOT counted as done: the chain stopped there,
 * and the caption should show the work that actually landed.
 */
export function subtaskProgress(subtasks: readonly Task[]): { done: number; total: number } {
  return {
    done: subtasks.filter((s) => s.status === 'done').length,
    total: subtasks.length,
  };
}

/**
 * Is a step of this card mid-run? A card whose chain is live must not be dragged to
 * another column: the steps travel with it, and the runner owns their statuses until
 * the chain stops. (The parent's own status is checked separately — it reads
 * `in-progress` while a step runs, which on its own says nothing.)
 */
export function hasLiveSubtask(subtasks: readonly Task[]): boolean {
  return subtasks.some((s) => s.status === 'running' || s.status === 'waiting-input');
}

/**
 * A step's 1-based position among its siblings ("step 2 of 5"), or null when the
 * task isn't in the list — an orphan, or an ordinary card.
 */
export function stepPosition(subtasks: readonly Task[], taskId: string): number | null {
  const index = subtasks.findIndex((s) => s.id === taskId);
  return index < 0 ? null : index + 1;
}
