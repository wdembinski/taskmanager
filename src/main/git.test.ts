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
  currentBranch,
  deleteBranch,
  git,
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
});
