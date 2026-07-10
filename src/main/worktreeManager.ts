/**
 * Worktree manager (team-orchestrator feature).
 *
 * Gives each task its own **git worktree on its own branch** so parallel agents
 * never share a working tree, then integrates a finished branch back into the base
 * (rebase onto latest base → fast-forward merge → remove the worktree). All git
 * sequencing lives here so `scheduler.ts` only deals in high-level results.
 *
 * Integration is **serialized per project** (a promise chain) so two tasks that
 * finish together can't race each other into the base branch.
 *
 * Non-git projects (or projects with worktrees disabled) transparently fall back to
 * the shared-directory behavior, which keeps existing setups working unchanged.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task } from '@shared/model';
import {
  abortRebase,
  addWorktree,
  commitAll,
  continueRebase,
  currentBranch,
  deleteBranch,
  hasConflicts,
  isClean,
  isRepo,
  mergeFfOnly,
  rebaseOnto,
  removeWorktree,
} from './git';

/** Where a task's agent should run, and (in worktree mode) how to integrate it. */
export interface WorktreePrep {
  mode: 'worktree' | 'shared';
  /** The working directory to run the agent in. */
  cwd: string;
  /** The task's branch (worktree mode only). */
  branch?: string;
  /** The base branch to integrate the task's branch back into (worktree mode only). */
  base?: string;
}

/** The outcome of integrating a task's branch back into base. */
export type IntegrationResult =
  | { status: 'merged' }
  /** Rebase left conflicts; the worktree is paused mid-rebase for resolution. */
  | { status: 'conflict'; worktree: string; branch: string; base: string }
  /** The base working tree has uncommitted changes, so we won't fast-forward it. */
  | { status: 'dirty-base'; base: string }
  | { status: 'error'; message: string };

/** The branch name for a task. Namespaced so orchestrator branches are recognizable. */
export function taskBranch(taskId: string): string {
  return `orch/${taskId}`;
}

export class WorktreeManager {
  /** Per-project promise chain, so integrations run one at a time per project. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** @param root Base directory to place worktrees under (e.g. userData/worktrees). */
  constructor(private readonly root: string) {}

  /** Deterministic worktree path for a task, so a resumed run reuses it. */
  private pathFor(projectId: string, taskId: string): string {
    return join(this.root, projectId, taskId);
  }

  /**
   * Decide where a task should run. In worktree mode, ensure the task's worktree
   * exists (creating it off the current base branch on first run) and return it;
   * otherwise fall back to the project directory.
   */
  async prepare(project: Project, task: Task): Promise<WorktreePrep> {
    if (!project.useWorktrees || !(await isRepo(project.path))) {
      return { mode: 'shared', cwd: project.path };
    }
    const base = await currentBranch(project.path);
    const branch = taskBranch(task.id);
    const cwd = this.pathFor(project.id, task.id);
    if (!existsSync(cwd)) {
      const res = await addWorktree(project.path, cwd, branch, base);
      if (res.code !== 0) {
        // Couldn't create the worktree (e.g. odd git state) — degrade to shared so
        // the task still runs rather than failing outright.
        return { mode: 'shared', cwd: project.path };
      }
    }
    return { mode: 'worktree', cwd, branch, base };
  }

  /**
   * Integrate a finished task's branch back into base: safety-commit anything the
   * agent left, rebase onto the latest base, then fast-forward base to it and remove
   * the worktree. Serialized per project. See IntegrationResult for the outcomes.
   */
  integrate(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
    commitMessage: string,
  ): Promise<IntegrationResult> {
    return this.enqueue(project.id, async () => {
      await commitAll(worktree, commitMessage);
      const rebased = await rebaseOnto(worktree, base);
      if (rebased.code !== 0) {
        if (await hasConflicts(worktree)) return { status: 'conflict', worktree, branch, base };
        await abortRebase(worktree);
        return { status: 'error', message: rebased.stderr || 'rebase failed' };
      }
      return this.fastForward(project, branch, base, worktree);
    });
  }

  /**
   * Finish integration after a human (or agent) resolved a rebase conflict in the
   * worktree: continue the rebase if one is still in progress, then fast-forward.
   */
  finishAfterConflict(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
  ): Promise<IntegrationResult> {
    return this.enqueue(project.id, async () => {
      if (await hasConflicts(worktree)) return { status: 'conflict', worktree, branch, base };
      // If a rebase is still open (conflicts were staged but not continued), continue
      // it; a "no rebase in progress" error is fine — it means they finished already.
      await continueRebase(worktree);
      if (await hasConflicts(worktree)) return { status: 'conflict', worktree, branch, base };
      return this.fastForward(project, branch, base, worktree);
    });
  }

  /** Remove a task's worktree (best effort) — used when cleaning up a failed task. */
  async cleanup(project: Project, taskId: string): Promise<void> {
    const cwd = this.pathFor(project.id, taskId);
    if (existsSync(cwd)) await removeWorktree(project.path, cwd);
  }

  /** ff-merge the (already rebased) branch into base in the main tree, then clean up. */
  private async fastForward(
    project: Project,
    branch: string,
    base: string,
    worktree: string,
  ): Promise<IntegrationResult> {
    // Never fast-forward a base tree that has uncommitted work — we'd risk the user's
    // changes. Park instead; they can commit/stash and retry.
    if (!(await isClean(project.path))) return { status: 'dirty-base', base };
    const merged = await mergeFfOnly(project.path, branch);
    if (merged.code !== 0) return { status: 'error', message: merged.stderr || 'merge failed' };
    await removeWorktree(project.path, worktree);
    await deleteBranch(project.path, branch);
    return { status: 'merged' };
  }

  /** Run `fn` after any pending work for `key`, keeping a single chain per project. */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the previous task's outcome
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
