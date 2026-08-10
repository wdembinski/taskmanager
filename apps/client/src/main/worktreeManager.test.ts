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
import {
  classifyUntrackedCollisions,
  resolveVersionOnlyConflict,
  taskBranch,
  WorktreeManager,
} from './worktreeManager';

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
 * Rung 1.5 (mechanical, scripted) — the rung that exists so a lockfile collision, far and away
 * the commonest thing parallel worktrees conflict on, does not cost an agent session to fix by
 * running one command. The contract these pin: it resolves everything or it touches nothing.
 */
describe('WorktreeManager.integrate — conflict ladder Rung 1.5 (scripted)', () => {
  /** What `pnpm install --lockfile-only` writes for a manifest with no dependencies. */
  const REAL_LOCK =
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n" +
    '  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n';

  const manifest = (version: string, build = 'tsc'): string =>
    `{\n  "name": "fixture",\n  "version": "${version}",\n  "private": true,\n` +
    `  "scripts": {\n    "build": "${build}"\n  },\n  "dependencies": {}\n}\n`;

  /** Commit `files` on the base branch (advancing it). */
  async function commitOnBase(files: Record<string, string>, msg: string) {
    for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', msg]);
  }

  /** A worktree on `branch`, cut from base, with `files` written and committed. */
  async function branchCommitting(branch: string, files: Record<string, string>): Promise<string> {
    const wt = join(root, `wt-${branch.replace(/\W/g, '_')}`);
    await git(repo, ['worktree', 'add', '-b', branch, wt, base]);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(wt, file), content);
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '--no-verify', '-m', `branch: ${branch}`]);
    return wt;
  }

  it('rebuilds a conflicting lockfile and merges, with no escalation', async () => {
    const wtm = new WorktreeManager(root);
    // A seeded lockfile both sides then edit at the same spot — the shape of every "two cards
    // each added a dependency" collision, minus the dependencies.
    await commitOnBase(
      { 'package.json': manifest('1.0.0'), 'pnpm-lock.yaml': `${REAL_LOCK}# SEED\n` },
      'seed manifest + lock',
    );
    const wt = await branchCommitting('orch/lock1', {
      'pnpm-lock.yaml': `${REAL_LOCK}# STALE-BRANCH\n`,
      'feature.txt': 'branch work\n',
    });
    await commitOnBase({ 'pnpm-lock.yaml': `${REAL_LOCK}# STALE-BASE\n` }, 'base lock churn');

    const res = await wtm.integrate(project(), 'orch/lock1', base, wt, 'integrate lock1');

    expect(res.status).toBe('merged');
    expect(res.status === 'merged' && res.autoResolved).toEqual(['pnpm-lock.yaml']);
    // The branch's real work landed...
    expect((await git(repo, ['show', `HEAD:feature.txt`])).stdout).toBe('branch work\n');
    // ...and the lockfile in base is the one pnpm regenerated, not either side's stale text.
    const lock = (await git(repo, ['show', 'HEAD:pnpm-lock.yaml'])).stdout;
    expect(lock).toContain('lockfileVersion');
    expect(lock).not.toContain('STALE-BRANCH');
    expect(lock).not.toContain('STALE-BASE');
    expect(lock).not.toContain('<<<<<<<');
  }, 120_000);

  it('takes base’s version when package.json conflicts only on the release bump', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase({ 'package.json': manifest('1.0.0') }, 'seed manifest');
    const wt = await branchCommitting('orch/ver1', {
      'package.json': manifest('1.0.1'),
      'feature.txt': 'branch work\n',
    });
    // A release ran on base while this branch was out — its number is the newer one.
    await commitOnBase({ 'package.json': manifest('1.1.0') }, 'release 1.1.0');

    const res = await wtm.integrate(project(), 'orch/ver1', base, wt, 'integrate ver1');

    expect(res.status).toBe('merged');
    expect(res.status === 'merged' && res.autoResolved).toEqual(['package.json']);
    const merged = (await git(repo, ['show', 'HEAD:package.json'])).stdout;
    expect(merged).toContain('"version": "1.1.0"');
    expect(merged).not.toContain('<<<<<<<');
    // The rest of the manifest is untouched — this rung rewrites one line, not the file.
    expect(merged).toContain('"build": "tsc"');
    expect((await git(repo, ['show', `HEAD:feature.txt`])).stdout).toBe('branch work\n');
  }, 60_000);

  it('escalates a package.json that also conflicts somewhere other than the version', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase({ 'package.json': manifest('1.0.0') }, 'seed manifest');
    const wt = await branchCommitting('orch/ver2', { 'package.json': manifest('1.0.1', 'vite') });
    await commitOnBase({ 'package.json': manifest('1.1.0', 'rollup') }, 'base changes build');

    const res = await wtm.integrate(project(), 'orch/ver2', base, wt, 'integrate ver2');

    expect(res.status).toBe('conflict');
    expect(await wtm.listConflicts(project(), wt)).toContain('package.json');
    // Untouched: the markers git wrote are still there for the rung that can read code.
    expect(readFileSync(join(wt, 'package.json'), 'utf8')).toContain('<<<<<<<');
  }, 60_000);

  it('leaves a plain source conflict to the rungs above, resolving nothing', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase({ 'src.txt': 'original\n' }, 'seed src');
    const wt = await branchCommitting('orch/src1', { 'src.txt': 'BRANCH-EDIT\n' });
    await commitOnBase({ 'src.txt': 'BASE-EDIT\n' }, 'base edits src');

    const res = await wtm.integrate(project(), 'orch/src1', base, wt, 'integrate src1');

    expect(res.status).toBe('conflict');
    expect(readFileSync(join(wt, 'src.txt'), 'utf8')).toContain('<<<<<<<');
  }, 60_000);

  /**
   * The one that matters most: a partially resolved tree handed upwards LOOKS clean, so the AI
   * rung stages what it finds, the orchestrator continues the rebase, and a lockfile nobody
   * regenerated lands in base. All-or-nothing is the whole contract.
   */
  it('escalates a mixed lockfile + source conflict without half-resolving the lockfile', async () => {
    const wtm = new WorktreeManager(root);
    await commitOnBase(
      {
        'package.json': manifest('1.0.0'),
        'pnpm-lock.yaml': `${REAL_LOCK}# SEED\n`,
        'src.txt': 'original\n',
      },
      'seed all three',
    );
    const wt = await branchCommitting('orch/mix1', {
      'pnpm-lock.yaml': `${REAL_LOCK}# STALE-BRANCH\n`,
      'src.txt': 'BRANCH-EDIT\n',
    });
    await commitOnBase(
      { 'pnpm-lock.yaml': `${REAL_LOCK}# STALE-BASE\n`, 'src.txt': 'BASE-EDIT\n' },
      'base edits both',
    );

    const res = await wtm.integrate(project(), 'orch/mix1', base, wt, 'integrate mix1');

    expect(res.status).toBe('conflict');
    // BOTH files are still conflicted — the lockfile was never taken, regenerated, or staged.
    const conflicts = await wtm.listConflicts(project(), wt);
    expect(conflicts).toContain('pnpm-lock.yaml');
    expect(conflicts).toContain('src.txt');
    expect(readFileSync(join(wt, 'pnpm-lock.yaml'), 'utf8')).toContain('<<<<<<<');
    // Nothing is staged: the index still holds git's unmerged stages, so the next rung sees
    // exactly the tree git left rather than a half-resolved one.
    expect(
      (await git(wt, ['diff', '--cached', '--name-only', '--diff-filter=M'])).stdout.trim(),
    ).toBe('');
  }, 120_000);
});

describe('resolveVersionOnlyConflict', () => {
  const conflicted = (ours: string, theirs: string, extra = ''): string =>
    `{\n  "name": "x",\n<<<<<<< HEAD\n  "version": "${ours}",\n=======\n  "version": ` +
    `"${theirs}",\n>>>>>>> branch\n${extra}  "private": true\n}\n`;

  it('takes our (base) side when every conflict is a version line', () => {
    const out = resolveVersionOnlyConflict(conflicted('2.0.0', '1.9.9'));
    expect(out).toBe('{\n  "name": "x",\n  "version": "2.0.0",\n  "private": true\n}\n');
  });

  it('handles the diff3 conflict style, discarding the ancestor section', () => {
    const text =
      '{\n<<<<<<< HEAD\n  "version": "2.0.0",\n||||||| base\n  "version": "1.0.0",\n' +
      '=======\n  "version": "1.9.9",\n>>>>>>> branch\n}\n';
    expect(resolveVersionOnlyConflict(text)).toBe('{\n  "version": "2.0.0",\n}\n');
  });

  it('refuses a conflict that touches anything else', () => {
    const text =
      '{\n<<<<<<< HEAD\n  "version": "2.0.0",\n  "main": "base.js"\n=======\n' +
      '  "version": "1.9.9",\n  "main": "branch.js"\n>>>>>>> branch\n}\n';
    expect(resolveVersionOnlyConflict(text)).toBeNull();
  });

  it('refuses a second, non-version hunk even when the first one qualifies', () => {
    const text =
      conflicted('2.0.0', '1.9.9') +
      '<<<<<<< HEAD\n  "build": "tsc"\n=======\n  "build": "vite"\n>>>>>>> branch\n';
    expect(resolveVersionOnlyConflict(text)).toBeNull();
  });

  it('refuses a file with no markers, and one whose markers never close', () => {
    expect(resolveVersionOnlyConflict('{\n  "version": "1.0.0"\n}\n')).toBeNull();
    expect(resolveVersionOnlyConflict('<<<<<<< HEAD\n  "version": "1.0.0",\n')).toBeNull();
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

/**
 * The `stacked` chain gate (`@shared/taskChain`): the successor's branch is cut from the
 * PREDECESSOR's, so it opens with that work already in the tree — while still merging back
 * into the project's base. Those two being separate is the whole point; a start point that
 * also moved the merge target would quietly make one card's review the other's problem.
 */
describe('WorktreeManager.prepare — a branch stacked on another card’s', () => {
  function worktreeProject(): Project {
    return { id: 'p1', path: repo, useWorktrees: true, target: LOCAL_TARGET } as unknown as Project;
  }

  it('cuts the branch from the start point but still merges back into base', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-stack'));
    // The predecessor's branch, with a commit base has never seen.
    await git(repo, ['checkout', '-b', 'orch/first']);
    writeFileSync(join(repo, 'from-first.txt'), 'first\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'first card']);
    await git(repo, ['checkout', base]);

    const prep = await wtm.prepare(
      worktreeProject(),
      { id: 'second' } as unknown as Task,
      'second',
      'orch/second',
      'orch/first',
    );

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    expect(existsSync(join(prep.cwd, 'from-first.txt'))).toBe(true);
    // The merge TARGET is untouched — integration still goes to the project's base.
    expect(prep.base).toBe(base);
    expect(prep.note).toContain('orch/first');
  });

  it('falls back to base when the start point is gone, and says nothing about it', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-stack2'));

    // The commonest way for a start point to vanish: the predecessor merged and its branch
    // was deleted — by which time its work is in base anyway.
    const prep = await wtm.prepare(
      worktreeProject(),
      { id: 'third' } as unknown as Task,
      'third',
      'orch/third',
      'orch/long-gone',
    );

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    expect(prep.base).toBe(base);
    expect(prep.note).toBeUndefined();
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

/**
 * The regression that produced this suite: a card whose branch had merged PERFECTLY WELL sat
 * parked in the inbox saying "fatal: not a git repository", and its Retry button reproduced
 * that forever.
 *
 * The chain was: cleanup after the successful merge died part-way through the directory
 * (Windows won't delete a folder a still-exiting process has as its cwd), leaving files but no
 * `.git`; `prepare` tested only `existsSync` and so handed the remains to the next run as a
 * live worktree, naming the branch the merge had just deleted; and a chat reply on the card
 * settled through the same auto-integration path and tried to merge it a second time.
 *
 * Each of those three is pinned separately below — any one of them alone breaks the loop.
 */
describe('WorktreeManager — a worktree that was already merged and cleaned up', () => {
  function worktreeProject(): Project {
    return { id: 'p1', path: repo, useWorktrees: true, target: LOCAL_TARGET } as unknown as Project;
  }

  /** Exactly what a half-finished cleanup leaves: the files, minus `.git`. */
  function halfDeleteWorktree(dir: string): void {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
  }

  it('rebuilds a worktree whose .git a failed cleanup removed, instead of trusting the remains', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-debris'));
    const task = { id: 'debris1' } as unknown as Task;
    const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/whitening');
    expect(first.mode).toBe('worktree');
    if (first.mode !== 'worktree') return;

    // The merge lands and its cleanup dies half-way: `.git` gone, a build artifact left.
    writeFileSync(join(first.cwd, 'node_modules-stand-in.txt'), 'locked\n');
    halfDeleteWorktree(first.cwd);
    await git(repo, ['worktree', 'prune']);
    await git(repo, ['branch', '-D', 'feat/whitening']);

    const again = await wtm.prepare(worktreeProject(), task, task.id, 'feat/whitening');

    expect(again.mode).toBe('worktree');
    if (again.mode !== 'worktree') return;
    // A real worktree this time — not a folder that merely exists.
    expect(existsSync(join(again.cwd, '.git'))).toBe(true);
    // The debris is gone rather than inherited.
    expect(existsSync(join(again.cwd, 'node_modules-stand-in.txt'))).toBe(false);
    // And the repair is on the record, because it deleted something.
    expect(again.note).toMatch(/half-deleted/i);
  });

  it('refuses to merge a branch the previous merge deleted, rather than parking the card', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-gone'));
    const wt = await branchAdding('integration/gone', 'shipped.txt', 'work\n');

    const first = await wtm.integrate(project(), 'integration/gone', base, wt, 'integrate once');
    expect(first.status).toBe('merged');

    // The second attempt — a chat reply settling, or the Merge button pressed again.
    const second = await wtm.integrate(project(), 'integration/gone', base, wt, 'integrate twice');

    expect(second.status).toBe('nothing-to-merge');
    // Never `error`: an error parks the card and offers a Retry that repeats this exact call.
    expect(second.status === 'nothing-to-merge' && second.reason).toMatch(/no longer|already/i);
  });

  it('refuses to merge a branch that has no commits base lacks', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-empty'));
    // A branch cut from base that nobody ever committed to — what a conversation-only run
    // leaves behind.
    const wt = join(root, 'wt-empty');
    await git(repo, ['worktree', 'add', '-b', 'integration/empty', wt, base]);

    const res = await wtm.integrate(project(), 'integration/empty', base, wt, 'integrate empty');

    expect(res.status).toBe('nothing-to-merge');
    expect(res.status === 'nothing-to-merge' && res.reason).toMatch(/no commits/i);
    // The branch is left alone — refusing is not abandoning.
    expect((await git(repo, ['rev-parse', '--verify', 'integration/empty'])).code).toBe(0);
  });

  it('still merges a run that left work uncommitted — the safety commit comes first', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-dirty'));
    const wt = join(root, 'wt-dirty');
    await git(repo, ['worktree', 'add', '-b', 'integration/dirty', wt, base]);
    // No commit, just a file the agent left on disk. This must NOT read as "nothing to merge".
    writeFileSync(join(wt, 'left-behind.txt'), 'real work\n');

    const res = await wtm.integrate(project(), 'integration/dirty', base, wt, 'integrate dirty');

    expect(res.status).toBe('merged');
    expect((await git(repo, ['show', `${base}:left-behind.txt`])).stdout).toBe('real work\n');
  });

  /**
   * The other way a worktree stops having a branch, and the one that cost a whole card: a
   * step left it stranded mid-rebase, so `HEAD` was detached. `rev-parse --abbrev-ref HEAD`
   * answers the literal `HEAD` there — not empty — so the guard above sailed past it, the
   * run was launched with `HEAD` recorded as its branch, and the merge afterwards looked for
   * a branch by that name, found none, and reported `nothing-to-merge`. The work was fine and
   * committed; nothing merged it, and the step span "Running" until a human noticed.
   */
  it('refuses a worktree whose HEAD is detached instead of calling the branch "HEAD"', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-detached'));
    const task = { id: 'det1' } as unknown as Task;
    const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/mid-rebase');
    expect(first.mode).toBe('worktree');
    if (first.mode !== 'worktree') return;

    // Exactly what an interrupted `git rebase` leaves behind in that worktree.
    writeFileSync(join(first.cwd, 'step.txt'), 'work\n');
    await git(first.cwd, ['add', '-A']);
    await git(first.cwd, ['commit', '--no-verify', '-m', 'step work']);
    await git(first.cwd, ['checkout', '--detach', 'HEAD']);
    expect((await git(first.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe(
      'HEAD',
    );

    const again = await wtm.prepare(worktreeProject(), task, task.id, 'feat/mid-rebase');

    expect(again.mode).toBe('failed');
    // Never handed back as a working dir — a run there could not be merged afterwards.
    expect(again).not.toHaveProperty('cwd');
    // The reason has to name the state and a way out, or it is just "it broke".
    expect(again.mode === 'failed' && again.reason).toMatch(/detached/i);
    expect(again.mode === 'failed' && again.reason).toMatch(/rebase --abort/);
    // And it touched nothing: the commit the stranded worktree holds is still there.
    expect((await git(first.cwd, ['log', '--oneline'])).stdout).toContain('step work');
  });

  it('inspect() reads what is there without creating a worktree or resurrecting a branch', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-inspect'));
    const task = { id: 'insp1' } as unknown as Task;

    // Nothing prepared yet: no worktree, no branch, and asking must not make either.
    expect(await wtm.inspect(worktreeProject(), task.id, 'feat/never-ran')).toBeNull();
    expect((await git(repo, ['rev-parse', '--verify', 'feat/never-ran'])).code).not.toBe(0);

    const prep = await wtm.prepare(worktreeProject(), task, task.id, 'feat/inspect-me');
    expect(prep.mode).toBe('worktree');
    const live = await wtm.inspect(worktreeProject(), task.id, 'feat/inspect-me');
    expect(live?.branch).toBe('feat/inspect-me');
    expect(live?.base).toBe(base);
  });
});
