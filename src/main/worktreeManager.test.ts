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
import { LOCAL_TARGET } from '@shared/execTarget';
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
  // `target` decides which machine git runs on, so it is part of a valid project
  // even in a fixture — these tests exercise the local host.
  return { id: 'p1', path: repo, target: LOCAL_TARGET } as unknown as Project;
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
    expect(res.status === 'conflict' && (await wtm.listConflicts(project(), wt))).toContain(
      'src.txt',
    );
  });
});

/**
 * The reported bug: "Base branch «development» has uncommitted changes, so branch «…» was not
 * merged" on a repo where nothing else was running. Integration used to be a `git merge` in the
 * main checkout, which can only ever advance the branch that is CHECKED OUT — so it had to
 * refuse whenever that tree was dirty, even when the human's uncommitted work had nothing to do
 * with the base branch. A base branch that isn't checked out is now integrated by moving the
 * ref, which touches no file and therefore cannot be blocked by one.
 */
describe('WorktreeManager.integrate — a base branch that is not checked out', () => {
  /** A project pinned to `branch` as its integration base. */
  function pinned(branch: string): Project {
    return { id: 'p1', path: repo, baseBranch: branch, target: LOCAL_TARGET } as unknown as Project;
  }

  it('merges into the pinned base while the checkout sits dirty on another branch', async () => {
    const wtm = new WorktreeManager(root);
    // Never named after the machine's `init.defaultBranch` — that IS `base`, and a fixture
    // that accidentally names the checked-out branch tests the opposite of what it says.
    await git(repo, ['branch', 'integration']);
    const wt = await branchAdding('orch/nb1', 'feature.txt', 'feature\n');
    // The human is on another branch, mid-edit — none of it concerns `integration`.
    await git(repo, ['checkout', '-b', 'scratch']);
    writeFileSync(join(repo, 'seed.txt'), 'my uncommitted work\n');

    const res = await wtm.integrate(pinned('integration'), 'orch/nb1', 'integration', wt, 'nb1');

    expect(res.status).toBe('merged');
    // `integration` really moved...
    expect((await git(repo, ['cat-file', '-e', 'integration:feature.txt'])).code).toBe(0);
    // ...and the dirty file the human was editing was never touched.
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('my uncommitted work\n');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    // The branch and its worktree are cleaned up exactly as a checked-out merge does.
    expect((await git(repo, ['rev-parse', '--verify', '--quiet', 'orch/nb1'])).code).not.toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it('still refuses when the dirty tree IS on the base branch — that merge would overwrite it', async () => {
    const wtm = new WorktreeManager(root);
    const wt = await branchAdding('orch/nb2', 'feature.txt', 'feature\n');
    writeFileSync(join(repo, 'seed.txt'), 'my uncommitted work\n');

    const res = await wtm.integrate(pinned(base), 'orch/nb2', base, wt, 'nb2');

    expect(res.status).toBe('dirty-base');
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('my uncommitted work\n');
  });
});

describe('WorktreeManager.prepare — a project that names its base branch', () => {
  /** A project pinned to `branch`, with worktrees on. */
  function pinnedProject(branch: string): Project {
    return {
      id: 'p1',
      path: repo,
      useWorktrees: true,
      baseBranch: branch,
      target: LOCAL_TARGET,
    } as unknown as Project;
  }

  it('branches from the pinned base, not from whatever is checked out', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-pin'));
    // `integration` gets a commit the checked-out branch will never have.
    await git(repo, ['checkout', '-b', 'integration']);
    writeFileSync(join(repo, 'only-on-integration.txt'), 'dev\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'integration only']);
    await git(repo, ['checkout', base]);

    const prep = await wtm.prepare(pinnedProject('integration'), { id: 'pin1' } as unknown as Task);

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    expect(prep.base).toBe('integration');
    expect(existsSync(join(prep.cwd, 'only-on-integration.txt'))).toBe(true);
  });

  it('parks the task, naming the branches that DO exist, when the pinned base is gone', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-pin2'));

    const prep = await wtm.prepare(pinnedProject('no-such-branch'), {
      id: 'pin2',
    } as unknown as Task);

    expect(prep.mode).toBe('failed');
    expect(prep).not.toHaveProperty('cwd');
    // The message says which branch is missing AND which ones are there, so the fix is obvious.
    expect(prep.mode === 'failed' && prep.reason).toContain('"no-such-branch"');
    expect(prep.mode === 'failed' && prep.reason).toContain(base);
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
    const proj = {
      id: 'p1',
      path: repo,
      useWorktrees: true,
      target: LOCAL_TARGET,
    } as unknown as Project;
    const prep = await wtm.prepare(proj, task);

    expect(prep.mode).toBe('failed');
    // The base tree is never handed back as a working dir.
    expect(prep).not.toHaveProperty('cwd');
    expect(prep.mode === 'failed' && prep.reason).toMatch(/worktree/i);
  });
});

/**
 * The regression this suite exists for: a project pointed at a `git init`-ed repo with NO
 * commits. `git worktree add -b <branch> <path> <base>` cannot work there — there is no commit
 * to branch from — and because `currentBranch` reports its failure as `''`, the base handed to
 * git was an empty string, which git rejected as `fatal: not a valid object name: ''`. Every
 * recovery button then re-ran the same impossible command.
 */
describe('WorktreeManager.prepare — a repo with no commits yet', () => {
  let unborn = '';

  beforeEach(async () => {
    unborn = join(root, 'unborn');
    mkdirSync(unborn);
    await initRepo(unborn);
  });

  function unbornProject(): Project {
    return {
      id: 'p-unborn',
      path: unborn,
      useWorktrees: true,
      target: LOCAL_TARGET,
    } as unknown as Project;
  }

  it('borns the repo and isolates the task, instead of dying on an empty start-point', async () => {
    const task = { id: 'u1' } as unknown as Task;
    const wtm = new WorktreeManager(join(root, 'wtroot-unborn'));

    const prep = await wtm.prepare(unbornProject(), task, task.id, 'feat/travel-planning-feature');

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    expect(prep.branch).toBe('feat/travel-planning-feature');
    // The base is a real branch name — never the `''` that produced the old fatal.
    expect(prep.base).toBeTruthy();
    expect(existsSync(prep.cwd)).toBe(true);
    // The write we made in their repo is reported back so the run's activity can say so.
    expect(prep.note).toMatch(/no commits/i);

    // The base repo now has exactly one, EMPTY commit — none of its files were swept in.
    const log = await git(unborn, ['log', '--oneline']);
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    expect((await git(unborn, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.trim()).toBe('');
  });

  it('leaves an untracked file in the unborn repo untracked', async () => {
    writeFileSync(join(unborn, 'draft.txt'), 'not mine to commit\n');
    const wtm = new WorktreeManager(join(root, 'wtroot-unborn2'));

    await wtm.prepare(unbornProject(), { id: 'u2' } as unknown as Task);

    const untracked = await git(unborn, ['ls-files', '--others', '--exclude-standard']);
    expect(untracked.stdout).toContain('draft.txt');
  });

  it('parks the task with a reason naming the real cause when it cannot even commit', async () => {
    // A stale index lock: `git commit` refuses outright. Chosen over unsetting the identity
    // because a developer's GLOBAL user.name/user.email would still satisfy the commit, so
    // that version of this test passed or failed depending on whose machine ran it.
    writeFileSync(join(unborn, '.git', 'index.lock'), '');

    const wtm = new WorktreeManager(join(root, 'wtroot-unborn3'));
    const prep = await wtm.prepare(unbornProject(), { id: 'u3' } as unknown as Task);

    expect(prep.mode).toBe('failed');
    expect(prep).not.toHaveProperty('cwd');
    // The message must name the cause (no commits), not git's `not a valid object name: ''`.
    expect(prep.mode === 'failed' && prep.reason).toMatch(/no commits/i);
  });
});
