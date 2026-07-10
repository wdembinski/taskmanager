/**
 * Thin async wrappers over the `git` CLI (Phase: team orchestrator).
 *
 * The scheduler runs each task in its own **git worktree** on its own branch, then
 * integrates the branch back into the base. These helpers are the only place that
 * shells out to `git`, so the worktree lifecycle reads clearly and can be tested
 * against a real temporary repository (git is a system binary — no Electron ABI
 * concerns, unlike better-sqlite3).
 *
 * Every function takes a working directory and returns data (or a boolean); a
 * non-zero git exit is surfaced as `GitResult.code` rather than throwing, so the
 * caller decides what a failure means (e.g. a non-zero `rebase` = conflicts).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one `git` invocation in `cwd`, capturing output and the exit code. */
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

/** True if `dir` is inside a git work tree. */
export async function isRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return res.code === 0 && res.stdout.trim() === 'true';
}

/** The current branch name (or 'HEAD' when detached). Empty on error. */
export async function currentBranch(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** True when the work tree has no staged or unstaged changes (untracked ignored). */
export async function isClean(dir: string): Promise<boolean> {
  const res = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return res.code === 0 && res.stdout.trim() === '';
}

/** True if the given branch name already exists. */
export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return res.code === 0;
}

/**
 * Add a worktree at `worktreePath` on `branch`. If the branch doesn't exist yet it
 * is created from `baseRef`; if it does (e.g. resuming a task), it is simply checked
 * out into the new worktree.
 */
export async function addWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<GitResult> {
  const exists = await branchExists(repoDir, branch);
  const args = exists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseRef];
  return git(repoDir, args);
}

/** Remove a worktree (force, so a dirty/locked one still detaches). Prunes admin files. */
export async function removeWorktree(repoDir: string, worktreePath: string): Promise<GitResult> {
  const res = await git(repoDir, ['worktree', 'remove', '--force', worktreePath]);
  // Best-effort prune so a manually-deleted dir doesn't linger in git's records.
  await git(repoDir, ['worktree', 'prune']);
  return res;
}

/** Delete a branch (force). Used only after a successful merge. */
export async function deleteBranch(repoDir: string, branch: string): Promise<GitResult> {
  return git(repoDir, ['branch', '-D', branch]);
}

/**
 * Stage everything and commit. Returns whether a commit was actually made (false
 * when the tree was already clean — nothing to commit).
 */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(worktreePath, ['add', '-A']);
  const staged = await git(worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false; // exit 0 = no staged changes
  const res = await git(worktreePath, ['commit', '--no-verify', '-m', message]);
  return res.code === 0;
}

/** True when a rebase/merge left unmerged (conflicted) paths. */
export async function hasConflicts(dir: string): Promise<boolean> {
  const res = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
  return res.code === 0 && res.stdout.trim() !== '';
}

/**
 * Rebase the worktree's branch onto `baseRef`. `code === 0` means clean; a non-zero
 * code with conflicts means the caller must resolve (or `abortRebase`).
 */
export async function rebaseOnto(worktreePath: string, baseRef: string): Promise<GitResult> {
  return git(worktreePath, ['rebase', baseRef]);
}

/** Abort an in-progress rebase, restoring the branch to its pre-rebase state. */
export async function abortRebase(worktreePath: string): Promise<GitResult> {
  return git(worktreePath, ['rebase', '--abort']);
}

/** Continue a rebase after conflicts were resolved and staged. */
export async function continueRebase(worktreePath: string): Promise<GitResult> {
  // -c core.editor=true avoids opening an editor for the continue commit message.
  return git(worktreePath, ['-c', 'core.editor=true', 'rebase', '--continue']);
}

/** Fast-forward `branch` into the currently checked-out branch of `repoDir`. */
export async function mergeFfOnly(repoDir: string, branch: string): Promise<GitResult> {
  return git(repoDir, ['merge', '--ff-only', branch]);
}
