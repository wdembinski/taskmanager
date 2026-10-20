/**
 * The column move a **landed PR** makes — the one exception to "nothing else moves a card",
 * and only when the card's project asks for it ({@link Project.autoDoneOnLand}).
 *
 * The chain never needed this: successors start on `landedAt`, not on status. What it saves
 * is the human's last drag — a card whose PR merged sitting in IN PROGRESS until somebody
 * notices. So it is built to never fight that human:
 *
 *  - **It only moves a card nobody has touched since it landed.** `recordStatusChange` is
 *    written only by human moves, so a `status` activity row newer than `landedAt` means a
 *    person already put the card where they want it, and their move wins.
 *  - **It only moves a card with nothing left open.** A second PR still open on the card or
 *    one of its steps is work that has not landed yet.
 *  - **It writes the forge first, exactly as a drag does, and a failed write moves nothing.**
 *    A drag would not have moved it either. The board is warned once per card per app session;
 *    the next poll retries quietly.
 *  - **The card that moves is the OWNER.** A landed step moves the card it belongs to; a step
 *    is never a board card and is never moved itself.
 *
 * It runs on every merged report, not only the first stamp: once moved the card is Done and
 * the next call is a no-op, so repeating it is safe — and it is how a card whose second PR
 * merges later still gets moved.
 */
import { restingStatus } from '@shared/board';
import { mrRef, type MergeRequest } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry, TaskStatus } from '@shared/model';
import { humanStatusPatch } from './cardStatusGuard';

/** Why a landed card was left where it is. */
export type LandedDoneSkip =
  | 'setting-off'
  | 'step'
  | 'already-done'
  | 'archived'
  | 'open-pr-left'
  | 'human-moved'
  | 'not-landed';

/** The merged PR/MR the move names on the timeline. */
export type LandedMr = Pick<MergeRequest, 'provider' | 'number' | 'targetBranch'>;

/**
 * Whether a landed card moves to DONE — pure, so every guard is testable on its own.
 * The guards run in the order of the {@link LandedDoneSkip} they report.
 */
export function landedDoneDecision(input: {
  /** The OWNER, already resolved — see {@link moveLandedCardToDone}. */
  card: Task;
  project: Project | undefined;
  openPrTaskIds: ReadonlySet<string>;
  stepIds: readonly string[];
  /** A `status` activity row stamped after `card.landedAt`: a human moved it since. */
  movedAfterLand: boolean;
}): { move: true } | { move: false; reason: LandedDoneSkip } {
  const { card } = input;
  if (!input.project?.autoDoneOnLand) return { move: false, reason: 'setting-off' };
  if (card.parentTaskId) return { move: false, reason: 'step' };
  if (card.landedAt == null) return { move: false, reason: 'not-landed' };
  const resting = restingStatus(card);
  if (resting === 'done' || resting === 'cancelled') return { move: false, reason: 'already-done' };
  if (card.archivedAt != null) return { move: false, reason: 'archived' };
  if (input.openPrTaskIds.has(card.id) || input.stepIds.some((id) => input.openPrTaskIds.has(id)))
    return { move: false, reason: 'open-pr-left' };
  if (input.movedAfterLand) return { move: false, reason: 'human-moved' };
  return { move: true };
}

/** Everything the move needs from the world, so it can be exercised without Electron. */
export interface LandedDoneMoveDeps {
  getTask(id: string): Task | undefined;
  getProject(id: string): Project | undefined;
  getSubtasks(parentId: string): Task[];
  /** `openPrTaskIds(store.listMergeRequests())` */
  openPrTaskIds(): ReadonlySet<string>;
  activity(taskId: string): TaskActivityEntry[];
  /** resolveMove(card,'done') + writeMoveToForge + preBlockMarker, as a drag does; returns the extra patch. Throws on forge failure. */
  writeForgeMove(card: Task): Promise<Partial<Task>>;
  updateTask(id: string, patch: Partial<Task>): Task | undefined;
  recordStatusChange(projectId: string, id: string, from: TaskStatus, to: TaskStatus): void;
  addComment(projectId: string, id: string, body: string): void;
  /** `send('task:changed', { task, runId: null })` */
  emit(task: Task): void;
  /** `send('board:notice', { intent: 'warning', text })` */
  warn(text: string): void;
  /** `scheduler.dismissAttentionForCard`, as a drag into DONE does. */
  dismissAttention(taskId: string): void;
}

/**
 * The cards already warned about a failed forge write this app session — a poll repeats
 * "merged" every few minutes, and one warning per card is enough. Exported so tests can reset it.
 */
export const landedDoneWarned = new Set<string>();

/** What the moved card's timeline says, naming the PR as every other MR reference does. */
export function landedDoneNote(mr: LandedMr): string {
  return `Moved to Done: ${mrRef(mr)} merged into ${mr.targetBranch}.`;
}

function movedSince(entries: readonly TaskActivityEntry[], landedAt: number): boolean {
  return entries.some((e) => e.kind === 'status' && e.createdAt > landedAt);
}

/**
 * Move the owner of a landed card to DONE, if its project asks for it and nothing says no.
 *
 * Call on every merged report for `landedTaskId`. Returns the moved card, or null when
 * nothing moved.
 */
export async function moveLandedCardToDone(
  deps: LandedDoneMoveDeps,
  landedTaskId: string,
  mr: LandedMr,
): Promise<Task | null> {
  const landed = deps.getTask(landedTaskId);
  const card = landed?.parentTaskId ? deps.getTask(landed.parentTaskId) : landed;
  if (!card) return null;

  // The setting lives on the project the card's work runs in — the repo — as merge-on-green's does.
  const decision = landedDoneDecision({
    card,
    project: deps.getProject(card.agentProjectId ?? card.projectId),
    openPrTaskIds: deps.openPrTaskIds(),
    stepIds: deps.getSubtasks(card.id).map((s) => s.id),
    movedAfterLand: card.landedAt != null && movedSince(deps.activity(card.id), card.landedAt),
  });
  if (!decision.move) return null;

  let extra: Partial<Task>;
  try {
    extra = await deps.writeForgeMove(card);
  } catch (e) {
    if (!landedDoneWarned.has(card.id)) {
      landedDoneWarned.add(card.id);
      deps.warn(
        `${card.externalKey ?? card.title}: could not move the linked ticket to Done ` +
          `(${e instanceof Error ? e.message : String(e)}). The card stays where it is; ` +
          `the next sync tries again.`,
      );
    }
    return null;
  }

  // Re-read after the await: a human may have moved the card while the forge answered, and
  // their move wins.
  const fresh = deps.getTask(card.id) ?? card;
  const resting = restingStatus(fresh);
  if (resting === 'done' || resting === 'cancelled') return null;
  if (fresh.landedAt != null && movedSince(deps.activity(card.id), fresh.landedAt)) return null;

  const updated = deps.updateTask(card.id, { ...humanStatusPatch(fresh, 'done'), ...extra });
  if (!updated) return null;
  landedDoneWarned.delete(card.id);
  deps.recordStatusChange(card.projectId, card.id, resting, 'done');
  deps.addComment(card.projectId, card.id, landedDoneNote(mr));
  deps.emit(updated);
  deps.dismissAttention(card.id);
  return updated;
}

/** {@link LandedDoneMoveDeps}, plus the landing itself and somewhere to report a failed move. */
export interface LandThenMoveDeps extends LandedDoneMoveDeps {
  /** `scheduler.noteWorkLanded` — stamps `landedAt` and releases the chain. */
  noteWorkLanded(taskId: string): void;
  /** `logMain` — a failed move must not stop the sync that reported the merge. */
  logError(message: string, e: unknown): void;
}

/**
 * What both forge syncs do with a merged PR: stamp the landing (and release the chain),
 * THEN make the column move, never the other way round.
 *
 * The order is the point. The move to Done is not a human's, so it must never ask whether
 * to release the cards waiting on this one — and it never needs to, because by the time the
 * card reaches Done `landedAt` is already set, and a landed card holds nobody
 * (`@shared/releaseOnDone`'s `releasePrompt`). Kept in one function so neither call site can
 * reorder it. `mr` is undefined when the merged row is not filed under this card id, and
 * then only the landing happens.
 */
export async function landThenMoveToDone(
  deps: LandThenMoveDeps,
  taskId: string,
  mr: LandedMr | undefined,
): Promise<Task | null> {
  deps.noteWorkLanded(taskId);
  if (!mr) return null;
  try {
    return await moveLandedCardToDone(deps, taskId, mr);
  } catch (e) {
    deps.logError(`Moving landed card ${taskId} to Done failed`, e);
    return null;
  }
}
