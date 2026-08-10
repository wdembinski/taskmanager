/**
 * Claiming the blocks that were already on the board, now that `preBlockStatus` says
 * **who owns a block** rather than merely where the card came from.
 *
 * The new rule (`jira/jiraSync.ts`) is that a sync preserves BLOCKED only when the block is
 * ours — `preBlockStatus != null` — because a block the tracker took arrives as a blocked
 * status every poll and needs no preserving. Everything the app wrote before that rule
 * existed disagrees on one point: `preBlockStatus` was only ever written by a **drag**, and
 * only for a JIRA card. A card blocked any other way — the demo seed, a hand-edited row, a
 * cloud move, a card blocked before the column even transitioned tickets — is resting at
 * `blocked` with a null marker, which the new rule reads as "the tracker is holding this",
 * and the very next sync would quietly unblock it.
 *
 * So every such card is claimed as ours. That is the safe direction and not merely the
 * conservative one: these blocks were *by construction* local — no drop into BLOCKED ever
 * transitioned a ticket before this change, so no tracker anywhere is standing behind them.
 *
 * `pending` is the column restored on un-block. The pre-drag value is not recoverable (it
 * was never stored), and TO DO is the one answer that is always true of a card nobody has
 * picked up again: it un-blocks into the leftmost column instead of claiming a history it
 * does not have.
 *
 * **It must run exactly once**, for the same reason as `projectTagMigration`: after this,
 * null means something — "the tracker owns this block" — and a second pass would overwrite
 * that on every card JIRA has legitimately blocked since. The caller guards it with an
 * `app_state` key; the predicate here is pure so it can be tested, which the store cannot be.
 */
import type { Task, TaskStatus } from '@shared/model';
import { restingStatus } from '@shared/board';

/**
 * What a claimed block restores to. See the note above on why the real column is not
 * recoverable and TO DO is the honest answer.
 */
export const CLAIMED_BLOCK_RESTORES_TO: TaskStatus = 'pending';

/**
 * Whether this card is a block written before `preBlockStatus` meant ownership.
 *
 * Read from where the card RESTS, exactly as the sync does: a blocked card whose agent is
 * mid-run has lent `status` to that run, and it is no less blocked for it — miss those and
 * the one sync that lands during a session unblocks the card.
 */
export function needsBlockOwner(task: Task): boolean {
  return restingStatus(task) === 'blocked' && (task.preBlockStatus ?? null) === null;
}

/** The `preBlockStatus` a task should carry after the back-fill. Unchanged for every other card. */
export function blockOwnerFor(task: Task): TaskStatus | null {
  return needsBlockOwner(task) ? CLAIMED_BLOCK_RESTORES_TO : (task.preBlockStatus ?? null);
}
