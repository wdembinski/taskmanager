/**
 * Integration tests for WorktreeManager's branch-integration behavior, run against REAL
 * temporary git repositories (git is a system binary — no Electron ABI split, so these run
 * under vitest). Focus: untracked base-tree files that collide with an incoming branch must be
 * adopted (identical) or preserved (differing), never silently overwritten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// A single test here spawns a dozen real `git` processes against a real temp repo, so its
// duration is a function of how loaded the machine is rather than of anything under test. In
// isolation the slowest is ~2s; inside the full workspace run — which the mirror round grew
// by ~470 tests — two of them crossed vitest's 5s default and went red on timing alone. The
// budget is raised only for this file, so a genuinely hung UNIT test still fails fast.
// `worktreeWsl.test.ts` carries the same line for the same reason.
vi.setConfig({ testTimeout: 30_000 });
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Task } from '@shared/model';
import { LOCAL_TARGET } from '@shared/execTarget';
import { currentBranch, git, hasConflicts, rebaseOnto } from './git';
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
 * A rebase this app already paused, met by a SECOND integration attempt — "Retry integration"
 * in the inbox, or the automatic merge at the end of the next run.
 *
 * This is the state a card is in for as long as its conflict is unresolved, and it used to be
 * the state from which nothing could ever succeed. `git rebase <base>` on top of a paused
 * rebase fails with *"there is already a rebase-merge directory"*; that failure names no
 * conflicted path, so it was read as "not a conflict, some other error" and answered with
 * `rebase --abort` — which threw away whatever had been resolved and put the branch back where
 * it started, so the next press repeated the whole cycle. `rerere` made it worse, not better:
 * a repo that has recorded the resolution replays and STAGES it, so the retry saw a clean tree
 * and aborted a rebase that only needed `--continue`.
 */
describe('WorktreeManager.integrate — a rebase already paused in the worktree', () => {
  async function commitOnBase(file: string, content: string, msg: string) {
    writeFileSync(join(repo, file), content);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', msg]);
  }

  /**
   * A branch whose first commit conflicts with base and whose second does not — the shape of
   * every branch that has been open long enough to matter, and the one a single `--continue`
   * is not enough for.
   */
  async function branchStoppedOnConflict(
    name: string,
  ): Promise<{ wtm: WorktreeManager; wt: string }> {
    const wtm = new WorktreeManager(root);
    await commitOnBase('src.txt', 'original\n', 'seed src');
    const wt = join(root, `wt-${name}`);
    await git(repo, ['worktree', 'add', '-b', `orch/${name}`, wt, base]);
    writeFileSync(join(wt, 'src.txt'), 'BRANCH-EDIT\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch edits src']);
    writeFileSync(join(wt, 'later.txt'), 'later\n');
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '--no-verify', '-m', 'a second commit that does not conflict']);
    await commitOnBase('src.txt', 'BASE-EDIT\n', 'base edits src');

    const first = await wtm.integrate(project(), `orch/${name}`, base, wt, 'integrate');
    expect(first.status).toBe('conflict'); // the rebase is now paused, mid-flight
    return { wtm, wt };
  }

  it('continues a paused rebase whose resolutions are staged, instead of restarting it', async () => {
    const { wtm, wt } = await branchStoppedOnConflict('p1');
    // What Rung 2's agent is told to do, and all it is told to do: resolve the markers and
    // stage them, leaving the `--continue` to the orchestrator. (It is also exactly what
    // `rerere` does by itself on a repo that has seen the conflict before.)
    writeFileSync(join(wt, 'src.txt'), 'RESOLVED-BY-HAND\n');
    await git(wt, ['add', 'src.txt']);
    expect(await hasConflicts(wt)).toBe(false);

    const res = await wtm.integrate(project(), 'orch/p1', base, wt, 'integrate again');
    expect(res.status).toBe('merged');
    // The resolution landed, and so did the commit after it — a `--continue` that stops at
    // the first patch has not finished the rebase.
    expect((await git(repo, ['show', 'HEAD:src.txt'])).stdout).toContain('RESOLVED-BY-HAND');
    expect((await git(repo, ['show', 'HEAD:later.txt'])).stdout).toContain('later');
  });

  it('hands a still-conflicted paused rebase back to the ladder, without aborting it', async () => {
    const { wtm, wt } = await branchStoppedOnConflict('p2');
    const res = await wtm.integrate(project(), 'orch/p2', base, wt, 'integrate again');
    // `conflict` sends it up the ladder (AI, then a human) — which is where an unresolved
    // conflict belongs. `error` was the old answer, and it came with an abort.
    expect(res.status).toBe('conflict');
    // The markers are still there: nothing undid the rebase behind the human's back.
    expect(readFileSync(join(wt, 'src.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await hasConflicts(wt)).toBe(true);
  });

  /**
   * The reported failure, reproduced exactly. `rerere` ("reuse recorded resolution") is on in
   * plenty of repos, and it turns a branch that has been rebased before into one that can
   * never be merged again: on the next attempt git replays the recorded resolution, STAGES it,
   * and still stops. The tree is then clean and the index full — which the old code read as
   * "the rebase failed and there are no conflicts", i.e. as an unexplained error, and answered
   * with an abort. The human's log said it in one line, twice in six seconds:
   *
   *     Rebasing (1/13)
   *     error: could not apply 234684b... refactor(mr): make merge requests provider-neutral
   *     Staged 'apps/web/src/board/httpTransport.ts' using previous resolution.
   */
  it('continues through a stop that rerere already staged, instead of calling it an error', async () => {
    const wtm = new WorktreeManager(root);
    await git(repo, ['config', 'rerere.enabled', 'true']);
    // `autoUpdate` is what makes the replayed resolution reach the INDEX rather than only the
    // working tree — i.e. what makes git print "Staged … using previous resolution", which is
    // the line the human's failing merge printed. Without it rerere leaves the path unmerged
    // and the conflict is visible in the ordinary way.
    await git(repo, ['config', 'rerere.autoUpdate', 'true']);
    await commitOnBase('src.txt', 'original\n', 'seed src');
    const wt = join(root, 'wt-rr');
    await git(repo, ['worktree', 'add', '-b', 'orch/rr', wt, base]);
    writeFileSync(join(wt, 'src.txt'), 'BRANCH-EDIT\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch edits src']);
    const branchTip = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
    await commitOnBase('src.txt', 'BASE-EDIT\n', 'base edits src');

    // Rebase once and resolve by hand, so rerere records the resolution…
    await git(wt, ['rebase', base]);
    writeFileSync(join(wt, 'src.txt'), 'RESOLVED\n');
    await git(wt, ['add', 'src.txt']);
    await git(wt, ['-c', 'core.editor=true', 'rebase', '--continue']);
    // …then put the branch back where it was, so the merge meets the conflict a second time.
    await git(wt, ['reset', '--hard', branchTip]);

    const res = await wtm.integrate(project(), 'orch/rr', base, wt, 'integrate rr');
    expect(res.status).toBe('merged');
    expect((await git(repo, ['show', 'HEAD:src.txt'])).stdout).toContain('RESOLVED');
  });

  it('lands a resolution that reproduces base, dropping the patch it emptied', async () => {
    const { wtm, wt } = await branchStoppedOnConflict('p3');
    // Taking base's side leaves the patch with nothing in it. Git drops such a commit on
    // `--continue` by itself; `advancePausedRebase` covers the case where it refuses instead.
    // What this pins is the outcome either way: base gets the rest of the branch, and never a
    // fast-forward to the branch's PRE-rebase tip (which is where its ref still points).
    writeFileSync(join(wt, 'src.txt'), 'BASE-EDIT\n');
    await git(wt, ['add', 'src.txt']);

    const res = await wtm.finishAfterConflict(project(), 'orch/p3', base, wt);
    expect(res.status).toBe('merged');
    expect((await git(repo, ['show', 'HEAD:src.txt'])).stdout).toBe('BASE-EDIT\n');
    expect((await git(repo, ['show', 'HEAD:later.txt'])).stdout).toContain('later');
  });

  it('reports each stop of a rebase that stops more than once, then lands it', async () => {
    // Two conflicting commits, so the rebase stops twice. A branch open long enough to
    // conflict usually conflicts more than once, and each stop has to reach a human (or Rung
    // 2) rather than one of them being merged over.
    const wtm = new WorktreeManager(root);
    await commitOnBase('a.txt', 'original-a\n', 'seed a');
    await commitOnBase('b.txt', 'original-b\n', 'seed b');
    const wt = join(root, 'wt-p4');
    await git(repo, ['worktree', 'add', '-b', 'orch/p4', wt, base]);
    writeFileSync(join(wt, 'a.txt'), 'BRANCH-A\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch edits a']);
    writeFileSync(join(wt, 'b.txt'), 'BRANCH-B\n');
    await git(wt, ['commit', '--no-verify', '-am', 'branch edits b']);
    await commitOnBase('a.txt', 'BASE-A\n', 'base edits a');
    await commitOnBase('b.txt', 'BASE-B\n', 'base edits b');

    expect((await wtm.integrate(project(), 'orch/p4', base, wt, 'integrate')).status).toBe(
      'conflict',
    );
    writeFileSync(join(wt, 'a.txt'), 'RESOLVED-A\n');
    await git(wt, ['add', 'a.txt']);
    // The second stop is reported honestly rather than merged over.
    const mid = await wtm.finishAfterConflict(project(), 'orch/p4', base, wt);
    expect(mid.status).toBe('conflict');
    writeFileSync(join(wt, 'b.txt'), 'RESOLVED-B\n');
    await git(wt, ['add', 'b.txt']);

    const res = await wtm.finishAfterConflict(project(), 'orch/p4', base, wt);
    expect(res.status).toBe('merged');
    expect((await git(repo, ['show', 'HEAD:a.txt'])).stdout).toBe('RESOLVED-A\n');
    expect((await git(repo, ['show', 'HEAD:b.txt'])).stdout).toBe('RESOLVED-B\n');
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

/**
 * The regression this suite exists for: a card whose worktree was left part-way through a
 * rebase. `HEAD` is detached there, so `currentBranch` reports nothing, and preparation used
 * to refuse — identically, every time the human pressed anything, with "Retry fresh (discard
 * branch)" as the only offered way out. It is a state one `rebase --abort` undoes without
 * losing a commit, and any agent that rebases in its own worktree can produce it.
 */
describe('WorktreeManager.prepare — a worktree stranded mid-rebase', () => {
  function worktreeProject(): Project {
    return { id: 'p1', path: repo, useWorktrees: true, target: LOCAL_TARGET } as unknown as Project;
  }

  /**
   * Give `taskId` a worktree, then strand it: a commit on its branch and a conflicting one on
   * base, rebased into a stop. Returns the worktree path, which has no branch checked out.
   */
  async function strand(wtm: WorktreeManager, taskId: string): Promise<string> {
    const first = await wtm.prepare(worktreeProject(), { id: taskId } as unknown as Task);
    expect(first.mode).toBe('worktree');
    if (first.mode !== 'worktree') throw new Error('no worktree');
    writeFileSync(join(first.cwd, 'seed.txt'), 'branch side\n');
    await git(first.cwd, ['commit', '--no-verify', '-am', 'branch edit']);
    writeFileSync(join(repo, 'seed.txt'), 'base side\n');
    await git(repo, ['commit', '--no-verify', '-am', 'base edit']);

    expect((await rebaseOnto(first.cwd, base)).code).not.toBe(0);
    expect(await currentBranch(first.cwd)).toBe(''); // the state under test
    return first.cwd;
  }

  it('undoes the abandoned rebase, runs on the restored branch, and says so on the card', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-reb1'));
    const cwd = await strand(wtm, 'reb1');

    const prep = await wtm.prepare(worktreeProject(), { id: 'reb1' } as unknown as Task);

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    // The SAME worktree, back on its own branch — not a rebuilt one, and not the base tree.
    expect(prep.cwd).toBe(cwd);
    expect(prep.branch).toBe(taskBranch('reb1'));
    expect(await currentBranch(cwd)).toBe(taskBranch('reb1'));
    // Nothing of the branch was lost, and the agent gets a tree with no conflict markers.
    expect(await hasConflicts(cwd)).toBe(false);
    // Read line-normalized: a checkout on Windows may write CRLF back (core.autocrlf).
    expect(readFileSync(join(cwd, 'seed.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'branch side\n',
    );
    // A write nobody asked for belongs on the timeline.
    expect(prep.note).toMatch(/rebase/i);
    expect(prep.note).toContain(taskBranch('reb1'));
  });

  it('leaves the pause alone when resolving that rebase IS the run', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-reb2'));
    const cwd = await strand(wtm, 'reb2');

    const prep = await wtm.prepare(
      worktreeProject(),
      { id: 'reb2' } as unknown as Task,
      'reb2',
      undefined,
      undefined,
      { resumingRebase: true },
    );

    expect(prep.mode).toBe('worktree');
    if (prep.mode !== 'worktree') return;
    // The branch the rebase will land on, read out of the paused rebase rather than guessed.
    expect(prep.branch).toBe(taskBranch('reb2'));
    // The conflict the run exists to resolve is still there, and nothing was announced.
    expect(await hasConflicts(cwd)).toBe(true);
    expect(await currentBranch(cwd)).toBe('');
    expect(prep.note).toBeUndefined();
  });

  it('still refuses a HEAD detached for some other reason, and names what it checked', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-reb3'));
    const first = await wtm.prepare(worktreeProject(), { id: 'reb3' } as unknown as Task);
    if (first.mode !== 'worktree') throw new Error('no worktree');
    await git(first.cwd, ['checkout', '--detach', 'HEAD']);

    const prep = await wtm.prepare(worktreeProject(), { id: 'reb3' } as unknown as Task);

    expect(prep.mode).toBe('failed');
    expect(prep).not.toHaveProperty('cwd');
    expect(prep.mode === 'failed' && prep.reason).toContain('no rebase is in progress');
    expect(prep.mode === 'failed' && prep.reason).toContain(first.cwd);
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
   * The other way a worktree stops having a branch, and the one that cost a whole card:
   * `HEAD` detached. `rev-parse --abbrev-ref HEAD` answers the literal `HEAD` there — not
   * empty — so the guard above sailed past it, the run was launched with `HEAD` recorded as
   * its branch, and the merge afterwards looked for a branch by that name, found none, and
   * reported `nothing-to-merge`. The work was fine and committed; nothing merged it, and the
   * step span "Running" until a human noticed.
   *
   * Detached by a bare `checkout`, as here, is still refused. The far commoner cause — a
   * rebase abandoned in the worktree — is recovered instead; see the suite above.
   */
  it('refuses a worktree whose HEAD is detached instead of calling the branch "HEAD"', async () => {
    const wtm = new WorktreeManager(join(root, 'wtroot-detached'));
    const task = { id: 'det1' } as unknown as Task;
    const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/mid-rebase');
    expect(first.mode).toBe('worktree');
    if (first.mode !== 'worktree') return;

    // A HEAD detached on purpose — no rebase in progress to undo.
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
    expect(again.mode === 'failed' && again.reason).toMatch(/checkout <branch>/);
    // And it touched nothing: the commit the stranded worktree holds is still there.
    expect((await git(first.cwd, ['log', '--oneline'])).stdout).toContain('step work');
  });

  /**
   * The regression THIS group exists for, one turn of the screw further on: the debris could
   * not be deleted at all.
   *
   * A card's first steps merged, the merge's cleanup died on a lock inside `node_modules`
   * (Windows holds a file open and `rmSync` gives up with `ENOTEMPTY`), and the next step
   * added to that card — days later, with nothing to do with the lock — was parked on "Delete
   * that directory and retry". Every button on the card re-ran the same impossible delete.
   *
   * The lock is invisible to the person being asked to win a race against it, so preparation
   * builds the worktree NEXT DOOR instead and says what it left behind.
   */
  describe('when the leftover directory cannot be deleted', () => {
    /** The delete that never succeeds — a lock we cannot reproduce portably. */
    type Debris = { removeDebris: (appPath: string) => Promise<string | null> };
    const STUCK =
      "ENOTEMPTY: directory not empty, rmdir '…\\node_modules\\.pnpm\\electron\\dist\\resources'";

    function jam(wtm: WorktreeManager) {
      return vi.spyOn(wtm as unknown as Debris, 'removeDebris').mockResolvedValue(STUCK);
    }

    /** Exactly what a merge whose cleanup half-failed leaves: files, no `.git`, no branch. */
    async function mergeAndStrandCleanup(cwd: string, branch: string): Promise<void> {
      writeFileSync(join(cwd, 'locked-node-modules.txt'), 'held open\n');
      rmSync(join(cwd, '.git'), { recursive: true, force: true });
      await git(repo, ['worktree', 'prune']);
      await git(repo, ['branch', '-D', branch]);
    }

    it('builds the next step a fresh worktree beside the debris instead of parking it', async () => {
      const wtm = new WorktreeManager(join(root, 'wtroot-stuck'));
      const task = { id: 'stuck1' } as unknown as Task;
      const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck');
      expect(first.mode).toBe('worktree');
      if (first.mode !== 'worktree') return;
      await mergeAndStrandCleanup(first.cwd, 'feat/stuck');
      jam(wtm);

      const again = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck');

      // The step RUNS — the whole point. Not `failed`, and not in the base tree.
      expect(again.mode).toBe('worktree');
      if (again.mode !== 'worktree') return;
      expect(again.cwd).not.toBe(first.cwd);
      expect(again.cwd).toBe(`${first.cwd}-2`);
      expect(existsSync(join(again.cwd, '.git'))).toBe(true);
      expect(again.branch).toBe('feat/stuck');
      expect(again.base).toBe(base);
      // The directory nobody could delete is left exactly as it was, and named — a leftover
      // on the timeline can be swept up, a silent one poisons the next run.
      expect(existsSync(join(first.cwd, 'locked-node-modules.txt'))).toBe(true);
      expect(again.note).toContain(first.cwd);
      expect(again.note).toMatch(/could not be deleted/i);
    });

    it('finds that fresh worktree again — a resumed step, and the Merge button', async () => {
      const wtm = new WorktreeManager(join(root, 'wtroot-stuck2'));
      const task = { id: 'stuck2' } as unknown as Task;
      const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck2');
      if (first.mode !== 'worktree') throw new Error('setup failed');
      await mergeAndStrandCleanup(first.cwd, 'feat/stuck2');
      const spy = jam(wtm);
      const moved = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck2');
      if (moved.mode !== 'worktree') throw new Error('setup failed');
      writeFileSync(join(moved.cwd, 'step.txt'), 'the new step ran\n');
      await git(moved.cwd, ['add', '-A']);
      await git(moved.cwd, ['commit', '--no-verify', '-m', 'new step']);

      // The next run of the same card reuses it rather than building a third...
      const resumed = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck2');
      expect(resumed.mode === 'worktree' && resumed.cwd).toBe(moved.cwd);
      // ...and the Merge button, which reads disk and nothing else, finds it too.
      const live = await wtm.inspect(worktreeProject(), task.id, 'feat/stuck2');
      expect(live?.cwd).toBe(moved.cwd);
      expect(live?.branch).toBe('feat/stuck2');

      // And it merges from there, which is what "the step ran" has to end in.
      spy.mockRestore();
      const res = await wtm.integrate(project(), 'feat/stuck2', base, moved.cwd, 'integrate');
      expect(res.status).toBe('merged');
      expect((await git(repo, ['show', `${base}:step.txt`])).stdout).toBe('the new step ran\n');
    });

    it('cleans up BOTH the moved worktree and the debris when the card is abandoned', async () => {
      const wtm = new WorktreeManager(join(root, 'wtroot-stuck3'));
      const task = { id: 'stuck3' } as unknown as Task;
      const first = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck3');
      if (first.mode !== 'worktree') throw new Error('setup failed');
      await mergeAndStrandCleanup(first.cwd, 'feat/stuck3');
      const spy = jam(wtm);
      const moved = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck3');
      if (moved.mode !== 'worktree') throw new Error('setup failed');

      // The lock is gone by the time the human presses "Clean up & abandon" — the usual case,
      // since what held it was a process on its way out.
      spy.mockRestore();
      await wtm.cleanup(worktreeProject(), task.id);

      expect(existsSync(moved.cwd)).toBe(false);
      expect(existsSync(first.cwd)).toBe(false);
    });

    it('refuses only once every slot is occupied, naming each one', async () => {
      const wtm = new WorktreeManager(join(root, 'wtroot-stuck4'));
      const task = { id: 'stuck4' } as unknown as Task;
      const stranded: string[] = [];
      jam(wtm);
      // Ten worktrees, each merged and each left half-deleted: the bound has to be reachable
      // or it is not a bound, and a card in this state has ten directories nobody swept up.
      for (let i = 0; i < 10; i++) {
        const prep = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck4');
        expect(prep.mode).toBe('worktree');
        if (prep.mode !== 'worktree') return;
        stranded.push(prep.cwd);
        await mergeAndStrandCleanup(prep.cwd, 'feat/stuck4');
      }

      const full = await wtm.prepare(worktreeProject(), task, task.id, 'feat/stuck4');

      expect(full.mode).toBe('failed');
      expect(full).not.toHaveProperty('cwd');
      if (full.mode !== 'failed') return;
      // Every leftover is named: the human is being asked to delete them, so "some
      // directories" would send them hunting.
      for (const dir of stranded) expect(full.reason).toContain(dir);
      // Eleven preparations, each shelling out to git several times: the only test here that
      // needs longer than the 5s default, and it needs it on any machine.
    }, 60_000);
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
