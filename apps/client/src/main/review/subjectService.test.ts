/**
 * `ReviewSubjectService` against fakes of `DiffService`, `ForgeDiffSource` and `Store` — the
 * task/pr split, finding a PR subject off the review queue or `merge_requests`, the
 * local-ref-first/forge-api-fallback decision `summary()` makes once, and the routing rule a
 * later `file`/`image`/`context` read follows from it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ForgeProvider } from '@shared/mergeRequest';
import {
  LOCAL_REF_CAPABILITIES,
  type DiffContextResult,
  type DiffFile,
  type DiffFileResult,
  type DiffImage,
  type DiffImageResult,
  type DiffSummary,
  type DiffSummaryResult,
  type ReviewQueueItem,
  type ReviewSubject,
} from '@shared/review';
import type { MergeRequest } from '@shared/mergeRequest';
import type { DiffGit, PrLocalResult, ResolvedDiff } from './diffService';
import { ReviewSubjectService, type ReviewSubjectServiceDeps } from './subjectService';

type PrSubject = Extract<ReviewSubject, { kind: 'pr' }>;

function prSubject(over: Partial<PrSubject> = {}): PrSubject {
  return { kind: 'pr', provider: 'github', repoId: 1, repoPath: 'acme/web', number: 7, ...over };
}

function queueRow(subject: ReviewSubject, subjectId: string): { item: ReviewQueueItem; syncedAt: number } {
  return {
    syncedAt: 1,
    item: {
      subjectId,
      queue: 'requested',
      subject,
      title: '',
      author: '',
      repoPath: '',
      ref: '',
      headSha: null,
      draft: false,
      updatedAt: 0,
      projectId: null,
      taskId: null,
      draftCount: 0,
      viewedCount: 0,
      fileCount: null,
    },
  };
}

function mergeRequest(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'gh-1-7',
    taskId: null,
    openedForTaskId: null,
    provider: 'github',
    repoId: 1,
    projectPath: 'acme/web',
    number: 7,
    title: 't',
    displayName: null,
    webUrl: '',
    sourceBranch: 'feature',
    targetBranch: 'main',
    state: 'opened',
    draft: false,
    pipelineStatus: 'unknown',
    pipelineUrl: null,
    headSha: null,
    lastActedSha: null,
    lastActedAction: null,
    pipelineStages: [],
    approvalsRequired: null,
    approvalsGiven: 0,
    changesRequested: false,
    detailedMergeStatus: null,
    hasConflicts: false,
    issueKeys: [],
    latestNoteAt: null,
    lastReadAt: null,
    lastEventAt: null,
    lastEventSeenAt: null,
    updatedAt: 1000,
    syncedAt: 1000,
    ...over,
  };
}

function fakeResolved(diffId: string, over: Partial<ResolvedDiff> = {}): ResolvedDiff {
  return {
    git: {} as DiffGit,
    dir: '/repo',
    baseRef: 'main',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    to: 'head-sha',
    includesWorkingTree: false,
    diffId,
    source: 'local-ref',
    subjectId: 'gh-1-7',
    capabilities: LOCAL_REF_CAPABILITIES,
    ...over,
  };
}

function summary(over: Partial<DiffSummary> = {}): DiffSummary {
  return {
    diffId: 'd1',
    baseRef: 'main',
    baseSha: 'base',
    headSha: 'head',
    includesWorkingTree: false,
    files: [],
    truncated: false,
    ...over,
  };
}

function deps(
  over: {
    diffs?: Partial<ReviewSubjectServiceDeps['diffs']>;
    forge?: Partial<ReviewSubjectServiceDeps['forge']>;
    store?: Partial<ReviewSubjectServiceDeps['store']>;
    hostFor?: ReviewSubjectServiceDeps['hostFor'];
  } = {},
): ReviewSubjectServiceDeps {
  return {
    diffs: {
      summary: vi.fn(async (): Promise<DiffSummaryResult> => ({ status: 'ok', summary: summary() })),
      file: vi.fn(
        async (_taskId: string, diffId: string, path: string): Promise<DiffFileResult> => ({
          status: 'ok',
          file: { diffId, path, hunks: [] },
        }),
      ),
      image: vi.fn(
        async (_taskId: string, diffId: string, path: string): Promise<DiffImageResult> => ({
          status: 'ok',
          image: { diffId, path, old: null, new: null },
        }),
      ),
      context: vi.fn(
        async (
          _taskId: string,
          diffId: string,
          path: string,
          side: 'old' | 'new',
        ): Promise<DiffContextResult> => ({
          status: 'ok',
          context: { diffId, path, side, start: 1, text: [], truncated: false },
        }),
      ),
      resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'no-project' })),
      summaryFor: vi.fn(async (resolved: ResolvedDiff): Promise<DiffSummary> => summary({ diffId: resolved.diffId })),
      fileIn: vi.fn(
        async (_resolved: ResolvedDiff, diffId: string, path: string): Promise<DiffFile> => ({
          diffId,
          path,
          hunks: [],
        }),
      ),
      imageIn: vi.fn(
        async (_resolved: ResolvedDiff, diffId: string, path: string): Promise<DiffImage> => ({
          diffId,
          path,
          old: null,
          new: null,
        }),
      ),
      contextIn: vi.fn(
        async (_resolved: ResolvedDiff, diffId: string, path: string, side: 'old' | 'new') => ({
          diffId,
          path,
          side,
          start: 1,
          text: [],
          truncated: false,
        }),
      ),
      ...over.diffs,
    },
    forge: {
      detail: vi.fn(async () => ({ diffId: 'forge-d1', baseSha: 'base', headSha: 'head', baseRef: 'main' })),
      summary: vi.fn(async (): Promise<DiffSummary> => summary({ diffId: 'forge-d1', source: 'forge-api' })),
      file: vi.fn(
        async (_subject: PrSubject, diffId: string, path: string): Promise<DiffFileResult> => ({
          status: 'ok',
          file: { diffId, path, hunks: [] },
        }),
      ),
      image: vi.fn(
        async (_subject: PrSubject, diffId: string, path: string): Promise<DiffImageResult> => ({
          status: 'ok',
          image: { diffId, path, old: null, new: null },
        }),
      ),
      context: vi.fn(
        async (
          _subject: PrSubject,
          diffId: string,
          path: string,
          side: 'old' | 'new',
        ): Promise<DiffContextResult> => ({
          status: 'ok',
          context: { diffId, path, side, start: 1, text: [], truncated: false },
        }),
      ),
      ...over.forge,
    },
    store: {
      listReviewQueue: vi.fn(() => []),
      listMergeRequests: vi.fn(() => []),
      ...over.store,
    },
    hostFor: over.hostFor ?? vi.fn((_provider: ForgeProvider) => 'github.com'),
  };
}

describe('task routing', () => {
  it('sends every method straight to the DiffService task methods', async () => {
    const d = deps();
    const service = new ReviewSubjectService(d);

    const summaryResult = await service.summary('task:t1');
    expect(d.diffs.summary).toHaveBeenCalledWith('t1');
    expect(summaryResult.status).toBe('ok');

    await service.file('task:t1', 'd1', 'a.ts');
    expect(d.diffs.file).toHaveBeenCalledWith('t1', 'd1', 'a.ts');

    await service.image('task:t1', 'd1', 'a.png');
    expect(d.diffs.image).toHaveBeenCalledWith('t1', 'd1', 'a.png');

    await service.context('task:t1', 'd1', 'a.ts', 'new', 1, 10);
    expect(d.diffs.context).toHaveBeenCalledWith('t1', 'd1', 'a.ts', 'new', 1, 10);

    expect(d.forge.detail).not.toHaveBeenCalled();
  });
});

describe('a bad id', () => {
  it('throws "Not a review subject" instead of calling anything', async () => {
    const d = deps();
    const service = new ReviewSubjectService(d);
    await expect(service.summary('nonsense')).rejects.toThrow('Not a review subject: nonsense');
    expect(d.diffs.summary).not.toHaveBeenCalled();
  });
});

describe('a PR found only in merge_requests', () => {
  it('builds the subject off the merge-request row and resolves it locally', async () => {
    const resolved = fakeResolved('d1');
    const d = deps({
      store: { listMergeRequests: vi.fn(() => [mergeRequest()]) },
      diffs: { resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'ok', resolved })) },
    });
    const service = new ReviewSubjectService(d);

    const result = await service.summary('gh-1-7');

    expect(d.forge.detail).toHaveBeenCalledWith(prSubject());
    expect(d.diffs.resolvePrLocal).toHaveBeenCalledWith({
      subject: prSubject(),
      host: 'github.com',
      headSha: 'head',
      baseBranch: 'main',
    });
    expect(result).toEqual({ status: 'ok', summary: summary({ diffId: 'd1' }) });
  });
});

describe('an unknown PR', () => {
  it('throws when neither the queue cache nor merge_requests knows it', async () => {
    const d = deps();
    const service = new ReviewSubjectService(d);
    await expect(service.summary('gh-9-9')).rejects.toThrow('gh-9-9 is not in any review queue.');
  });
});

describe('local-ref success', () => {
  it('routes a later file read to DiffService.fileIn and never touches forge', async () => {
    const resolved = fakeResolved('d1');
    const file: DiffFile = { diffId: 'd1', path: 'a.ts', hunks: [] };
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: {
        resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'ok', resolved })),
        fileIn: vi.fn(async (): Promise<DiffFile> => file),
      },
    });
    const service = new ReviewSubjectService(d);

    await service.summary('gh-1-7');
    const result = await service.file('gh-1-7', 'd1', 'a.ts');

    expect(result).toEqual({ status: 'ok', file });
    expect(d.diffs.fileIn).toHaveBeenCalledWith(resolved, 'd1', 'a.ts');
    expect(d.forge.file).not.toHaveBeenCalled();
  });
});

describe('fallback reasons', () => {
  it('says so when no project has a local clone of the repository', async () => {
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: { resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'no-project' })) },
    });
    const service = new ReviewSubjectService(d);
    const result = await service.summary('gh-1-7');
    expect(result).toEqual({
      status: 'ok',
      summary: {
        ...summary({ diffId: 'forge-d1', source: 'forge-api' }),
        fallbackReason: 'no project with a local clone of this repository is open',
      },
    });
  });

  it('passes the git fetch failure reason through verbatim', async () => {
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: {
        resolvePrLocal: vi.fn(
          async (): Promise<PrLocalResult> => ({ status: 'fetch-failed', reason: 'git fetch failed' }),
        ),
      },
    });
    const service = new ReviewSubjectService(d);
    const result = await service.summary('gh-1-7');
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.summary.fallbackReason).toBe('git fetch failed');
  });

  it('names both SHAs when the forge head moved since the fetch', async () => {
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: {
        resolvePrLocal: vi.fn(
          async (): Promise<PrLocalResult> => ({ status: 'stale', headSha: 'aaa', forgeHeadSha: 'bbb' }),
        ),
      },
    });
    const service = new ReviewSubjectService(d);
    const result = await service.summary('gh-1-7');
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.summary.fallbackReason).toBe(
      "the local clone's fetched head (aaa) does not match the pull request's (bbb)",
    );
  });
});

describe('a stale local-ref read', () => {
  it('answers stale against the remembered diffId, with no call to fileIn', async () => {
    const resolved = fakeResolved('d1');
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: { resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'ok', resolved })) },
    });
    const service = new ReviewSubjectService(d);

    await service.summary('gh-1-7');
    const result = await service.file('gh-1-7', 'old-diff-id', 'a.ts');

    expect(result).toEqual({ status: 'stale', diffId: 'old-diff-id', currentDiffId: 'd1' });
    expect(d.diffs.fileIn).not.toHaveBeenCalled();
  });
});

describe('forge-api reads', () => {
  it('delegates file/image/context straight to ForgeDiffSource, passthrough included', async () => {
    const staleAnswer: DiffFileResult = { status: 'stale', diffId: 'old', currentDiffId: 'new' };
    const d = deps({
      store: { listReviewQueue: vi.fn(() => [queueRow(prSubject(), 'gh-1-7')]) },
      diffs: { resolvePrLocal: vi.fn(async (): Promise<PrLocalResult> => ({ status: 'no-project' })) },
      forge: { file: vi.fn(async (): Promise<DiffFileResult> => staleAnswer) },
    });
    const service = new ReviewSubjectService(d);
    await service.summary('gh-1-7');

    const fileResult = await service.file('gh-1-7', 'old', 'a.ts');
    expect(fileResult).toBe(staleAnswer);
    expect(d.forge.file).toHaveBeenCalledWith(prSubject(), 'old', 'a.ts');

    await service.image('gh-1-7', 'd1', 'a.png');
    expect(d.forge.image).toHaveBeenCalledWith(prSubject(), 'd1', 'a.png');

    await service.context('gh-1-7', 'd1', 'a.ts', 'old', 1, 10);
    expect(d.forge.context).toHaveBeenCalledWith(prSubject(), 'd1', 'a.ts', 'old', 1, 10);

    expect(d.diffs.fileIn).not.toHaveBeenCalled();
    expect(d.diffs.imageIn).not.toHaveBeenCalled();
    expect(d.diffs.contextIn).not.toHaveBeenCalled();
  });
});
