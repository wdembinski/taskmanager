/**
 * `buildVariantSummary` against a REAL git repo, a REAL `WorktreeManager` and a REAL
 * `DiffService` (the same approach `worktreeManager.test.ts` / `git.review.test.ts` use) —
 * what a fake `DiffGit` cannot prove is that a row's reported diffstat actually matches
 * what git itself says about an ordinary mix of committed, uncommitted and untracked
 * changes in a real worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Several cases here shell out to git a dozen times against a real temp repo, the same cost
// worktreeManager.test.ts carries an explicit timeout for.
vi.setConfig({ testTimeout: 30_000 });
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Task } from '@shared/model';
import { LOCAL_TARGET } from '@shared/execTarget';
import type { SessionEvent } from '@shared/session';
import { VARIANT_SUMMARY_MAX_CHARS, type VariantLabel } from '@shared/variants';
import { RESULTS_BYTES_LIMIT } from './cloudResults';
import { localHost } from './exec';
import { git } from './git';
import { createDiffGit, DiffService } from './review/diffService';
import { buildVariantSummary, type VariantSummaryDeps } from './variantSummary';
import { WorktreeManager } from './worktreeManager';

let root = '';
let repo = '';
let base = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orch-vsum-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
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

function project(): Project {
  return { id: 'p1', path: repo, useWorktrees: true, target: LOCAL_TARGET } as unknown as Project;
}

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, projectId: 'p1', status: 'pending', ...over } as unknown as Task;
}

/** The in-memory tasks/rows/history store `VariantSummaryDeps` reads from. */
function fakeStore() {
  const tasks = new Map<string, Task>();
  const history = new Map<string, SessionEvent[]>();
  return {
    add(t: Task) {
      tasks.set(t.id, t);
    },
    setHistory(id: string, events: SessionEvent[]) {
      history.set(id, events);
    },
    getTask: (id: string) => tasks.get(id),
    listVariantRows: (leaderId: string) =>
      [...tasks.values()].filter((t) => t.variantOf === leaderId),
    getTaskHistory: (id: string) => history.get(id) ?? [],
  };
}

/** `VariantSummaryDeps` wired to a real `DiffService` over the given `WorktreeManager`. */
function depsFor(store: ReturnType<typeof fakeStore>, wtm: WorktreeManager): VariantSummaryDeps {
  const diffs = new DiffService({
    getTask: store.getTask,
    getProject: (id) => (id === 'p1' ? project() : undefined),
    inspect: (p, ownerTaskId, branchName) => wtm.inspect(p, ownerTaskId, branchName),
    gitFor: () => createDiffGit(localHost()),
    listMergeRequests: () => [],
  });
  return {
    getTask: store.getTask,
    listVariantRows: store.listVariantRows,
    getTaskHistory: store.getTaskHistory,
    diffStat: (id) => diffs.stat(id),
  };
}

const resultEvent = (resultText: string, costUsd: number | null): SessionEvent => ({
  kind: 'result',
  success: true,
  resultText,
  costUsd,
  durationMs: null,
  stopReason: null,
  terminalReason: null,
  usage: null,
});

/**
 * What `DiffService.stat` ought to report, reproduced independently from git itself:
 * `git diff --numstat` against the merge base for every tracked change (committed or not),
 * plus each untracked file's own `--no-index` diff against `/dev/null` — never a hand-typed
 * number.
 */
async function gitsOwnStat(cwd: string, mergeBaseSha: string) {
  const tracked = (await git(cwd, ['diff', mergeBaseSha, '--numstat'])).stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const added = tracked.reduce((n, [a]) => n + (Number(a) || 0), 0);
  const removed = tracked.reduce((n, [, r]) => n + (Number(r) || 0), 0);
  let files = tracked.length;
  let untrackedAdded = 0;

  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout
    .split('\n')
    .filter(Boolean);
  for (const path of untracked) {
    const res = await git(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', path]);
    const [a] = res.stdout.trim().split('\t');
    untrackedAdded += Number(a) || 0;
    files += 1;
  }
  return { files, added: added + untrackedAdded, removed };
}

describe('buildVariantSummary against a real git repo', () => {
  it('reports a diffstat that matches git itself for committed + uncommitted + untracked changes', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const rowA = task('rowA', { variantOf: 'L', variantLabel: 'A', status: 'running' });
    store.add(rowA);

    const prep = await wtm.prepare(project(), rowA, rowA.id);
    if (prep.mode !== 'worktree') throw new Error(`expected a worktree, got ${prep.mode}`);
    const mergeBaseSha = (await git(prep.cwd, ['merge-base', base, 'HEAD'])).stdout.trim();

    // One committed file...
    writeFileSync(join(prep.cwd, 'added.ts'), 'export const a = 1;\nexport const b = 2;\n');
    await git(prep.cwd, ['add', '-A']);
    await git(prep.cwd, ['commit', '--no-verify', '-m', 'add added.ts']);
    // ...one tracked edit left uncommitted...
    writeFileSync(join(prep.cwd, 'seed.txt'), 'seed\nedited uncommitted\n');
    // ...and one untracked file nobody staged.
    writeFileSync(join(prep.cwd, 'scratch.ts'), 'export const scratch = true;\n');

    const expected = await gitsOwnStat(prep.cwd, mergeBaseSha);
    expect(expected.files).toBeGreaterThan(0); // not vacuously {0,0,0}

    const summary = await buildVariantSummary(depsFor(store, wtm), 'L');

    expect(summary).toHaveLength(1);
    expect(summary[0]!.diffStat).toEqual(expected);
  });

  it('reports {0, 0, 0} for a failed row that never wrote anything, and for a row never prepared', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const rowB = task('rowB', { variantOf: 'L', variantLabel: 'B', status: 'failed' });
    const rowC = task('rowC', { variantOf: 'L', variantLabel: 'C', status: 'pending' });
    store.add(rowB);
    store.add(rowC);

    // B gets a worktree but never changes anything in it.
    const prep = await wtm.prepare(project(), rowB, rowB.id);
    if (prep.mode !== 'worktree') throw new Error(`expected a worktree, got ${prep.mode}`);
    // C never runs at all: no worktree, no branch.

    const summary = await buildVariantSummary(depsFor(store, wtm), 'L');
    const byId = new Map(summary.map((r) => [r.id, r]));
    expect(byId.get('rowB')!.diffStat).toEqual({ files: 0, added: 0, removed: 0 });
    expect(byId.get('rowC')!.diffStat).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('sums cost across two result events, takes the summary from the LAST one, sorted by label', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    store.add(task('rowC', { variantOf: 'L', variantLabel: 'C', status: 'done' }));
    store.add(task('rowA', { variantOf: 'L', variantLabel: 'A', status: 'done' }));
    store.setHistory('rowA', [
      resultEvent('First attempt.\nmore', 0.5),
      resultEvent('# Second and final attempt\nmore detail', 1.25),
    ]);

    const summary = await buildVariantSummary(depsFor(store, wtm), 'L');

    expect(summary.map((r) => r.label)).toEqual(['A', 'C']); // label order, not insertion order
    const a = summary.find((r) => r.id === 'rowA')!;
    expect(a.costUsd).toBe(1.75);
    expect(a.summary).toBe('Second and final attempt');
  });

  it('fits three rows with 100 kB results and large counts under the relay cap', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const bigText = 'x'.repeat(100_000);
    const labels: VariantLabel[] = ['A', 'B', 'C'];
    for (const label of labels) {
      store.add(task(`row${label}`, { variantOf: 'L', variantLabel: label, status: 'done' }));
      store.setHistory(`row${label}`, [resultEvent(bigText, 999_999.99)]);
    }
    const deps: VariantSummaryDeps = {
      ...depsFor(store, wtm),
      // Large diff counts without an actual multi-million-line worktree to go with them.
      diffStat: async () => ({ files: 999_999, added: 999_999_999, removed: 999_999_999 }),
    };

    const result = await buildVariantSummary(deps, 'L');

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(RESULTS_BYTES_LIMIT);
    for (const row of result) {
      // The cap itself plus the trailing ellipsis character `variantSummaryLine` appends
      // once it truncates — see its own test in variants.test.ts.
      expect(row.summary.length).toBeLessThanOrEqual(VARIANT_SUMMARY_MAX_CHARS + 1);
    }
  });
});
