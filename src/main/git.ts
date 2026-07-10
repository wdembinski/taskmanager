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

/** Prune stale worktree admin records (dirs removed out of band). */
export async function pruneWorktrees(repoDir: string): Promise<GitResult> {
  return git(repoDir, ['worktree', 'prune']);
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

/** Extra `-c` config to point git at an ephemeral attributes file (e.g. for `merge=union`). */
function attributesConfig(attributesFile?: string): string[] {
  return attributesFile ? ['-c', `core.attributesFile=${attributesFile}`] : [];
}

/**
 * Rebase the worktree's branch onto `baseRef`. `code === 0` means clean; a non-zero
 * code with conflicts means the caller must resolve (or `abortRebase`). When
 * `attributesFile` is given, its merge attributes apply — e.g. `path merge=union` lets
 * additive files (`.gitignore`, workspace lists) auto-resolve instead of conflicting.
 */
export async function rebaseOnto(
  worktreePath: string,
  baseRef: string,
  attributesFile?: string,
): Promise<GitResult> {
  return git(worktreePath, [...attributesConfig(attributesFile), 'rebase', baseRef]);
}

/** Abort an in-progress rebase, restoring the branch to its pre-rebase state. */
export async function abortRebase(worktreePath: string): Promise<GitResult> {
  return git(worktreePath, ['rebase', '--abort']);
}

/** Continue a rebase after conflicts were resolved and staged. */
export async function continueRebase(
  worktreePath: string,
  attributesFile?: string,
): Promise<GitResult> {
  // -c core.editor=true avoids opening an editor for the continue commit message.
  return git(worktreePath, [
    ...attributesConfig(attributesFile),
    '-c',
    'core.editor=true',
    'rebase',
    '--continue',
  ]);
}

/** Work-tree paths left with merge conflicts (unmerged, `U`) — NUL-delimited. */
export async function conflictedFiles(dir: string): Promise<string[]> {
  const res = await git(dir, ['diff', '-z', '--name-only', '--diff-filter=U']);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/** Fast-forward `branch` into the currently checked-out branch of `repoDir`. */
export async function mergeFfOnly(repoDir: string, branch: string): Promise<GitResult> {
  return git(repoDir, ['merge', '--ff-only', branch]);
}

/** Split a NUL-delimited git output (`-z`) into paths, dropping the empty trailing entry. */
function splitZ(stdout: string): string[] {
  return stdout.split('\0').filter((p) => p !== '');
}

/**
 * Paths that `branch` *adds* relative to `base` — i.e. files a fast-forward would newly
 * create in the work tree. Modified-in-branch files are already tracked in base, so they
 * can never collide with an untracked file; only additions can. NUL-delimited so paths
 * with spaces/unicode (and `core.quotePath`) parse cleanly.
 */
export async function addedInBranch(dir: string, base: string, branch: string): Promise<string[]> {
  const res = await git(dir, ['diff', '-z', '--name-only', '--diff-filter=A', `${base}..${branch}`]);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/** Untracked, non-ignored files in the work tree (NUL-delimited). */
export async function listUntracked(dir: string): Promise<string[]> {
  const res = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/** Blob SHA of `path` at `ref` (e.g. a branch), or '' if it doesn't exist there. */
export async function blobSha(dir: string, ref: string, path: string): Promise<string> {
  const res = await git(dir, ['rev-parse', `${ref}:${path}`]);
  return res.code === 0 ? res.stdout.trim() : '';
}

/**
 * The blob SHA the work-tree file at `path` *would* have once git's clean filters run
 * (`--path` applies `.gitattributes`/autocrlf), so a content comparison against a stored
 * blob isn't fooled by line-ending normalization. '' if the file can't be hashed.
 */
export async function workingFileSha(dir: string, path: string): Promise<string> {
  const res = await git(dir, ['hash-object', `--path=${path}`, '--', path]);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** Delete specific untracked files from the work tree (force). Paths only — never a whole tree. */
export async function removeUntracked(dir: string, paths: string[]): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  return git(dir, ['clean', '-f', '-q', '--', ...paths]);
}

/** Outcome of stashing untracked files aside so a merge can proceed without losing them. */
export interface StashResult {
  ok: boolean;
  /** The stash ref to restore from (`stash@{0}`) when `ok` and something was actually stashed. */
  stashRef: string | null;
  files: string[];
}

/**
 * Stash the given untracked files aside (preserving them) so a fast-forward can overwrite
 * their paths. Scoped to `paths` via a pathspec, so the rest of the work tree is untouched.
 * `ok:false` means nothing was stashed (git error, or no matching untracked files) — the
 * caller must then NOT force the merge.
 */
export async function preserveUntracked(
  dir: string,
  paths: string[],
  label: string,
): Promise<StashResult> {
  if (paths.length === 0) return { ok: false, stashRef: null, files: [] };
  const res = await git(dir, [
    'stash',
    'push',
    '--include-untracked',
    '-m',
    label,
    '--',
    ...paths,
  ]);
  // "No local changes to save" exits 0 but stashes nothing; detect it so we don't claim success.
  const stashed = res.code === 0 && !/No local changes to save/i.test(res.stdout + res.stderr);
  return { ok: stashed, stashRef: stashed ? 'stash@{0}' : null, files: paths };
}
