/**
 * Board column view helpers for the My Tasks Kanban. The pure status↔column↔category
 * mapping lives in `@tm/shared/board` (shared with the main process); this module adds
 * the renderer-only concerns: display metadata and the "Show Done" toggle.
 */
import type { BoardColumn, Task, TaskStatus } from '@tm/shared/model';
import type { RunState } from '@tm/shared/board';
import {
  chainNeedsAttention,
  columnForStatus,
  columnForTask,
  restingStatus,
  statusForColumn,
} from '@tm/shared/board';
import { priorityRank } from '@tm/shared/priority';
import type { MergeRequest } from '@tm/shared/mergeRequest';

export type { BoardColumn } from '@tm/shared/model';
export {
  categoryFromKey,
  categoryToColumn,
  columnForStatus,
  columnForTask,
  isRunStatus,
  statusForColumn,
} from '@tm/shared/board';

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

/**
 * The status worth badging on a card, or null when the column already says it.
 *
 * Measured against the column the card is actually IN (`columnForTask`), not against the
 * one its raw status would imply. Those two part company the moment a run borrows the
 * status: a card sitting in TO DO with a live agent is `running`, and the badge is then
 * the card's own way of saying so — without the card going anywhere.
 *
 * The `run` fallback covers the card whose STEP is the thing parked: a chain held behind
 * the usage-limit gate leaves the parent `in-progress` in IN PROGRESS, so the rule above
 * has nothing to say and the card looked exactly like one merely working. Taken from
 * {@link runPhase} rather than from a second predicate of its own — `phase: 'blocked'` is
 * returned from the two usage-limit branches and nowhere else, and one answer to "what is
 * this card doing" is the whole reason that helper exists. A parallel test here is how the
 * card and the detail pane start disagreeing.
 *
 * `blocked` never spins, so the badge clears the card's `!run.spinner` guard — which is
 * right: a running card's badge would only repeat the label, but a paused one has no label
 * to repeat.
 */
export function cardBadgeStatus(task: Task, run: RunState): TaskStatus | null {
  const canonical = statusForColumn(columnForTask(task));
  const secondary = task.status === canonical ? null : task.status;
  return secondary ?? (run.phase === 'blocked' ? 'blocked-by-limit' : null);
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
 * What the DONE column is holding while it is closed: how many cards are in it, and how
 * many of those the human never actually marked done (`failed`, `stopped`, `cancelled`).
 *
 * This exists because "Show Done" is off by default, so the one column a card can arrive in
 * without anybody dragging it there is also the column nobody is looking at — a card that
 * fails, or whose JIRA status maps into DONE, simply stops existing as far as the board
 * says. The count is the whole fix. The toggle still hides the column: a board that opens
 * its own columns cannot be reasoned about, and the complaint was never "the column was
 * closed", it was "nothing anywhere told me the cards were there". A numeral answers that
 * completely, and costs no colour — colour is for things that move, and a closed card is
 * the least-moving thing on the board.
 *
 * `notMarkedDone` is counted apart because those are the ones worth a second look:
 * "finished" and "gave up" land in the same column, and a card that failed is far more
 * likely to be the one you are hunting for.
 *
 * Reads {@link restingStatus}, like everything else that asks where a card sits — a card
 * whose agent is running this second, parked over the `cancelled` its human left it in,
 * is in the DONE column and is just as hidden as the rest.
 */
export function hiddenDoneSummary(cards: readonly BoardCard[]): {
  total: number;
  notMarkedDone: number;
} {
  let total = 0;
  let notMarkedDone = 0;
  for (const card of cards) {
    const status = restingStatus(card.task);
    if (columnForStatus(status) !== 'done') continue;
    total += 1;
    if (status !== 'done') notMarkedDone += 1;
  }
  return { total, notMarkedDone };
}

/**
 * The card chain focus should be drawn around, for whatever the user has SELECTED — the
 * selection itself when it is a card, and its **parent** when it is a step.
 *
 * The anchor is the fix for a board that emptied itself: open a step in the detail pane
 * (clicking one selects the step, not the card it lives in), turn Chain focus on, and the
 * component was computed for an id no card on the board has. Steps are never chained —
 * `canLink` refuses one at either end — so the component came back as that step alone, and
 * `focusCards` matched nothing: every card gone, including the one you were reading.
 *
 * Fixed here rather than in {@link focusCards}, which is right to test card ids and only
 * card ids: a card's steps travel with it, so admitting step ids to the filter would be
 * the wrong repair. It is the ANCHOR that was wrong. A step's chain is its parent's chain,
 * because that is the only thing a step's work is ever part of.
 *
 * An orphaned step — parent not on this board — anchors to itself, matching
 * {@link groupSubtasks}, which promotes exactly those steps to cards of their own. Null
 * for nothing selected and for an id the board doesn't have (a deleted card can still be
 * the selection), which reads through focus as "no filter" rather than as an empty board.
 */
export function focusAnchorId(
  tasks: readonly Task[],
  selectedTaskId: string | null,
): string | null {
  if (!selectedTaskId) return null;
  const selected = tasks.find((t) => t.id === selectedTaskId);
  if (!selected) return null;
  const parentId = selected.parentTaskId;
  if (!parentId) return selected.id;
  return tasks.some((t) => t.id === parentId) ? parentId : selected.id;
}

/**
 * Chain focus mode: the cards the board shows when it is narrowed to one chain.
 *
 * `focusIds` is the chain's component (see `chainComponent`) or **null** for "show
 * everything" — null rather than a set of every id on the board, so the ordinary case is a
 * no-op and focus with nothing selected reads as no filter rather than as an empty board.
 *
 * The test is the CARD's id, never a step's. A card's steps are not cards of their own —
 * they render inside the parent and travel with it — and a step can never be chained
 * (`canLink` refuses one at either end), so a card whose step id somehow appeared in the
 * set would still be the wrong thing to keep, and filtering the steps themselves would
 * empty a card of its work.
 *
 * Which is exactly why a selected STEP has to be resolved to its parent BEFORE the
 * component is built, and not rescued here: see {@link focusAnchorId}. Take the anchor
 * from the raw selection instead and focus hands this function a component of one step id,
 * it correctly matches no card, and the board goes blank.
 */
export function focusCards(
  cards: readonly BoardCard[],
  focusIds: ReadonlySet<string> | null,
): BoardCard[] {
  if (!focusIds) return [...cards];
  return cards.filter((card) => focusIds.has(card.task.id));
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
 * lying if the two disagreed. That is also why `attentionTaskIds` has to be threaded
 * through here and not just to the card: pass it to one and not the other and the ring
 * and the ordering start disagreeing again.
 */
export function sortCards(
  cards: readonly BoardCard[],
  attentionTaskIds?: ReadonlySet<string>,
): BoardCard[] {
  return [...cards].sort((a, b) => {
    const attention =
      Number(chainNeedsAttention(b.task, b.subtasks, b.mergeRequests, attentionTaskIds)) -
      Number(chainNeedsAttention(a.task, a.subtasks, a.mergeRequests, attentionTaskIds));
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

/** One step, with the place it holds in its card's WHOLE chain. */
export interface StepEntry {
  step: Task;
  /** 0-based, across every round — see {@link groupStepsByRound}. */
  index: number;
}

/** One planning round's steps, with the index each holds in the card's whole chain. */
export interface StepRound {
  round: number;
  steps: StepEntry[];
}

/**
 * Split a chain into its planning rounds, in order (Phase 18).
 *
 * The chain itself stays one sequence — `index` is the step's position across the WHOLE
 * card, so the numbering the human reads never restarts and never disagrees with the
 * card's `3/7` counter. Rounds only decide what can be folded away.
 *
 * Steps that predate re-planning carry no round at all, which `rowToTask` already reads
 * as round 1; the `?? 1` here is the same answer for a task that never went through it.
 *
 * Lives here rather than beside the detail pane that first needed it because the CARD now
 * groups by round too (it folds the earlier rounds away), and one rule read two ways is how
 * the pane and the card end up disagreeing about where a bunch of steps begins.
 */
export function groupStepsByRound(subtasks: readonly Task[]): StepRound[] {
  const rounds: StepRound[] = [];
  subtasks.forEach((step, index) => {
    const round = step.planRound ?? 1;
    const last = rounds[rounds.length - 1];
    // Grouped by ADJACENCY, not by collecting equal round numbers: steps are appended in
    // round order, and a list that reordered them would put the chain's numbering out of
    // step with the order it actually runs in.
    if (last && last.round === round) last.steps.push({ step, index });
    else rounds.push({ round, steps: [{ step, index }] });
  });
  return rounds;
}

/**
 * A chain cut into **what came before** and **the newest bunch** — the split the card's
 * automatic partial fold is drawn from.
 *
 * The boundary is the last planning round, because that is what "new steps arrived" means
 * in the data: approving a plan files its steps under a round of their own, while a step
 * typed by hand joins the round already in progress (`store.addSubtask`), which is right —
 * a step written among the bunch you are watching belongs with it and must not fold the
 * bunch away.
 *
 * A card that has only ever been planned once has no earlier steps at all, so nothing is
 * hidden from it: the fold only ever appears on a card that has actually been re-planned.
 */
export function splitEarlierSteps(subtasks: readonly Task[]): {
  earlier: StepEntry[];
  latest: StepEntry[];
} {
  const rounds = groupStepsByRound(subtasks);
  if (rounds.length < 2) return { earlier: [], latest: rounds[0]?.steps ?? [] };
  return {
    earlier: rounds.slice(0, -1).flatMap((r) => r.steps),
    latest: rounds[rounds.length - 1].steps,
  };
}

/**
 * A step's 1-based position among its siblings ("step 2 of 5"), or null when the
 * task isn't in the list — an orphan, or an ordinary card.
 */
export function stepPosition(subtasks: readonly Task[], taskId: string): number | null {
  const index = subtasks.findIndex((s) => s.id === taskId);
  return index < 0 ? null : index + 1;
}
