/**
 * Integration tests for the git helpers, run against a REAL temporary repository.
 * git is a system binary (no Electron ABI split), so these run fine under vitest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWorktree,
  commitAll,
  createRootCommit,
  currentBranch,
  deleteBranch,
  git,
  gitPreflight,
  hasCommits,
  hasConflicts,
  isClean,
  isRepo,
  mergeFfOnly,
  rebaseOnto,
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
    const pre = await gitPreflight(repo);
    expect(pre.state).toBe('ready');
    expect(pre.branch).toBe(base);
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
