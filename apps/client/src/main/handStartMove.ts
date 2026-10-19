/**
 * The column move a **human Start** makes — the hand-start mirror of the chain's
 * `ChainRunnerDeps.markInProgress`.
 *
 * When the APP starts a card (a chain release, a start on boot, a re-ask) it moves the card
 * to IN PROGRESS, and so does **assign + start** (`assignmentStatusPatch`). A plain Start
 * used not to, on the reasoning that the person pressing it had already chosen the column —
 * which left a card the agent was visibly working on sitting in TO DO. The rule is now one
 * sentence: **any start of a card resting in TO DO moves it to IN PROGRESS; nothing else
 * moves a card.** A card resting in IN REVIEW, DONE, BLOCKED — wherever a human filed it —
 * stays there, exactly as {@link assignmentMovesCard} already decides for assign.
 *
 * Three details are the whole design:
 *
 *  - **It runs only after a start SUCCEEDED.** A refused start (a usage limit that parked
 *    the card, a signed-out CLI, a run already in flight) moved no work, so it moves no
 *    column. The caller is what knows, which is why the helper is called rather than built
 *    into `Scheduler.startTaskNow` — that door is also the chain's, the automation runner's
 *    and assign's, and the forge write is async and lives in `ipc.ts`.
 *  - **The card that moves is the OWNER.** Run this step on a step moves the card the step
 *    belongs to; a step is never a board card and is never moved itself.
 *  - **A forge failure does not undo the start.** The run is already under way, so the
 *    linked ticket's transition is best-effort, as it is for assign: a warning on the board,
 *    and the local move still happens.
 *
 * The write goes through the real `humanStatusPatch`. The start has already borrowed
 * `status`, so the move lands in `preRunStatus` and the card comes back to IN PROGRESS when
 * the run settles — the same end state `markInProgress` reaches from the other side.
 */
import type { Task, TaskStatus } from '@shared/model';
import { assignmentMovesCard, humanStatusPatch } from './cardStatusGuard';

/** Everything the move needs from the world, so it can be exercised without Electron. */
export interface HandStartMoveDeps {
  getTask(id: string): Task | undefined;
  /** resolveMove + writeMoveToForge + preBlockMarker, as a drag does; returns the extra patch. Throws on forge failure. */
  writeForgeMove(card: Task): Promise<Partial<Task>>;
  updateTask(id: string, patch: Partial<Task>): Task | undefined;
  recordStatusChange(projectId: string, id: string, from: TaskStatus, to: TaskStatus): void;
  addComment(projectId: string, id: string, body: string): void;
  /** `send('task:changed', { task, runId: null })` */
  emit(task: Task): void;
  /** `send('board:notice', { intent: 'warning', text })` */
  warn(text: string): void;
}

/** What the moved card's timeline says — once, because the move happens once. */
export const HAND_START_NOTE = 'Started by hand — moved to In Progress.';

/**
 * Move the card behind a successful human start to IN PROGRESS, if it rests in TO DO.
 *
 * Call ONLY after a start succeeded. Returns the moved card, or null when nothing moved.
 */
export async function moveHandStartedCard(
  deps: HandStartMoveDeps,
  startedId: string,
): Promise<Task | null> {
  const started = deps.getTask(startedId);
  const card = started?.parentTaskId ? deps.getTask(started.parentTaskId) : started;
  if (!card || !assignmentMovesCard(card, true)) return null;

  let extra: Partial<Task>;
  try {
    extra = await deps.writeForgeMove(card);
  } catch (e) {
    deps.warn(
      `${card.externalKey ?? card.title}: could not move the linked ticket to In Progress ` +
        `(${e instanceof Error ? e.message : String(e)}). The run started anyway.`,
    );
    extra = {};
  }

  // Re-read after the await: the run may have moved on in the meantime, and the patch must
  // be computed against the `status` it borrows NOW, or it could land in the wrong field.
  const fresh = deps.getTask(card.id) ?? card;
  const updated = deps.updateTask(card.id, {
    ...humanStatusPatch(fresh, 'in-progress'),
    ...extra,
  });
  if (!updated) return null;
  deps.recordStatusChange(card.projectId, card.id, 'pending', 'in-progress');
  deps.addComment(card.projectId, card.id, HAND_START_NOTE);
  deps.emit(updated);
  return updated;
}
