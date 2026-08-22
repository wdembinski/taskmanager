/**
 * Integration tests for the git helpers, run against a REAL temporary repository.
 * git is a system binary (no Electron ABI split), so these run fine under vitest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abortRebase,
  addWorktree,
  changedInBranch,
  commitAll,
  createRootCommit,
  currentBranch,
  deleteBranch,
  fastForwardRef,
  git,
  gitPreflight,
  hasCommits,
  hasConflicts,
  isClean,
  isRepo,
  listBranches,
  mergeFfOnly,
  pushBranch,
  rebasingBranch,
  rebaseOnto,
  redactSecrets,
  remoteUrl,
  removeWorktree,
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
