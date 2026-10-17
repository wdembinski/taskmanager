/**
 * Proves the eleven `review:*`/`task:diff*` handler bodies through the SAME path a browser
 * tab actually takes: a real `RelayRegistry`, dispatching to handlers built by
 * `createReviewHandlers` — no Electron, no real `Store`/`ReviewSubjectService`/
 * `ReviewQueueService` except in the one end-to-end test at the bottom. Routing, the queue
 * cap, and argument validation are each this file's own concern; `ReviewSubjectService`'s own
 * routing rules are `subjectService.test.ts`'s.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Project, Task } from '@shared/model';
import {
  DIFF_FILE_MAX_BYTES,
  REVIEW_QUEUE_MAX_ROWS,
  taskSubjectId,
  type DiffContextResult,
  type DiffFileResult,
  type DiffImageResult,
  type DiffSummaryResult,
  type ReviewQueue,
  type ReviewQueueItem,
  type ReviewQueuesSnapshot,
  type ReviewViewedMark,
} from '@shared/review';
import { DiffService, type DiffGit } from './diffService';
import { ReviewSubjectService } from './subjectService';
import { createReviewHandlers, type ReviewHandlersDeps } from './reviewHandlers';
import { RelayRegistry } from '../ipcRegistry';

const NOW = 1_700_000_000_000;

const SUMMARY_OK: DiffSummaryResult = {
  status: 'ok',
  summary: {
    diffId: 'd1',
    baseRef: 'main',
    baseSha: 'b1',
    headSha: 'h1',
    includesWorkingTree: false,
    files: [],
    truncated: false,
  },
};
const FILE_OK: DiffFileResult = { status: 'ok', file: { diffId: 'd1', path: 'a.ts', hunks: [] } };
const IMAGE_OK: DiffImageResult = {
  status: 'ok',
  image: { diffId: 'd1', path: 'a.png', old: null, new: null },
};
const CONTEXT_OK: DiffContextResult = {
  status: 'ok',
  context: { diffId: 'd1', path: 'a.ts', side: 'new', start: 1, text: ['x'], truncated: false },
};
const MARK: ReviewViewedMark = {
  subjectId: 'task:t1',
  path: 'a.ts',
  blobSha: 'sha1',
  viewedAt: NOW,
};

function emptySnapshot(items: ReviewQueueItem[] = []): ReviewQueuesSnapshot {
  return { items, asOf: { requested: null, mine: null, agent: null }, partial: [] };
}

function queueItem(queue: ReviewQueue, n: number): ReviewQueueItem {
  return {
    subjectId: `task:${queue}-${n}`,
    queue,
    subject: { kind: 'task', taskId: `${queue}-${n}` },
    title: '',
    author: '',
    repoPath: '',
    ref: '',
    headSha: null,
    draft: false,
    updatedAt: 0,
    projectId: null,
    taskId: `${queue}-${n}`,
    draftCount: 0,
    viewedCount: 0,
    fileCount: null,
  };
}

interface Harness {
  registry: RelayRegistry;
  summary: Mock;
  file: Mock;
  image: Mock;
  context: Mock;
  open: Mock;
  refresh: Mock;
  snapshot: Mock;
  listReviewViewed: Mock;
  setReviewViewed: Mock;
  clearReviewViewed: Mock;
}

function buildHarness(): Harness {
  const summary = vi.fn(async (): Promise<DiffSummaryResult> => SUMMARY_OK);
  const file = vi.fn(async (): Promise<DiffFileResult> => FILE_OK);
  const image = vi.fn(async (): Promise<DiffImageResult> => IMAGE_OK);
  const context = vi.fn(async (): Promise<DiffContextResult> => CONTEXT_OK);
  const open = vi.fn((): ReviewQueuesSnapshot => emptySnapshot());
  const refresh = vi.fn(async (): Promise<void> => {});
  const snapshot = vi.fn((): ReviewQueuesSnapshot => emptySnapshot());
  const listReviewViewed = vi.fn((): ReviewViewedMark[] => [MARK]);
  const setReviewViewed = vi.fn((): ReviewViewedMark[] => [MARK]);
  const clearReviewViewed = vi.fn((): ReviewViewedMark[] => []);

  const deps: ReviewHandlersDeps = {
    subjects: { summary, file, image, context },
    queues: { open, refresh, snapshot },
    store: { listReviewViewed, setReviewViewed, clearReviewViewed },
    now: () => NOW,
  };

  const handlers = createReviewHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }

  return {
    registry,
    summary,
    file,
    image,
    context,
    open,
    refresh,
    snapshot,
    listReviewViewed,
    setReviewViewed,
    clearReviewViewed,
  };
}

describe('review handlers — routing', () => {
  it('routes task:diffSummary through taskSubjectId', async () => {
    const h = buildHarness();
    await h.registry.invoke('task:diffSummary', ['t1']);
    expect(h.summary).toHaveBeenCalledWith('task:t1');
  });

  it('routes task:diffFile through taskSubjectId', async () => {
    const h = buildHarness();
    await h.registry.invoke('task:diffFile', ['t1', 'd1', 'a.ts']);
    expect(h.file).toHaveBeenCalledWith('task:t1', 'd1', 'a.ts');
  });

  it('routes task:diffImage through taskSubjectId', async () => {
    const h = buildHarness();
    await h.registry.invoke('task:diffImage', ['t1', 'd1', 'a.png']);
    expect(h.image).toHaveBeenCalledWith('task:t1', 'd1', 'a.png');
  });

  it('routes review:subjectSummary with the subjectId as given', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:subjectSummary', ['gh-1-7']);
    expect(h.summary).toHaveBeenCalledWith('gh-1-7');
  });

  it('routes review:subjectFile with the subjectId as given', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:subjectFile', ['gh-1-7', 'd1', 'a.ts']);
    expect(h.file).toHaveBeenCalledWith('gh-1-7', 'd1', 'a.ts');
  });

  it('routes review:subjectImage with the subjectId as given', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:subjectImage', ['gh-1-7', 'd1', 'a.png']);
    expect(h.image).toHaveBeenCalledWith('gh-1-7', 'd1', 'a.png');
  });

  it('routes review:context with every argument', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:context', ['gh-1-7', 'd1', 'a.ts', 'old', 2, 9]);
    expect(h.context).toHaveBeenCalledWith('gh-1-7', 'd1', 'a.ts', 'old', 2, 9);
  });

  it('routes review:viewed to store.listReviewViewed', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:viewed', ['task:t1']);
    expect(h.listReviewViewed).toHaveBeenCalledWith('task:t1');
  });

  it('routes review:queues to queues.open(), never refresh()', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:queues', []);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('routes review:refreshQueues to refresh() then snapshot()', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:refreshQueues', []);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
  });
});

describe('review handlers — the queue cap', () => {
  it('caps each queue at REVIEW_QUEUE_MAX_ROWS and names the cut queues in truncated', async () => {
    const h = buildHarness();
    const items = [
      ...Array.from({ length: REVIEW_QUEUE_MAX_ROWS + 5 }, (_, i) => queueItem('requested', i)),
      ...Array.from({ length: 3 }, (_, i) => queueItem('mine', i)),
    ];
    h.open.mockReturnValueOnce(emptySnapshot(items));

    const result = await h.registry.invoke('review:queues', []);
    expect(result.ok).toBe(true);
    const out = result.value as ReviewQueuesSnapshot;
    expect(out.items.filter((i) => i.queue === 'requested')).toHaveLength(REVIEW_QUEUE_MAX_ROWS);
    expect(out.items.filter((i) => i.queue === 'mine')).toHaveLength(3);
    expect(out.truncated).toEqual(['requested']);
  });

  it('applies the same cap to review:refreshQueues', async () => {
    const h = buildHarness();
    const items = Array.from({ length: REVIEW_QUEUE_MAX_ROWS + 1 }, (_, i) =>
      queueItem('agent', i),
    );
    h.snapshot.mockReturnValueOnce(emptySnapshot(items));

    const result = await h.registry.invoke('review:refreshQueues', []);
    expect(result.ok).toBe(true);
    const out = result.value as ReviewQueuesSnapshot;
    expect(out.items).toHaveLength(REVIEW_QUEUE_MAX_ROWS);
    expect(out.truncated).toEqual(['agent']);
  });
});

describe('review handlers — setViewed', () => {
  it('sets a mark with the given blobSha and now()', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:setViewed', ['task:t1', 'a.ts', 'sha1']);
    expect(h.setReviewViewed).toHaveBeenCalledWith({
      subjectId: 'task:t1',
      path: 'a.ts',
      blobSha: 'sha1',
      viewedAt: NOW,
    });
    expect(h.clearReviewViewed).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, value: [MARK] });
  });

  it('clears the mark when blobSha is null', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:setViewed', ['task:t1', 'a.ts', null]);
    expect(h.clearReviewViewed).toHaveBeenCalledWith('task:t1', 'a.ts');
    expect(h.setReviewViewed).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe('review handlers — argument validation', () => {
  it('refuses a non-string subjectId', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:subjectSummary', [42]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subjectId/);
  });

  it('refuses an empty subjectId', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:viewed', ['']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subjectId/);
  });

  it('refuses an empty path', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:subjectFile', ['s1', 'd1', '']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path/);
  });

  it('refuses a non-integer from', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:context', ['s1', 'd1', 'a.ts', 'old', 1.5, 9]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/from/);
  });

  it('refuses a non-integer to', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:context', [
      's1',
      'd1',
      'a.ts',
      'old',
      1,
      'nine',
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/to/);
  });

  it('refuses from greater than to', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:context', ['s1', 'd1', 'a.ts', 'old', 9, 2]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/from\/to/);
  });

  it('refuses from below 1', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:context', ['s1', 'd1', 'a.ts', 'old', 0, 2]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/from\/to/);
  });

  it('refuses a side that is not old|new', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:context', ['s1', 'd1', 'a.ts', 'both', 1, 9]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/side/);
  });

  it('refuses a blobSha that is neither a string nor null', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:setViewed', ['s1', 'a.ts', 42]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blobSha/);
  });

  it('refuses an empty blobSha string', async () => {
    const h = buildHarness();
    const result = await h.registry.invoke('review:setViewed', ['s1', 'a.ts', '']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blobSha/);
  });

  it('none of the refused calls reach the deps', async () => {
    const h = buildHarness();
    await h.registry.invoke('review:subjectSummary', [42]);
    await h.registry.invoke('review:context', ['s1', 'd1', 'a.ts', 'both', 1, 9]);
    await h.registry.invoke('review:setViewed', ['s1', 'a.ts', 42]);
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.context).not.toHaveBeenCalled();
    expect(h.setReviewViewed).not.toHaveBeenCalled();
    expect(h.clearReviewViewed).not.toHaveBeenCalled();
  });
});

describe('review:context over the DIFF_FILE_MAX_BYTES cap, end to end', () => {
  it('answers tooLarge through a real ReviewSubjectService and DiffService, never reading the file', async () => {
    const calls: string[] = [];
    const g: DiffGit = {
      revParse: async () => 'h'.repeat(40),
      branchExists: async () => true,
      currentBranch: async () => 'main',
      mergeBase: async () => 'b'.repeat(40),
      rebaseInProgress: async () => false,
      conflictedFiles: async () => [],
      workingTreeFingerprint: async () => '',
      nameStatus: async () => [],
      workingTree: async () => [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, binary: false },
      ],
      filePatch: async () => null,
      fileSizes: async () => new Map(),
      fileSize: async () => DIFF_FILE_MAX_BYTES + 1,
      readFile: async (_dir, ref, path) => {
        calls.push(`readFile ${ref ?? 'WORK'}:${path}`);
        return Buffer.from('should never be read');
      },
    };

    const project = {
      id: 'p1',
      path: '/repo',
      useWorktrees: true,
      baseBranch: 'main',
      target: { kind: 'local' },
    } as unknown as Project;
    const task = { id: 't1', projectId: 'p1', agentBranch: 'feat/x' } as unknown as Task;

    const diffs = new DiffService({
      getTask: (id) => (id === 't1' ? task : undefined),
      getProject: (id) => (id === 'p1' ? project : undefined),
      inspect: async () => ({ cwd: '/wt/card', branch: 'feat/x', base: 'main' }),
      gitFor: () => g,
      listMergeRequests: () => [],
    });

    const subjects = new ReviewSubjectService({
      diffs,
      forge: {
        detail: async () => {
          throw new Error('not used by a task subject');
        },
        summary: async () => {
          throw new Error('not used by a task subject');
        },
        file: async () => {
          throw new Error('not used by a task subject');
        },
        image: async () => {
          throw new Error('not used by a task subject');
        },
        context: async () => {
          throw new Error('not used by a task subject');
        },
      },
      store: { listReviewQueue: () => [], listMergeRequests: () => [] },
      hostFor: () => '',
    });

    const handlers = createReviewHandlers({
      subjects,
      queues: {
        open: () => emptySnapshot(),
        refresh: async () => {},
        snapshot: () => emptySnapshot(),
      },
      store: { listReviewViewed: () => [], setReviewViewed: () => [], clearReviewViewed: () => [] },
      now: () => NOW,
    });
    const registry = new RelayRegistry();
    for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
      registry.register(channel, handlers[channel] as never);
    }

    const subjectId = taskSubjectId('t1');
    const summaryResult = await registry.invoke('review:subjectSummary', [subjectId]);
    if (!summaryResult.ok) throw new Error(`expected ok, got ${summaryResult.error}`);
    const summary = summaryResult.value as DiffSummaryResult;
    if (summary.status !== 'ok') throw new Error(`expected ok, got ${summary.status}`);
    const diffId = summary.summary.diffId;

    const contextResult = await registry.invoke('review:context', [
      subjectId,
      diffId,
      'src/a.ts',
      'new',
      1,
      5,
    ]);

    expect(contextResult).toEqual({
      ok: true,
      value: {
        status: 'ok',
        context: {
          diffId,
          path: 'src/a.ts',
          side: 'new',
          start: 0,
          text: [],
          truncated: false,
          tooLarge: { bytes: DIFF_FILE_MAX_BYTES + 1 },
        },
      },
    });
    expect(calls.filter((c) => c.startsWith('readFile'))).toHaveLength(0);
  });
});
