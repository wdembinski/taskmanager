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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitPreflight } from '@shared/model';
import type { DiffFileStatus } from '@shared/review';
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
 *
 * `env` is added to this process' environment for the one command, and is only ever passed
 * by {@link pushBranch} and {@link fetchRefspecs} — see {@link NO_PROMPT_ENV} for the single
 * thing it is for. Omitted everywhere else, so no other git call's environment changes at all.
 */
export async function git(
  cwd: string,
  args: string[],
  host: ExecHost = localHost(),
  env?: Record<string, string>,
): Promise<GitResult> {
  return host.exec(cwd, 'git', args, {
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
}

/** True if `dir` is inside a git work tree. */
export async function isRepo(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--is-inside-work-tree'], host);
  return res.code === 0 && res.stdout.trim() === 'true';
}

/**
 * The current branch name. **Empty when there isn't one** — on error, and equally when
 * `HEAD` is detached.
 *
 * `git rev-parse --abbrev-ref HEAD` answers the literal string `HEAD` for a detached head,
 * which is not a branch and is not a name any caller here can use. Passing it on is worse
 * than saying nothing: a worktree left mid-rebase reported its branch as `HEAD`, the run
 * worked on it perfectly well, and then the integrate step asked git to merge a branch
 * called `HEAD`, found no such thing, and quietly recorded that no merge was needed — a
 * whole step's work left unmerged, with a card that span "Running" to show for it.
 *
 * So the pseudo-name is collapsed into the empty answer every caller already handles as
 * "git won't say which branch this is", and each of them refuses or falls back instead.
 * `hasCommits` documents the other half of this contract: `''` must never reach git as a
 * start-point.
 */
export async function currentBranch(dir: string, host?: ExecHost): Promise<string> {
  const res = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], host);
  if (res.code !== 0) return '';
  const name = res.stdout.trim();
  return name === 'HEAD' ? '' : name;
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

/**
 * Pull the paths back out of `git status --porcelain` output — pure, so the rename edge
 * case can be checked without a real repository behind it.
 *
 * Each line is a two-letter status code, a space, then the path — except a rename/copy
 * line (`R  old -> new`), where only the half AFTER the arrow is what exists in the tree
 * now; the old name is history, not something left to commit.
 */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.slice(3))
    .filter(Boolean)
    .map((path) => {
      const arrow = path.indexOf(' -> ');
      return arrow === -1 ? path : path.slice(arrow + 4);
    });
}

/**
 * Every path with something uncommitted about it — staged, unstaged, OR untracked — unlike
 * {@link isClean}, which is asked only "does the tree match HEAD" and so, via
 * `--untracked-files=no`, never sees a file git hasn't started tracking yet. Exists for the
 * one place that has to NAME what is sitting there rather than just refuse: a branch with
 * nothing committed and an empty worktree is a different wall than one whose worktree still
 * has the very work that was supposed to land, and only this tells them apart.
 */
export async function uncommittedPaths(dir: string, host?: ExecHost): Promise<string[]> {
  const res = await git(dir, ['status', '--porcelain'], host);
  return res.code === 0 ? parsePorcelainPaths(res.stdout) : [];
}

/**
 * The remote and ref `branch` tracks (`branch.<name>.remote`/`.merge`), or **null** when it
 * has none configured.
 *
 * Read from config rather than `<branch>@{upstream}`: the latter answers with a single
 * `remote/ref` string that has to be split back apart, and splitting on the first `/` breaks
 * the moment a tracked branch name itself contains one (`feature/foo`) — exactly the kind of
 * name this app's own branches use. The two config keys are what git itself writes when a
 * branch is told to track something, and reading them back apart avoids ever having to guess
 * where the remote's name ends.
 *
 * A branch with no upstream at all — a purely local repo, or one nobody has pushed — is a
 * normal, supported state here, not a failure: every caller treats `null` as "there is
 * nothing to sync against" and carries on against the local branch exactly as before.
 */
export async function upstreamOf(
  dir: string,
  branch: string,
  host?: ExecHost,
): Promise<{ remote: string; ref: string } | null> {
  const remote = await git(dir, ['config', '--get', `branch.${branch}.remote`], host);
  const merge = await git(dir, ['config', '--get', `branch.${branch}.merge`], host);
  const remoteName = remote.code === 0 ? remote.stdout.trim() : '';
  const mergeRef = merge.code === 0 ? merge.stdout.trim() : '';
  if (!remoteName || !mergeRef.startsWith('refs/heads/')) return null;
  return { remote: remoteName, ref: mergeRef.slice('refs/heads/'.length) };
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

/**
 * Add a worktree at `worktreePath` with a DETACHED head at `sha` — the read-only checkout
 * an AI review runs against (F16).
 *
 * Unlike {@link addWorktree} this creates no branch and moves no ref: nothing in
 * `refs/heads` changes, and the main checkout's HEAD and index are untouched. Removing it
 * again ({@link removeWorktree}) therefore leaves no trace in the repo at all.
 */
export async function addDetachedWorktree(
  repoDir: string,
  worktreePath: string,
  sha: string,
  host?: ExecHost,
): Promise<GitResult> {
  return git(repoDir, ['worktree', 'add', '--detach', worktreePath, sha], host);
}

/** One record of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** As git prints it — forward slashes even on Windows (`C:/Users/…`). */
  path: string;
  /** The checked-out commit; `''` for a bare repo, which has none. */
  head: string;
  detached: boolean;
  /** Short name (`refs/heads/` stripped), or null when detached or bare. */
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` — pure, so the record shapes can be checked without a
 * repository. Records are separated by a blank line; each opens with `worktree <path>`,
 * followed by `HEAD <sha>` and then `branch refs/heads/<name>` or `detached` (a bare repo has
 * only `bare`). Other attribute lines (`locked`, `prunable`, …) are ignored.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of stdout.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    let entry: WorktreeEntry | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        entry = { path: line.slice('worktree '.length), head: '', detached: false, branch: null };
      } else if (!entry) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        entry.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        entry.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line.trim() === 'detached') {
        entry.detached = true;
      }
    }
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Every worktree git knows for `repoDir`, the main checkout first. Empty on error. */
export async function listWorktrees(repoDir: string, host?: ExecHost): Promise<WorktreeEntry[]> {
  const res = await git(repoDir, ['worktree', 'list', '--porcelain'], host);
  return res.code === 0 ? parseWorktreeList(res.stdout) : [];
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
 *
 * `autostash`, when true, passes `--autostash`: uncommitted changes in the worktree are
 * stashed before the rebase starts and popped back once it finishes, instead of the rebase
 * refusing outright with "cannot rebase: you have unstaged changes". `integrate` never needs
 * this — it commits everything first — but the pre-PR remote check runs on a worktree that
 * may still have an agent's uncommitted edits sitting in it, and failing there with a generic
 * git error is a worse outcome than stashing work that is about to be rebased anyway.
 *
 * `upstream`, when given, turns this into `rebase --onto <baseRef> <upstream>`: only the
 * commits HEAD has that `upstream` does not are replayed, onto `baseRef`, rather than every
 * commit `baseRef` itself doesn't have. `syncOntoRemoteBase` is the one caller that needs
 * this — the branch's OWN fork point, never `baseRef`'s current tip, is what must stay fixed
 * however far a local base has drifted from the remote either side.
 */
export async function rebaseOnto(
  worktreePath: string,
  baseRef: string,
  attributesFile?: string,
  host?: ExecHost,
  autostash?: boolean,
  upstream?: string,
): Promise<GitResult> {
  return git(
    worktreePath,
    [
      ...attributesConfig(attributesFile),
      'rebase',
      ...(autostash ? ['--autostash'] : []),
      ...(upstream ? ['--onto', baseRef, upstream] : [baseRef]),
    ],
    host,
  );
}

/** Abort an in-progress rebase, restoring the branch to its pre-rebase state. */
export async function abortRebase(worktreePath: string, host?: ExecHost): Promise<GitResult> {
  return git(worktreePath, ['rebase', '--abort'], host);
}

/**
 * The branch a rebase in progress is replaying in `dir` — i.e. the branch git will put back
 * when that rebase finishes or is aborted — or **null** when no rebase is under way.
 *
 * This is the one question {@link currentBranch} cannot answer and every caller of it then
 * has to guess at: mid-rebase, `HEAD` is detached, so the worktree reports no branch at all
 * even though it very much has one waiting for it. Told apart, "detached because a rebase is
 * paused here" becomes a recoverable state ({@link abortRebase} puts the branch back, losing
 * no commit) instead of the dead end it looks like.
 *
 * Both rebase backends are checked — `rebase-merge` (the default, and every interactive
 * rebase) and `rebase-apply` (`--apply`) — because which one ran is not ours to predict.
 * A rebase of a detached HEAD writes the literal `detached HEAD` here rather than a ref, and
 * that is correctly reported as "no branch": there is none to go back to.
 */
export async function rebasingBranch(dir: string, host?: ExecHost): Promise<string | null> {
  for (const backend of ['rebase-merge', 'rebase-apply']) {
    const head = await readGitFile(dir, `${backend}/head-name`, host);
    const ref = head?.trim() ?? '';
    if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length) || null;
  }
  return null;
}

/**
 * Is a rebase paused in `dir` at all — has git stopped part-way and left its state behind?
 *
 * The blunter sibling of {@link rebasingBranch}, and the two are not interchangeable. That one
 * answers *which branch* is being replayed, so it says "no" for a rebase of a detached `HEAD`
 * and for one whose `head-name` git wrote as the literal `detached HEAD`. Here the question is
 * only ever asked to decide two things — would `git rebase <base>` refuse with *"there is
 * already a rebase-merge directory"*, and is `--continue` the move rather than a fresh start —
 * and for both of those, ANY paused rebase counts.
 *
 * Asked of the state DIRECTORY, which is what git itself checks, rather than of a file inside
 * it: which files a stopped rebase leaves behind differs by backend and by why it stopped, and
 * a predicate that answers "no" to a rebase that is plainly in progress is worse than useless
 * — it is what licenses a caller to start a second one.
 */
export async function rebaseInProgress(
  dir: string,
  host: ExecHost = localHost(),
): Promise<boolean> {
  for (const backend of ['rebase-merge', 'rebase-apply']) {
    const path = await gitPath(dir, backend, host);
    if (path && existsSync(host.toApp(path))) return true;
  }
  return false;
}

/**
 * Name a path inside the repo's git DIRECTORY (not its work tree), as this process can open it.
 *
 * `rev-parse --git-path` is what makes this safe to do at all: a worktree's `.git` is a *file*
 * pointing into the main repo's admin area, so the state of a rebase running here lives at a
 * path only git can name. It answers with an absolute path in a real repo and a relative one
 * in some layouts, hence the join — and the result goes through `toApp` at the call site so a
 * WSL project's `/home/...` is named the way this process can reach it.
 */
async function gitPath(
  dir: string,
  relative: string,
  host: ExecHost = localHost(),
): Promise<string | null> {
  const res = await git(dir, ['rev-parse', '--git-path', relative], host);
  const path = res.code === 0 ? res.stdout.trim() : '';
  if (!path) return null;
  return /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${dir.replace(/[\\/]+$/, '')}/${path}`;
}

/**
 * Read a file out of the repo's git DIRECTORY (not its work tree), or null if it isn't there.
 */
async function readGitFile(
  dir: string,
  relative: string,
  host: ExecHost = localHost(),
): Promise<string | null> {
  const absolute = await gitPath(dir, relative, host);
  if (!absolute) return null;
  try {
    return readFileSync(host.toApp(absolute), 'utf8');
  } catch {
    return null; // no rebase in progress is the ordinary case, not an error
  }
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

/**
 * Drop the patch a rebase is stopped on and move to the next one.
 *
 * Needed by any *automatic* conflict resolution: when the resolution turns out to reproduce
 * what base already has, the patch becomes empty and `rebase --continue` refuses with "No
 * changes - did you forget to use 'git add'?". That is not a failure — the commit's content
 * is already in base — so the right move is to skip it. See {@link hasStagedChanges} for how
 * the two cases are told apart.
 */
export async function skipRebase(worktreePath: string, host?: ExecHost): Promise<GitResult> {
  return git(worktreePath, ['rebase', '--skip'], host);
}

/**
 * True when the index differs from `HEAD` — i.e. there is still something for the next commit
 * to record. Mid-rebase that answers "does this patch still have content after resolution?".
 *
 * `diff --quiet` exits 1 for "differences" and 0 for "none"; any *other* code is an error, and
 * is deliberately reported as `false` rather than assumed — see `skipRebase`.
 */
export async function hasStagedChanges(dir: string, host?: ExecHost): Promise<boolean> {
  const res = await git(dir, ['diff', '--cached', '--quiet', 'HEAD'], host);
  return res.code === 1;
}

/**
 * Replace the conflicted work-tree copy of each path with **our** side of the merge, unstaged.
 *
 * During a REBASE "ours" is the branch being rebased *onto* — the base — because a rebase
 * replays the branch's commits on top of it. That inversion is the whole reason this wrapper
 * exists rather than a bare `--ours` at the call site.
 */
export async function checkoutOurs(
  dir: string,
  paths: string[],
  host?: ExecHost,
): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  return git(dir, ['checkout', '--ours', '--', ...paths], host);
}

/**
 * Put the conflict markers back for paths whose work-tree copy was overwritten — the undo for
 * {@link checkoutOurs} and for any file an automatic resolution rewrote.
 *
 * Only works while the index still holds the unmerged stages, i.e. *before* the path is staged.
 * That constraint is load-bearing: an automatic resolution must stage nothing until it knows
 * every file it touched succeeded, so that a failure half-way can hand git's own conflicted
 * tree to the next rung untouched.
 */
export async function restoreConflicted(
  dir: string,
  paths: string[],
  host?: ExecHost,
): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  return git(dir, ['checkout', '--merge', '--', ...paths], host);
}

/** Stage specific paths (marking conflicted ones resolved). Paths only — never the whole tree. */
export async function stagePaths(
  dir: string,
  paths: string[],
  host?: ExecHost,
): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  return git(dir, ['add', '--', ...paths], host);
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
 * Every path `branch` touched relative to `base` — added, modified, deleted, renamed. Unlike
 * {@link addedInBranch} this carries no `--diff-filter`: it exists to describe the whole of a
 * finished chain's work for a human reading a summary, where an edit is exactly as worth
 * naming as a new file. NUL-delimited for the same reason as `addedInBranch`.
 */
export async function changedInBranch(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<string[]> {
  const res = await git(dir, ['diff', '-z', '--name-only', `${base}..${branch}`], host);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/**
 * Every path `branch` touched since it left `base` — a THREE-dot range, so the diff runs from
 * their merge base and what `base` itself gained in the meantime is not counted as the
 * branch's. This is the file set a card's work actually claims (`Task.plannedFiles`), where
 * {@link changedInBranch}'s two-dot range would also name every file another card landed on
 * `base` after this branch was cut. `[]` on failure, like `changedInBranch`.
 */
export async function changedSinceMergeBase(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<string[]> {
  const res = await git(dir, ['diff', '-z', '--name-only', `${base}...${branch}`], host);
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/**
 * Reading a diff's actual file contents — status, counts, and the patch text itself
 * (Phase: F6 in-app code review). Where {@link changedInBranch} only names files, these
 * answer "what changed in this one" and "what did this file's old/new side actually
 * contain", which a diff viewer needs one file at a time rather than all at once.
 *
 * Every helper here keeps this file's own contract: a failure is data (`[]`/`''`/`null`),
 * never a throw, so a diff viewer can show "couldn't read this file" instead of crashing
 * the whole screen.
 */

/** One file's row out of {@link diffNameStatus} / {@link diffWorkingTree}. */
export interface NameStatusEntry {
  path: string;
  /** Set only for a rename or copy — the path it moved from. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** This entry came from {@link listUntracked}, not a tracked diff — see {@link diffWorkingTree}. */
  untracked?: boolean;
}

/** Split a NUL-delimited `-z` stream into tokens, dropping the trailing empty one it leaves. */
function splitZTokens(stdout: string): string[] {
  const tokens = stdout.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  return tokens;
}

/**
 * One `--name-status -z` record: `<status>\0<path>\0` ordinarily, or
 * `<status>\0<oldPath>\0<newPath>\0` for a rename/copy (`status` starting `R`/`C`, e.g.
 * `R100`). Pure, and exported so a fixture's raw bytes can be tested without a real repo.
 */
export function parseNameStatusZ(
  stdout: string,
): Array<{ status: string; path: string; oldPath?: string }> {
  const tokens = splitZTokens(stdout);
  const out: Array<{ status: string; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i++] ?? '';
      const path = tokens[i++] ?? '';
      out.push({ status, path, oldPath });
    } else {
      const path = tokens[i++] ?? '';
      out.push({ status, path });
    }
  }
  return out;
}

/**
 * One `--numstat -z` record: `<added>\t<deleted>\t<path>\0` ordinarily (`-`/`-` means a
 * binary file, reported here as 0/0), or `<added>\t<deleted>\t\0<oldPath>\0<newPath>\0`
 * for a rename/copy — the empty path field before the first NUL is what signals that a
 * second NUL-delimited token pair follows instead. Pure, same reason as
 * {@link parseNameStatusZ}.
 */
export function parseNumstatZ(stdout: string): Array<{
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}> {
  const tokens = splitZTokens(stdout);
  const out: Array<{
    path: string;
    oldPath?: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }> = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++];
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(head);
    if (!match) continue; // not a record we understand — skip rather than throw
    const [, addRaw, delRaw, pathPart] = match;
    const binary = addRaw === '-' || delRaw === '-';
    const additions = binary ? 0 : Number(addRaw);
    const deletions = binary ? 0 : Number(delRaw);
    if (pathPart === '') {
      const oldPath = tokens[i++] ?? '';
      const path = tokens[i++] ?? '';
      out.push({ path, oldPath, additions, deletions, binary });
    } else {
      out.push({ path: pathPart, additions, deletions, binary });
    }
  }
  return out;
}

/** A `name-status` code's first letter, mapped to the shape the review UI speaks ({@link DiffFileStatus}). */
function fileStatusOf(code: string): DiffFileStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'modified'; // M (modified) and T (type change)
  }
}

/**
 * Every file `from..to` touched, with status AND counts. Two `git diff` calls merged by
 * path rather than one, because git will not combine `--name-status` and `--numstat`
 * into a single output no matter how it's asked.
 *
 * `to === null` means the working tree against `from` (tracked files only — see
 * {@link diffWorkingTree} for untracked ones too). Callers pass a {@link mergeBase} SHA
 * as `from` to get the three-dot (`...`) comparison the review design wants, without
 * actually using git's `...` syntax — which a working-tree diff (`to === null`) cannot
 * take at all.
 */
export async function diffNameStatus(
  dir: string,
  from: string,
  to: string | null,
  host?: ExecHost,
): Promise<NameStatusEntry[]> {
  const refs = to === null ? [from] : [from, to];
  const [nameStatusRes, numstatRes] = await Promise.all([
    git(dir, ['diff', '-z', '-M', '--no-color', '--no-ext-diff', '--name-status', ...refs], host),
    git(dir, ['diff', '-z', '-M', '--no-color', '--no-ext-diff', '--numstat', ...refs], host),
  ]);
  if (nameStatusRes.code !== 0) return [];

  const numstatByPath = new Map(
    (numstatRes.code === 0 ? parseNumstatZ(numstatRes.stdout) : []).map((n) => [n.path, n]),
  );

  return parseNameStatusZ(nameStatusRes.stdout).map((entry): NameStatusEntry => {
    const numstat = numstatByPath.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: fileStatusOf(entry.status),
      additions: numstat?.additions ?? 0,
      deletions: numstat?.deletions ?? 0,
      binary: numstat?.binary ?? false,
    };
  });
}

/**
 * {@link diffNameStatus}'s working-tree variant, with untracked files folded in as
 * `added` — the file list a review screen shows when uncommitted work is included.
 *
 * An untracked file has no tracked "old side" for `--numstat` to diff against, so its
 * counts come from a one-off `diff --no-index` against `/dev/null` instead — the one
 * git call in this file where a non-zero exit (1, "the two sides differ") is the
 * expected outcome rather than a failure, so it is accepted alongside 0.
 */
export async function diffWorkingTree(
  dir: string,
  from: string,
  host?: ExecHost,
): Promise<NameStatusEntry[]> {
  const tracked = await diffNameStatus(dir, from, null, host);
  const untrackedPaths = await listUntracked(dir, host);
  const untracked = await Promise.all(
    untrackedPaths.map(async (path): Promise<NameStatusEntry> => {
      const res = await git(
        dir,
        ['diff', '--no-index', '-z', '--numstat', '--', '/dev/null', path],
        host,
      );
      const [counts] = res.code === 0 || res.code === 1 ? parseNumstatZ(res.stdout) : [];
      return {
        path,
        status: 'added',
        additions: counts?.additions ?? 0,
        deletions: counts?.deletions ?? 0,
        binary: counts?.binary ?? false,
        untracked: true,
      };
    }),
  );
  return [...tracked, ...untracked];
}

/**
 * The patch text for one file, straight off `git diff` and ready for `parsePatch`
 * (`@shared/review`) to turn into hunks. `null` on failure.
 *
 * Both `oldPath` and `path` go in the pathspec for a tracked rename, not just `path`:
 * git only reports a move as a rename — rather than an unrelated delete plus add — when
 * it can see both sides to compare. `to` omitted or `null` means the working tree.
 */
export async function diffFilePatch(
  dir: string,
  req: { from: string; to?: string | null; path: string; oldPath?: string; untracked?: boolean },
  host?: ExecHost,
): Promise<string | null> {
  if (req.untracked) {
    const res = await git(
      dir,
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', '/dev/null', req.path],
      host,
    );
    return res.code === 0 || res.code === 1 ? res.stdout : null;
  }
  const refs = req.to ? [req.from, req.to] : [req.from];
  const paths = req.oldPath ? [req.oldPath, req.path] : [req.path];
  const res = await git(
    dir,
    ['diff', '--no-color', '--no-ext-diff', '-U3', '-M', ...refs, '--', ...paths],
    host,
  );
  return res.code === 0 ? res.stdout : null;
}

/**
 * The raw bytes of `path` as it existed at `ref` — an image diff's "old" side, or its
 * "new" side when the working tree isn't included. Read with `encoding: 'latin1'`
 * rather than the usual UTF-8: it is the one encoding that round-trips every byte value
 * 1:1 through a JS string, so arbitrary binary content (a PNG, a JPEG) survives
 * `ExecHost.exec`'s string-based result instead of being corrupted as invalid UTF-8.
 */
export async function showBlob(
  dir: string,
  ref: string,
  path: string,
  host?: ExecHost,
): Promise<Buffer | null> {
  const res = await (host ?? localHost()).exec(dir, 'git', ['cat-file', 'blob', `${ref}:${path}`], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'latin1',
  });
  if (res.code !== 0) return null;
  return Buffer.from(res.stdout, 'latin1');
}

/**
 * The byte size of `path` at `ref`, without reading the blob itself — `-1` when it
 * can't be answered. Lets F6.6 weigh a file against `DIFF_IMAGE_MAX_BYTES` before
 * paying for {@link showBlob}'s full read.
 */
export async function blobSize(
  dir: string,
  ref: string,
  path: string,
  host?: ExecHost,
): Promise<number> {
  const res = await git(dir, ['cat-file', '-s', `${ref}:${path}`], host);
  if (res.code !== 0) return -1;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

/** How many paths one `git hash-object` call names — well inside Windows' command-line limit. */
const HASH_OBJECT_BATCH = 100;

/**
 * The git blob SHA of each of `paths` at `ref`, or in the work tree when `ref` is null — the
 * `newBlobSha` a viewed mark (F15.4) is keyed on. A path with no blob on that side (deleted,
 * a directory, a submodule) is simply absent from the map.
 *
 * At a ref, one `ls-tree -r -z` over the whole tree, filtered — the same shape `fileSizes`
 * reads, so a summary of a thousand files is still one call. In the work tree, `hash-object`
 * on the files that exist, in batches: it runs the path's clean filters (`core.autocrlf`,
 * `.gitattributes`) just as `git add` would, so the SHA is the blob the file BECOMES once
 * committed — a file viewed before the agent commits it is still viewed after. A batch git
 * refuses is left out rather than failing the whole summary.
 */
export async function blobShas(
  dir: string,
  ref: string | null,
  paths: readonly string[],
  host: ExecHost = localHost(),
): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  if (paths.length === 0) return shas;
  if (ref !== null) {
    const res = await git(dir, ['ls-tree', '-r', '-z', ref], host);
    if (res.code !== 0) return shas;
    const wanted = new Set(paths);
    for (const record of res.stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [, type, sha] = record.slice(0, tab).trim().split(/\s+/);
      const path = record.slice(tab + 1);
      if (type === 'blob' && sha && wanted.has(path)) shas.set(path, sha);
    }
    return shas;
  }
  const present = paths.filter((p) => {
    try {
      return statSync(join(host.toApp(dir), p)).isFile();
    } catch {
      return false;
    }
  });
  for (let i = 0; i < present.length; i += HASH_OBJECT_BATCH) {
    const batch = present.slice(i, i + HASH_OBJECT_BATCH);
    const res = await git(dir, ['hash-object', '--', ...batch], host);
    if (res.code !== 0) continue;
    const lines = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length !== batch.length) continue;
    batch.forEach((p, idx) => shas.set(p, lines[idx]));
  }
  return shas;
}

/**
 * A work-tree file's raw bytes, or `null` if it can't be read — an image diff's "new"
 * side when the working tree is included. There is no git plumbing command that reads a
 * work-tree file's current content without first writing it into an object, so this
 * goes straight to `fs`; `host.toApp` is what lets a WSL project's path resolve from
 * this (Windows) process at all.
 */
export function readWorkingFile(
  dir: string,
  path: string,
  host: ExecHost = localHost(),
): Buffer | null {
  try {
    return readFileSync(join(host.toApp(dir), path));
  } catch {
    return null;
  }
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

/**
 * Every commit `branch` has that `base` does not, as raw commit-message text, oldest first —
 * the material `@shared/commitMessage`'s `branchChangesBody`/`aggregateTested` turn into an
 * automated pull request's body and `Tested:` trailer.
 *
 * `[]` on any failure (an unreadable ref, git unavailable) — mirroring {@link commitsAhead}'s
 * "don't know" contract rather than its "-1", because this answer's only consumer
 * (`forge/createPr.ts`'s `prBody`) has a perfectly good fallback: the card's own description,
 * used exactly as it was before this function existed. An empty array reads as "nothing to
 * summarize" and triggers that fallback; it must never be read as "the branch is empty" when
 * what actually happened is that git could not be asked.
 *
 * `-z` NUL-delimits each commit's full `%B` (subject, body and trailers together) so a
 * message containing its own blank lines can never be confused with the separator between
 * commits. `--no-merges` drops merge commits, which carry no authored work of their own to
 * summarize. `--reverse` puts them in the order they were written — the order a human
 * reading "what happened on this branch" would expect, and the order `branchChangesBody`'s
 * bullet list follows.
 */
export async function branchCommitMessages(
  dir: string,
  base: string,
  branch: string,
  host?: ExecHost,
): Promise<string[]> {
  const res = await git(
    dir,
    ['log', '-z', '--reverse', '--no-merges', '--format=%B', `${base}..${branch}`],
    host,
  );
  return res.code === 0 ? splitZ(res.stdout) : [];
}

/**
 * The subject line of every commit in `range` that touches at least one of `files` —
 * `git log --format=%s <range> -- <files>`. Read by {@link WorktreeManager.syncOntoRemoteBase}
 * on a conflict, BEFORE it aborts the rebase, so a human (or the agent it hands the
 * conflict to) can see what each side was actually trying to do to the files that clashed,
 * not just their names.
 *
 * `[]` on a failed call or an empty `files` list — the same "don't know"/"nothing to ask"
 * shape every other reader of this file uses, never read as "neither side touched anything".
 */
export async function commitSubjectsTouching(
  dir: string,
  range: string,
  files: readonly string[],
  host?: ExecHost,
): Promise<string[]> {
  if (files.length === 0) return [];
  const res = await git(dir, ['log', '--format=%s', range, '--', ...files], host);
  if (res.code !== 0) return [];
  return res.stdout.split('\n').filter((line) => line.trim() !== '');
}

/**
 * A remote's URL — `git remote get-url <remote>` — or **`''` when git won't say**.
 *
 * The empty answer is the same contract {@link currentBranch} documents: a repo with no
 * `origin`, a `git` that could not run, and a remote nobody has configured all arrive here
 * as one thing, and every caller has to treat that thing as "there is no remote" rather
 * than passing it on. Nothing downstream may hand `''` to a URL parser and believe the
 * result.
 */
export async function remoteUrl(cwd: string, remote = 'origin', host?: ExecHost): Promise<string> {
  const res = await git(cwd, ['remote', 'get-url', remote], host);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** Where and how {@link pushBranch} (and {@link fetchRef}) should push or fetch. */
export interface PushOptions {
  /**
   * Push to this URL instead of to `remote`'s configured one — an EPHEMERAL, tokenized
   * URL, passed as argv and never written anywhere. See {@link pushBranch}.
   */
  url?: string;
  /** Strings to strip out of the captured output before anybody reads it. */
  secrets?: readonly string[];
  host?: ExecHost;
  /**
   * Push only if the remote's current tip of `branch` is still `expected` —
   * `--force-with-lease`. Lets a rewritten branch (e.g. after a rebase onto a PR's base)
   * overwrite the remote without blindly clobbering a commit someone else pushed there
   * since we last fetched it.
   *
   * An EMPTY `expected` leases against the branch's absence — "push only if the remote does
   * not have this branch at all yet" — which is git's own reading of `--force-with-lease=
   * <ref>:` with nothing after the colon, and what {@link remoteBranchSha}'s `null` maps to.
   */
  forceWithLease?: { expected: string };
}

/**
 * Env that makes a push **fail rather than ask**.
 *
 * This runs in the main process, which has no terminal and no window a credential prompt
 * could appear in — so a `git push` that decides to ask for a password does not ask
 * anybody, it simply never returns, and the app is wedged with no error and nothing on
 * screen to cancel. Every route git has to a prompt is closed here:
 *
 *  - `GIT_TERMINAL_PROMPT=0` — git's own tty prompt for a username/password.
 *  - `GIT_ASKPASS=`, `SSH_ASKPASS=` — deliberately EMPTY rather than unset. Unset means
 *    "fall back to `core.askpass`, then to `SSH_ASKPASS`, then to the terminal"; empty
 *    means there is no helper to run, which is the instruction we actually want.
 *  - `SSH_ASKPASS_REQUIRE=never` — newer OpenSSH will launch an askpass GUI even with no
 *    tty, which is precisely the window nobody is looking at.
 *  - `GIT_SSH_COMMAND` — `BatchMode=yes` turns an ssh passphrase/host-key question into a
 *    failure, and the short timeout stops an unreachable host holding the process open.
 */
const NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};

/**
 * Push the work tree's current commit onto `branch` on the remote.
 *
 * `HEAD:refs/heads/<branch>` rather than `<branch>:<branch>`: the worktree's HEAD is the
 * thing that was actually worked on, and spelling the destination out in full stops git
 * guessing at a ref that does not exist upstream yet.
 *
 * Two things are load-bearing and neither is obvious:
 *
 *  - **It must fail fast, never prompt.** See {@link NO_PROMPT_ENV}; `credential.interactive
 *    =never` closes the same door on the credential *helpers* (Git Credential Manager and
 *    friends), which have their own UI and do not care about `GIT_TERMINAL_PROMPT`.
 *  - **`--set-upstream` is skipped for a tokenized URL.** `-u` records what it was given in
 *    `.git/config` as `branch.<name>.remote`, and what it was given here is a URL with a
 *    token in it — so the one thing this whole path exists to avoid (a secret written to
 *    disk, in the user's repo, surviving the push) is exactly what `-u` would do. Pushing
 *    to the named remote keeps it: there the recorded value is the word `origin`.
 */
export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  opts: PushOptions = {},
): Promise<GitResult> {
  const target = opts.url || remote;
  const tokenized = Boolean(opts.url);
  const res = await git(
    cwd,
    [
      '-c',
      'credential.interactive=never',
      'push',
      ...(tokenized ? [] : ['--set-upstream']),
      ...(opts.forceWithLease
        ? [`--force-with-lease=refs/heads/${branch}:${opts.forceWithLease.expected}`]
        : []),
      target,
      `HEAD:refs/heads/${branch}`,
    ],
    opts.host,
    NO_PROMPT_ENV,
  );
  return {
    code: res.code,
    stdout: redactSecrets(res.stdout, opts.secrets),
    stderr: redactSecrets(res.stderr, opts.secrets),
  };
}

/** The namespace this app owns for review state. See {@link reviewRef}. */
export const REVIEW_REF_PREFIX = 'refs/tm/review/';

/**
 * The ref a review's `head` or `base` snapshot lives at — `refs/tm/review/<subjectId>/<side>`.
 * This is the single source of truth for the namespace's shape: F15.6 writes these refs and
 * the pruning code (see {@link deleteRefs}) deletes everything under {@link REVIEW_REF_PREFIX}
 * without knowing `subjectId` or `side` individually.
 */
export function reviewRef(subjectId: string, side: 'head' | 'base'): string {
  return `${REVIEW_REF_PREFIX}${subjectId}/${side}`;
}

/**
 * Fetch each of `specs` (git refspecs, e.g. `+refs/heads/main:refs/tm/review/x/base`) from
 * `remoteOrUrl` in one call, without touching HEAD, the index, the work tree or any branch —
 * only the refs named on the right-hand side of `specs` change. That guarantee is what makes
 * this safe to call while the checkout is dirty or mid-rebase, and it is also why this never
 * runs a bare `git fetch <remote>`: with no refspec of its own, that falls back to the
 * configured ones and moves `refs/remotes/*`, exactly the side effect named refspecs exist to
 * avoid.
 *
 * `--no-tags`: fetching explicit refspecs still auto-follows tags into `refs/tags` unless
 * told not to, which would write refs outside the destinations `specs` actually named. Every
 * caller here fetches into a scratch or remote-tracking ref and none of them reads tags
 * (`worktreeManager.ts`'s pre-PR base and upstream fetches, `ipc.ts`'s diff fetch,
 * {@link remoteBranchSha}), so there is nothing for a tag to be useful for.
 *
 * Shares {@link pushBranch}'s "never prompt, redact secrets" contract for the same
 * tokenized-URL path. An empty `specs` is refused outright — see the guard below — rather
 * than silently becoming the bare-fetch case this function exists to avoid.
 */
export async function fetchRefspecs(
  cwd: string,
  remoteOrUrl: string,
  specs: readonly string[],
  opts: PushOptions = {},
): Promise<GitResult> {
  if (specs.length === 0) {
    return { code: 1, stdout: '', stderr: 'fetchRefspecs: no refspecs given' };
  }
  const target = opts.url || remoteOrUrl;
  const res = await git(
    cwd,
    ['-c', 'credential.interactive=never', 'fetch', '--no-tags', target, ...specs],
    opts.host,
    NO_PROMPT_ENV,
  );
  return {
    code: res.code,
    stdout: redactSecrets(res.stdout, opts.secrets),
    stderr: redactSecrets(res.stderr, opts.secrets),
  };
}

/**
 * Fetch `branch` from `remoteOrUrl` into the local ref `localRef`. The `+` on the refspec
 * force-updates `localRef` regardless of whether it would fast-forward: it is scratch space
 * the caller owns (e.g. the base ref for computing a lease's expected SHA), not a branch with
 * history of its own to protect. See {@link fetchRefspecs} for the guarantees this relies on.
 */
export async function fetchRef(
  cwd: string,
  remoteOrUrl: string,
  branch: string,
  localRef: string,
  opts: PushOptions = {},
): Promise<GitResult> {
  return fetchRefspecs(cwd, remoteOrUrl, [`+refs/heads/${branch}:${localRef}`], opts);
}

/**
 * Delete every ref under `prefix` (e.g. {@link REVIEW_REF_PREFIX}). Refuses, without running
 * git, any `prefix` that does not start with `refs/tm/` — this is the one guard that stops a
 * bad caller from pointing it at `refs/heads/` or similar and wiping real branches.
 *
 * Matches with `for-each-ref`'s own path-component rule, so `refs/tm/review/gh-1-7` does not
 * also match `refs/tm/review/gh-1-70`. Deletes one ref at a time with `update-ref -d`: hosts
 * run commands with no stdin (see {@link ExecHost.exec}), so `update-ref --stdin` isn't
 * available here. Stops at the first failure and returns it; zero matching refs is success.
 */
export async function deleteRefs(cwd: string, prefix: string, host?: ExecHost): Promise<GitResult> {
  if (!prefix.startsWith('refs/tm/')) {
    return {
      code: 1,
      stdout: '',
      stderr: `deleteRefs: refusing prefix outside refs/tm/: ${prefix}`,
    };
  }
  const listed = await git(cwd, ['for-each-ref', '--format=%(refname)', prefix], host);
  if (listed.code !== 0) return listed;
  const refs = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const ref of refs) {
    const res = await git(cwd, ['update-ref', '-d', ref], host);
    if (res.code !== 0) return res;
  }
  return { code: 0, stdout: '', stderr: '' };
}

/**
 * Every configured remote, by name, with its fetch and push URLs — parsed from
 * `git remote -v`'s `<name>\t<url> (fetch|push)` lines, grouped by name in first-seen order.
 * `[]` on a non-zero exit: the same "empty means none" contract as {@link remoteUrl}.
 */
export async function listRemotes(
  cwd: string,
  host?: ExecHost,
): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]> {
  const res = await git(cwd, ['remote', '-v'], host);
  if (res.code !== 0) return [];
  const byName = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  for (const line of res.stdout.split('\n')) {
    const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    const entry = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

/**
 * The commit `branch` points at on `remote` right now, fetched fresh — or **null** when the
 * remote doesn't have it (or the fetch couldn't be asked at all; the two are not told apart,
 * same contract as {@link fetchRef}). Exists to feed {@link PushOptions.forceWithLease}: a
 * leased push must refuse unless the remote is exactly what this process just SAW, never a
 * remote-tracking ref that may have gone stale while the worktree sat idle.
 *
 * Fetched into a scratch ref of its own (`refs/orch/remote-branch`) rather than read from
 * `FETCH_HEAD`, the same choice the pre-PR base check makes, so the two never share state.
 */
export async function remoteBranchSha(
  cwd: string,
  remote: string,
  branch: string,
  opts: PushOptions = {},
): Promise<string | null> {
  const localRef = 'refs/orch/remote-branch';
  const fetched = await fetchRef(cwd, remote, branch, localRef, opts);
  if (fetched.code !== 0) return null;
  const res = await git(cwd, ['rev-parse', localRef], opts.host);
  return res.code === 0 ? res.stdout.trim() : null;
}

/**
 * True when `a` is an ancestor of `b` — i.e. `a` is reachable by walking `b`'s history.
 * `git merge-base --is-ancestor` exits 0 for yes, 1 for no, and anything else (a ref that
 * doesn't exist) is reported as `false` rather than thrown.
 */
export async function isAncestor(
  dir: string,
  a: string,
  b: string,
  host?: ExecHost,
): Promise<boolean> {
  const res = await git(dir, ['merge-base', '--is-ancestor', a, b], host);
  return res.code === 0;
}

/**
 * The SHAs `git cherry <head> <upstream>` marks `+` — commits reachable from `upstream`
 * that have no patch-id twin among the commits reachable from `head`. `[]` on a failed
 * call, the same "don't know" shape {@link branchCommitMessages} uses, since this file's
 * one caller ({@link planBranchPush} in `forge/createPr.ts`) already has its own fallback
 * for that case and must never read an empty array as "every commit matched".
 *
 * Git's own argument order is `git cherry [<upstream> [<head>]]`: commits are walked from
 * `<head>` and each is checked for a patch-id match against `<upstream>`. Passing `head`
 * into that first slot and `upstream` into the second therefore answers a different
 * question than the names suggest — it walks commits reachable from THIS function's
 * `upstream` argument and checks each against THIS function's `head` argument. That is
 * deliberate: the one caller wants to know whether a remote branch's own tip (its
 * `upstream` here) was already rebased into the local branch (`head`) — i.e. whether
 * `git cherry HEAD <remote-sha>` prints no `+` lines — and that is exactly what this
 * parameter order spells.
 */
export async function cherryUnmatched(
  cwd: string,
  head: string,
  upstream: string,
  host?: ExecHost,
): Promise<string[]> {
  const res = await git(cwd, ['cherry', head, upstream], host);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .filter((line) => line.startsWith('+ '))
    .map((line) => line.slice(2).trim());
}

/**
 * The best common ancestor of `a` and `b` — `git merge-base`. `''` when they share no
 * history (or the call fails), which every caller here must read as "don't know" rather
 * than as a ref name; this is a SHA, never a ref itself, so it is safe to pass on as a
 * revision (e.g. `rebaseOnto`'s `upstream`) once checked for emptiness.
 */
export async function mergeBase(
  dir: string,
  a: string,
  b: string,
  host?: ExecHost,
): Promise<string> {
  const res = await git(dir, ['merge-base', a, b], host);
  return res.code === 0 ? res.stdout.trim() : '';
}

/**
 * Replace every occurrence of each secret with `***`.
 *
 * Pure, and applied to git's output before that output can reach an error message, a
 * timeline note or a log line. It is needed because git is helpful: a push to a URL it
 * could not reach quotes the URL back — token and all — in its own error, and that error
 * is precisely the string a refusal would show the human and a note would keep forever.
 *
 * The percent-encoded spelling is redacted too, because that is the form the token
 * actually takes inside the URL we built (see `createPr.ts`), and a token containing a
 * `/` or a `+` would otherwise sail straight through a search for its raw text.
 *
 * Empty and whitespace-only entries are skipped rather than matched: replacing `''`
 * everywhere would turn the output into a wall of asterisks and hide the real error.
 */
export function redactSecrets(text: string, secrets: readonly string[] | undefined): string {
  if (!secrets?.length) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret.trim()) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
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
