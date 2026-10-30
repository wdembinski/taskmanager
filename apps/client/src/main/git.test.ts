/**
 * Integration tests for the git helpers, run against a REAL temporary repository.
 * git is a system binary (no Electron ABI split), so these run fine under vitest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// A single test here spawns a dozen real `git` processes against a real temp repo, so its
// duration is a function of how loaded the machine is rather than of anything under test.
// `worktreeManager.test.ts` carries the same line for the same reason.
vi.setConfig({ testTimeout: 30_000 });
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abortRebase,
  addDetachedWorktree,
  addWorktree,
  branchCommitMessages,
  changedInBranch,
  cherryUnmatched,
  commitAll,
  createRootCommit,
  currentBranch,
  deleteBranch,
  deleteRefs,
  fastForwardRef,
  fetchRef,
  fetchRefspecs,
  git,
  gitPreflight,
  hasCommits,
  hasConflicts,
  isAncestor,
  isClean,
  isRepo,
  listBranches,
  listRemotes,
  listWorktrees,
  mergeBase,
  mergeFfOnly,
  parsePorcelainPaths,
  parseWorktreeList,
  pushBranch,
  rebasingBranch,
  rebaseOnto,
  redactSecrets,
  remoteBranchSha,
  remoteUrl,
  removeWorktree,
  reviewRef,
  REVIEW_REF_PREFIX,
  uncommittedPaths,
  upstreamOf,
} from './git';

let repo = '';
let base = '';

async function commitFile(dir: string, name: string, content: string, message: string) {
  writeFileSync(join(dir, name), content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--no-verify', '-m', message]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'orch-git-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await commitFile(repo, 'a.txt', 'hello\n', 'initial');
  base = await currentBranch(repo);
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('git helpers', () => {
  it('detects a repo, its branch, and a clean tree', async () => {
    expect(await isRepo(repo)).toBe(true);
    expect(await isRepo(tmpdir())).toBe(false);
    expect(base).toBeTruthy();
    expect(await isClean(repo)).toBe(true);
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(await isClean(repo)).toBe(false);
  });

  it('names uncommitted paths that isClean (untracked ignored) would miss', async () => {
    expect(await uncommittedPaths(repo)).toEqual([]);
    writeFileSync(join(repo, 'a.txt'), 'changed\n'); // tracked, modified
    writeFileSync(join(repo, 'untracked.txt'), 'new\n'); // never added
    expect(await isClean(repo)).toBe(false);
    expect(await uncommittedPaths(repo)).toEqual(
      expect.arrayContaining(['a.txt', 'untracked.txt']),
    );

    // Staging doesn't change the answer — staged, unstaged, and untracked are all "uncommitted".
    await git(repo, ['add', '-A']);
    expect(await uncommittedPaths(repo)).toEqual(
      expect.arrayContaining(['a.txt', 'untracked.txt']),
    );
  });

  it('adds a worktree on a new branch, commits there, and fast-forwards base', async () => {
    const wt = join(repo, '..', `wt-${Date.now()}`);
    expect((await addWorktree(repo, wt, 'orch/t1', base)).code).toBe(0);

    // Work in the worktree on an independent file.
    expect(await commitAll(wt, 'noop on clean tree')).toBe(false); // nothing to commit yet
    writeFileSync(join(wt, 'b.txt'), 'from-branch\n');
    expect(await commitAll(wt, 'add b')).toBe(true);

    // Base advances independently on a different file.
    await commitFile(repo, 'c.txt', 'from-base\n', 'add c');

    // Rebase the branch onto the new base (no overlap → clean), then ff-merge.
    expect((await rebaseOnto(wt, base)).code).toBe(0);
    expect(await hasConflicts(wt)).toBe(false);
    expect((await mergeFfOnly(repo, 'orch/t1')).code).toBe(0);

    // Base now contains both files.
    const log = await git(repo, ['log', '--oneline']);
    expect(log.stdout).toContain('add b');
    expect(log.stdout).toContain('add c');

    // Cleanup succeeds.
    expect((await removeWorktree(repo, wt)).code).toBe(0);
    expect((await deleteBranch(repo, 'orch/t1')).code).toBe(0);
  });

  it('autostashes uncommitted work around a clean rebase, then restores it', async () => {
    const wt = join(repo, '..', `wta-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/t1a', base);
    writeFileSync(join(wt, 'b.txt'), 'from-branch\n');
    await commitAll(wt, 'add b');
    await commitFile(repo, 'c.txt', 'from-base\n', 'add c');

    // Dirty on a TRACKED file the rebase never touches — without --autostash this refuses
    // outright ("cannot rebase: you have unstaged changes").
    writeFileSync(join(wt, 'b.txt'), 'from-branch, edited uncommitted\n');
    expect((await rebaseOnto(wt, base)).code).not.toBe(0);
    expect(await hasConflicts(wt)).toBe(false); // refused before it ever started, not a conflict

    const res = await rebaseOnto(wt, base, undefined, undefined, true);

    expect(res.code).toBe(0);
    // `.trim()`: a global `core.autocrlf` on the test machine is free to normalize line
    // endings on checkout/stash-pop, and that is not what this test is about.
    expect(readFileSync(join(wt, 'b.txt'), 'utf8').trim()).toBe('from-branch, edited uncommitted');
    expect(await isClean(wt)).toBe(false); // the autostashed edit is back, still uncommitted

    await removeWorktree(repo, wt);
  });

  it("with an upstream, rebases --onto a target unrelated to the branch's own base, replaying only its own commits", async () => {
    // `syncOntoRemoteBase`'s own shape: the branch's base has a commit of its own (`local`)
    // that the branch inherits as an ancestor, and the fresh target it must land on (`onto`)
    // comes from a different lineage entirely — the shared root, never having seen `local`.
    // `upstream: local` must exclude `local`'s own file from the replay — only the branch's
    // commit made after it travels.
    const root = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await commitFile(repo, 'local.txt', 'local-only\n', 'local-only commit');
    const upstream = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    const wt = join(repo, '..', `wto-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/onto1', base);
    writeFileSync(join(wt, 'mine.txt'), 'card work\n');
    await commitAll(wt, 'add mine');

    await git(repo, ['checkout', root]);
    await git(repo, ['checkout', '-b', 'onto-target']);
    await commitFile(repo, 'remote.txt', 'remote-only\n', 'remote-only commit');

    const res = await rebaseOnto(wt, 'onto-target', undefined, undefined, false, upstream);

    expect(res.code).toBe(0);
    expect((await git(wt, ['cat-file', '-e', 'HEAD:remote.txt'])).code).toBe(0);
    expect((await git(wt, ['cat-file', '-e', 'HEAD:mine.txt'])).code).toBe(0);
    expect((await git(wt, ['cat-file', '-e', 'HEAD:local.txt'])).code).not.toBe(0);

    await removeWorktree(repo, wt);
  });

  it('surfaces a conflicting rebase (non-zero + hasConflicts) and can abort', async () => {
    const wt = join(repo, '..', `wtc-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/t2', base);

    // Both branch and base edit the SAME line of a.txt → conflict on rebase.
    writeFileSync(join(wt, 'a.txt'), 'branch-change\n');
    await commitAll(wt, 'branch edits a');
    await commitFile(repo, 'a.txt', 'base-change\n', 'base edits a');

    const res = await rebaseOnto(wt, base);
    expect(res.code).not.toBe(0);
    expect(await hasConflicts(wt)).toBe(true);

    const { abortRebase } = await import('./git');
    expect((await abortRebase(wt)).code).toBe(0);
    expect(await hasConflicts(wt)).toBe(false);

    await removeWorktree(repo, wt);
  });

  it('reports a repo with history as having commits, and preflights it as ready', async () => {
    expect(await hasCommits(repo)).toBe(true);
    await git(repo, ['branch', 'integration']);
    const pre = await gitPreflight(repo);
    expect(pre.state).toBe('ready');
    expect(pre.branch).toBe(base);
    // The whole branch list rides along, so the project form can offer a base to merge into.
    expect(pre.branches).toEqual(expect.arrayContaining([base, 'integration']));
  });

  it('lists local branches only — a remote-tracking ref is not something we can merge into', async () => {
    await git(repo, ['branch', 'integration']);
    await git(repo, ['update-ref', 'refs/remotes/origin/nope', 'HEAD']);
    expect(await listBranches(repo)).toEqual(expect.arrayContaining([base, 'integration']));
    expect(await listBranches(repo)).not.toContain('origin/nope');
  });

  it('fast-forwards a branch nobody has checked out, without touching the work tree', async () => {
    // Never the machine's `init.defaultBranch` — that IS `base`, and a fixture that
    // accidentally names the checked-out branch tests the opposite of what it says.
    await git(repo, ['branch', 'integration']);
    const wt = join(repo, '..', `wtf-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/t3', 'integration');
    writeFileSync(join(wt, 'b.txt'), 'from-branch\n');
    await commitAll(wt, 'add b');
    // The checkout is dirty on a DIFFERENT branch — irrelevant to a ref move.
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n');

    expect((await fastForwardRef(repo, 'orch/t3', 'integration')).code).toBe(0);
    expect((await git(repo, ['cat-file', '-e', 'integration:b.txt'])).code).toBe(0);
    expect(await isClean(repo)).toBe(false); // their edit is still exactly where it was

    // The checked-out branch is refused rather than forced — `git merge` is the tool for that.
    expect((await fastForwardRef(repo, 'orch/t3', base)).code).not.toBe(0);

    await removeWorktree(repo, wt);
  });

  it('lists every path a branch touched, additions and edits alike', async () => {
    const wt = join(repo, '..', `wtd-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/t4', base);
    writeFileSync(join(wt, 'a.txt'), 'edited\n'); // modifies a file already in base
    writeFileSync(join(wt, 'b.txt'), 'new\n'); // adds a new one
    await commitAll(wt, 'edit a, add b');

    expect(await changedInBranch(repo, base, 'orch/t4')).toEqual(
      expect.arrayContaining(['a.txt', 'b.txt']),
    );
    // A ref that doesn't exist fails soft to an empty list rather than throwing.
    expect(await changedInBranch(repo, base, 'no-such-branch')).toEqual([]);

    await removeWorktree(repo, wt);
  });

  it('reads every commit a branch has over base, oldest first, full message included', async () => {
    const wt = join(repo, '..', `wte-${Date.now()}`);
    await addWorktree(repo, wt, 'orch/t5', base);
    writeFileSync(join(wt, 'b.txt'), 'one\n');
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '--no-verify', '-m', 'fix: first change', '-m', 'Tested: pnpm test']);
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '--no-verify', '-m', 'fix: second change']);

    const messages = await branchCommitMessages(repo, base, 'orch/t5');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('fix: first change');
    expect(messages[0]).toContain('Tested: pnpm test');
    expect(messages[1]).toContain('fix: second change');

    // A ref that doesn't exist fails soft to an empty list rather than throwing.
    expect(await branchCommitMessages(repo, base, 'no-such-branch')).toEqual([]);

    await removeWorktree(repo, wt);
  });
});

/**
 * A DETACHED head — what a half-finished rebase leaves behind, and the state that made a
 * step run to completion and then merge nothing: `rev-parse --abbrev-ref HEAD` answers the
 * literal string `HEAD`, which is not a branch, and the integrate step went looking for one
 * by that name. Every caller of `currentBranch` already handles "git won't say", so the
 * pseudo-name has to collapse into it.
 */
describe('git helpers — a detached HEAD', () => {
  it('reports no branch at all, not the pseudo-name "HEAD"', async () => {
    await commitFile(repo, 'b.txt', 'second\n', 'second');
    // Straight to a commit: exactly what `rebase` does between picks.
    await git(repo, ['checkout', '--detach', 'HEAD~1']);

    // git's own answer, which is what used to be passed on as a branch name…
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('HEAD');
    // …and what the helper reports instead.
    expect(await currentBranch(repo)).toBe('');
    // Still a perfectly good work tree with commits — which is why nothing else caught it.
    expect(await isRepo(repo)).toBe(true);
    expect(await hasCommits(repo)).toBe(true);

    // Back on a branch, the name comes back.
    await git(repo, ['checkout', base]);
    expect(await currentBranch(repo)).toBe(base);
  });
});

/**
 * `rebasingBranch` is the other half of that answer. "No branch checked out" is where the app
 * used to stop — it could not tell a worktree paused mid-rebase (which has a branch waiting
 * for it, and one command that puts it back) from one detached on purpose.
 */
describe('git helpers — the branch a paused rebase is replaying', () => {
  /** Leave `repo` stopped on a conflict, rebasing `topic` onto `base`. */
  async function conflictingRebase(): Promise<void> {
    await git(repo, ['checkout', '-b', 'topic']);
    await commitFile(repo, 'a.txt', 'topic\n', 'topic edit');
    await git(repo, ['checkout', base]);
    await commitFile(repo, 'a.txt', 'base\n', 'base edit');
    await git(repo, ['checkout', 'topic']);
    const rebased = await rebaseOnto(repo, base);
    expect(rebased.code).not.toBe(0); // the conflict this test is about
  }

  it('names the branch while the rebase is paused, and nothing once it is aborted', async () => {
    await conflictingRebase();

    // The worktree reports no branch — and yet it has one, which is the whole point.
    expect(await currentBranch(repo)).toBe('');
    expect(await hasConflicts(repo)).toBe(true);
    expect(await rebasingBranch(repo)).toBe('topic');

    await abortRebase(repo);
    expect(await rebasingBranch(repo)).toBeNull();
    expect(await currentBranch(repo)).toBe('topic');
  });

  it('is null in an ordinary repo, and in one detached without a rebase', async () => {
    expect(await rebasingBranch(repo)).toBeNull();
    await git(repo, ['checkout', '--detach', 'HEAD']);
    expect(await currentBranch(repo)).toBe('');
    expect(await rebasingBranch(repo)).toBeNull();
  });

  it('reads a rebase running in a WORKTREE, whose git dir is not its own `.git`', async () => {
    // The case the app actually hits: `.git` is a file pointing into the main repo's admin
    // area, so the rebase state is at a path only `rev-parse --git-path` can name.
    const wt = mkdtempSync(join(tmpdir(), 'orch-git-wt-'));
    await git(repo, ['checkout', '-b', 'wt-topic']);
    await commitFile(repo, 'a.txt', 'topic\n', 'topic edit');
    await git(repo, ['checkout', base]);
    await commitFile(repo, 'a.txt', 'base\n', 'base edit');
    await git(repo, ['worktree', 'add', wt, 'wt-topic']);
    try {
      expect((await rebaseOnto(wt, base)).code).not.toBe(0);
      expect(await currentBranch(wt)).toBe('');
      expect(await rebasingBranch(wt)).toBe('wt-topic');
    } finally {
      await git(repo, ['worktree', 'remove', '--force', wt]);
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

/**
 * An UNBORN repo: `git init` and nothing else. This is the state that produced
 * `fatal: not a valid object name: ''` — `isRepo` says yes, `currentBranch` fails and is
 * coerced to `''`, and that empty string reaches `git worktree add` as a start-point.
 */
describe('git helpers — a repo with no commits yet', () => {
  let unborn = '';

  beforeEach(async () => {
    unborn = mkdtempSync(join(tmpdir(), 'orch-unborn-'));
    await git(unborn, ['init']);
    await git(unborn, ['config', 'user.email', 'test@example.com']);
    await git(unborn, ['config', 'user.name', 'Test']);
    await git(unborn, ['config', 'commit.gpgsign', 'false']);
  });

  afterEach(() => {
    try {
      rmSync(unborn, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('is a repo, but has no commits — and currentBranch degrades to the empty string', async () => {
    expect(await isRepo(unborn)).toBe(true);
    expect(await hasCommits(unborn)).toBe(false);
    // The trap this whole fix exists for: not an error, just `''`, ready to be passed to git.
    expect(await currentBranch(unborn)).toBe('');
  });

  it('preflights as no-commits, still naming the branch HEAD points at', async () => {
    const pre = await gitPreflight(unborn);
    expect(pre.state).toBe('no-commits');
    // `branch --show-current` answers on an unborn HEAD where `rev-parse` cannot.
    expect(pre.branch).toBeTruthy();
  });

  it('createRootCommit borns it without committing any of the working tree', async () => {
    // A file sitting there uncommitted: it must stay untracked, not be swept into our commit.
    writeFileSync(join(unborn, 'secret.env'), 'TOKEN=hunter2\n');

    expect((await createRootCommit(unborn)).code).toBe(0);

    expect(await hasCommits(unborn)).toBe(true);
    expect(await currentBranch(unborn)).toBeTruthy();
    const tree = await git(unborn, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tree.stdout.trim()).toBe('');
    const untracked = await git(unborn, ['ls-files', '--others', '--exclude-standard']);
    expect(untracked.stdout).toContain('secret.env');
    expect((await gitPreflight(unborn)).state).toBe('ready');
  });

  it('preflights a plain folder as not-a-repo, and a missing path as missing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orch-plain-'));
    try {
      expect((await gitPreflight(plain)).state).toBe('not-a-repo');
      expect((await gitPreflight(join(plain, 'nope'))).state).toBe('missing');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('git helpers — reading a remote and pushing to it', () => {
  let bare = '';

  beforeEach(async () => {
    bare = mkdtempSync(join(tmpdir(), 'orch-bare-'));
    await git(bare, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', bare]);
  });

  afterEach(() => {
    try {
      rmSync(bare, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('reads origin, and answers the empty string for a remote nobody configured', async () => {
    expect(await remoteUrl(repo)).toBe(bare);
    // The `currentBranch` contract: git could not say, so we say nothing rather than guess.
    expect(await remoteUrl(repo, 'upstream')).toBe('');
  });

  it('pushes the branch into the bare repo and sets its upstream', async () => {
    const branch = 'feat/push-me';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'b.txt', 'work\n', 'work');

    const res = await pushBranch(repo, 'origin', branch);

    expect(res.code).toBe(0);
    // The commit really landed on the far side, under the ref we named.
    const there = await git(bare, ['rev-parse', `refs/heads/${branch}`]);
    expect(there.code).toBe(0);
    expect(there.stdout.trim()).toBe((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim());
    const upstream = await git(repo, ['config', `branch.${branch}.remote`]);
    expect(upstream.stdout.trim()).toBe('origin');
  });

  it('pushing to an explicit URL writes NOTHING into .git/config', async () => {
    // The tokenized-URL path in miniature: given a URL, `--set-upstream` is skipped,
    // because `-u` would record the URL — token and all — in the user's own repository.
    const branch = 'feat/by-url';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'c.txt', 'work\n', 'work');

    const res = await pushBranch(repo, 'origin', branch, { url: bare });

    expect(res.code).toBe(0);
    expect((await git(bare, ['rev-parse', `refs/heads/${branch}`])).code).toBe(0);
    const config = readFileSync(join(repo, '.git', 'config'), 'utf8');
    expect(config).not.toContain(`branch "${branch}"`);
  });

  it('fails rather than hangs when the remote is not there', async () => {
    const branch = 'feat/nowhere';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'd.txt', 'work\n', 'work');

    const res = await pushBranch(repo, 'origin', branch, {
      url: join(bare, 'does-not-exist'),
    });

    expect(res.code).not.toBe(0);
  });

  describe('upstreamOf, fetchRef, isAncestor', () => {
    it('answers null for a branch with no upstream configured', async () => {
      await git(repo, ['checkout', '-b', 'feat/no-upstream']);
      expect(await upstreamOf(repo, 'feat/no-upstream')).toBeNull();
      // The base branch itself was never pushed either.
      expect(await upstreamOf(repo, base)).toBeNull();
    });

    it('reads the remote and ref apart, for a branch name that itself has a slash', async () => {
      const branch = 'feat/has/slashes';
      await git(repo, ['checkout', '-b', branch]);
      await commitFile(repo, 'e.txt', 'work\n', 'work');
      expect((await pushBranch(repo, 'origin', branch)).code).toBe(0);

      expect(await upstreamOf(repo, branch)).toEqual({ remote: 'origin', ref: branch });
    });

    it('fetches a commit pushed from a second clone into the remote-tracking ref', async () => {
      await git(repo, ['checkout', '-b', 'feat/fetch-me']);
      expect((await pushBranch(repo, 'origin', 'feat/fetch-me')).code).toBe(0);

      // A second clone pushes a commit `repo` has never seen.
      const clone = mkdtempSync(join(tmpdir(), 'orch-clone-'));
      try {
        await git(clone, ['clone', bare, '.']);
        // A clone starts with no identity of its own — unlike `repo`, which gets one in
        // `beforeEach`. Without this, `commitFile`'s commit fails silently wherever no
        // global git identity is configured (every CI runner), and the push right after
        // it still exits 0 ("Everything up-to-date") with nothing actually pushed.
        await git(clone, ['config', 'user.email', 'test@example.com']);
        await git(clone, ['config', 'user.name', 'Test']);
        await git(clone, ['checkout', 'feat/fetch-me']);
        await commitFile(clone, 'f.txt', 'from-second-clone\n', 'from second clone');
        expect((await git(clone, ['push', 'origin', 'feat/fetch-me'])).code).toBe(0);

        const upstream = await upstreamOf(repo, 'feat/fetch-me');
        expect(upstream).toEqual({ remote: 'origin', ref: 'feat/fetch-me' });
        const fetched = await fetchRef(
          repo,
          upstream!.remote,
          upstream!.ref,
          `refs/remotes/${upstream!.remote}/${upstream!.ref}`,
        );
        expect(fetched.code).toBe(0);
        expect(
          (await git(repo, ['cat-file', '-e', 'refs/remotes/origin/feat/fetch-me:f.txt'])).code,
        ).toBe(0);
        // The local branch itself is untouched — fetch only moves the remote-tracking ref.
        expect((await git(repo, ['cat-file', '-e', 'feat/fetch-me:f.txt'])).code).not.toBe(0);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it('fails rather than hangs when fetching from an unreachable remote', async () => {
      const res = await fetchRef(
        repo,
        join(bare, 'does-not-exist'),
        base,
        `refs/remotes/origin/${base}`,
      );
      expect(res.code).not.toBe(0);
    });

    it('is true for a strict or equal ancestor, false once history has diverged', async () => {
      await commitFile(repo, 'g.txt', 'ancestor\n', 'ancestor commit');
      const ancestor = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      await commitFile(repo, 'h.txt', 'descendant\n', 'descendant commit');
      const descendant = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

      expect(await isAncestor(repo, ancestor, descendant)).toBe(true);
      expect(await isAncestor(repo, descendant, descendant)).toBe(true); // identical counts too
      expect(await isAncestor(repo, descendant, ancestor)).toBe(false);

      // Diverge: a branch off the ancestor that base never gets.
      await git(repo, ['checkout', ancestor]);
      await git(repo, ['checkout', '-b', 'feat/diverged']);
      await commitFile(repo, 'i.txt', 'diverged\n', 'diverged commit');
      expect(await isAncestor(repo, 'feat/diverged', descendant)).toBe(false);
      expect(await isAncestor(repo, descendant, 'feat/diverged')).toBe(false);
    });

    it('finds the common ancestor of two diverged branches, and reports none across unrelated histories', async () => {
      const fork = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repo, ['checkout', '-b', 'feat/left']);
      await commitFile(repo, 'left.txt', 'left\n', 'left commit');
      const left = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repo, ['checkout', fork]);
      await git(repo, ['checkout', '-b', 'feat/right']);
      await commitFile(repo, 'right.txt', 'right\n', 'right commit');

      expect(await mergeBase(repo, 'feat/left', 'feat/right')).toBe(fork);
      expect(await mergeBase(repo, left, left)).toBe(left); // identical refs

      // An orphan branch shares no history at all.
      await git(repo, ['checkout', '--orphan', 'feat/orphan']);
      await git(repo, ['rm', '-rf', '--cached', '.']);
      await commitFile(repo, 'orphan.txt', 'orphan\n', 'orphan commit');
      expect(await mergeBase(repo, 'feat/orphan', 'feat/left')).toBe('');
    });
  });

  describe('cherryUnmatched', () => {
    it('reports no unmatched commits once a rebase gave the same change a new SHA', async () => {
      await git(repo, ['checkout', '-b', 'feat/mine']);
      await commitFile(repo, 'mine.txt', 'mine\n', 'my work');
      const origSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

      // Advance `base`, then rebase `feat/mine` onto it — the same content, a new SHA.
      await git(repo, ['checkout', base]);
      await commitFile(repo, 'advance.txt', 'advance\n', 'advance the base');
      await git(repo, ['checkout', 'feat/mine']);
      expect((await git(repo, ['rebase', base])).code).toBe(0);
      const rebasedSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      expect(rebasedSha).not.toBe(origSha);

      // `origSha` (the pre-rebase tip, standing in for a stale remote) has no patch-id twin
      // missing from HEAD — the rebase just gave its own content a new SHA.
      expect(await cherryUnmatched(repo, 'HEAD', origSha)).toEqual([]);
    });

    it('names a genuinely foreign commit that HEAD has no patch-id twin for', async () => {
      await git(repo, ['checkout', '-b', 'feat/mine']);
      await commitFile(repo, 'mine.txt', 'mine\n', 'my work');
      const mineSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

      await git(repo, ['checkout', base]);
      await git(repo, ['checkout', '-b', 'feat/foreign']);
      await commitFile(repo, 'foreign.txt', 'foreign\n', 'someone else entirely');
      const foreignSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

      expect(await cherryUnmatched(repo, mineSha, foreignSha)).toEqual([foreignSha]);
    });

    it('returns an empty list rather than throwing when the call fails', async () => {
      expect(await cherryUnmatched(repo, 'HEAD', 'not-a-real-ref')).toEqual([]);
    });
  });
});

describe('git helpers — fetching a ref and pushing with a lease', () => {
  let bare = '';

  beforeEach(async () => {
    bare = mkdtempSync(join(tmpdir(), 'orch-bare-'));
    await git(bare, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', bare]);
  });

  afterEach(() => {
    try {
      rmSync(bare, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('fetches the branch into the given local ref, without touching the work tree', async () => {
    const branch = 'feat/fetch-me';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'e.txt', 'work\n', 'work');
    await pushBranch(repo, 'origin', branch);
    const remoteSha = (await git(bare, ['rev-parse', `refs/heads/${branch}`])).stdout.trim();

    const res = await fetchRef(repo, 'origin', branch, 'refs/orch/pr-base');

    expect(res.code).toBe(0);
    const landed = await git(repo, ['rev-parse', 'refs/orch/pr-base']);
    expect(landed.stdout.trim()).toBe(remoteSha);
    expect(await isClean(repo)).toBe(true);
    expect(await isAncestor(repo, landed.stdout.trim(), remoteSha)).toBe(true);
  });

  it('a lease push succeeds when pushing a rewritten branch over its known remote tip', async () => {
    const branch = 'feat/lease-ok';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'f.txt', 'v1\n', 'v1');
    await pushBranch(repo, 'origin', branch);
    const original = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    // Rewrite history the way a rebase onto a new base would.
    writeFileSync(join(repo, 'f.txt'), 'v2\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--amend', '--no-verify', '-m', 'v2']);

    const res = await pushBranch(repo, 'origin', branch, {
      forceWithLease: { expected: original },
    });

    expect(res.code).toBe(0);
    const there = await git(bare, ['rev-parse', `refs/heads/${branch}`]);
    expect(there.stdout.trim()).toBe((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim());
  });

  it('a stale lease is rejected once the remote has moved on', async () => {
    const branch = 'feat/lease-stale';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'g.txt', 'v1\n', 'v1');
    await pushBranch(repo, 'origin', branch);
    const stale = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    // Someone else moves the remote branch forward in the meantime.
    await commitFile(repo, 'g.txt', 'v2\n', 'v2 from elsewhere');
    await pushBranch(repo, 'origin', branch);

    // We still try to push, holding only the now-stale lease.
    await commitFile(repo, 'g.txt', 'v3\n', 'v3');
    const res = await pushBranch(repo, 'origin', branch, {
      forceWithLease: { expected: stale },
    });

    expect(res.code).not.toBe(0);
    // And the remote must still be exactly where the lease last saw it.
    const there = await git(bare, ['rev-parse', `refs/heads/${branch}`]);
    expect(there.stdout.trim()).not.toBe((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim());
  });

  it('redacts a token embedded in the fetch URL from the error output', async () => {
    const token = 'ghp_fetchLeakedToken';
    const res = await fetchRef(repo, 'origin', 'nope', 'refs/orch/missing', {
      url: join(bare, `does-not-exist-${token}`),
      secrets: [token],
    });

    expect(res.code).not.toBe(0);
    expect(res.stdout).not.toContain(token);
    expect(res.stderr).not.toContain(token);
  });

  it("reads a branch's current tip on the remote, and null when it has none", async () => {
    const branch = 'feat/has-a-remote-tip';
    await git(repo, ['checkout', '-b', branch]);
    await commitFile(repo, 'e.txt', 'work\n', 'work');
    await git(repo, ['push', 'origin', branch]);
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    expect(await remoteBranchSha(repo, 'origin', branch)).toBe(sha);
    expect(await remoteBranchSha(repo, 'origin', 'no-such-branch')).toBeNull();
  });

  describe('pushBranch — leased against absence', () => {
    it('an empty lease succeeds for a branch the remote has never seen', async () => {
      const branch = 'feat/lease-new';
      await git(repo, ['checkout', '-b', branch]);
      await commitFile(repo, 'f.txt', 'work\n', 'work');

      const res = await pushBranch(repo, 'origin', branch, { forceWithLease: { expected: '' } });

      expect(res.code).toBe(0);
      expect((await git(bare, ['rev-parse', `refs/heads/${branch}`])).code).toBe(0);
    });

    it('an empty lease refuses when someone else already pushed that branch', async () => {
      const branch = 'feat/lease-raced';
      // Someone else — a second clone — gets there first.
      const other = mkdtempSync(join(tmpdir(), 'orch-other-'));
      await git(other, ['clone', bare, '.']);
      await git(other, ['config', 'user.email', 'test@example.com']);
      await git(other, ['config', 'user.name', 'Test']);
      await git(other, ['config', 'commit.gpgsign', 'false']);
      await commitFile(other, 'race.txt', 'first\n', 'got there first');
      await git(other, ['push', 'origin', `HEAD:${branch}`]);
      rmSync(other, { recursive: true, force: true });

      await git(repo, ['checkout', '-b', branch]);
      await commitFile(repo, 'f.txt', 'work\n', 'work');

      const res = await pushBranch(repo, 'origin', branch, { forceWithLease: { expected: '' } });

      expect(res.code).not.toBe(0);
    });
  });

  describe('fetchRefspecs, deleteRefs, listRemotes', () => {
    /** Every path under `dir` (relative, forward-slashed), excluding `.git`. */
    function walkFiles(dir: string, sub = ''): string[] {
      const entries = readdirSync(join(dir, sub), { withFileTypes: true });
      let out: string[] = [];
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const rel = sub ? `${sub}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out = out.concat(walkFiles(dir, rel));
        else out.push(rel);
      }
      return out;
    }

    /**
     * Everything a fetch into a scratch ref must leave untouched: `HEAD`, the index, the
     * work tree's own bytes, and `status`'s view of them. The ref list is captured too, but
     * — unlike the rest — it is expected to GAIN exactly the refs a fetch was asked to write,
     * so callers compare it separately rather than for byte equality.
     */
    async function snapshot(dir: string) {
      const head = readFileSync(join(dir, '.git', 'HEAD'));
      const headSha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
      const index = readFileSync(join(dir, '.git', 'index'));
      const files = walkFiles(dir)
        .sort()
        .map((path) => ({ path, bytes: readFileSync(join(dir, path)) }));
      // --no-optional-locks: a plain `status` is free to refresh and rewrite the index as a
      // side effect of merely answering, which would make the `index` comparison above flaky.
      const status = (
        await git(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all'])
      ).stdout;
      const refLines = (
        await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'])
      ).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return { head, headSha, index, files, status, refLines };
    }

    it('fetches a PR ref into refs/tm/review, changing nothing in a dirty tree', async () => {
      // The base: pushed to the forge so `refs/heads/<base>` exists there too.
      await commitFile(repo, 'b.txt', 'b-v1\n', 'add b');
      expect((await git(repo, ['push', 'origin', base])).code).toBe(0);
      const baseSha = (await git(bare, ['rev-parse', `refs/heads/${base}`])).stdout.trim();

      // The PR commit exists only on the forge, at a GitHub-shaped ref — never in `repo`.
      await git(repo, ['checkout', '-b', 'pr-7']);
      await commitFile(repo, 'pr.txt', 'pr work\n', 'pr commit');
      const prSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      expect((await git(repo, ['push', 'origin', `${prSha}:refs/pull/7/head`])).code).toBe(0);
      await git(repo, ['checkout', base]);
      await git(repo, ['branch', '-D', 'pr-7']);
      await git(repo, ['reset', '--hard', base]);

      // Dirty the tree: an unstaged edit, a staged edit, and an untracked file.
      writeFileSync(join(repo, 'a.txt'), 'dirty-unstaged\n');
      writeFileSync(join(repo, 'b.txt'), 'dirty-staged\n');
      await git(repo, ['add', 'b.txt']);
      writeFileSync(join(repo, 'c.txt'), 'untracked\n');

      const before = await snapshot(repo);

      const headRef = reviewRef('gh-1-7', 'head');
      const baseRef = reviewRef('gh-1-7', 'base');
      const res = await fetchRefspecs(repo, 'origin', [
        `refs/pull/7/head:${headRef}`,
        `refs/heads/${base}:${baseRef}`,
      ]);

      const after = await snapshot(repo);

      expect(res.code).toBe(0);
      expect((await git(repo, ['rev-parse', headRef])).stdout.trim()).toBe(prSha);
      expect((await git(repo, ['rev-parse', baseRef])).stdout.trim()).toBe(baseSha);

      // Nothing about HEAD, the index, the work tree, or git's own view of it changed.
      expect(after.head).toEqual(before.head);
      expect(after.headSha).toBe(before.headSha);
      expect(after.index).toEqual(before.index);
      expect(after.files).toEqual(before.files);
      expect(after.status).toBe(before.status);

      // The ref list gained exactly the two review refs — nothing else moved.
      const expected = [...before.refLines, `${baseRef} ${baseSha}`, `${headRef} ${prSha}`].sort();
      expect(after.refLines.slice().sort()).toEqual(expected);
    });

    it('fetches a GitLab-shaped merge-request ref the same way', async () => {
      await git(repo, ['checkout', '-b', 'mr-3']);
      await commitFile(repo, 'mr.txt', 'mr work\n', 'mr commit');
      const mrSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      expect(
        (await git(repo, ['push', 'origin', `${mrSha}:refs/merge-requests/3/head`])).code,
      ).toBe(0);
      await git(repo, ['checkout', base]);
      await git(repo, ['branch', '-D', 'mr-3']);

      const headRef = reviewRef('gl-1-3', 'head');
      const res = await fetchRefspecs(repo, 'origin', [`refs/merge-requests/3/head:${headRef}`]);

      expect(res.code).toBe(0);
      expect((await git(repo, ['rev-parse', headRef])).stdout.trim()).toBe(mrSha);
    });

    it('refuses an empty refspec list, touching neither the work tree nor the refs', async () => {
      const statusBefore = (
        await git(repo, [
          '--no-optional-locks',
          'status',
          '--porcelain=v2',
          '--untracked-files=all',
        ])
      ).stdout;
      const refsBefore = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']))
        .stdout;

      const res = await fetchRefspecs(repo, 'origin', []);

      expect(res.code).not.toBe(0);
      const statusAfter = (
        await git(repo, [
          '--no-optional-locks',
          'status',
          '--porcelain=v2',
          '--untracked-files=all',
        ])
      ).stdout;
      const refsAfter = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']))
        .stdout;
      expect(statusAfter).toBe(statusBefore);
      expect(refsAfter).toBe(refsBefore);
    });

    it('redacts a token embedded in the URL from fetchRefspecs output', async () => {
      const token = 'ghp_fetchRefspecsLeakedToken';
      const res = await fetchRefspecs(repo, 'origin', [`refs/heads/${base}:refs/orch/missing`], {
        url: join(bare, `does-not-exist-${token}`),
        secrets: [token],
      });

      expect(res.code).not.toBe(0);
      expect(res.stdout).not.toContain(token);
      expect(res.stderr).not.toContain(token);
    });

    describe('deleteRefs', () => {
      it('deletes every ref under a review prefix, sparing a longer sibling id and all branches', async () => {
        const sha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
        await git(repo, ['update-ref', reviewRef('gh-1-7', 'head'), sha]);
        await git(repo, ['update-ref', reviewRef('gh-1-7', 'base'), sha]);
        await git(repo, ['update-ref', reviewRef('gh-1-70', 'head'), sha]);
        await git(repo, ['branch', 'keep-me']);

        const res = await deleteRefs(repo, `${REVIEW_REF_PREFIX}gh-1-7/`);

        expect(res.code).toBe(0);
        expect(
          (await git(repo, ['rev-parse', '--verify', '--quiet', reviewRef('gh-1-7', 'head')])).code,
        ).not.toBe(0);
        expect(
          (await git(repo, ['rev-parse', '--verify', '--quiet', reviewRef('gh-1-7', 'base')])).code,
        ).not.toBe(0);
        expect(
          (await git(repo, ['rev-parse', '--verify', '--quiet', reviewRef('gh-1-70', 'head')]))
            .code,
        ).toBe(0);
        expect(await listBranches(repo)).toEqual(expect.arrayContaining([base, 'keep-me']));
      });

      it('refuses a prefix outside refs/tm/, deleting nothing', async () => {
        await git(repo, ['branch', 'do-not-delete']);

        const res = await deleteRefs(repo, 'refs/heads/');

        expect(res.code).not.toBe(0);
        expect(await listBranches(repo)).toEqual(expect.arrayContaining([base, 'do-not-delete']));
      });
    });

    describe('listRemotes', () => {
      it('lists every remote with separate fetch and push URLs', async () => {
        const upstreamFetch = mkdtempSync(join(tmpdir(), 'orch-bare-upstream-'));
        const upstreamPush = mkdtempSync(join(tmpdir(), 'orch-bare-upstream-push-'));
        await git(upstreamFetch, ['init', '--bare']);
        await git(upstreamPush, ['init', '--bare']);
        try {
          await git(repo, ['remote', 'add', 'upstream', upstreamFetch]);
          await git(repo, ['remote', 'set-url', '--push', 'upstream', upstreamPush]);

          expect(await listRemotes(repo)).toEqual([
            { name: 'origin', fetchUrl: bare, pushUrl: bare },
            { name: 'upstream', fetchUrl: upstreamFetch, pushUrl: upstreamPush },
          ]);
        } finally {
          rmSync(upstreamFetch, { recursive: true, force: true });
          rmSync(upstreamPush, { recursive: true, force: true });
        }
      });

      it('is empty for a directory that is not a repo', async () => {
        const plain = mkdtempSync(join(tmpdir(), 'orch-plain-remotes-'));
        try {
          expect(await listRemotes(plain)).toEqual([]);
        } finally {
          rmSync(plain, { recursive: true, force: true });
        }
      });
    });
  });
});

/**
 * A DETACHED worktree at a fixed SHA — the read-only checkout an AI review runs against
 * (F16.7). The whole point is that it leaves the repo exactly as it found it.
 */
describe('git helpers — a detached review worktree', () => {
  /** Compare paths the way git prints them (forward slashes) against a native one. */
  const norm = (p: string) => realpathSync.native(p).replace(/\\/g, '/').toLowerCase();

  it('checks out the SHA with no branch, moving no ref and leaving the main checkout alone', async () => {
    const first = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await commitFile(repo, 'b.txt', 'second\n', 'second');
    const mainHead = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const branches = await listBranches(repo);

    const wt = join(repo, '..', `wt-detached-${Date.now()}`);
    try {
      expect((await addDetachedWorktree(repo, wt, first)).code).toBe(0);

      expect((await git(wt, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(first);
      expect(await currentBranch(wt)).toBe('');
      expect(await listBranches(repo)).toEqual(branches);
      expect((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mainHead);
      expect(await currentBranch(repo)).toBe(base);
      expect(await isClean(repo)).toBe(true);

      const listed = await listWorktrees(repo);
      expect(listed).toHaveLength(2);
      expect(norm(listed[0].path)).toBe(norm(repo));
      expect(listed[0]).toMatchObject({ head: mainHead, detached: false, branch: base });
      const mine = listed.find((w) => norm(w.path) === norm(wt));
      expect(mine).toEqual({ path: mine?.path, head: first, detached: true, branch: null });

      expect((await removeWorktree(repo, wt)).code).toBe(0);
      expect(await listWorktrees(repo)).toHaveLength(1);
      expect(await listBranches(repo)).toEqual(branches);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('lists nothing for a folder that is not a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orch-plain-'));
    try {
      expect(await listWorktrees(plain)).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('parseWorktreeList', () => {
  it('reads a branch record, a detached record and a bare record', () => {
    const out = [
      'worktree /srv/bare.git',
      'bare',
      '',
      'worktree C:/Users/me/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/Users/me/review/r1',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'locked',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/srv/bare.git', head: '', detached: false, branch: null },
      {
        path: 'C:/Users/me/repo',
        head: '1111111111111111111111111111111111111111',
        detached: false,
        branch: 'main',
      },
      {
        path: 'C:/Users/me/review/r1',
        head: '2222222222222222222222222222222222222222',
        detached: true,
        branch: null,
      },
    ]);
  });

  it('keeps a path with spaces, a slashed branch name, and CRLF line ends', () => {
    const out = 'worktree /home/me/my repo\r\nHEAD abc\r\nbranch refs/heads/orch/feature-x\r\n\r\n';
    expect(parseWorktreeList(out)).toEqual([
      { path: '/home/me/my repo', head: 'abc', detached: false, branch: 'orch/feature-x' },
    ]);
  });

  it('answers nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('parsePorcelainPaths', () => {
  it('reads the path past the two-letter status code and the space', () => {
    expect(parsePorcelainPaths(' M a.txt\n?? b.txt\nA  c.txt\n')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });

  it('keeps only the new name of a rename, not the arrow or the old one', () => {
    expect(parsePorcelainPaths('R  old.txt -> new.txt\n')).toEqual(['new.txt']);
  });

  it('is empty for an empty or blank-only status', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
    expect(parsePorcelainPaths('\n\n')).toEqual([]);
  });
});

describe('parsePorcelainPaths', () => {
  it('reads the path past the two-letter status code and the space', () => {
    expect(parsePorcelainPaths(' M a.txt\n?? b.txt\nA  c.txt\n')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });

  it('keeps only the new name of a rename, not the arrow or the old one', () => {
    expect(parsePorcelainPaths('R  old.txt -> new.txt\n')).toEqual(['new.txt']);
  });

  it('is empty for an empty or blank-only status', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
    expect(parsePorcelainPaths('\n\n')).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('strips a token out of text, in raw and URL-encoded form', () => {
    const token = 'ghp_a/b+c';
    const text = `remote: rejected https://x-access-token:${encodeURIComponent(token)}@h/o/r (${token})`;
    const out = redactSecrets(text, [token]);
    expect(out).not.toContain('ghp_a');
    expect(out).toContain('***');
  });

  it('leaves the text alone when there is nothing to hide', () => {
    expect(redactSecrets('all fine', [])).toBe('all fine');
    expect(redactSecrets('all fine', undefined)).toBe('all fine');
    // An empty secret must not match everywhere and bury the real error.
    expect(redactSecrets('all fine', ['', '   '])).toBe('all fine');
  });
});
