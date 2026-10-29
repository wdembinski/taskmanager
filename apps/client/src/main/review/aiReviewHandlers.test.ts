/**
 * Proves the four `aiReview:*` handler bodies through the SAME path a browser tab takes: a
 * real `RelayRegistry`, dispatching to handlers built by `createAiReviewHandlers`. The two
 * refusal suites run a real `AiReviewRunner` over a real `AiReviewSubjects`, so what they
 * prove is the answer a browser actually gets — and that nothing was spent getting it. The
 * runner's own queue and settle rules are `aiReviewRunner.test.ts`'s.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { AI_REVIEW_MAX_CHANGED_LINES, AI_REVIEW_MAX_FILES, type AiReview } from '@shared/aiReview';
import type { Project, Task } from '@shared/model';
import {
  FORGE_API_CAPABILITIES,
  WORKTREE_CAPABILITIES,
  type DiffFileEntry,
  type DiffSummary,
  type DiffSummaryResult,
} from '@shared/review';
import { RelayRegistry } from '../ipcRegistry';
import { createAiReviewHandlers, type AiReviewHandlersDeps } from './aiReviewHandlers';
import { AiReviewRunner, type AiReviewRunnerDeps } from './aiReviewRunner';
import { AiReviewSubjects, type AiReviewSubjectDeps } from './aiReviewSubjects';

const PROJECT = { id: 'p', path: '/repo' } as Project;
const TASK = { id: 't1', projectId: 'p', title: 'Fix the parser' } as Task;

const REVIEW: AiReview = {
  id: 'ai-1',
  subjectId: 'task:t1',
  diffId: 'd1',
  headSha: 'head',
  status: 'queued',
  parkReason: null,
  model: 'opus',
  startedAt: null,
  finishedAt: null,
  costUsd: null,
  tokens: null,
  summary: null,
  verdict: null,
  findingCount: 0,
  droppedCount: 0,
  error: null,
  requestedBy: 'human',
  reviewDoc: 'default',
};

function entry(path: string, over: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    image: false,
    bytes: 10,
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
    files: [entry('a.ts')],
    truncated: false,
    subjectId: 'task:t1',
    source: 'worktree',
    capabilities: WORKTREE_CAPABILITIES,
    ...over,
  };
}

const prSummary = (over: Partial<DiffSummary> = {}): DiffSummaryResult => ({
  status: 'ok',
  summary: summary({
    subjectId: 'gh-1-7',
    source: 'forge-api',
    capabilities: FORGE_API_CAPABILITIES,
    ...over,
  }),
});

function register(deps: AiReviewHandlersDeps): RelayRegistry {
  const handlers = createAiReviewHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }
  return registry;
}

interface RealHarness {
  registry: RelayRegistry;
  createAiReview: Mock;
  probe: Mock;
  filesFor: Mock;
  prFile: Mock;
}

/** A real runner over real subjects; every read the refusals must never reach is a spy. */
function realHarness(
  over: { taskSummary?: DiffSummaryResult; prSummary?: DiffSummaryResult } = {},
): RealHarness {
  const createAiReview = vi.fn(() => REVIEW);
  const probe = vi.fn(async () => null);
  const filesFor = vi.fn(async () => null);
  const prFile = vi.fn(async () => {
    throw new Error('a refused subject must not read a file');
  });

  const subjects = new AiReviewSubjects({
    store: {
      getTask: (id: string) => (id === 't1' ? TASK : undefined),
      getProject: (id: string) => (id === 'p' ? PROJECT : undefined),
      listReviewQueue: () => [],
      listMergeRequests: () => [],
    },
    diffs: {
      summary: async () => over.taskSummary ?? { status: 'ok', summary: summary() },
      filesFor,
    },
    subjects: {
      summary: async () => over.prSummary ?? prSummary(),
      file: prFile,
      localProject: () => null,
    },
    hostFor: () => {
      throw new Error('a refused subject must not reach git');
    },
    cardWorktree: async () => null,
  } as unknown as AiReviewSubjectDeps);

  const runner = new AiReviewRunner({
    store: { createAiReview },
    scheduler: { setReviewParkHandler: () => {} },
    worktrees: {},
    subjects,
    probe,
    emitChanged: () => {},
  } as unknown as AiReviewRunnerDeps);

  return { registry: register({ runner }), createAiReview, probe, filesFor, prFile };
}

describe('aiReview:start — refusals, end to end', () => {
  it('refuses a forge-api PR subject: no-capability, no row, no probe', async () => {
    const h = realHarness();
    const result = await h.registry.invoke('aiReview:start', ['gh-1-7']);
    expect(result).toEqual({
      ok: true,
      value: {
        refused: 'no-capability',
        reason: 'add the repo as a project to let the AI review it',
      },
    });
    expect(h.createAiReview).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.prFile).not.toHaveBeenCalled();
  });

  it('refuses a diff over the changed-lines cap: too-large, no row, no file read', async () => {
    const h = realHarness({
      taskSummary: {
        status: 'ok',
        summary: summary({
          files: [entry('big.ts', { additions: AI_REVIEW_MAX_CHANGED_LINES + 1, deletions: 0 })],
        }),
      },
    });
    const result = await h.registry.invoke('aiReview:start', ['task:t1']);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ refused: 'too-large' });
    expect(h.createAiReview).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.filesFor).not.toHaveBeenCalled();
  });

  it('refuses a diff over the file cap: too-large, no row, no file read', async () => {
    const files = Array.from({ length: AI_REVIEW_MAX_FILES + 1 }, (_, i) =>
      entry(`f${i}.ts`, { additions: 1, deletions: 0 }),
    );
    const h = realHarness({ taskSummary: { status: 'ok', summary: summary({ files }) } });
    const result = await h.registry.invoke('aiReview:start', ['task:t1']);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ refused: 'too-large' });
    expect(h.createAiReview).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.filesFor).not.toHaveBeenCalled();
  });
});

interface StubHarness {
  registry: RelayRegistry;
  start: Mock;
  cancel: Mock;
  list: Mock;
  get: Mock;
}

function stubHarness(): StubHarness {
  const start = vi.fn(async () => REVIEW);
  const cancel = vi.fn(async () => true);
  const list = vi.fn(() => [REVIEW]);
  const get = vi.fn((): AiReview | undefined => REVIEW);
  return {
    registry: register({ runner: { start, cancel, list, get } }),
    start,
    cancel,
    list,
    get,
  };
}

describe('aiReview handlers — routing', () => {
  it('starts as a human and answers the row', async () => {
    const h = stubHarness();
    const result = await h.registry.invoke('aiReview:start', ['task:t1']);
    expect(h.start).toHaveBeenCalledWith('task:t1', 'human');
    expect(result).toEqual({ ok: true, value: REVIEW });
  });

  it('routes cancel by id', async () => {
    const h = stubHarness();
    const result = await h.registry.invoke('aiReview:cancel', ['ai-1']);
    expect(h.cancel).toHaveBeenCalledWith('ai-1');
    expect(result).toEqual({ ok: true, value: true });
  });

  it('routes list by subjectId', async () => {
    const h = stubHarness();
    const result = await h.registry.invoke('aiReview:list', ['task:t1']);
    expect(h.list).toHaveBeenCalledWith('task:t1');
    expect(result).toEqual({ ok: true, value: [REVIEW] });
  });

  it('routes get by id', async () => {
    const h = stubHarness();
    const result = await h.registry.invoke('aiReview:get', ['ai-1']);
    expect(h.get).toHaveBeenCalledWith('ai-1');
    expect(result).toEqual({ ok: true, value: REVIEW });
  });

  it('answers null, not undefined, for an unknown review', async () => {
    const h = stubHarness();
    h.get.mockReturnValueOnce(undefined);
    const result = await h.registry.invoke('aiReview:get', ['nope']);
    expect(result).toEqual({ ok: true, value: null });
  });
});

describe('aiReview handlers — argument validation', () => {
  const CHANNELS = [
    ['aiReview:start', 'subjectId', 'start'],
    ['aiReview:cancel', 'id', 'cancel'],
    ['aiReview:list', 'subjectId', 'list'],
    ['aiReview:get', 'id', 'get'],
  ] as const;
  const BAD: [string, unknown[]][] = [
    ['an empty string', ['']],
    ['a number', [42]],
    ['a missing argument', []],
  ];

  for (const [channel, name, method] of CHANNELS) {
    for (const [what, args] of BAD) {
      it(`${channel} refuses ${what} without reaching the runner`, async () => {
        const h = stubHarness();
        const result = await h.registry.invoke(channel, args);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(new RegExp(`${name} must be a non-empty string`));
        expect(h[method]).not.toHaveBeenCalled();
      });
    }
  }
});
