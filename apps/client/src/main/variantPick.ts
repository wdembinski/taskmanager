/**
 * Assembles `variants:pick` (F10.6): keep one variant row and discard the rest — stop the
 * losers, remove their worktrees, delete their branches, archive them `'variant-discarded'`,
 * and point the leader's `pickedVariantId` at the winner.
 *
 * Kept off `ipc.ts` so it is testable (memory *headless-scenario-harness-traps*): `ipc.ts`
 * wires `VariantPickDeps` to the real store, `Scheduler` and `WorktreeManager`; a test wires
 * fakes, or a real `WorktreeManager` over a scratch git repo, instead.
 */
import { hasRepo, type Project, type Task, type TaskArchiveReason } from '@shared/model';
import { pickNote, planVariantPick, VARIANT_PICK_REFUSAL_MESSAGE } from '@shared/variants';
import { taskBranch } from './worktreeManager';

export interface VariantPickDeps {
  getTask(id: string): Task | undefined;
  getProject(id: string): Project | undefined;
  /** The leader's live rows — `store.listVariantRows(leaderId)`. */
  listVariantRows(leaderId: string): Task[];
  /** `Scheduler.discardVariantRow` — stops a live loser and drops it from the variant queue. */
  discardVariantRow(id: string): void;
  /** `WorktreeManager.cleanup` — removes every worktree slot the row used; never throws. */
  cleanup(project: Project, taskId: string): Promise<string[]>;
  /** `WorktreeManager.deleteTaskBranch` — a no-op (undefined) when the branch is already gone. */
  deleteTaskBranch(project: Project, branch: string): Promise<string | undefined>;
  archiveTask(id: string, at: number, reason: TaskArchiveReason): void;
  updateTask(id: string, patch: Partial<Pick<Task, 'pickedVariantId'>>): Task | undefined;
  addComment(projectId: string, taskId: string, body: string): void;
}

/**
 * Where a row's worktree/branch actually live — the same resolution as
 * `Scheduler.runProjectFor` (also duplicated in `DiffService`): the agent project if it still
 * has a repo, else the row's own.
 */
function projectFor(deps: VariantPickDeps, row: Task): Project | undefined {
  if (row.agentProjectId) {
    const agentProject = deps.getProject(row.agentProjectId);
    if (agentProject && hasRepo(agentProject)) return agentProject;
  }
  return deps.getProject(row.projectId);
}

/**
 * Keep `variantId` and discard `leaderId`'s other live rows. Resolves with the leader —
 * unchanged on a same-id re-pick (no cleanup runs, no new note), or with `pickedVariantId`
 * freshly set once the losers are gone. Throws {@link VARIANT_PICK_REFUSAL_MESSAGE}'s sentence
 * for an unknown leader/row, a leader that already picked a DIFFERENT row, or a leader whose
 * pick already merged — see {@link planVariantPick} for the exact rules.
 *
 * A loser's worktree failing to delete is logged on the leader's timeline, never fatal — the
 * same "report, don't retry into a failure" rule `WorktreeManager` already applies to a
 * successful merge's own cleanup.
 */
export async function pickVariant(
  deps: VariantPickDeps,
  leaderId: string,
  variantId: string,
): Promise<Task> {
  const leader = deps.getTask(leaderId);
  if (!leader) throw new Error(VARIANT_PICK_REFUSAL_MESSAGE['unknown-task']);

  const rows = deps.listVariantRows(leaderId);
  const plan = planVariantPick(leader, rows, variantId);
  if ('refused' in plan) throw new Error(VARIANT_PICK_REFUSAL_MESSAGE[plan.refused]);
  if ('noop' in plan) return leader;

  const { winner, losers } = plan;
  const winnerBranch = winner.agentBranch?.trim() || taskBranch(winner.id);
  const failures: string[] = [];

  for (const loser of losers) {
    deps.discardVariantRow(loser.id);
    const project = projectFor(deps, loser);
    if (project) {
      failures.push(...(await deps.cleanup(project, loser.id)));
      const loserBranch = loser.agentBranch?.trim() || taskBranch(loser.id);
      if (loserBranch !== winnerBranch) {
        const failure = await deps.deleteTaskBranch(project, loserBranch);
        if (failure) failures.push(failure);
      }
    }
    deps.archiveTask(loser.id, Date.now(), 'variant-discarded');
  }

  const updated = deps.updateTask(leader.id, { pickedVariantId: winner.id });
  deps.addComment(leader.projectId, leader.id, pickNote(winner, rows.length));
  if (failures.length > 0) {
    deps.addComment(
      leader.projectId,
      leader.id,
      `Cleaning up the discarded variants left something behind: ${failures.join(' ')}`,
    );
  }
  return updated ?? { ...leader, pickedVariantId: winner.id };
}
