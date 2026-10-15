/**
 * `pickVariant` against a REAL git repo and a REAL `WorktreeManager` (the same approach
 * `variantSummary.test.ts` uses) — what a fake worktree manager cannot prove is that picking
 * a variant actually leaves ONE worktree and ONE branch standing in git's own eyes, not just
 * in whatever the fakes were told to say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Several cases here shell out to git a dozen times against a real temp repo, the same cost
// worktreeManager.test.ts carries an explicit timeout for.
vi.setConfig({ testTimeout: 30_000 });
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Task, TaskArchiveReason } from '@shared/model';
import { LOCAL_TARGET } from '@shared/execTarget';
import { VARIANT_PICK_REFUSAL_MESSAGE } from '@shared/variants';
import { branchExists, git } from './git';
import { pickVariant, type VariantPickDeps } from './variantPick';
import { taskBranch, WorktreeManager } from './worktreeManager';

let root = '';
let repo = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orch-vpick-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await git(repo, ['commit', '--no-verify', '--allow-empty', '-m', 'initial']);
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
  return {
    id,
    projectId: 'p1',
    status: 'pending',
    title: id,
    ...over,
  } as unknown as Task;
}

/** The in-memory leader/rows store `VariantPickDeps` reads from and writes to. */
function fakeStore() {
  const tasks = new Map<string, Task>();
  const comments = new Map<string, string[]>();
  return {
    add(t: Task) {
      tasks.set(t.id, t);
    },
    getTask: (id: string) => tasks.get(id),
    listVariantRows: (leaderId: string) =>
      [...tasks.values()].filter((t) => t.variantOf === leaderId && !t.archivedAt),
    archiveTask: (id: string, at: number, reason: TaskArchiveReason) => {
      const t = tasks.get(id);
      if (!t) return undefined;
      const updated = { ...t, archivedAt: at, archivedReason: reason };
      tasks.set(id, updated);
      return updated;
    },
    updateTask: (id: string, patch: Partial<Task>) => {
      const t = tasks.get(id);
      if (!t) return undefined;
      const updated = { ...t, ...patch };
      tasks.set(id, updated);
      return updated;
    },
    addComment: (_projectId: string, taskId: string, body: string) => {
      const list = comments.get(taskId) ?? [];
      list.push(body);
      comments.set(taskId, list);
    },
    commentsFor: (taskId: string) => comments.get(taskId) ?? [],
  };
}

/** `VariantPickDeps` wired to a real `WorktreeManager`; `discardVariantRow` is a spy only —
 * the bookkeeping it performs on a running/queued row is `Scheduler`'s own, tested there. */
function depsFor(
  store: ReturnType<typeof fakeStore>,
  wtm: WorktreeManager,
  discardCalls: string[] = [],
): VariantPickDeps {
  return {
    getTask: store.getTask,
    getProject: (id) => (id === 'p1' ? project() : undefined),
    listVariantRows: store.listVariantRows,
    discardVariantRow: (id) => discardCalls.push(id),
    cleanup: (p, taskId) => wtm.cleanup(p, taskId),
    deleteTaskBranch: (p, branch) => wtm.deleteTaskBranch(p, branch),
    archiveTask: store.archiveTask,
    updateTask: store.updateTask,
    addComment: store.addComment,
  };
}

describe('pickVariant against a real git repo', () => {
  it('keeps only the winner’s worktree and branch, and archives the losers', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const rowA = task('rowA', { variantOf: 'L', variantLabel: 'A' });
    const rowB = task('rowB', { variantOf: 'L', variantLabel: 'B' });
    const rowC = task('rowC', { variantOf: 'L', variantLabel: 'C' });
    [rowA, rowB, rowC].forEach((r) => store.add(r));

    const prepA = await wtm.prepare(project(), rowA, rowA.id);
    const prepB = await wtm.prepare(project(), rowB, rowB.id);
    const prepC = await wtm.prepare(project(), rowC, rowC.id);
    if (prepA.mode !== 'worktree' || prepB.mode !== 'worktree' || prepC.mode !== 'worktree') {
      throw new Error('setup failed');
    }

    const leader = await pickVariant(depsFor(store, wtm), 'L', 'rowB');

    expect(leader.pickedVariantId).toBe('rowB');
    expect(await branchExists(repo, taskBranch('rowB'))).toBe(true);
    expect(await branchExists(repo, taskBranch('rowA'))).toBe(false);
    expect(await branchExists(repo, taskBranch('rowC'))).toBe(false);

    expect(store.getTask('rowA')?.archivedReason).toBe('variant-discarded');
    expect(store.getTask('rowC')?.archivedReason).toBe('variant-discarded');
    expect(store.getTask('rowB')?.archivedAt).toBeUndefined();

    expect(store.commentsFor('L')).toEqual(['Picked B of 3 — discarded A, C.']);
  });

  it('is a no-op re-picking the same winner: no cleanup, no extra note', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L', { pickedVariantId: 'rowB' }));
    store.add(task('rowB', { variantOf: 'L', variantLabel: 'B' }));
    const discardCalls: string[] = [];
    const deps = depsFor(store, wtm, discardCalls);
    const cleanupSpy = vi.spyOn(deps, 'cleanup');

    const leader = await pickVariant(deps, 'L', 'rowB');

    expect(leader.pickedVariantId).toBe('rowB');
    expect(discardCalls).toEqual([]);
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(store.commentsFor('L')).toEqual([]);
  });

  it('refuses picking a different variant once one is already picked', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L', { pickedVariantId: 'rowB' }));
    store.add(task('rowA', { variantOf: 'L', variantLabel: 'A' }));

    await expect(pickVariant(depsFor(store, wtm), 'L', 'rowA')).rejects.toThrow(
      VARIANT_PICK_REFUSAL_MESSAGE['already-picked'],
    );
  });

  it('refuses picking a different variant once the pick has already merged', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L', { pickedVariantId: 'rowB', landedAt: Date.now() }));
    store.add(task('rowC', { variantOf: 'L', variantLabel: 'C' }));

    await expect(pickVariant(depsFor(store, wtm), 'L', 'rowC')).rejects.toThrow(
      VARIANT_PICK_REFUSAL_MESSAGE['already-merged'],
    );
  });

  it('never deletes a branch name the winner and a loser share', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const shared = 'feature/shared';
    const rowA = task('rowA', { variantOf: 'L', variantLabel: 'A', agentBranch: shared });
    // The loser shares the winner's branch name but never got its own worktree built on it —
    // git refuses two worktrees checked out on the same branch, so only the winner's is real.
    const rowB = task('rowB', { variantOf: 'L', variantLabel: 'B', agentBranch: shared });
    store.add(rowA);
    store.add(rowB);
    const prepA = await wtm.prepare(project(), rowA, rowA.id, shared);
    if (prepA.mode !== 'worktree') throw new Error('setup failed');

    const deps = depsFor(store, wtm);
    const deleteBranchSpy = vi.spyOn(deps, 'deleteTaskBranch');

    const leader = await pickVariant(deps, 'L', 'rowA');

    expect(leader.pickedVariantId).toBe('rowA');
    expect(deleteBranchSpy).not.toHaveBeenCalled();
    expect(await branchExists(repo, shared)).toBe(true);
    expect(store.getTask('rowB')?.archivedReason).toBe('variant-discarded');
  });

  it('logs an undeletable loser worktree on the leader timeline but still picks', async () => {
    const wtm = new WorktreeManager(root);
    const store = fakeStore();
    store.add(task('L'));
    const rowA = task('rowA', { variantOf: 'L', variantLabel: 'A' });
    const rowB = task('rowB', { variantOf: 'L', variantLabel: 'B' });
    store.add(rowA);
    store.add(rowB);
    const prepA = await wtm.prepare(project(), rowA, rowA.id);
    const prepB = await wtm.prepare(project(), rowB, rowB.id);
    if (prepA.mode !== 'worktree' || prepB.mode !== 'worktree') throw new Error('setup failed');

    const deps: VariantPickDeps = {
      ...depsFor(store, wtm),
      cleanup: async () => ['the worktree at B could not be removed (locked).'],
      deleteTaskBranch: async () => undefined,
    };

    const leader = await pickVariant(deps, 'L', 'rowA');

    expect(leader.pickedVariantId).toBe('rowA');
    const notes = store.commentsFor('L');
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain('the worktree at B could not be removed (locked).');
  });
});
