/**
 * Integration tests for WorktreeManager's branch-integration behavior, run against REAL
 * temporary git repositories (git is a system binary — no Electron ABI split, so these run
 * under vitest). Focus: untracked base-tree files that collide with an incoming branch must be
 * adopted (identical) or preserved (differing), never silently overwritten.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Task } from '@shared/model';
import { git } from './git';
import { classifyUntrackedCollisions, taskBranch, WorktreeManager } from './worktreeManager';

let root = '';
let repo = '';
let base = '';

async function initRepo(dir: string) {
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

/** A Project stub — only `id` and `path` are read by the integration code under test. */
function project(): Project {
  return { id: 'p1', path: repo } as unknown as Project;
}

/** Prepare a branch worktree that adds `file` with `branchContent`, ready to integrate. */
async function branchAdding(branch: string, file: string, branchContent: string): Promise<string> {
  const wt = join(root, `wt-${branch.replace(/\W/g, '_')}`);
  await git(repo, ['worktree', 'add', '-b', branch, wt, base]);
  writeFileSync(join(wt, file), branchContent);
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '--no-verify', '-m', `add ${file}`]);
  return wt;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orch-wtm-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await initRepo(repo);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-m', 'initial']);
  base = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('classifyUntrackedCollisions', () => {
  it('splits colliding untracked files into identical vs differing, ignoring unrelated ones', async () => {
    const wt = await branchAdding('orch/c1', 'shared.txt', 'BRANCH\n');
    // Base tree: one identical dupe, one differing dupe, one file the branch never adds.
    writeFileSync(join(repo, 'shared.txt'), 'BRANCH\n'); // identical to branch's version
    writeFileSync(join(repo, 'other.txt'), 'only-in-base\n'); // unrelated untracked

    const { identical, differing } = await classifyUntrackedCollisions(repo, base, 'orch/c1');
    expect(identical).toEqual(['shared.txt']);
    expect(differing).toEqual([]);

    // Now make the base copy differ → it should be classified as differing.
    writeFileSync(join(repo, 'shared.txt'), 'DIFFERENT\n');
    const again = await classifyUntrackedCollisions(repo, base, 'orch/c1');
    expect(again.identical).toEqual([]);
    expect(again.differing).toEqual(['shared.txt']);

    await git(repo, ['worktree', 'remove', '--force', wt]);
  });
});

describe('WorktreeManager.integrate — untracked collisions', () => {
  it('adopts an identical untracked dupe: merges with no stash and the file becomes tracked', async () => {
    const wtm = new WorktreeManager(root);
    const wt = await branchAdding('orch/i1', 'pkg.txt', 'shared-content\n');
    writeFileSync(join(repo, 'pkg.txt'), 'shared-content\n'); // identical untracked dupe in base

    const res = await wtm.integrate(project(), 'orch/i1', base, wt, 'integrate i1');
    expect(res.status).toBe('merged');
    expect(res.status === 'merged' && res.preserved).toBeUndefined();

    // File is now committed on base, and no stash was created.
    expect((await git(repo, ['cat-file', '-e', `HEAD:pkg.txt`])).code).toBe(0);
    expect((await git(repo, ['stash', 'list'])).stdout.trim()).toBe('');
  });

  it('preserves a differing untracked file: merges taking the branch version, base version stashed', async () => {
    const wtm = new WorktreeManager(root);
    const wt = await branchAdding('orch/i2', 'pkg.txt', 'BRANCH-VERSION\n');
    writeFileSync(join(repo, 'pkg.txt'), 'BASE-VERSION\n'); // differing untracked content in base

    const res = await wtm.integrate(project(), 'orch/i2', base, wt, 'integrate i2');
    expect(res.status).toBe('merged');
    expect(res.status === 'merged' && res.preserved?.files).toEqual(['pkg.txt']);

    // Merged tree holds the BRANCH version...
    expect((await git(repo, ['show', 'HEAD:pkg.txt'])).stdout).toBe('BRANCH-VERSION\n');
    // ...and the base's version is safe in a stash.
    expect((await git(repo, ['stash', 'list'])).stdout).toContain('orch-preserve orch/i2');
  });

  it('leaves unrelated untracked files untouched while merging', async () => {
    const wtm = new WorktreeManager(root);
    const wt = await branchAdding('orch/i3', 'feature.txt', 'feature\n');
    writeFileSync(join(repo, 'unrelated.txt'), 'keep-me\n'); // no branch adds this

    const res = await wtm.integrate(project(), 'orch/i3', base, wt, 'integrate i3');
    expect(res.status).toBe('merged');
    expect(existsSync(join(repo, 'unrelated.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'unrelated.txt'), 'utf8')).toBe('keep-me\n');
  });
});

describe('WorktreeManager.integrate — conflict ladder Rung 1 (mechanical)', () => {
  /** Commit `content` to `file` on the base branch (advancing it). */
  async function commitOnBase(file: string, content: string, msg: string) {
    writeFileSync(join(repo, file), content);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', msg]);
  }

  it('union-merges additive .gitignore churn instead of conflicting', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase('.gitignore', 'shared\n', 'seed gitignore');
    const wt = join(root, 'wt-u1');
    await git(repo, ['worktree', 'add', '-b', 'orch/u1', wt, base]);
    // Branch and base each append a different line at the SAME spot → would conflict on a
    // plain rebase; the union merge attribute should concatenate them instead.
    writeFileSync(join(wt, '.gitignore'), 'shared\nBRANCH\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch gitignore']);
    await commitOnBase('.gitignore', 'shared\nBASE\n', 'base gitignore');

    const res = await wtm.integrate(project(), 'orch/u1', base, wt, 'integrate u1');
    expect(res.status).toBe('merged');
    const merged = (await git(repo, ['show', 'HEAD:.gitignore'])).stdout;
    expect(merged).toContain('BRANCH');
    expect(merged).toContain('BASE');
  });

  it('escalates a real source conflict to "conflict" (not auto-resolved)', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase('src.txt', 'original\n', 'seed src');
    const wt = join(root, 'wt-u2');
    await git(repo, ['worktree', 'add', '-b', 'orch/u2', wt, base]);
    writeFileSync(join(wt, 'src.txt'), 'BRANCH-EDIT\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch edits src']);
    await commitOnBase('src.txt', 'BASE-EDIT\n', 'base edits src');

    const res = await wtm.integrate(project(), 'orch/u2', base, wt, 'integrate u2');
    expect(res.status).toBe('conflict');
    expect(res.status === 'conflict' && (await wtm.listConflicts(wt))).toContain('src.txt');
  });
});

describe('WorktreeManager.prepare — worktree-enabled repo that cannot isolate', () => {
  it('reports "failed" (never falls back to the base tree) when a worktree cannot be created', async () => {
    const task = { id: 't1' } as unknown as Task;
    const branch = taskBranch(task.id);
    // Occupy the branch in the main tree so `git worktree add <branch>` fails
    // ("already checked out"), and keep failing after a prune retry.
    await git(repo, ['branch', branch]);
    await git(repo, ['checkout', branch]);

    const wtm = new WorktreeManager(join(root, 'wtroot'));
    const proj = { id: 'p1', path: repo, useWorktrees: true } as unknown as Project;
    const prep = await wtm.prepare(proj, task);

    expect(prep.mode).toBe('failed');
    // The base tree is never handed back as a working dir.
    expect(prep).not.toHaveProperty('cwd');
    expect(prep.mode === 'failed' && prep.reason).toMatch(/worktree/i);
  });
});
