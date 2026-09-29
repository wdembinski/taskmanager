/**
 * The rule that keeps a card's state the human's: **an agent run never moves a card.**
 *
 * A run's own lifecycle lives in the very field the board reads — `Task.status` — because
 * the whole engine is written against it (`running` gates the drag, `waiting-input` draws
 * the orange ring, `blocked-by-limit` parks the queue). So the two cannot simply be split
 * apart. Instead the run BORROWS the field and this guard remembers what it borrowed it
 * from, in `preRunStatus`; the board reads the remembered one (`restingStatus`), and the
 * card goes back to it the moment the run is over.
 *
 * The upshot, from the board's side:
 *
 *   - a card left in TO DO stays in TO DO while its agent works, and after it finishes;
 *   - a run that finishes, fails, is stopped or is retried changes no column;
 *   - a drag, the detail pane's dropdown, or starting an agent on a TO DO card ({@link
 *     assignmentMovesCard}) are the only things that ever move a card.
 *
 * The rule has a second half, {@link humanStatusPatch}: because the run only BORROWED the
 * field, the human can still move the card while the run holds it — the move is written to
 * the parked value instead. Every function here is deliberately scoped by the same
 * `isBoardCard` predicate, so whatever the guard protects is exactly what a human move (a
 * drag, a dropdown pick, or delegating a TO DO card to an agent) parks.
 *
 * Every status write the scheduler makes goes through here (see `Scheduler.updateTask`),
 * which is the point: there are some thirty of them and a rule enforced at each would
 * have been a rule with holes.
 *
 * `isBoardCard` is what scopes it. A plan project's tasks are a queue where
 * `pending → running → done` IS the product, and a step of an approved plan must still
 * reach `done` or its chain cannot advance — neither is a card anybody drags, and both
 * pass through untouched.
 */
import { isBoardCard, isRunStatus, restingStatus } from '@shared/board';
import type { Task, TaskStatus } from '@shared/model';

/** The subset of a task the scheduler patches. */
export type SchedulerPatch = Partial<
  Pick<Task, 'status' | 'sessionId' | 'agentPlan' | 'preRunStatus'>
>;

/**
 * Rewrite one scheduler patch so it cannot change a board card's state.
 *
 * Three cases, given the task as it is now (`before`):
 *
 *  1. **Not a status write, or not a board card** — passed through verbatim.
 *  2. **Entering a run** (`patch.status` is a run status). Allowed: the run needs the
 *     field. The human's status is captured into `preRunStatus` on the way in — but only
 *     on the FIRST such write, so `running → waiting-input → running` doesn't overwrite
 *     the memory with a run status.
 *  3. **Anything else** — the scheduler proposing a resting status (`in-progress` when a
 *     run settles, `done`, `failed`, `stopped`, `pending` for a retry). Refused: the card
 *     goes to the remembered status instead, and the memory is released.
 *
 * Case 3 covers the write that has no run behind it at all — a card whose chain starts is
 * pushed to `in-progress` with nothing borrowed yet, and `before.status` (what the human
 * chose) is then the right answer too.
 */
export function guardCardStatus(before: Task, patch: SchedulerPatch): SchedulerPatch {
  if (patch.status === undefined || !isBoardCard(before)) return patch;

  if (isRunStatus(patch.status)) {
    if (isRunStatus(before.status)) return patch; // already borrowed; keep the memory
    return { ...patch, preRunStatus: before.status };
  }

  return {
    ...patch,
    // `before.status` when nothing was borrowed. The `pending` fallback is for the one
    // case that cannot happen through this guard but could through a hand-edited row: a
    // run status with no memory behind it, where the alternative is leaving the card
    // wedged mid-run forever.
    status: before.preRunStatus ?? (isRunStatus(before.status) ? 'pending' : before.status),
    preRunStatus: null,
  };
}

/**
 * Where to write a status the HUMAN chose — the other half of the borrowing rule.
 *
 * Straight into `status`, unless a run has borrowed that field, and then into
 * `preRunStatus`: the value the run will be given back when it settles. So moving a card
 * mid-run neither kills the run nor gets quietly undone the moment it ends — the card
 * lands in the column you dropped it in and stays there.
 *
 * That is the whole reason a live run no longer blocks a move. The two states cannot
 * collide because they are two different fields: the run keeps saying `running` (spinner,
 * attention ring, chat target), while the board reads `restingStatus` and shows the card
 * where you put it. The run is left running on purpose — moving a card says where the work
 * belongs, not that it should stop; stopping is what the Stop button is for.
 *
 * Scoped by `isBoardCard` for the same reason {@link guardCardStatus} is: on anything else
 * nothing ever releases `preRunStatus`, so parking a status there would strand it.
 */
export function humanStatusPatch(task: Task, status: TaskStatus): SchedulerPatch {
  return isBoardCard(task) && isRunStatus(task.status) ? { preRunStatus: status } : { status };
}

/**
 * Whether **wiring an agent onto a task and starting it** is allowed to move the card to
 * IN PROGRESS.
 *
 * Only a board card, only when the assignment is starting the agent (not just staging it —
 * see the `start: false` branch of `task:assignAgent`), and only when the card rests in
 * TO DO. "Rests in TO DO" is `restingStatus(task) === 'pending'`, plus the one case a card can
 * rest nowhere at all: a run status with nothing remembered behind it (`preRunStatus` unset),
 * which is the field-borrowed-before-this-guard-existed state the rest of this module treats
 * as honestly `pending` (see {@link restingStatus}).
 *
 * A card resting anywhere else — IN REVIEW, BLOCKED, DONE, whatever a human filed it under —
 * is left there: starting an agent on it says who does the work, not that the work has moved
 * to a different column.
 */
export function assignmentMovesCard(task: Task, starting: boolean): boolean {
  if (!starting || !isBoardCard(task)) return false;
  const resting = restingStatus(task);
  return resting === 'pending' || isRunStatus(resting);
}

/**
 * The status write **wiring an agent onto a task** is allowed to make.
 *
 * Assigning an agent (`task:assignAgent`) or attaching a session (`task:attachSession`) says
 * who will do the work. On its own that says nothing about which column the work belongs in,
 * and the column is the human's: a ticket resting in IN REVIEW that you hand to an agent is
 * still in review, and one you had filed under BLOCKED does not become un-blocked by being
 * delegated. Both handlers used to write `status: 'pending'` unconditionally, which yanked the
 * card back to TO DO — the same thing {@link guardCardStatus} exists to stop a run doing, just
 * through a door the guard does not watch, because these are the human's writes and not the
 * scheduler's.
 *
 * The one case that IS a move: assigning an agent that starts immediately, on a card that
 * rests in TO DO. "Assign an agent and start it" on a TO DO card is the human saying the work
 * has begun, the same as dragging it to IN PROGRESS by hand — see {@link assignmentMovesCard}.
 * That write, like every other human write, goes through {@link humanStatusPatch}, so a run
 * already live on the card (mid re-assignment) gets the move parked in `preRunStatus` rather
 * than overwritten.
 *
 * Outside that one case, a board card resting somewhere is left exactly there. Off the board
 * the write survives unchanged, and deliberately: a plan project's task and a step of a chain
 * are a queue whose `pending` means "runnable", which is exactly what re-wiring one is asking
 * for, `starting` or not.
 */
export function assignmentStatusPatch(task: Task, starting = false): SchedulerPatch {
  if (assignmentMovesCard(task, starting)) return humanStatusPatch(task, 'in-progress');
  if (isBoardCard(task) && !isRunStatus(restingStatus(task))) return {};
  return humanStatusPatch(task, 'pending');
}
