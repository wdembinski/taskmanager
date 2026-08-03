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
import { existsSync } from 'node:fs';
import type { GitPreflight } from '@shared/model';
import { localHost, type ExecHost } from './exec';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one `git` invocation in `cwd`, capturing output and the exit code.
 *
 * `host` decides WHICH machine runs it — the default is the machine the GUI runs on,
 * so every existing caller behaves exactly as before. A project targeting WSL passes
 * its own host and the identical argv runs inside the distro instead.
 */
export async function git(
  cwd: string,
  args: string[],
  host: ExecHost = localHost(),
): Promise<GitResult> {
  return host.exec(cwd, 'git', args, { maxBuffer: 32 * 1024 * 1024 });
}

/** True if `dir` is inside a git work tree. */
export async function isRepo(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--is-inside-work-tree'], host);
  return res.code === 0 && res.stdout.trim() === 'true';
}

/** The current branch name (or 'HEAD' when detached). Empty on error. */
export async function currentBranch(dir: string, host?: ExecHost): Promise<string> {
  const res = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], host);
  return res.code === 0 ? res.stdout.trim() : '';
}

/**
 * True when the repo has at least one commit — i.e. `HEAD` is BORN.
 *
 * A freshly `git init`-ed repo is a perfectly valid work tree ({@link isRepo} says yes) whose
 * `HEAD` points at a branch that does not exist yet. Almost every ref-taking git command fails
 * there, including `git worktree add`: there is no commit to branch FROM. Worse,
 * {@link currentBranch} coerces its own failure to `''`, so an unchecked caller ends up passing
 * an empty string where git expects a commit-ish and gets `fatal: not a valid object name: ''`
 * — an error that names neither the repo nor the real problem. Check this first.
 */
export async function hasCommits(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], host);
  return res.code === 0;
}

/**
 * Give an unborn repo its root commit, so branches (and therefore worktrees) can exist.
 *
 * **Deliberately EMPTY** (`--allow-empty`, and no `git add`): a repo can be unborn while its
 * folder is already full of files, and sweeping those into a commit the human never wrote is
 * not ours to do — it would author their project's history and quietly stage secrets, build
 * output, anything. An empty root commit changes no file on disk, leaves every untracked file
 * exactly as untracked as it was, and is undone with one `git update-ref -d HEAD`.
 *
 * `--no-verify` because a commit hook that fails must not be able to strand the run, and the
 * commit carries no content for a hook to have an opinion about. Identity is NOT injected: if
 * `user.email`/`user.name` are unset the commit fails and the caller surfaces git's own
 * complaint, which is the right thing to fix — an orchestrator-invented author is not.
 */
export async function createRootCommit(dir: string, host?: ExecHost): Promise<GitResult> {
  return git(dir, ['commit', '--allow-empty', '--no-verify', '-m', 'Initial commit'], host);
}

/**
 * Answer what a candidate project folder's git looks like, for the add/edit form.
 *
 * Read-only and deliberately cheap: three `git` calls at most, so it can run on every edit of
 * the path field. The point is to move "this folder can't host isolated worktrees" from the
 * first parked run back to the moment the human chose the folder, when the fix is obvious.
 */
export async function gitPreflight(dir: string, host?: ExecHost): Promise<GitPreflight> {
  // Existence is checked with `fs`, NOT by reading git's complaint, because a cwd that
  // doesn't exist and a `git` that isn't installed are the SAME failure at this layer: both
  // arrive as `spawn git ENOENT` with an empty stderr. Only a direct look at the path can
  // separate "your folder is gone" from "I can't run git here" — and reporting one as the
  // other sends the human to fix the wrong thing. `toApp` because a distro path has to be
  // named the way this process can see it (`\\wsl.localhost\…`) before `fs` can answer.
  const probe = host ?? localHost();
  if (!existsSync(probe.toApp(dir))) return { state: 'missing' };

  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'], host);
  if (inside.code !== 0) {
    const err = inside.stderr.trim();
    // The folder is there, so anything that still stops git from answering (not installed,
    // distro down) is not the folder's fault and must not be reported as "not a repo".
    if (/not a git repository/i.test(err)) return { state: 'not-a-repo' };
    return { state: 'unknown', detail: err || 'git could not be run' };
  }
  if (inside.stdout.trim() !== 'true') return { state: 'not-a-repo' };

  // `--show-current` rather than `rev-parse --abbrev-ref HEAD`: it is the one form that still
  // names the branch when HEAD is UNBORN, which is precisely the case being reported here.
  const branch = (await git(dir, ['branch', '--show-current'], host)).stdout.trim() || undefined;
  if (!(await hasCommits(dir, host))) return { state: 'no-commits', branch };
  return { state: 'ready', branch, branches: await listBranches(dir, host) };
}

/** Every local branch in the repo, in git's own (alphabetical) order. Empty on error. */
export async function listBranches(dir: string, host?: ExecHost): Promise<string[]> {
  const res = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], host);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** True when the work tree has no staged or unstaged changes (untracked ignored). */
export async function isClean(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['status', '--porcelain', '--untracked-files=no'], host);
  return res.code === 0 && res.stdout.trim() === '';
}

/** True if the given branch name already exists. */
export async function branchExists(dir: string, branch: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], host);
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
  host?: ExecHost,
): Promise<GitResult> {
  const exists = await branchExists(repoDir, branch, host);
  const args = exists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseRef];
  return git(repoDir, args, host);
}

/** Remove a worktree (force, so a dirty/locked one still detaches). Prunes admin files. */
export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
  host?: ExecHost,
): Promise<GitResult> {
  const res = await git(repoDir, ['worktree', 'remove', '--force', worktreePath], host);
  // Best-effort prune so a manually-deleted dir doesn't linger in git's records.
  await git(repoDir, ['worktree', 'prune'], host);
  return res;
}

/** Prune stale worktree admin records (dirs removed out of band). */
export async function pruneWorktrees(repoDir: string, host?: ExecHost): Promise<GitResult> {
  return git(repoDir, ['worktree', 'prune'], host);
}

/** Delete a branch (force). Used only after a successful merge. */
export async function deleteBranch(
  repoDir: string,
  branch: string,
  host?: ExecHost,
): Promise<GitResult> {
  return git(repoDir, ['branch', '-D', branch], host);
}

/**
 * Stage everything and commit. Returns whether a commit was actually made (false
 * when the tree was already clean — nothing to commit).
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  host?: ExecHost,
): Promise<boolean> {
  await git(worktreePath, ['add', '-A'], host);
  const staged = await git(worktreePath, ['diff', '--cached', '--quiet'], host);
  if (staged.code === 0) return false; // exit 0 = no staged changes
  const res = await git(worktreePath, ['commit', '--no-verify', '-m', message], host);
  return res.code === 0;
}

/** True when a rebase/merge left unmerged (conflicted) paths. */
export async function hasConflicts(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['diff', '--name-only', '--diff-filter=U'], host);
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
  host?: ExecHost,
): Promise<GitResult> {
  return git(worktreePath, [...attributesConfig(attributesFile), 'rebase', baseRef], host);
}

/** Abort an in-progress rebase, restoring the branch to its pre-rebase state. */
export async function abortRebase(worktreePath: string, host?: ExecHost): Promise<GitResult> {
  return git(worktreePath, ['rebase', '--abort'], host);
}

/** Continue a rebase after conflicts were resolved and staged. */
export async function continueRebase(
  worktreePath: string,
  attributesFile?: string,
  host?: ExecHost,
): Promise<GitResult> {
  // -c core.editor=true avoids opening an editor for the continue commit message.
  return git(
    worktreePath,
    [...attributesConfig(attributesFile), '-c', 'core.editor=true', 'rebase', '--continue'],
    host,
  );
}

/** Work-tree paths left with merge conflicts (unmerged, `U`) — NUL-delimited. */
export async function conflictedFiles(dir: string, host?: ExecHost): Promise<string[]> {
  const res = await git(dir, ['diff', '-z', '--name-only', '--diff-filter=U'], host);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/** Fast-forward `branch` into the currently checked-out branch of `repoDir`. */
export async function mergeFfOnly(
  repoDir: string,
  branch: string,
  host?: ExecHost,
): Promise<GitResult> {
  return git(repoDir, ['merge', '--ff-only', branch], host);
}

/**
 * Fast-forward the ref `target` to `source` **without touching any work tree**.
 *
 * `git merge` can only ever advance the branch that is CHECKED OUT, which is why a base
 * branch nobody has checked out used to be unreachable — and why uncommitted work in the
 * main checkout blocked merges into a branch that work had nothing to do with. Pushing
 * into the repo itself has neither problem: no files are written, so a dirty work tree is
 * irrelevant, and git refuses the update outright (non-zero) if `target` IS checked out
 * somewhere, or if the move would not be a fast-forward — both of which we want to hear
 * about rather than force past. The refspec is deliberately un-prefixed (no `+`).
 */
export async function fastForwardRef(
  repoDir: string,
  source: string,
  target: string,
  host?: ExecHost,
): Promise<GitResult> {
  return git(repoDir, ['fetch', '.', `${source}:${target}`], host);
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
export async function addedInBranch(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<string[]> {
  const res = await git(
    dir,
    ['diff', '-z', '--name-only', '--diff-filter=A', `${base}..${branch}`],
    host,
  );
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/**
 * How many commits `branch` has that `base` does not.
 *
 * `0` means merging it would be a no-op: everything on it is already contained in base,
 * either because it was merged before or because nothing was ever written to it. That is
 * the difference between "this branch has work to land" and "there is nothing to land",
 * which no other signal here can tell apart — a branch that merged an hour ago and a
 * branch an agent never committed to look identical from every other angle.
 *
 * `-1` when the count can't be read at all (a ref that no longer exists, git unavailable).
 * Callers must treat that as "don't know" and never as "nothing" — refusing to merge on a
 * failed count would strand real work.
 */
export async function commitsAhead(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<number> {
  const res = await git(dir, ['rev-list', '--count', `${base}..${branch}`], host);
  if (res.code !== 0) return -1;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

/** Untracked, non-ignored files in the work tree (NUL-delimited). */
export async function listUntracked(dir: string, host?: ExecHost): Promise<string[]> {
  const res = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard'], host);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/** Blob SHA of `path` at `ref` (e.g. a branch), or '' if it doesn't exist there. */
export async function blobSha(
  dir: string,
  ref: string,
  path: string,
  host?: ExecHost,
): Promise<string> {
  const res = await git(dir, ['rev-parse', `${ref}:${path}`], host);
  return res.code === 0 ? res.stdout.trim() : '';
}

/**
 * The blob SHA the work-tree file at `path` *would* have once git's clean filters run
 * (`--path` applies `.gitattributes`/autocrlf), so a content comparison against a stored
 * blob isn't fooled by line-ending normalization. '' if the file can't be hashed.
 */
export async function workingFileSha(dir: string, path: string, host?: ExecHost): Promise<string> {
  const res = await git(dir, ['hash-object', `--path=${path}`, '--', path], host);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** Delete specific untracked files from the work tree (force). Paths only — never a whole tree. */
export async function removeUntracked(
  dir: string,
  paths: string[],
  host?: ExecHost,
): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  return git(dir, ['clean', '-f', '-q', '--', ...paths], host);
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
  host?: ExecHost,
): Promise<StashResult> {
  if (paths.length === 0) return { ok: false, stashRef: null, files: [] };
  const res = await git(
    dir,
    ['stash', 'push', '--include-untracked', '-m', label, '--', ...paths],
    host,
  );
  // "No local changes to save" exits 0 but stashes nothing; detect it so we don't claim success.
  const stashed = res.code === 0 && !/No local changes to save/i.test(res.stdout + res.stderr);
  return { ok: stashed, stashRef: stashed ? 'stash@{0}' : null, files: paths };
}
