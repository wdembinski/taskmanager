/**
 * `AiReviewRunner` at the scheduler level: a REAL `Scheduler` whose `SessionManager` is a
 * fake (it captures each run's observer and records `send`/`stop`), an in-memory store of
 * reviews and draft batches, fake worktrees and a fake subject source. Every test drives
 * the session's events by hand.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AiDraftInput, AiReview, AiReviewStatus } from '@shared/aiReview';
import type { AuthState } from '@shared/auth';
import type { LimitState } from '@shared/limit';
import type { Project, Task } from '@shared/model';
import {
  markOutdated,
  WORKTREE_CAPABILITIES,
  type DiffFile,
  type DiffSummary,
  type ReviewComment,
} from '@shared/review';
import type { SessionEvent, StartSessionRequest } from '@shared/session';
import type { ClaudeCliCapabilities } from '../claudeCapabilities';
import type { CliUsageReading } from '../claudeUsage';
import type { PermissionGate } from '../claudeSession';
import { Scheduler } from '../scheduler';
import type { SessionManager } from '../sessionManager';
import type { Store } from '../store';
import type { AiReviewRefusal, ReviewTarget } from './aiReviewSubjects';
import {
  AiReviewRunner,
  REVIEW_ALLOWED_TOOLS,
  REVIEW_DISALLOWED_TOOLS,
  reviewModelFor,
  type AiReviewRunnerDeps,
} from './aiReviewRunner';

const PROJECT = {
  id: 'p',
  path: '/repo',
  planningModel: null,
  reviewModel: null,
  defaultModel: 'sonnet',
} as unknown as Project;

/** A limit reset an hour out: in the past, the gate's resume timer fires inside `flush()`. */
const FUTURE_RESET = Math.floor(Date.now() / 1000) + 60 * 60;

/** `a.ts` as the reviewer was shown it: line 2 is the added `const b = 2;`. */
const FILE_A: DiffFile = {
  diffId: 'd1',
  path: 'a.ts',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      header: '@@ -1 +1,2 @@',
      lines: [
        { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
        { kind: 'add', text: 'const b = 2;', newLine: 2 },
      ],
    },
  ],
};

function summary(subjectId: string): DiffSummary {
  return {
    diffId: 'd1',
    baseRef: 'main',
    baseSha: 'base',
    headSha: 'head',
    includesWorkingTree: false,
    files: [
      {
        path: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        image: false,
        bytes: 30,
      },
    ],
    truncated: false,
    subjectId,
    source: 'worktree',
    capabilities: WORKTREE_CAPABILITIES,
  };
}

function target(subjectId: string): ReviewTarget {
  return {
    project: PROJECT,
    taskId: subjectId.startsWith('task:') ? subjectId.slice(5) : null,
    summary: summary(subjectId),
    files: new Map([['a.ts', FILE_A]]),
    prompt: {
      subject: { kind: 'task', title: 'Fix it' },
      baseRef: 'main',
      baseSha: 'base',
      headSha: 'head',
      files: [],
      reviewDoc: null,
    },
  };
}

const FINDINGS = [
  {
    path: 'a.ts',
    side: 'new',
    startLine: 2,
    endLine: 2,
    severity: 'minor',
    title: 'Name it',
    body: 'b says nothing.',
  },
  {
    path: 'a.ts',
    side: 'new',
    startLine: 40,
    endLine: 41,
    severity: 'nit',
    title: 'Far away',
    body: 'A caller.',
  },
];

const reply = (output: unknown) => `Reviewed.\n\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n`;
const VALID = reply({ summary: 'Two notes.', verdict: 'comment', findings: FINDINGS });

function result(
  resultText: string,
  over: Partial<Extract<SessionEvent, { kind: 'result' }>> = {},
): Extract<SessionEvent, { kind: 'result' }> {
  return {
    kind: 'result',
    success: true,
    resultText,
    costUsd: 0.42,
    durationMs: 1000,
    stopReason: null,
    terminalReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 },
    ...over,
  };
}

const CAPS: ClaudeCliCapabilities = {
  allowedTools: true,
  disallowedTools: true,
  settingSources: true,
  strictMcpConfig: true,
  version: '2.1.0',
};

/** Let the runner's awaited worktree calls and pumps run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function harness(
  opts: {
    limit?: LimitState;
    auth?: AuthState;
    /** Restore the saved gates as the harness is built — before the runner exists, as at boot. */
    restore?: boolean;
    /** `/usage`, through `scheduler.setUsageProbe`; unset = no probe. */
    usage?: () => Promise<CliUsageReading | null>;
    /** Rows already in the store when the runner is built. */
    seed?: AiReview[];
    caps?: ClaudeCliCapabilities | null;
    resolve?: (subjectId: string) => ReviewTarget | AiReviewRefusal;
    createFails?: string;
    tasks?: Task[];
  } = {},
) {
  // --- the real scheduler, over a fake session manager ---
  const schedulerStore = {
    getSettings: () => ({ limitJitterMs: 0 }),
    getProject: () => PROJECT,
    appendTokenUsage: vi.fn(),
    loadLimitGate: () => opts.limit ?? null,
    saveLimitGate: vi.fn(),
    clearLimitGate: vi.fn(),
    loadAuthGate: () => opts.auth ?? null,
    saveAuthGate: vi.fn(),
    listProjects: () => [],
    saveAttention: () => undefined,
    deleteAttention: () => undefined,
    listAttention: () => [],
    getTaskHistory: () => [],
    // A gate's resume reconsiders every chain.
    listTaskLinks: () => [],
  } as unknown as Store;
  const observers = new Map<string, (event: SessionEvent) => void>();
  const requests: StartSessionRequest[] = [];
  const startedRunIds: string[] = [];
  const sessions = {
    start: vi.fn(
      (req: StartSessionRequest, o: { runId: string; onEvent: (e: SessionEvent) => void }) => {
        requests.push(req);
        startedRunIds.push(o.runId);
        observers.set(o.runId, o.onEvent);
        return { runId: o.runId };
      },
    ),
    send: vi.fn(),
    stop: vi.fn(),
  };
  const scheduler = new Scheduler(
    schedulerStore,
    sessions as unknown as SessionManager,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  scheduler.setPermissionGate({ configPath: 'gate.json' } as unknown as PermissionGate);
  if (opts.usage) scheduler.setUsageProbe(opts.usage);
  if (opts.restore !== false) {
    if (opts.auth) scheduler.restoreAuthGate();
    if (opts.limit) scheduler.restoreLimitGate();
  }

  // --- the in-memory store of reviews and draft batches ---
  const reviews = new Map<string, AiReview>((opts.seed ?? []).map((r) => [r.id, r]));
  const resultTexts = new Map<string, string | null>();
  const batches: AiDraftInput[][] = [];
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, t]));
  const store: AiReviewRunnerDeps['store'] = {
    createAiReview: vi.fn((input) => {
      const review = { ...input, findingCount: 0, droppedCount: 0 };
      reviews.set(review.id, review);
      return review;
    }),
    getAiReview: (id) => reviews.get(id),
    listAiReviews: (subjectId) => [...reviews.values()].filter((r) => r.subjectId === subjectId),
    listAiReviewsByStatus: (statuses) =>
      [...reviews.values()].filter((r) => statuses.includes(r.status)),
    updateAiReview: (id, patch) => {
      const prior = reviews.get(id);
      if (!prior) return undefined;
      const { resultText, ...rest } = patch;
      if (resultText !== undefined) resultTexts.set(id, resultText);
      const next = { ...prior, ...rest };
      reviews.set(id, next);
      return next;
    },
    addAiDrafts: vi.fn((drafts: readonly AiDraftInput[]) => {
      batches.push([...drafts]);
      return [];
    }),
    getTask: (id) => tasks.get(id),
  };

  const worktrees = {
    create: vi.fn(async (_p: Project, id: string, _sha: string) =>
      opts.createFails
        ? { ok: false as const, reason: opts.createFails }
        : { ok: true as const, path: `/rw/${id}` },
    ),
    remove: vi.fn(async () => null),
  };
  const emitted: AiReview[] = [];
  let ids = 0;
  const runner = new AiReviewRunner({
    store,
    scheduler,
    worktrees,
    subjects: { resolve: async (id) => (opts.resolve ?? target)(id) },
    probe: async () => (opts.caps === undefined ? CAPS : opts.caps),
    emitChanged: (review) => emitted.push(review),
    now: () => 1000,
    newId: () => `r${++ids}`,
  });

  /** Feed an event to the session the runner started `n`th (0 = first). */
  const emit = (event: SessionEvent, n = startedRunIds.length - 1) =>
    observers.get(startedRunIds[n])!(event);

  return {
    runner,
    scheduler,
    sessions,
    store,
    reviews,
    resultTexts,
    batches,
    worktrees,
    emitted,
    requests,
    startedRunIds,
    emit,
  };
}

async function started(h: ReturnType<typeof harness>, subjectId = 'task:t1'): Promise<AiReview> {
  const review = await h.runner.start(subjectId, 'human');
  if ('refused' in review) throw new Error(`refused: ${review.reason}`);
  await flush();
  return review;
}

describe('reviewModelFor — the review rung (F16.10)', () => {
  it("runs on the project's reviewModel, even when a planning model is set", () => {
    expect(
      reviewModelFor({ reviewModel: 'opus', planningModel: 'haiku', defaultModel: 'sonnet' }),
    ).toBe('opus');
  });

  it('falls back to the planning model when reviewModel is null', () => {
    expect(
      reviewModelFor({ reviewModel: null, planningModel: 'haiku', defaultModel: 'sonnet' }),
    ).toBe('haiku');
  });

  it('falls back to the execution model when both are null', () => {
    expect(reviewModelFor({ reviewModel: null, planningModel: null, defaultModel: 'sonnet' })).toBe(
      'sonnet',
    );
  });
});

describe('AiReviewRunner — a clean run', () => {
  it('lands every finding in one batch, then cleans up and reports done', async () => {
    const h = harness();
    const review = await started(h);
    expect(h.reviews.get(review.id)?.status).toBe('running');
    const runId = h.startedRunIds[0];

    h.emit(result(VALID));
    await flush();

    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(2);
    expect(h.batches[0].every((d) => d.diffId === 'd1' && d.aiReviewId === review.id)).toBe(true);
    expect(h.batches[0][0]).toMatchObject({ line: 2, excerpt: 'const b = 2;', fileLevel: false });
    expect(h.batches[0][1]).toMatchObject({ fileLevel: true, excerpt: '' });

    const row = h.reviews.get(review.id)!;
    expect(row).toMatchObject({
      status: 'done',
      summary: 'Two notes.',
      verdict: 'comment',
      findingCount: 2,
      droppedCount: 0,
      costUsd: 0.42,
      finishedAt: 1000,
    });
    expect(row.tokens).toMatchObject({ inputTokens: 10, cacheReadTokens: 100 });
    expect(h.resultTexts.get(review.id)).toBe(VALID);
    expect(h.sessions.stop).toHaveBeenCalledWith(runId);
    expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);
    expect(h.emitted.at(-1)?.status).toBe('done');
  });

  it('launches with the review flags, in the worktree, on the planning ladder', async () => {
    const h = harness();
    await started(h);
    const [request] = h.requests;
    expect(request).toMatchObject({
      cwd: '/rw/r1',
      model: 'sonnet',
      permissionMode: 'manual',
      settingSources: ['user'],
      strictMcpConfig: true,
    });
    expect(request.allowedTools).toEqual(REVIEW_ALLOWED_TOOLS);
    expect(request.allowedTools).toContain('Bash(git log:*)');
    expect(request.disallowedTools).toEqual(REVIEW_DISALLOWED_TOOLS);
    expect(request.prompt).toContain('code review only');
    expect(h.worktrees.create).toHaveBeenCalledWith(PROJECT, 'r1', 'head');
  });
});

describe('AiReviewRunner — the repair turn', () => {
  it('sends exactly one repair naming the errors, then lands a valid second reply', async () => {
    const h = harness();
    const review = await started(h);
    h.emit(result('I looked, it is fine. No json, sorry.'));
    await flush();
    expect(h.sessions.send).toHaveBeenCalledTimes(1);
    const [runId, text] = h.sessions.send.mock.calls[0];
    expect(runId).toBe(h.startedRunIds[0]);
    expect(text).toContain('no ```json block in the reply');
    expect(h.sessions.stop).not.toHaveBeenCalled();
    expect(h.reviews.get(review.id)?.status).toBe('running');

    h.emit(result(VALID));
    await flush();
    expect(h.sessions.send).toHaveBeenCalledTimes(1);
    expect(h.reviews.get(review.id)?.status).toBe('done');
    expect(h.batches).toHaveLength(1);
  });

  it('fails after a second bad reply, keeping the errors and the reply, with no drafts', async () => {
    const h = harness();
    const review = await started(h);
    h.emit(result(reply({ summary: 'x', verdict: 'lgtm', findings: [] })));
    await flush();
    const second = reply({ summary: '', verdict: 'comment', findings: [] });
    h.emit(result(second));
    await flush();

    const row = h.reviews.get(review.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('summary must be a non-empty string');
    expect(h.resultTexts.get(review.id)).toBe(second);
    expect(h.store.addAiDrafts).not.toHaveBeenCalled();
    expect(h.sessions.send).toHaveBeenCalledTimes(1);
    expect(h.worktrees.remove).toHaveBeenCalled();
  });
});

describe('AiReviewRunner — cancel', () => {
  it('cancels mid-run: session stopped, worktree removed, a late result ignored', async () => {
    const h = harness();
    const review = await started(h);
    expect(await h.runner.cancel(review.id)).toBe(true);
    await flush();
    expect(h.reviews.get(review.id)?.status).toBe('cancelled');
    expect(h.sessions.stop).toHaveBeenCalledWith(h.startedRunIds[0]);
    expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);

    h.emit(result(VALID));
    await flush();
    expect(h.store.addAiDrafts).not.toHaveBeenCalled();
    expect(h.reviews.get(review.id)?.status).toBe('cancelled');
    expect(await h.runner.cancel(review.id)).toBe(false);
  });

  it('cancels a queued review without ever starting it', async () => {
    const h = harness();
    await started(h, 'task:t1');
    const second = await started(h, 'task:t2');
    expect(h.reviews.get(second.id)?.status).toBe('queued');
    expect(await h.runner.cancel(second.id)).toBe(true);
    h.emit(result(VALID));
    await flush();
    expect(h.reviews.get(second.id)?.status).toBe('cancelled');
    expect(h.startedRunIds).toHaveLength(1);
  });
});

describe('AiReviewRunner — a head that moved mid-run', () => {
  it('stamps drafts with the pinned diff, so markOutdated flags them against the new one', async () => {
    const h = harness();
    await started(h);
    // The card's worktree moves on while the reviewer reads: line 2 is now something else.
    const moved: DiffFile = {
      ...FILE_A,
      diffId: 'd2',
      hunks: [
        {
          ...FILE_A.hunks[0],
          lines: [
            { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
            { kind: 'add', text: 'const renamed = 2;', newLine: 2 },
          ],
        },
      ],
    };
    h.emit(result(VALID));
    await flush();

    const [inline] = h.batches[0];
    expect(inline.diffId).toBe('d1');
    expect(inline.excerpt).toBe('const b = 2;');
    const asComment = {
      ...inline,
      id: 'c1',
      taskId: 't1',
      createdAt: 1,
      updatedAt: 1,
      sentAt: null,
    } as ReviewComment;
    expect(markOutdated([asComment], moved)[0].outdated).toBe(true);
    expect(markOutdated([asComment], FILE_A)[0].outdated).toBe(false);
  });
});

describe('AiReviewRunner — refusals', () => {
  async function refusal(h: ReturnType<typeof harness>, subjectId = 'task:t1') {
    const answer = await h.runner.start(subjectId, 'human');
    expect(h.store.createAiReview).not.toHaveBeenCalled();
    return answer;
  }

  it('passes the subject source’s refusal straight through', async () => {
    const h = harness({
      resolve: () => ({
        refused: 'too-large',
        reason: 'too large to review — 5,000 changed lines',
      }),
    });
    expect(await refusal(h)).toMatchObject({ refused: 'too-large' });
  });

  it('refuses a duplicate of a review still under way, and an already-reviewed diff', async () => {
    const h = harness();
    const review = await started(h);
    expect(await h.runner.start('task:t1', 'human')).toMatchObject({ refused: 'duplicate' });
    h.emit(result(VALID));
    await flush();
    expect(h.reviews.get(review.id)?.status).toBe('done');
    expect(await h.runner.start('task:t1', 'human')).toMatchObject({
      refused: 'already-reviewed',
    });
  });

  it('refuses a card with a live run — including one of its steps', async () => {
    const h = harness({ tasks: [{ id: 'step', parentTaskId: 't1' } as Task] });
    (h.scheduler as unknown as { runs: Map<string, unknown> }).runs.set('run-x', {
      taskId: 'step',
      runId: 'run-x',
      projectId: 'p',
      settled: false,
    });
    expect(await refusal(h)).toMatchObject({ refused: 'card-running' });
  });

  it('refuses a CLI that lacks the sandbox flags, or cannot be read', async () => {
    const lacking = harness({ caps: { ...CAPS, settingSources: false } });
    expect(await refusal(lacking)).toEqual({
      refused: 'sandbox-unsupported',
      reason: 'update Claude Code — this CLI lacks --setting-sources',
    });
    expect(await refusal(harness({ caps: null }))).toMatchObject({
      refused: 'sandbox-unsupported',
    });
  });

  it('parks, rather than refuses, while the usage-limit gate is up', async () => {
    const h = harness({
      limit: {
        limitType: 'rolling',
        resetsAt: null,
        resumeAt: Date.now() + 3_600_000,
        parkedTaskIds: [],
      },
    });
    const answer = await h.runner.start('task:t1', 'human');
    await flush();
    expect(answer).not.toHaveProperty('refused');
    const row = h.reviews.get((answer as AiReview).id)!;
    expect(row.status).toBe('parked-limit');
    expect(row.parkReason).toMatch(/usage limit/);
    expect(row.finishedAt).toBeNull();
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual([row.id]);
    expect(h.startedRunIds).toHaveLength(0);
    expect(h.worktrees.create).not.toHaveBeenCalled();
    h.scheduler.dispose();
  });

  it('refuses once disposed', async () => {
    const h = harness();
    h.runner.dispose();
    expect(await refusal(h)).toMatchObject({ refused: 'shutting-down' });
  });
});

describe('AiReviewRunner — the queue and launch failures', () => {
  it('runs one review at a time: the second starts only once the first settles', async () => {
    const h = harness();
    const first = await started(h, 'task:t1');
    const second = await started(h, 'task:t2');
    expect(h.startedRunIds).toHaveLength(1);
    expect(h.reviews.get(second.id)?.status).toBe('queued');

    h.emit(result(VALID), 0);
    await flush();
    expect(h.reviews.get(first.id)?.status).toBe('done');
    expect(h.startedRunIds).toHaveLength(2);
    expect(h.reviews.get(second.id)?.status).toBe('running');
  });

  it('fails a review whose worktree cannot be made, and pumps the next', async () => {
    const h = harness({ createFails: 'fatal: could not create work tree dir: No space left' });
    const first = await started(h, 'task:t1');
    const second = await started(h, 'task:t2');
    await flush();
    expect(h.reviews.get(first.id)).toMatchObject({
      status: 'failed',
      error: 'fatal: could not create work tree dir: No space left',
    });
    expect(h.worktrees.create).toHaveBeenCalledWith(PROJECT, second.id, 'head');
    expect(h.reviews.get(second.id)?.status).toBe('failed');
    expect(h.startedRunIds).toHaveLength(0);
    expect(h.worktrees.remove).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a sign-in failure',
      'Failed to authenticate: OAuth session expired',
      'parked-signin',
      'OAuth session expired',
    ],
    [
      'a usage limit',
      `Claude AI usage limit reached|${FUTURE_RESET}`,
      'parked-limit',
      'usage limit reached',
    ],
  ])(
    'parks on %s in the gate, with no repair turn and nothing landed',
    async (_name, text, status, inReason) => {
      const h = harness();
      const review = await started(h);
      h.emit(result(text, { success: false }));
      await flush();
      const row = h.reviews.get(review.id)!;
      expect(row.status).toBe(status);
      expect(row.parkReason).toContain(inReason);
      expect(row.finishedAt).toBeNull();
      const gate =
        status === 'parked-signin' ? h.scheduler.currentAuth() : h.scheduler.currentLimit();
      expect(gate?.parkedReviewIds).toEqual([review.id]);
      expect(h.sessions.stop).toHaveBeenCalledWith(h.startedRunIds[0]);
      expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);
      expect(h.sessions.send).not.toHaveBeenCalled();
      expect(h.store.addAiDrafts).not.toHaveBeenCalled();
      h.scheduler.dispose();
    },
  );

  it('fails a session that exits without an answer', async () => {
    const h = harness();
    const review = await started(h);
    h.emit({ kind: 'exited', code: 1 });
    await flush();
    expect(h.reviews.get(review.id)).toMatchObject({
      status: 'failed',
      error: 'the review session ended without an answer',
    });
    expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);
  });

  it('records a denied tool use on a failed review', async () => {
    const h = harness();
    const review = await started(h);
    await h.scheduler.decidePermission({
      runId: h.startedRunIds[0],
      toolName: 'Edit',
      input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    });
    h.emit({ kind: 'exited', code: 1 });
    await flush();
    expect(h.reviews.get(review.id)?.error).toContain('denied tool uses: Edit');
  });
});

describe('AiReviewRunner — parks (F16.9)', () => {
  /**
   * A limit named only in `resultText` — the text tier, no epoch and no `rate-limit` event.
   * ("You've hit your session limit" is not a sentence `detectLimitFailure` reads: see the
   * scheduler's settled-park test.)
   */
  const PROSE_LIMIT = "You've reached your usage limit · resets 11:30pm (Europe/Warsaw)";
  /** A failure that is no wall at all: left to the settle path, it would earn a repair turn. */
  const API_ERROR =
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
  const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const REJECTED = (): SessionEvent =>
    ({
      kind: 'rate-limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    }) as SessionEvent;

  /** A gate's own timer (a reset already passed, at boot) fires on a real `setTimeout`. */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
    await flush();
  }

  /** A review the store already holds `parked-*` from a previous run of the app. */
  function parkedRow(id: string, status: AiReviewStatus = 'parked-limit'): AiReview {
    return {
      id,
      subjectId: 'task:t1',
      diffId: 'd0',
      headSha: 'old',
      status,
      parkReason: 'usage limit reached',
      model: 'sonnet',
      startedAt: 500,
      finishedAt: null,
      costUsd: 0.1,
      tokens: null,
      summary: null,
      verdict: null,
      findingCount: 0,
      droppedCount: 0,
      error: null,
      requestedBy: 'human',
    };
  }

  const savedLimit = (resumeAt: number, parkedReviewIds: string[]): LimitState => ({
    limitType: 'rolling',
    resetsAt: null,
    resumeAt,
    parkedTaskIds: [],
    parkedReviewIds,
  });

  it('parks a limit said only in prose, then restarts from scratch on resume', async () => {
    const h = harness();
    const review = await started(h);
    h.emit(result(PROSE_LIMIT, { success: false, terminalReason: 'api_error' }));
    await flush();

    expect(h.reviews.get(review.id)).toMatchObject({ status: 'parked-limit', finishedAt: null });
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual([review.id]);
    expect(h.sessions.stop).toHaveBeenCalledWith(h.startedRunIds[0]);
    expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);
    expect(h.sessions.send).not.toHaveBeenCalled();

    h.scheduler.resumeLimitNow();
    await flush();
    expect(h.scheduler.currentLimit()).toBeNull();
    expect(h.startedRunIds).toHaveLength(2);
    expect(h.worktrees.create).toHaveBeenCalledTimes(2);
    expect(h.reviews.get(review.id)).toMatchObject({ status: 'running', parkReason: null });

    h.emit(result(VALID));
    await flush();
    expect(h.batches).toHaveLength(1);
    const row = h.reviews.get(review.id)!;
    expect(row.status).toBe('done');
    // The parked session's spend is the base the restart's totals are added to.
    expect(row.costUsd).toBeCloseTo(0.84);
    h.scheduler.dispose();
  });

  it('fails, rather than parks, a prose limit /usage contradicts', async () => {
    const h = harness({ usage: () => Promise.resolve({ sessionPct: 20, weeklyPct: 3 }) });
    const review = await started(h);
    h.emit(result(PROSE_LIMIT, { success: false, terminalReason: 'api_error' }));
    await flush();

    const row = h.reviews.get(review.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('/usage shows budget left');
    expect(row.parkReason).toBeNull();
    expect(h.scheduler.currentLimit()).toBeNull();
    expect(h.sessions.send).not.toHaveBeenCalled();
    expect(h.worktrees.remove).toHaveBeenCalledWith(PROJECT, review.id);
  });

  it('parks a sign-in failure, then restarts it once signed in', async () => {
    const h = harness();
    const review = await started(h);
    h.emit(
      result('Failed to authenticate: OAuth session expired and could not be refreshed', {
        success: false,
        costUsd: 0,
        usage: NO_USAGE,
      }),
    );
    await flush();

    expect(h.reviews.get(review.id)?.status).toBe('parked-signin');
    expect(h.scheduler.currentAuth()?.parkedReviewIds).toEqual([review.id]);
    expect(h.sessions.send).not.toHaveBeenCalled();

    h.scheduler.signedIn();
    await flush();
    expect(h.scheduler.currentAuth()).toBeNull();
    expect(h.startedRunIds).toHaveLength(2);
    expect(h.worktrees.create).toHaveBeenCalledTimes(2);

    h.emit(result(VALID));
    await flush();
    expect(h.reviews.get(review.id)?.status).toBe('done');
    expect(h.batches).toHaveLength(1);
  });

  it.each([
    ['before the runner exists, as at boot', true],
    ['once the runner is listening', false],
  ])(
    'restarts a review held by a gate whose reset passed while closed, restored %s, once',
    async (_name, early) => {
      const h = harness({
        seed: [parkedRow('old1')],
        limit: savedLimit(Date.now() - 60_000, ['old1']),
        restore: early,
      });
      if (!early) h.scheduler.restoreLimitGate();
      await h.runner.restoreParked();
      await settle();
      // A second boot pass finds nothing left to restart.
      await h.runner.restoreParked();
      await settle();

      expect(h.scheduler.currentLimit()).toBeNull();
      expect(h.startedRunIds).toHaveLength(1);
      expect(h.worktrees.create).toHaveBeenCalledTimes(1);
      // Re-resolved and re-pinned at the subject's current head.
      expect(h.reviews.get('old1')).toMatchObject({
        status: 'running',
        diffId: 'd1',
        headSha: 'head',
      });
      h.emit(result(VALID));
      await flush();
      expect(h.reviews.get('old1')?.status).toBe('done');
    },
  );

  it('holds a review in a restored gate whose reset is still ahead until it lifts', async () => {
    const h = harness({
      seed: [parkedRow('old1')],
      limit: savedLimit(Date.now() + 3_600_000, ['old1']),
    });
    await h.runner.restoreParked();
    await settle();
    expect(h.startedRunIds).toHaveLength(0);
    expect(h.reviews.get('old1')?.status).toBe('parked-limit');
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual(['old1']);

    h.scheduler.resumeLimitNow();
    await flush();
    expect(h.startedRunIds).toHaveLength(1);
    expect(h.reviews.get('old1')?.status).toBe('running');
    h.scheduler.dispose();
  });

  it('restarts an orphan parked row that no gate holds', async () => {
    const h = harness({ seed: [parkedRow('old1'), parkedRow('old2', 'parked-signin')] });
    await h.runner.restoreParked();
    await flush();
    // One at a time: the first runs, the second waits its turn.
    expect(h.startedRunIds).toHaveLength(1);
    expect(h.reviews.get('old1')?.status).toBe('running');
    expect(h.reviews.get('old2')?.status).toBe('queued');
    h.emit(result(VALID));
    await flush();
    expect(h.startedRunIds).toHaveLength(2);
    expect(h.reviews.get('old2')?.status).toBe('running');
  });

  /**
   * The runner's repair turn, seen where the runner asks for it: once the park has stopped
   * the session, the scheduler drops a send to it, so `sessions.send` alone would not show it.
   */
  const repairs = (h: ReturnType<typeof harness>) => vi.spyOn(h.scheduler, 'sendToReviewSession');

  it('keeps a review parked when a failed result lands 10 ms after the park', async () => {
    const h = harness();
    const review = await started(h);
    const repair = repairs(h);
    h.emit(REJECTED());
    await flush();
    expect(h.reviews.get(review.id)?.status).toBe('parked-limit');
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual([review.id]);

    await new Promise((r) => setTimeout(r, 10));
    h.emit(result(API_ERROR, { success: false, terminalReason: 'api_error' }));
    await flush();

    expect(h.reviews.get(review.id)).toMatchObject({ status: 'parked-limit', finishedAt: null });
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual([review.id]);
    expect(repair).not.toHaveBeenCalled();
    expect(h.sessions.send).not.toHaveBeenCalled();
    expect(h.store.addAiDrafts).not.toHaveBeenCalled();

    h.scheduler.resumeLimitNow();
    await flush();
    expect(h.startedRunIds).toHaveLength(2);
    expect(h.worktrees.create).toHaveBeenCalledTimes(2);
    expect(h.reviews.get(review.id)?.status).toBe('running');
    h.scheduler.dispose();
  });

  it('keeps a review parked when the park lands while its result is being classified', async () => {
    const h = harness();
    const review = await started(h);
    const repair = repairs(h);
    h.emit(result(API_ERROR, { success: false, terminalReason: 'api_error' }));
    // Same tick: `classifyReviewWall` has not answered yet.
    h.emit(REJECTED());
    await flush();

    expect(h.reviews.get(review.id)?.status).toBe('parked-limit');
    expect(h.scheduler.currentLimit()?.parkedReviewIds).toEqual([review.id]);
    expect(repair).not.toHaveBeenCalled();
    expect(h.store.addAiDrafts).not.toHaveBeenCalled();
    h.scheduler.dispose();
  });
});
