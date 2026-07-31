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
 *   - only a drag, or the detail pane's dropdown, ever moves a card.
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
import { isBoardCard, isRunStatus } from '@shared/board';
import type { Task } from '@shared/model';

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
