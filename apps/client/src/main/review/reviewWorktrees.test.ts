/**
 * Integration test for the review worktrees (F16.7), against a REAL temp repository and a
 * REAL temp root — both under `tmpdir()`, so neither sits inside this repo's work tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Every case spawns a dozen real `git` processes; see `git.test.ts` for the same line.
vi.setConfig({ testTimeout: 30_000 });
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@shared/execTarget';
import type { Project } from '@shared/model';
import { currentBranch, git, listBranches, listWorktrees } from '../git';
import { ReviewWorktrees } from './reviewWorktrees';

let scratch = '';
let repo = '';
let root = '';
let project: Project;
let worktrees: ReviewWorktrees;

/** Compare paths the way git prints them (forward slashes) against a native one. */
const norm = (p: string) => realpathSync.native(p).replace(/\\/g, '/').toLowerCase();
const listed = async () => (await listWorktrees(repo)).map((w) => w.path.toLowerCase());

async function commitFile(dir: string, name: string, content: string, message: string) {
  writeFileSync(join(dir, name), content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--no-verify', '-m', message]);
}

async function headOf(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** Everything about the main checkout a review must never touch. */
async function snapshot() {
  return {
    head: await headOf(repo),
    branch: await currentBranch(repo),
    status: (await git(repo, ['status', '--porcelain'])).stdout,
    branches: await listBranches(repo),
    refs: (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']))
      .stdout,
  };
}

let firstSha = '';

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orch-review-wt-'));
  repo = join(scratch, 'repo');
  root = join(scratch, 'review-worktrees');
  mkdirSync(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['checkout', '-b', 'main']);
  await commitFile(repo, 'a.txt', 'one\n', 'first');
  firstSha = await headOf(repo);
  await commitFile(repo, 'b.txt', 'two\n', 'second');
  await git(repo, ['branch', 'feature']);
  project = { id: 'p1', path: repo, target: LOCAL_TARGET } as unknown as Project;
  worktrees = new ReviewWorktrees(root);
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('ReviewWorktrees', () => {
  it('creates a detached checkout at the SHA, leaving the main checkout untouched, and removes it', async () => {
    const before = await snapshot();
    expect(before.branches).toEqual(expect.arrayContaining(['main', 'feature']));

    const made = await worktrees.create(project, 'rev1', firstSha);
    expect(made).toEqual({ ok: true, path: join(root, 'rev1') });
    const wt = join(root, 'rev1');
    expect(await headOf(wt)).toBe(firstSha);
    expect(await currentBranch(wt)).toBe('');
    const entry = (await listWorktrees(repo)).find((w) => w.path.toLowerCase() === norm(wt));
    expect(entry).toMatchObject({ head: firstSha, detached: true, branch: null });

    expect(await snapshot()).toEqual(before);

    expect(await worktrees.remove(project, 'rev1')).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(await listWorktrees(repo)).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });

  it('sweeps orphans — a forgotten worktree and a directory git never knew — but keeps a live one', async () => {
    expect((await worktrees.create(project, 'rev2', firstSha)).ok).toBe(true);
    const rev2 = join(root, 'rev2');
    // git still has rev2's admin record, but the directory is no longer a worktree.
    rmSync(join(rev2, '.git'));
    const stray = join(root, 'stray');
    mkdirSync(stray);
    writeFileSync(join(stray, 'leftover.txt'), 'x\n');
    expect((await worktrees.create(project, 'rev3', firstSha)).ok).toBe(true);
    const rev3 = join(root, 'rev3');
    const rev2Listed = norm(rev2);
    expect(await listed()).toContain(rev2Listed);

    const swept = await worktrees.sweep([project], new Set(['rev3']));

    expect(swept.failed).toEqual([]);
    expect(swept.removed).toEqual(expect.arrayContaining([rev2, stray]));
    expect(existsSync(rev2)).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(rev3)).toBe(true);
    expect(await headOf(rev3)).toBe(firstSha);
    const after = await listed();
    expect(after).toContain(norm(rev3));
    expect(after).not.toContain(rev2Listed);
  });

  it('refuses an id that could leave the root, and a SHA git cannot check out', async () => {
    const bad = await worktrees.create(project, '../x', firstSha);
    expect(bad.ok).toBe(false);
    expect(existsSync(join(scratch, 'x'))).toBe(false);

    const missing = await worktrees.create(project, 'rev4', 'deadbeef'.repeat(5));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain('deadbeef'.repeat(5));
      expect(missing.reason).toMatch(/fatal|invalid|not a/i);
    }
    expect(existsSync(join(root, 'rev4'))).toBe(false);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it('sweeps a root that does not exist as nothing to do', async () => {
    const none = new ReviewWorktrees(join(scratch, 'never-made'));
    expect(await none.sweep([project])).toEqual({ removed: [], failed: [] });
    expect(existsSync(join(scratch, 'never-made'))).toBe(false);
  });
});
