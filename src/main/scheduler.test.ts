/**
 * Unit tests for the scheduler's pure decision logic — no store, no processes.
 * The class that wires this to SQLite and the SessionManager is exercised by
 * hand / verify; here we prove the selection rule and prompt shape.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildTaskPrompt,
  failureActionsFor,
  FAILURE_ACTION,
  PROPOSAL_ACTION,
  Scheduler,
  selectNextPending,
  shouldAutoRetry,
  type Schedulable,
} from './scheduler';
import { AGREE_SENTINEL, OBJECT_SENTINEL, PROPOSE_SENTINEL } from './attention';
import type { PermissionMode } from '@shared/session';
import type { Project, Task } from '@shared/model';
import type { LimitState } from '@shared/limit';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';
import type { WorktreeManager } from './worktreeManager';

/**
 * Inbox persistence, stubbed inert.
 *
 * Every path that raises or resolves an Attention item also writes it to the DB so it
 * survives a restart, but none of these tests are about that — they assert on the
 * `emitAttention` / `emitAttentionResolved` callbacks instead. Spread into each store
 * stub so a test only has to say what it actually cares about.
 */
const INERT_ATTENTION_STORE = {
  saveAttention: () => undefined,
  deleteAttention: () => undefined,
  listAttention: () => [],
  // Read when a finished chain summarises itself; no test here asserts on the summary's
  // per-step outcomes, so an empty history is the honest stub.
  getTaskHistory: () => [],
};

// `title` defaults to `id` so dependencies (referenced by title) can name other
// rows by their id in these tests.
const t = (
  id: string,
  status: Schedulable['status'],
  order: number,
  dependsOn: string[] = [],
  opts: { phase?: string; isContract?: boolean; isScaffold?: boolean } = {},
): Schedulable => ({
  id,
  status,
  order,
  title: id,
  dependsOn,
  phase: opts.phase ?? '',
  isContract: opts.isContract ?? false,
  isScaffold: opts.isScaffold ?? false,
});

describe('selectNextPending', () => {
  it('picks the lowest-order pending task', () => {
    const tasks = [t('a', 'done', 0), t('b', 'pending', 1), t('c', 'pending', 2)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('b');
  });

  it('ignores order in the array — order field wins', () => {
    const tasks = [t('late', 'pending', 5), t('early', 'pending', 1)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('early');
  });

  it('skips tasks already in flight', () => {
    const tasks = [t('a', 'pending', 0), t('b', 'pending', 1)];
    expect(selectNextPending(tasks, new Set(['a']))?.id).toBe('b');
  });

  it('returns null when nothing is pending or all are in flight', () => {
    expect(selectNextPending([t('a', 'running', 0), t('b', 'done', 1)], new Set())).toBeNull();
    expect(selectNextPending([t('a', 'pending', 0)], new Set(['a']))).toBeNull();
  });

  it('never returns non-pending tasks (running/failed/stopped are not restarted)', () => {
    const tasks = [
      t('r', 'running', 0),
      t('f', 'failed', 1),
      t('s', 'stopped', 2),
      t('w', 'waiting-input', 3),
      t('go', 'pending', 4),
    ];
    expect(selectNextPending(tasks, new Set())?.id).toBe('go');
  });

  it('holds a task until its @needs dependency is done', () => {
    // 'b' needs 'a'; while 'a' is pending, only 'a' is eligible.
    const pending = [t('a', 'pending', 0), t('b', 'pending', 1, ['a'])];
    expect(selectNextPending(pending, new Set())?.id).toBe('a');

    // With 'a' in flight (not yet done), 'b' is still blocked → nothing eligible.
    expect(selectNextPending(pending, new Set(['a']))).toBeNull();

    // Once 'a' is done, 'b' becomes eligible.
    const aDone = [t('a', 'done', 0), t('b', 'pending', 1, ['a'])];
    expect(selectNextPending(aDone, new Set())?.id).toBe('b');
  });

  it('lets independent tasks run in parallel (both eligible; caller fills slots)', () => {
    // Neither depends on the other, so the lowest-order one is picked first; with
    // it in flight, the next is still eligible (concurrency is the caller's cap).
    const tasks = [t('x', 'pending', 0), t('y', 'pending', 1)];
    expect(selectNextPending(tasks, new Set())?.id).toBe('x');
    expect(selectNextPending(tasks, new Set(['x']))?.id).toBe('y');
  });

  it('never satisfies an unknown/misspelled dependency (task waits)', () => {
    const tasks = [t('a', 'done', 0), t('b', 'pending', 1, ['nope'])];
    expect(selectNextPending(tasks, new Set())).toBeNull();
  });

  it('requires ALL tasks sharing a needed title to be done', () => {
    // Two tasks titled 'a' (ids a1/a2); 'b' needs 'a'. Not satisfied until both done.
    const partial = [
      {
        id: 'a1',
        status: 'done' as const,
        order: 0,
        title: 'a',
        dependsOn: [],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
      {
        id: 'a2',
        status: 'pending' as const,
        order: 1,
        title: 'a',
        dependsOn: [],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
      {
        id: 'b',
        status: 'pending' as const,
        order: 2,
        title: 'b',
        dependsOn: ['a'],
        phase: '',
        isContract: false,
        isScaffold: false,
      },
    ];
    // a2 is eligible (independent), b is not.
    expect(selectNextPending(partial, new Set())?.id).toBe('a2');
    expect(selectNextPending(partial, new Set(['a2']))).toBeNull();
  });

  it('holds a phase’s siblings until its @contract task is done', () => {
    // 'c' is the contract task for phase M; x and y are siblings under M. While the
    // contract is unfinished, only it is eligible; once done, the siblings unblock.
    const running = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('y', 'pending', 2, [], { phase: 'M' }),
    ];
    expect(selectNextPending(running, new Set())?.id).toBe('c');
    // Contract in flight (not done) → siblings still held → nothing else eligible.
    expect(selectNextPending(running, new Set(['c']))).toBeNull();

    const done = [
      t('c', 'done', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('y', 'pending', 2, [], { phase: 'M' }),
    ];
    expect(selectNextPending(done, new Set())?.id).toBe('x');
  });

  it('a @contract task only gates its own phase, not other phases', () => {
    const tasks = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('other', 'pending', 1, [], { phase: 'N' }),
    ];
    // 'c' is lowest-order and eligible; with it in flight, a task in a different
    // phase is unaffected by the contract gate.
    expect(selectNextPending(tasks, new Set(['c']))?.id).toBe('other');
  });

  it('runs a phase’s @scaffold task first and alone, before even its @contract task', () => {
    // Order within a phase: scaffold → contract → siblings. 's' is scaffold, 'c' is the
    // contract task, x is an ordinary sibling — all under M, with 's' NOT lowest-order to
    // prove ordering comes from the gate, not just `order`.
    const pending = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('s', 'pending', 2, [], { phase: 'M', isScaffold: true }),
    ];
    // Scaffold wins despite its higher order; everything else in the phase is held.
    expect(selectNextPending(pending, new Set())?.id).toBe('s');
    expect(selectNextPending(pending, new Set(['s']))).toBeNull();

    // Scaffold done → the contract task becomes eligible (still ahead of the sibling).
    const scaffoldDone = [
      t('c', 'pending', 0, [], { phase: 'M', isContract: true }),
      t('x', 'pending', 1, [], { phase: 'M' }),
      t('s', 'done', 2, [], { phase: 'M', isScaffold: true }),
    ];
    expect(selectNextPending(scaffoldDone, new Set())?.id).toBe('c');
  });
});

describe('buildTaskPrompt', () => {
  const task: Task = {
    id: '1',
    projectId: 'p',
    phase: 'Phase 2 — Persistence',
    title: 'wire the local store',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'plan',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
  };

  it('includes the project name, task title, and phase', () => {
    const prompt = buildTaskPrompt('Orchestrator', task);
    expect(prompt).toContain('Orchestrator');
    expect(prompt).toContain('wire the local store');
    expect(prompt).toContain('Phase 2 — Persistence');
  });

  it('omits the phase note when a task has no phase', () => {
    const prompt = buildTaskPrompt('Orchestrator', { ...task, phase: '' });
    expect(prompt).not.toContain('This task is under');
    expect(prompt).not.toContain('\n\n\n'); // no triple blank from the dropped line
  });

  it('invites plan edits in shared-dir mode (planRelPath given)', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { planRelPath: 'plan.md' });
    expect(prompt).toContain('plan.md');
    expect(prompt).toContain('you may add them to the plan file');
  });

  it('isolates the agent on its branch in worktree mode (branch given)', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { branch: 'orch/abc123' });
    expect(prompt).toContain('orch/abc123');
    expect(prompt).toContain('Do NOT edit the plan file');
    // The plan-editing invitation from shared-dir mode must be absent.
    expect(prompt).not.toContain('you may add them to the plan file');
  });

  it('tells a @contract task to author CONTRACT.md for its siblings', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      contractSiblings: ['Build API', 'Build UI'],
    });
    expect(prompt).toContain('SHARED CONTRACT task');
    expect(prompt).toContain('CONTRACT.md');
    expect(prompt).toContain('File ownership');
    expect(prompt).toContain('Build API');
    expect(prompt).toContain('Build UI');
    // A contract task is not itself told to read a pre-existing contract.
    expect(prompt).not.toContain('Read it FIRST');
  });

  it('tells a sibling of a contract task to build against CONTRACT.md', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      hasContract: true,
    });
    expect(prompt).toContain('CONTRACT.md');
    expect(prompt).toContain('Read it FIRST');
    expect(prompt).not.toContain('SHARED CONTRACT task');
  });

  it('says nothing about a contract when there is none in the milestone', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, { branch: 'orch/abc123' });
    expect(prompt).not.toContain('CONTRACT.md');
  });

  it('tells a contract sibling to raise a proposal instead of editing the contract', () => {
    const prompt = buildTaskPrompt('Orchestrator', task, {
      branch: 'orch/abc123',
      hasContract: true,
    });
    expect(prompt).toContain(PROPOSE_SENTINEL);
    expect(prompt).toContain('NOT change');
  });
});

describe('Scheduler.decidePermission — full auto (bypassPermissions)', () => {
  /**
   * Build a Scheduler wired to fake store/emitters, with one run pre-registered
   * (seeded directly into the private map — no process spawn). Enough to exercise
   * the permission-decision branch in isolation.
   */
  function makeScheduler(mode: PermissionMode) {
    const project = { id: 'p', defaultPermissionMode: mode } as Project;
    const task = { id: 'task', projectId: 'p', title: 'x' } as Task;
    const emitAttention = vi.fn();
    const store = {
      getProject: (id: string) => (id === 'p' ? project : undefined),
      getTask: (id: string) => (id === 'task' ? task : undefined),
      updateTask: (_id: string, patch: Partial<Task>) => ({ ...task, ...patch }),
      getSettings: () => ({ limitJitterMs: 0 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const sessions = {} as unknown as SessionManager;
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('run1', {
      taskId: 'task',
      projectId: 'p',
      runId: 'run1',
      settled: false,
    });
    return { scheduler, emitAttention };
  }

  const riskyPush = { runId: 'run1', toolName: 'Bash', input: { command: 'git push' } };

  it('auto-approves a risky tool without raising an inbox item', async () => {
    const { scheduler, emitAttention } = makeScheduler('bypassPermissions');
    const result = await scheduler.decidePermission(riskyPush);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(emitAttention).not.toHaveBeenCalled();
  });

  it('still parks the same risky tool for a non-bypass project', () => {
    const { scheduler, emitAttention } = makeScheduler('acceptEdits');
    // Held for a human: the returned promise stays pending, but an inbox item is
    // raised synchronously. (We don't await — it never resolves without an answer.)
    void scheduler.decidePermission(riskyPush);
    expect(emitAttention).toHaveBeenCalledTimes(1);
  });

  describe('AskUserQuestion is never auto-answered (Phase 17)', () => {
    const ask = {
      runId: 'run1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Database',
            question: 'Which database should this use?',
            multiSelect: false,
            options: [
              { label: 'SQLite', description: 'Embedded, zero-config.' },
              { label: 'Postgres', description: 'Needs a server.' },
            ],
          },
        ],
      },
    };

    it.each(['acceptEdits', 'bypassPermissions'] as const)(
      'holds it even under %s — that mode waives TOOL approvals, not your judgement',
      (mode) => {
        const { scheduler, emitAttention } = makeScheduler(mode);
        let settled = false;
        void scheduler.decidePermission(ask).then(() => {
          settled = true;
        });
        expect(settled).toBe(false);
        expect(emitAttention).toHaveBeenCalledTimes(1);
      },
    );

    it('carries the real options through to the item, descriptions and all', () => {
      const { scheduler, emitAttention } = makeScheduler('bypassPermissions');
      void scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as {
        kind: string;
        prompt: string;
        questions?: Array<{ options: Array<{ label: string; description?: string }> }>;
      };
      expect(item.kind).toBe('agent-question');
      expect(item.prompt).toBe('Which database should this use?');
      expect(item.questions?.[0].options).toEqual([
        { label: 'SQLite', description: 'Embedded, zero-config.' },
        { label: 'Postgres', description: 'Needs a server.' },
      ]);
    });

    it('resolves the held tool as a DENY carrying the answer, never an allow', async () => {
      // `allow` would run the tool — and headless, the CLI would answer itself. `deny` is
      // the only channel that hands TEXT back as the tool's result.
      const { scheduler, emitAttention } = makeScheduler('acceptEdits');
      const decision = scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as { id: string };

      scheduler.answerAttention(item.id, {
        decision: 'answers',
        selections: [['Postgres']],
        note: 'staging is on 14',
      });

      const result = (await decision) as { behavior: string; message: string };
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Which database should this use?');
      expect(result.message).toContain('→ Postgres');
      expect(result.message).toContain('staging is on 14');
    });

    it('lets the human explicitly hand the choice back', async () => {
      const { scheduler, emitAttention } = makeScheduler('acceptEdits');
      const decision = scheduler.decidePermission(ask);
      const item = emitAttention.mock.calls[0][0] as { id: string };

      scheduler.answerAttention(item.id, { decision: 'deny' });

      const result = (await decision) as { behavior: string; message: string };
      // The agent still gets to decide — but only because a human said so, which is the
      // whole difference from the timeout this replaces.
      expect(result.message).toContain('chose not to pick an option');
    });
  });
});

/**
 * The CLI can emit a second `system/init` — which `mapRawEvent` turns into another
 * `started` — AFTER its `result`. Seen in the wild: a finished step was written `done` by
 * `settle`, a late `started` 30ms later put it back to `running`, and the `exited` 96ms
 * after that declined to fix it because that case is guarded on `!run.settled`. The step
 * spun on the board for hours with nothing executing.
 */
describe('Scheduler.onRunEvent — a late `started` must not resurrect a settled run', () => {
  function makeScheduler(settled: boolean) {
    const task = { id: 'task', projectId: 'p', title: 'x' } as Task;
    const updateTask = vi.fn((_id: string, patch: Partial<Task>) => ({ ...task, ...patch }));
    const store = {
      getProject: () => undefined,
      getTask: () => task,
      updateTask,
      getSettings: () => ({ limitJitterMs: 0 }),
      appendTaskEvent: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const scheduler = new Scheduler(
      store,
      {} as unknown as SessionManager,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('run1', {
      taskId: 'task',
      projectId: 'p',
      runId: 'run1',
      settled,
    });
    const fire = (
      scheduler as unknown as {
        onRunEvent(runId: string, event: unknown): void;
      }
    ).onRunEvent.bind(scheduler);
    return { fire, updateTask };
  }

  const started = { kind: 'started', sessionId: 's-1', model: '', cwd: '', permissionMode: '' };

  it('leaves the status alone once the run has settled', () => {
    const { fire, updateTask } = makeScheduler(true);
    fire('run1', started);
    expect(updateTask).toHaveBeenCalledTimes(1);
    const patch = updateTask.mock.calls[0][1];
    // The session id is still worth recording — it is a resume handle. The claim that
    // work is moving is the only part that is wrong.
    expect(patch).toEqual({ sessionId: 's-1' });
    expect(patch).not.toHaveProperty('status');
  });

  it('still marks a genuinely starting run as running', () => {
    const { fire, updateTask } = makeScheduler(false);
    fire('run1', started);
    expect(updateTask.mock.calls[0][1]).toEqual({ status: 'running', sessionId: 's-1' });
  });
});

describe('Scheduler.schedulerStates', () => {
  function bareScheduler() {
    const emitScheduler = vi.fn();
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const scheduler = new Scheduler(
      store,
      {} as unknown as SessionManager,
      vi.fn(),
      emitScheduler,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    return scheduler;
  }

  it('starts empty and records the latest state per project', () => {
    const scheduler = bareScheduler();
    expect(scheduler.schedulerStates()).toEqual([]);
    // stop() on an untracked project still announces idle via setState.
    scheduler.stop('p');
    expect(scheduler.schedulerStates()).toEqual([{ projectId: 'p', state: 'idle' }]);
  });
});

describe('Scheduler — a card delegated to an agent project', () => {
  /**
   * A My Tasks card assigned to an agent: it stays on the Personal board
   * (`projectId: 'personal'`) but every run must execute in the AGENT project's repo,
   * with the per-assignment model/mode. No worktree manager here, so the run launches
   * synchronously in the shared directory.
   */
  function makeAgentScheduler(overrides: Partial<Task> = {}) {
    const personal = { id: 'personal', name: 'Personal', path: '', planPath: '', kind: 'plan' };
    const agentProject = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
      concurrency: 1,
    };
    const task = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'pending',
      sessionId: null,
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      externalSource: 'jira',
      externalKey: 'ABC-42',
      agentProjectId: 'agent-1',
      agentMode: 'plan',
      agentModel: 'opus',
      ...overrides,
    } as Task;
    const store = {
      getTask: (id: string) => (id === 't1' ? task : undefined),
      getProject: (id: string) =>
        id === 'agent-1' ? agentProject : id === 'personal' ? personal : undefined,
      getTasks: () => [task],
      getTaskActivity: () => [
        { kind: 'comment', id: 1, body: 'Start with the file-picker path.', createdAt: 1 },
      ],
      updateTask: (_id: string, patch: Partial<Task>) => Object.assign(task, patch),
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1 }),
      appendTaskEvent: vi.fn(),
      getSubtasks: () => [], // an ordinary card: no plan-driven steps
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r1' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    return { scheduler, start, stop, task };
  }

  it('runs in the agent project’s repo with the assignment’s model and mode', () => {
    const { scheduler, start } = makeAgentScheduler();
    scheduler.runTask('t1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({
      cwd: 'C:/repos/checkout',
      model: 'opus', // the assignment's override, not the project default (sonnet)
      permissionMode: 'plan',
    });
  });

  it('uses the single-ticket agent prompt, with the human’s notes', () => {
    const { scheduler, start } = makeAgentScheduler();
    scheduler.runTask('t1');
    const { prompt } = start.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('ABC-42');
    expect(prompt).toContain('ONE ticket');
    expect(prompt).toContain('Start with the file-picker path.');
  });

  it('falls back to the project defaults when the assignment has no overrides', () => {
    const { scheduler, start } = makeAgentScheduler({ agentMode: null, agentModel: null });
    scheduler.runTask('t1');
    expect(start.mock.calls[0][0]).toMatchObject({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
  });

  it('resumes an agent task in the agent project after a usage limit clears', () => {
    // The limit-park → auto-resume path can't be forced live, and it is the one that
    // would silently run the task in the wrong (Personal, path-less) project.
    const { scheduler, start, task } = makeAgentScheduler({
      status: 'blocked-by-limit',
      sessionId: 's1',
    });
    (scheduler as unknown as { resumeParked: (s: LimitState) => void }).resumeParked({
      limitType: 'rolling',
      resetsAt: null,
      resumeAt: 0,
      parkedTaskIds: [task.id],
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: 'C:/repos/checkout' });
    // A resume continues the saved conversation rather than re-briefing the agent.
    expect(start.mock.calls[0][1]).toMatchObject({ resumeSessionId: 's1' });
  });

  it('stopTask ends that task’s run and leaves the card where its human left it', () => {
    const { scheduler, stop, task } = makeAgentScheduler();
    scheduler.runTask('t1');
    expect(scheduler.stopTask('t1')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    // NOT `stopped`, which would have thrown the card into the DONE column. Stopping an
    // agent says nothing about whether the work is done — only the human moves a card.
    expect(task.status).toBe('pending');
    expect(task.preRunStatus).toBe(null);
    // A task with nothing running is a no-op, not an error (and never re-marked).
    expect(scheduler.stopTask('unknown')).toBe(false);
  });
});

describe('Scheduler.start resumes stopped tasks', () => {
  it('re-queues a stopped task to pending and pumps it (resuming its session)', () => {
    const project = { id: 'p', path: 'C:/w', planPath: 'C:/w/plan.md', concurrency: 1 } as Project;
    const tasks: Task[] = [
      {
        id: 't1',
        projectId: 'p',
        phase: '',
        title: 'x',
        status: 'stopped',
        sessionId: 's1',
        order: 0,
        source: 'plan',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
      } as Task,
    ];
    const store = {
      getTasks: () => tasks,
      getProject: () => project,
      getTask: (id: string) => tasks.find((t) => t.id === id),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1 }),
      appendTaskEvent: vi.fn(),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r1' }));
    const sessions = { start } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    scheduler.start('p');

    // The stopped task was re-queued (no longer 'stopped') and handed to a session.
    expect(tasks[0].status).not.toBe('stopped');
    expect(start).toHaveBeenCalledTimes(1);
    // It resumes the saved conversation rather than starting fresh.
    expect(start.mock.calls[0][1]).toMatchObject({ resumeSessionId: 's1' });
  });
});

describe('Scheduler.startAuxiliarySession (the AI "Align plan" run)', () => {
  it('registers the run so stop(projectId) terminates it', () => {
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'align1' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    const { runId } = scheduler.startAuxiliarySession('p', {
      prompt: 'align',
      cwd: 'C:/w',
    } as never);
    expect(runId).toBe('align1');

    // Stopping the project must kill the standalone align session — the bug was that
    // it lived outside `runs`, so Stop never reached it and the agent kept editing.
    scheduler.stop('p');
    expect(stop).toHaveBeenCalledWith('align1');
  });

  it('closes the one-shot run and prunes it from the registry on result', () => {
    // `getProject` is consulted so the run executes on the project's configured
    // machine; undefined (as here) means the local one, which is the old behavior.
    const store = {
      getSettings: () => ({ limitJitterMs: 0 }),
      getProject: () => undefined,
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    let observer: ((event: { kind: string }) => void) | undefined;
    const start = vi.fn((_req: unknown, opts: { onEvent?: (e: { kind: string }) => void }) => {
      observer = opts.onEvent;
      return { runId: 'align1' };
    });
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    scheduler.startAuxiliarySession('p', { prompt: 'align', cwd: 'C:/w' } as never);
    // The run finished on its own: the observer closes it (a one-shot with an
    // observer won't auto-close) and drops it from the registry...
    observer?.({ kind: 'result' });
    expect(stop).toHaveBeenCalledWith('align1');
    stop.mockClear();
    // ...so a later stop(projectId) is a no-op for it (not double-stopped).
    scheduler.stop('p');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('failure decision helpers (pure)', () => {
  it('auto-retries only while spent attempts are under the cap', () => {
    expect(shouldAutoRetry(0, 1)).toBe(true);
    expect(shouldAutoRetry(1, 1)).toBe(false);
    expect(shouldAutoRetry(0, 0)).toBe(false); // cap 0 = park on first failure
    expect(shouldAutoRetry(2, 5)).toBe(true);
    expect(shouldAutoRetry(0, -3)).toBe(false); // negative cap clamps to 0
  });

  it('offers retry/fix/cleanup actions for a run failure', () => {
    const actions = failureActionsFor('run');
    expect(actions).toEqual([
      FAILURE_ACTION.retry,
      FAILURE_ACTION.retryFresh,
      FAILURE_ACTION.aiFix,
      FAILURE_ACTION.cleanup,
      FAILURE_ACTION.markDone,
    ]);
  });

  it('offers integration-specific actions for a merge/integration failure', () => {
    const actions = failureActionsFor('integration');
    expect(actions).toEqual([
      FAILURE_ACTION.retryIntegration,
      // Phase 17: the way out of a retry loop. An integration failure usually has a cause
      // outside the app, so "Retry integration" alone meant failing and re-asking forever.
      FAILURE_ACTION.leaveBranch,
      FAILURE_ACTION.cleanup,
      FAILURE_ACTION.markDone,
    ]);
    // The agent-run-only actions must not appear here.
    expect(actions).not.toContain(FAILURE_ACTION.aiFix);
    expect(actions).not.toContain(FAILURE_ACTION.retryFresh);
  });
});

describe('Scheduler run-failure handling', () => {
  function setup(maxAutoRetries: number) {
    const project = {
      id: 'p',
      path: 'C:/w',
      planPath: 'C:/w/plan.md',
      name: 'P',
      concurrency: 1,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const task: Task = {
      id: 't1',
      projectId: 'p',
      phase: '',
      title: 'x',
      status: 'running',
      sessionId: 's1',
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const store = {
      getTasks: () => [task],
      getProject: () => project,
      getTask: (id: string) => (id === 't1' ? task : undefined),
      updateTask: (id: string, patch: Partial<Task>) => {
        if (id === 't1') Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      getSettings: () => ({ maxAutoRetries, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r2' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const emitTask = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      emitTask,
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    // Seed a live run for the task (as the scheduler would have on start).
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
      taskId: 't1',
      projectId: 'p',
      runId: 'r1',
      settled: false,
    });
    (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('t1');
    const fire = (event: unknown): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(
        'r1',
        event,
      );
    return { scheduler, task, start, emitAttention, emitTask, fire };
  }

  const failResult = {
    kind: 'result',
    success: false,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: 'error',
    terminalReason: null,
  };
  const exited = { kind: 'exited', code: 1 };

  it('auto-retries under the cap and relaunches when the run exits (no park)', () => {
    const { task, start, emitAttention, fire } = setup(1);
    fire(failResult);
    expect(task.status).toBe('pending'); // re-queued, not parked
    expect(emitAttention).not.toHaveBeenCalled();
    // The failed run exits; the idle-queue retry path relaunches it once.
    fire(exited);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('parks for the human once auto-retries are exhausted', () => {
    const { emitAttention, fire } = setup(0);
    fire(failResult);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as { kind: string; options: string[] };
    expect(item.kind).toBe('task-failed');
    expect(item.options).toEqual(failureActionsFor('run'));
  });

  /**
   * The UI re-reads `scheduler:activeRuns` when a `task:changed` arrives, and a run is
   * removed from that snapshot only here, on `exited` — which is AFTER the settling
   * `task:changed`. Without an announcement at removal time the UI's last snapshot forever
   * lists a run that has ended, and the card claims to be starting. The status is `pending`
   * in this case (an auto-retry re-queued it), which is exactly the state where the
   * snapshot, not the status, decides whether a spinner turns.
   */
  /**
   * The residual half of the "spinner over a finished agent" bug. `result` settles the run
   * but the process lingers (it holds stdin open, so it only dies when told to), and until
   * `exited` lands the run is still in the map. Reporting it as active made the UI show
   * "Starting…" underneath the chat line "The agent finished this turn."
   */
  it('drops a settled run from activeRuns before its process has exited', () => {
    const { scheduler, fire } = setup(0);
    expect(scheduler.activeRuns()).toEqual([{ taskId: 't1', runId: 'r1' }]);

    fire(failResult); // the outcome is decided; `exited` has not arrived yet

    expect(scheduler.activeRuns()).toEqual([]);
  });

  /**
   * A run leaves the map on `exited`, which is after the settling `task:changed` — so the
   * refresh that event triggers happens while the run is still there. Excluding settled runs
   * makes the snapshot right at that moment anyway; this announcement is the belt to that
   * braces, and the only signal for a run that leaves the map with no task change of its own.
   */
  it('announces the task again once the ended run has left the map', () => {
    // No auto-retry, so nothing relaunches and nothing re-enters the snapshot.
    const { scheduler, emitTask, fire } = setup(0);
    fire(failResult);
    emitTask.mockClear();

    fire(exited);

    expect(scheduler.activeRuns()).toEqual([]);
    // The UI was told to go and read it again, with no runId (the run is over).
    const announced = emitTask.mock.calls.map(([change]) => change as { task: Task; runId: null });
    expect(announced.some((c) => c.task.id === 't1' && c.runId === null)).toBe(true);
  });
});

describe('Scheduler cross-agent negotiation (Phase D)', () => {
  // Two in-flight tasks under the same milestone: a proposer and one sibling. There
  // is no CONTRACT.md on disk, so ownership is unparseable and the sibling is treated
  // as affected (fallback = all in-flight siblings).
  function setupNegotiation() {
    const project = {
      id: 'p',
      path: 'C:/does-not-exist',
      planPath: 'C:/does-not-exist/plan.md',
      name: 'P',
      concurrency: 2,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as Project;
    const proposer: Task = {
      id: 'prop',
      projectId: 'p',
      phase: 'M',
      title: 'Build API',
      status: 'running',
      sessionId: 's1',
      order: 0,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const sibling: Task = {
      id: 'sib',
      projectId: 'p',
      phase: 'M',
      title: 'Build UI',
      status: 'running',
      sessionId: 's2',
      order: 1,
      source: 'plan',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
    } as Task;
    const tasks = [proposer, sibling];
    const store = {
      getTasks: () => tasks,
      getProject: () => project,
      getTask: (id: string) => tasks.find((t) => t.id === id),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      appendTaskEvent: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 2 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const send = vi.fn();
    const sessions = { send, stop: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
    );
    const runs = (scheduler as unknown as { runs: Map<string, unknown> }).runs;
    runs.set('rprop', { taskId: 'prop', projectId: 'p', runId: 'rprop', settled: false });
    runs.set('rsib', { taskId: 'sib', projectId: 'p', runId: 'rsib', settled: false });
    const fire = (runId: string, event: unknown): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(
        runId,
        event,
      );
    return { scheduler, proposer, sibling, send, emitAttention, fire };
  }

  const propose = { kind: 'assistant', text: `${PROPOSE_SENTINEL} Rename the User type.` };
  // The proposer stops and waits after `@@PROPOSE@@`, so its turn ends with a result.
  const proposerDone = {
    kind: 'result',
    success: true,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
  };

  it('opens a round: parks the proposer and messages the affected sibling', () => {
    const { proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    expect(proposer.status).toBe('waiting-input'); // proposer parked, not settled
    expect(emitAttention).not.toHaveBeenCalled(); // no human item during the round
    // The sibling was asked to vote.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('rsib');
    expect(send.mock.calls[0][1]).toContain(AGREE_SENTINEL);
  });

  it('does not settle the proposer when its @@PROPOSE@@ turn ends mid-round', () => {
    const { proposer, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone); // the trailing result must NOT mark the task done
    expect(proposer.status).toBe('waiting-input');
  });

  it('unanimous agreement resumes the proposer and notifies teammates (no human item)', () => {
    const { proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone); // proposer now idle, waiting on the vote
    send.mockClear();
    fire('rsib', { kind: 'assistant', text: `${AGREE_SENTINEL}` });
    expect(proposer.status).toBe('running'); // proposer un-parked
    expect(emitAttention).not.toHaveBeenCalled(); // consensus — never bothered the human
    // Proposer told to update the contract; sibling told to re-read it.
    const targets = send.mock.calls.map((c) => c[0]);
    expect(targets).toContain('rprop');
    expect(targets).toContain('rsib');
    const toProposer = send.mock.calls.find((c) => c[0] === 'rprop')?.[1] as string;
    expect(toProposer).toContain('CONTRACT.md');
  });

  it('a decision reached before the proposer stops is delivered when its turn ends', () => {
    // Vote lands FIRST (proposer still mid-turn) — the resume must wait for the result.
    const { proposer, send, fire } = setupNegotiation();
    fire('rprop', propose);
    send.mockClear();
    fire('rsib', { kind: 'assistant', text: `${AGREE_SENTINEL}` });
    expect(proposer.status).toBe('waiting-input'); // not resumed yet — proposer not idle
    expect(send.mock.calls.find((c) => c[0] === 'rprop')).toBeUndefined();
    fire('rprop', proposerDone); // NOW it's idle — the queued decision flushes
    expect(proposer.status).toBe('running');
    expect(send.mock.calls.find((c) => c[0] === 'rprop')?.[1]).toContain('CONTRACT.md');
  });

  it('an objection escalates a `proposal` item to the human, listing the reason', () => {
    const { emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone);
    fire('rsib', { kind: 'assistant', text: `${OBJECT_SENTINEL} that breaks my migration` });
    expect(emitAttention).toHaveBeenCalledTimes(1);
    const item = emitAttention.mock.calls[0][0] as {
      kind: string;
      options: string[];
      prompt: string;
    };
    expect(item.kind).toBe('proposal');
    expect(item.options).toEqual([PROPOSAL_ACTION.accept, PROPOSAL_ACTION.keep]);
    expect(item.prompt).toContain('that breaks my migration');
  });

  it('human "Accept proposal" applies it: proposer resumes and updates the contract', () => {
    const { scheduler, proposer, send, emitAttention, fire } = setupNegotiation();
    fire('rprop', propose);
    fire('rprop', proposerDone);
    fire('rsib', { kind: 'assistant', text: `${OBJECT_SENTINEL} no` });
    const item = emitAttention.mock.calls[0][0] as { id: string };
    send.mockClear();
    scheduler.answerAttention(item.id, { decision: 'reply', text: PROPOSAL_ACTION.accept });
    expect(proposer.status).toBe('running');
    const toProposer = send.mock.calls.find((c) => c[0] === 'rprop')?.[1] as string;
    expect(toProposer).toContain('CONTRACT.md');
  });

  it('a proposal with no affected teammate is vacuously agreed after the proposer stops', () => {
    const { scheduler, proposer, send, fire } = setupNegotiation();
    // Remove the sibling run so there is no one to consult.
    (scheduler as unknown as { runs: Map<string, unknown> }).runs.delete('rsib');
    fire('rprop', propose);
    expect(proposer.status).toBe('waiting-input'); // parked awaiting its own turn-end
    fire('rprop', proposerDone);
    expect(proposer.status).toBe('running');
    expect(send.mock.calls.find((c) => c[0] === 'rprop')?.[1]).toContain('CONTRACT.md');
  });
});

describe('Scheduler — a plan approved into subtasks (Phase 11)', () => {
  /**
   * A delegated card with two steps, running in worktree mode. The fake worktree
   * manager records what it was asked to prepare/integrate, which is where the two
   * rules of the chain show up: every step prepares the PARENT's worktree, and only
   * the LAST step integrates.
   */
  function setup(
    steps: Array<Partial<Task>> = [{ id: 's1' }, { id: 's2' }],
    opts?: { autoIntegrate?: boolean },
  ) {
    const agentProject = {
      id: 'agent-1',
      name: 'Checkout service',
      path: 'C:/repos/checkout',
      planPath: '',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: true,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'acceptEdits',
    } as unknown as Project;
    const parent = {
      id: 't1',
      projectId: 'personal',
      phase: '',
      title: 'Fix the export dialog',
      status: 'in-progress',
      sessionId: null,
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      externalKey: 'ABC-42',
      agentProjectId: 'agent-1',
      agentMode: 'plan',
      agentPlan: '## Reproduce it\nfirst\n\n## Fix it\nsecond',
      parentTaskId: null,
    } as unknown as Task;
    const children = steps.map(
      (s, i) =>
        ({
          projectId: 'personal',
          phase: '',
          title: `Step ${i + 1}`,
          status: 'pending',
          sessionId: null,
          order: i,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 't1',
          agentProjectId: 'agent-1',
          agentMode: 'bypassPermissions',
          ...s,
        }) as unknown as Task,
    );
    const byId = new Map<string, Task>([
      [parent.id, parent],
      ...children.map((c) => [c.id, c] as const),
    ]);
    const added: Array<{ title: string; description?: string | null; round?: number }> = [];
    const comments: string[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      listProjects: () => [agentProject],
      getTasks: () => [parent, ...children],
      getSubtasks: (parentId: string) => children.filter((c) => c.parentTaskId === parentId),
      getTaskActivity: () => [],
      addSubtask: (
        _p: string,
        input: { title: string; description?: string | null; round?: number },
      ) => {
        added.push(input);
        return undefined;
      },
      maxSubtaskRound: (parentId: string) =>
        children
          .filter((c) => c.parentTaskId === parentId)
          .reduce((max, c) => Math.max(max, c.planRound ?? 1), 0),
      addComment: (_p: string, _t: string, body: string) => comments.push(body),
      // A board with no arrows on it: these cases run a plan's steps through settle and
      // integration, both of which now ask the chain runner what to release next.
      listTaskLinks: () => [],
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (task) Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      // `autoIntegrate` on: these cases are ABOUT the integration path, and Phase 17 made
      // merging manual by default. The manual case has its own test below.
      getSettings: () => ({
        maxAutoRetries: 0,
        limitJitterMs: 0,
        concurrency: 1,
        autoIntegrate: opts?.autoIntegrate ?? true,
      }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const prepared: Array<{ taskId: string; owner: string }> = [];
    const integrated: Array<{ branch: string; base: string }> = [];
    const worktrees = {
      prepare: (_p: Project, task: Task, owner: string = task.id) => {
        prepared.push({ taskId: task.id, owner });
        return Promise.resolve({
          mode: 'worktree',
          cwd: `C:/wt/${owner}`,
          branch: `orch/${owner}`,
          base: 'main',
        });
      },
      integrate: (_p: Project, branch: string, base: string) => {
        integrated.push({ branch, base });
        return Promise.resolve({ status: 'merged' });
      },
      cleanup: vi.fn(),
    } as unknown as WorktreeManager;
    const start = vi.fn((_req: unknown, opts: { runId?: string }) => ({
      runId: opts?.runId ?? 'r-new',
    }));
    const stop = vi.fn();
    const send = vi.fn();
    const sessions = { start, stop, send } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(
      store,
      sessions,
      vi.fn(),
      vi.fn(),
      emitAttention,
      vi.fn(),
      vi.fn(),
      worktrees,
    );
    /** Seed a live run for one task, as the scheduler would have after launching it. */
    const seedRun = (runId: string, taskId: string, owner = 't1'): void => {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
        taskId,
        projectId: 'agent-1',
        runId,
        settled: false,
        branch: `orch/${owner}`,
        base: 'main',
        worktree: `C:/wt/${owner}`,
      });
      (scheduler as unknown as { inFlight: Set<string> }).inFlight.add(taskId);
    };
    const fire = (runId: string, event: unknown): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(
        runId,
        event,
      );
    return {
      scheduler,
      parent,
      children,
      start,
      stop,
      emitAttention,
      prepared,
      integrated,
      added,
      comments,
      seedRun,
      fire,
    };
  }

  const okResult = {
    kind: 'result',
    success: true,
    resultText: '',
    costUsd: null,
    durationMs: null,
    stopReason: null,
    terminalReason: null,
  };

  /** Let the async chains settle (prepare → launch, and integrate → apply outcome). */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('runs every step in the PARENT’s worktree, on the parent’s branch', async () => {
    const { scheduler, prepared } = setup();
    scheduler.runTask('s2');
    await flush();
    expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
  });

  describe('starting a CARD that has steps', () => {
    // The bug: steps written by hand were ignored by `runTask`, so starting the card ran the
    // card's own session with the whole ticket as its brief. One agent did all the work in
    // one go while the board sat at 0/2 — the steps had been typed out and then quietly
    // bypassed. An approved plan handed over correctly, so who wrote the steps down decided
    // whether they were honoured.
    it('starts the first pending STEP, not the card’s own session', async () => {
      const { scheduler, prepared } = setup();
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    });

    it('skips a step that is already done and starts the next one waiting', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'done';
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
    });

    // The fall-through, and it matters as much as the hand-over: once the chain is over the
    // card holds the review conversation, and running it must reach the card again.
    it('runs the CARD once no step is left pending', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'done';
      children[1].status = 'done';
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 't1', owner: 't1' }]);
    });

    // A parked chain is the human's to resolve — `advanceSubtasks` will not step over a
    // failure, and neither may this.
    it('runs the CARD when the chain is parked at a failed step', async () => {
      const { scheduler, children, prepared } = setup();
      children[0].status = 'failed';
      children[1].status = 'pending';
      scheduler.runTask('t1');
      await flush();
      // Step 2 is pending, but step 1 failed — the first PENDING step is still what starts,
      // which is the same rule `advanceSubtasks` applies. The card is not run behind it.
      expect(prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
    });

    it('leaves a card with no steps at all exactly as it was', async () => {
      const { scheduler, prepared } = setup([]);
      scheduler.runTask('t1');
      await flush();
      expect(prepared).toEqual([{ taskId: 't1', owner: 't1' }]);
    });
  });

  it('a non-final step settles WITHOUT integrating, and starts its sibling', async () => {
    const { children, integrated, start, seedRun, fire } = setup();
    seedRun('r1', 's1');
    fire('r1', okResult);
    await flush();
    expect(children[0].status).toBe('done');
    expect(integrated).toEqual([]); // the chain's branch is not finished yet
    expect(start).toHaveBeenCalledTimes(1); // …step 2 is on its way instead
  });

  it('the FINAL step integrates the shared branch and hands the card back for review', async () => {
    const { parent, children, integrated, comments, seedRun, fire } = setup();
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();
    expect(integrated).toEqual([{ branch: 'orch/t1', base: 'main' }]);
    // The final STEP still reaches `done` — the chain machinery reads that as "over", and
    // a step is not a board column entry.
    expect(children[1].status).toBe('done');
    // The parent is NEVER auto-completed: it waits in progress for a human.
    expect(parent.status).toBe('in-progress');
    // Phase 17: a summary of what every step did, not a one-line "ready for review" note —
    // the card's Details Panel should read as one story.
    const filed = comments.join(' ');
    expect(filed).toContain('Plan complete');
    expect(filed).toContain('2 of 2 steps finished');
    expect(filed).toContain('1. Step 1');
    expect(filed).toContain('2. Step 2');
    expect(filed).toContain('Merged `orch/t1` into `main`');
    expect(filed).toContain('move it to Done yourself');
  });

  it('holds the finished branch for a human when autoIntegrate is off (Phase 17)', async () => {
    const { parent, children, integrated, comments, seedRun, fire } = setup(undefined, {
      autoIntegrate: false,
    });
    children[0].status = 'done';
    seedRun('r2', 's2');
    fire('r2', okResult);
    await flush();
    // The whole point: nothing was merged. Merging at the instant the agent stops is
    // merging at the moment the work has been reviewed least.
    expect(integrated).toEqual([]);
    // Everything else still happens — the step is over, the card waits for a human, and
    // the branch is named so it can be found and reviewed.
    expect(children[1].status).toBe('done');
    expect(parent.status).toBe('in-progress');
    const filed = comments.join(' ');
    expect(filed).toContain('orch/t1');
    expect(filed).toContain('NOT been merged');
  });

  it('a failed step stops the chain — its siblings stay pending', async () => {
    const { children, start, emitAttention, seedRun, fire } = setup();
    seedRun('r1', 's1');
    fire('r1', { ...okResult, success: false, stopReason: 'error' });
    await Promise.resolve();
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect((emitAttention.mock.calls[0][0] as { kind: string }).kind).toBe('task-failed');
    expect(children[1].status).toBe('pending'); // never started
    expect(start).not.toHaveBeenCalled();
  });

  // ---- Phase 12/4: resolving a parked step re-enters the chain ------------------

  /** Fail step 1 and return the inbox item the human would be answering. */
  async function park(h: ReturnType<typeof setup>): Promise<{ id: string }> {
    h.seedRun('r1', 's1');
    h.fire('r1', { ...okResult, success: false, stopReason: 'error' });
    await Promise.resolve();
    return h.emitAttention.mock.calls[0][0] as { id: string };
  }

  it('waving a parked step through with Mark done starts the NEXT step', async () => {
    const h = setup();
    const item = await park(h);
    h.scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.markDone });
    await flush();
    expect(h.children[0].status).toBe('done');
    // The chain moved on — the whole point of resolving from the parent's pane.
    expect(h.prepared).toEqual([{ taskId: 's2', owner: 't1' }]);
  });

  it('retrying a parked step re-runs THAT step in the chain’s shared worktree', async () => {
    const h = setup();
    const item = await park(h);
    h.scheduler.answerAttention(item.id, { decision: 'reply', text: FAILURE_ACTION.retry });
    await flush();
    expect(h.prepared).toEqual([{ taskId: 's1', owner: 't1' }]);
    expect(h.children[1].status).toBe('pending'); // step 2 still waits its turn
  });

  it('parks an interrupted STEP as failed on restart, so the chain says it stopped', () => {
    const h = setup([{ id: 's1', status: 'running' }, { id: 's2' }]);
    h.scheduler.reconcileInterruptedTasks();
    // `pending` would leave the card at 1/2 with nothing on screen and nothing to click:
    // no queue re-enters a chain, so the step has to be visibly parked instead.
    expect(h.children[0].status).toBe('failed');
    expect(h.children[1].status).toBe('pending'); // untouched
    expect(h.parent.status).toBe('in-progress');
  });

  it('still re-queues an interrupted CARD, which its project’s queue can pick up', () => {
    const h = setup();
    h.parent.status = 'running';
    h.scheduler.reconcileInterruptedTasks();
    expect(h.parent.status).toBe('pending');
  });

  it('holds ExitPlanMode as a plan-approval item listing the steps it would create', async () => {
    const { scheduler, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let released = false;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
      } as never)
      .then(() => {
        released = true;
      });
    await Promise.resolve();
    expect(released).toBe(false); // the tool is BLOCKED until a human answers
    const item = emitAttention.mock.calls[0][0] as { kind: string; steps: string[]; plan: string };
    expect(item.kind).toBe('plan-approval');
    expect(item.steps).toEqual(['Reproduce it', 'Fix it']);
    expect(item.plan).toContain('## Fix it');
  });

  it('approving creates the steps, stops the planner, and leaves the card in progress', async () => {
    const { scheduler, parent, added, stop, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let decision: { behavior: string; message?: string } | undefined;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: parent.agentPlan },
      } as never)
      .then((d) => {
        decision = d as { behavior: string; message?: string };
      });
    await Promise.resolve();
    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'approve' });
    await Promise.resolve();
    expect(added.map((s) => s.title)).toEqual(['Reproduce it', 'Fix it']);
    // The planning session is denied and killed — it must not implement its own plan.
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain('do NOT implement it here');
    expect(stop).toHaveBeenCalledWith('r0');
    expect(parent.status).toBe('in-progress');
  });

  it('rejecting hands the reason back and keeps the planning session alive', async () => {
    const { scheduler, parent, added, stop, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    let decision: { behavior: string; message?: string } | undefined;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: parent.agentPlan },
      } as never)
      .then((d) => {
        decision = d as { behavior: string; message?: string };
      });
    await Promise.resolve();
    const item = emitAttention.mock.calls[0][0] as { id: string };
    scheduler.answerAttention(item.id, { decision: 'deny', note: 'Split the migration out.' });
    await Promise.resolve();
    expect(decision).toEqual({ behavior: 'deny', message: 'Split the migration out.' });
    expect(added).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(parent.status).toBe('running');
  });

  /**
   * Re-planning a card whose chain has finished (Phase 18). The bug this closes: approval
   * used to skip creation entirely when the card already had steps, so a card's first plan
   * was its only one — the human watched an agent plan work that never appeared anywhere.
   */
  describe('a SECOND plan approved onto a card that already has steps', () => {
    /** A finished chain, so `chainInFlight` is false and the card is free to re-plan. */
    const finished = [
      { id: 's1', title: 'Reproduce it', status: 'done' as const },
      { id: 's2', title: 'Fix it', status: 'done' as const },
    ];

    async function approve(
      h: ReturnType<typeof setup>,
      plan: string,
    ): Promise<{ behavior: string; message?: string } | undefined> {
      h.seedRun('r0', 't1');
      let decision: { behavior: string; message?: string } | undefined;
      void scheduleDecision(h, plan).then((d) => {
        decision = d as { behavior: string; message?: string };
      });
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as { id: string };
      h.scheduler.answerAttention(item.id, { decision: 'approve' });
      await Promise.resolve();
      return decision;
    }

    const scheduleDecision = (h: ReturnType<typeof setup>, plan: string): Promise<unknown> =>
      h.scheduler.decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan },
      } as never);

    it('APPENDS the new steps instead of creating nothing', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Add JIRA sync\na\n\n## Map the columns\nb';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['Add JIRA sync', 'Map the columns']);
      expect(h.parent.status).toBe('in-progress');
    });

    it('files the appended steps under the next round, so the panel can fold round 1', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Add JIRA sync\na\n\n## Map the columns\nb';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.round)).toEqual([2, 2]);
    });

    it('drops the steps the card already carries, keeping only what is new', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Fix it\nagain\n\n## Add JIRA sync\nnew';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['Add JIRA sync']);
    });

    it('lists ONLY the steps approval will create, so the inbox cannot over-promise', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Fix it\nagain\n\n## Add JIRA sync\nnew';
      h.seedRun('r0', 't1');
      void scheduleDecision(h, h.parent.agentPlan);
      await Promise.resolve();
      const item = h.emitAttention.mock.calls.at(-1)?.[0] as { steps: string[]; prompt: string };
      expect(item.steps).toEqual(['Add JIRA sync']);
      expect(item.prompt).toContain('2 already on this card');
    });

    /**
     * The failure mode that reads EXACTLY like the original bug: approval resolves, the card
     * flips to `in-progress` and nothing appears. It has to say so instead.
     */
    it('adds nothing and does no hand-over when every step is a duplicate', async () => {
      const h = setup(finished);
      h.parent.agentPlan = '## Reproduce it\nx\n\n## Fix it\ny';
      h.parent.status = 'pending';
      await approve(h, h.parent.agentPlan);
      expect(h.added).toEqual([]);
      // Released from the `waiting-input` the approval item borrowed, back to the status the
      // human left it in — not left wearing a "wants you" ring over an answered item.
      expect(h.parent.status).toBe('pending');
      expect(h.comments.some((c) => c.includes('no steps this card does not already have'))).toBe(
        true,
      );
    });

    it('caps on the card’s total, not on the round', async () => {
      const many = Array.from({ length: 19 }, (_, i) => ({
        id: `s${i}`,
        title: `Old ${i + 1}`,
        status: 'done' as const,
      }));
      const h = setup(many);
      h.parent.agentPlan = '## New one\na\n\n## New two\nb\n\n## New three\nc';
      await approve(h, h.parent.agentPlan);
      expect(h.added.map((s) => s.title)).toEqual(['New one']);
    });
  });

  it('raises the plan for approval even under bypassPermissions', async () => {
    // "Never ask me to approve tools" is not "silently discard the plan": `capturePlan` used
    // to store the markdown and the bypass shortcut then allowed the call with nothing
    // raised, leaving a full-auto card unable to gain a single step.
    const { scheduler, emitAttention, seedRun } = setup([]);
    seedRun('r0', 't1');
    (scheduler as unknown as { runs: Map<string, { permissionMode?: string }> }).runs.get(
      'r0',
    )!.permissionMode = 'bypassPermissions';
    let released = false;
    void scheduler
      .decidePermission({
        runId: 'r0',
        toolName: 'ExitPlanMode',
        input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
      } as never)
      .then(() => {
        released = true;
      });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(emitAttention.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'plan-approval' });
  });

  it('raises the plan from the event stream when the gate never saw the tool', async () => {
    // The observational fallback used to capture the markdown and raise nothing, so an
    // ungated run's plan landed where no step could ever come of it.
    const { emitAttention, seedRun, fire, parent } = setup([]);
    seedRun('r0', 't1');
    fire('r0', {
      kind: 'tool-use',
      name: 'ExitPlanMode',
      id: 'x',
      input: { plan: '## Reproduce it\nfirst\n\n## Fix it\nsecond' },
    });
    await Promise.resolve();
    expect(parent.agentPlan).toContain('## Fix it');
    const raised = emitAttention.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'plan-approval',
    );
    expect(raised).toHaveLength(1);
    expect((raised[0][0] as { steps: string[] }).steps).toEqual(['Reproduce it', 'Fix it']);
  });

  it('does not double-raise when the gate already holds the plan', async () => {
    const { scheduler, emitAttention, seedRun, fire } = setup([]);
    seedRun('r0', 't1');
    const plan = '## Reproduce it\nfirst\n\n## Fix it\nsecond';
    void scheduler.decidePermission({
      runId: 'r0',
      toolName: 'ExitPlanMode',
      input: { plan },
    } as never);
    await Promise.resolve();
    fire('r0', { kind: 'tool-use', name: 'ExitPlanMode', id: 'x', input: { plan } });
    await Promise.resolve();
    expect(
      emitAttention.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'plan-approval'),
    ).toHaveLength(1);
  });
});

describe('Scheduler.replanCard (Phase 18)', () => {
  /**
   * A delegated card with a FINISHED chain — the state the bug report is about: the steps
   * are done, the human asks for more work, and nothing they can type produces any.
   */
  function setupReplan(
    opts: { card?: Partial<Task>; steps?: Array<Partial<Task>>; liveRun?: boolean } = {},
  ) {
    const agentProject = {
      id: 'agent-1',
      name: 'repo',
      path: 'C:/repo',
      planPath: 'C:/repo/plan.md',
      defaultModel: 'sonnet',
      defaultPermissionMode: 'bypassPermissions',
      kind: 'agent',
    } as unknown as Project;
    const card = {
      id: 'c1',
      projectId: 'personal',
      phase: 'JIRA',
      title: 'Ship the board',
      status: 'in-progress',
      sessionId: 's-old',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      parentTaskId: null,
      agentProjectId: 'agent-1',
      agentMode: 'bypassPermissions',
      ...opts.card,
    } as unknown as Task;
    const steps = (opts.steps ?? [{ title: 'Scaffold it' }, { title: 'Wire it' }]).map(
      (s, i) =>
        ({
          id: `s${i + 1}`,
          projectId: 'personal',
          phase: 'JIRA',
          title: `Step ${i + 1}`,
          status: 'done',
          sessionId: null,
          order: i,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 'c1',
          planRound: 1,
          ...s,
        }) as unknown as Task,
    );
    const all = [card, ...steps];
    const chats: string[] = [];
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      getTaskActivity: () => [],
      addChatMessage: (_p: string, _t: string, body: string) => {
        chats.push(body);
        return undefined;
      },
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const start = vi.fn((_req: unknown, o: { runId?: string }) => ({ runId: o?.runId ?? 'r-new' }));
    const stop = vi.fn();
    const sessions = { start, stop, send: vi.fn() } as unknown as SessionManager;
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    if (opts.liveRun) {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r-live', {
        taskId: 'c1',
        projectId: 'agent-1',
        runId: 'r-live',
        settled: false,
      });
      (scheduler as unknown as { inFlight: Set<string> }).inFlight.add('c1');
    }
    const exit = (runId: string): void =>
      (scheduler as unknown as { onRunEvent: (r: string, e: unknown) => void }).onRunEvent(runId, {
        kind: 'exited',
        code: 0,
      });
    return { scheduler, card, steps, start, stop, chats, exit };
  }

  it('runs the turn in PLAN mode, whatever the card is assigned', () => {
    // The heart of the bug: a chat resume inherits `bypassPermissions`, `buildClaudeArgs`
    // rewrites that to `default`, and the agent then has no ExitPlanMode tool at all — so it
    // writes its plan as prose and nothing can ever become a step.
    const h = setupReplan();
    const result = h.scheduler.replanCard('c1', 'Add the JIRA sync');
    expect(result.status).toBe('resumed');
    expect(h.start).toHaveBeenCalledTimes(1);
    const request = h.start.mock.calls[0][0] as { permissionMode: string; prompt: string };
    expect(request.permissionMode).toBe('plan');
    expect(request.prompt).toContain('ExitPlanMode');
  });

  it('tells the agent which steps are already on the card, and how much room is left', () => {
    const h = setupReplan({ steps: [{ title: 'Scaffold the store' }, { title: 'Wire the IPC' }] });
    h.scheduler.replanCard('c1', 'Now add the sync');
    const { prompt } = h.start.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('Scaffold the store');
    expect(prompt).toContain('Wire the IPC');
    expect(prompt).toContain('Now add the sync');
    expect(prompt).toContain('18 step(s)'); // MAX_PLAN_STEPS (20) minus the two it has
  });

  it('does NOT write the plan mode back to the card, so later runs are unaffected', () => {
    const h = setupReplan();
    h.scheduler.replanCard('c1');
    expect(h.card.agentMode).toBe('bypassPermissions');
  });

  it('files the human’s brief on the timeline before anything starts', () => {
    const h = setupReplan();
    h.scheduler.replanCard('c1', 'Add the JIRA sync');
    expect(h.chats).toEqual(['Add the JIRA sync']);
  });

  it('stops a live turn first and waits for its process to exit', () => {
    // The card's review session (seeded when the chain finished) is the very conversation
    // the human is typing into. Both runs share the card's worktree, so the planner must not
    // resume into it while the old process is still shutting down.
    const h = setupReplan({ liveRun: true });
    h.scheduler.replanCard('c1', 'more work');
    expect(h.stop).toHaveBeenCalledWith('r-live');
    expect(h.start).not.toHaveBeenCalled();
    h.exit('r-live');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect((h.start.mock.calls[0][0] as { permissionMode: string }).permissionMode).toBe('plan');
  });

  it('refuses a step: a step cannot own a plan', () => {
    const h = setupReplan();
    expect(h.scheduler.replanCard('s1')).toMatchObject({ reason: 'not-a-card' });
  });

  it('refuses while the chain is still running', () => {
    const h = setupReplan({
      steps: [
        { title: 'a', status: 'done' },
        { title: 'b', status: 'pending' },
      ],
    });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'chain-busy' });
  });

  it('refuses a card with no agent, and an unknown card', () => {
    const h = setupReplan({ card: { agentProjectId: null } });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'never-ran' });
    expect(h.scheduler.replanCard('nope')).toMatchObject({ reason: 'unknown-task' });
  });

  it('refuses once the card is full', () => {
    const h = setupReplan({
      steps: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}` })),
    });
    expect(h.scheduler.replanCard('c1')).toMatchObject({ reason: 'chain-full' });
  });
});

describe('Scheduler.chatWithAgent (Phase 12)', () => {
  /**
   * A delegated card, optionally with steps, and optionally with a live run + a parked
   * inbox item — the four situations a typed message can land in.
   */
  function setupChat(
    opts: {
      card?: Partial<Task>;
      steps?: Array<Partial<Task>>;
      /** Seed a live run for this task id. */
      liveFor?: string;
      /** Seed an inbox item on the live run. */
      parked?: 'question' | 'permission' | 'plan-approval';
    } = {},
  ) {
    const card = {
      id: 'c1',
      projectId: 'personal',
      phase: 'JIRA',
      title: 'Card',
      status: 'running',
      sessionId: 'sess-1',
      order: 0,
      source: 'jira',
      dependsOn: [],
      isContract: false,
      isScaffold: false,
      agentProjectId: 'agent-p',
      ...opts.card,
    } as Task;
    const steps = (opts.steps ?? []).map(
      (s, i) =>
        ({
          id: `s${i + 1}`,
          projectId: 'personal',
          phase: 'JIRA',
          title: `Step ${i + 1}`,
          status: 'pending',
          sessionId: null,
          order: i + 1,
          source: 'adhoc',
          dependsOn: [],
          isContract: false,
          isScaffold: false,
          parentTaskId: 'c1',
          agentProjectId: 'agent-p',
          ...s,
        }) as Task,
    );
    const all = [card, ...steps];
    const chats: Array<{ taskId: string; body: string }> = [];
    const comments: Array<{ taskId: string; body: string }> = [];
    const agentProject = {
      id: 'agent-p',
      name: 'Agent repo',
      path: '/repo',
      planPath: '/repo/PLAN.md',
      kind: 'agent',
      concurrency: 1,
      useWorktrees: false,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'default',
    } as unknown as Project;
    const store = {
      getTask: (id: string) => all.find((t) => t.id === id),
      getTasks: () => all,
      getProject: (id: string) => (id === 'agent-p' ? agentProject : undefined),
      getSubtasks: (parentId: string) => steps.filter((s) => s.parentTaskId === parentId),
      updateTask: (id: string, patch: Partial<Task>) => {
        const t = all.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t;
      },
      addChatMessage: (_projectId: string, taskId: string, body: string) => {
        chats.push({ taskId, body });
        return undefined;
      },
      // A first message to an assigned-but-not-started card is filed as a COMMENT, because
      // there is no session to resume and the fresh run's prompt is built from the timeline.
      addComment: (_projectId: string, taskId: string, body: string) => {
        comments.push({ taskId, body });
        return undefined;
      },
      getSettings: () => ({ limitJitterMs: 0, concurrency: 1, maxAutoRetries: 0 }),
      saveLimitGate: () => undefined,
      // Read by `buildPrompt` when a staged card starts from its timeline rather than
      // resuming a session.
      getTaskActivity: () => [],
      ...INERT_ATTENTION_STORE,
    } as unknown as Store;
    const send = vi.fn();
    const start = vi.fn();
    const sessions = { start, stop: vi.fn(), send } as unknown as SessionManager;
    const resolved = vi.fn();
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), vi.fn(), resolved, vi.fn());
    if (opts.liveFor) {
      (scheduler as unknown as { runs: Map<string, unknown> }).runs.set('r1', {
        taskId: opts.liveFor,
        projectId: 'agent-p',
        runId: 'r1',
        settled: false,
      });
    }
    if (opts.parked) {
      (scheduler as unknown as { attention: Map<string, unknown> }).attention.set('i1', {
        id: 'i1',
        runId: 'r1',
        taskId: opts.liveFor,
        projectId: 'agent-p',
        kind: opts.parked,
        title: 'parked',
        detail: '',
        createdAt: 0,
      });
    }
    return { scheduler, card, steps, send, start, chats, comments, resolved };
  }

  it('sends into the live session and records the message on the timeline', () => {
    const { scheduler, send, chats } = setupChat({ liveFor: 'c1' });
    const result = scheduler.chatWithAgent('c1', '  use the cache  ');
    expect(result).toEqual({ status: 'sent', taskId: 'c1', runId: 'r1' });
    expect(send).toHaveBeenCalledWith('r1', 'use the cache');
    // Trimmed, and recorded against the task that received it.
    expect(chats).toEqual([{ taskId: 'c1', body: 'use the cache' }]);
  });

  it('talks to the running STEP of a card, not the card itself', () => {
    const { scheduler, send, chats } = setupChat({
      card: { status: 'in-progress' },
      steps: [{ status: 'done' }, { status: 'running', sessionId: 'sess-2' }],
      liveFor: 's2',
    });
    const result = scheduler.chatWithAgent('c1', 'skip the migration');
    expect(result).toEqual({ status: 'sent', taskId: 's2', runId: 'r1' });
    expect(send).toHaveBeenCalledWith('r1', 'skip the migration');
    // The step heard it, so the step's timeline is where it belongs.
    expect(chats).toEqual([{ taskId: 's2', body: 'skip the migration' }]);
  });

  it('answers a parked question instead of stacking a second turn behind it', () => {
    const { scheduler, card, send, resolved } = setupChat({
      card: { status: 'waiting-input' },
      liveFor: 'c1',
      parked: 'question',
    });
    const result = scheduler.chatWithAgent('c1', 'use postgres');
    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledWith('r1', 'use postgres');
    // The inbox item cleared and the task is live again — not left parked on a
    // question the human has in fact just answered.
    expect(resolved).toHaveBeenCalledWith('i1');
    expect(card.status).toBe('running');
  });

  it('refuses while a permission request or a plan approval holds a tool', () => {
    for (const parked of ['permission', 'plan-approval'] as const) {
      const { scheduler, send, chats } = setupChat({
        card: { status: 'waiting-input' },
        liveFor: 'c1',
        parked,
      });
      expect(scheduler.chatWithAgent('c1', 'go ahead')).toEqual({
        status: 'refused',
        taskId: 'c1',
        reason: 'awaiting-decision',
      });
      expect(send).not.toHaveBeenCalled();
      expect(chats).toEqual([]); // nothing said, nothing recorded
    }
  });

  it('resumes an idle card by session id, with the message as the prompt', () => {
    const { scheduler, start, chats } = setupChat({ card: { status: 'in-progress' } });
    const result = scheduler.chatWithAgent('c1', '  still there?  ');
    expect(result.status).toBe('resumed');
    expect(result).toMatchObject({ taskId: 'c1' });
    expect(chats).toEqual([{ taskId: 'c1', body: 'still there?' }]);
    // The user's words are the prompt — NOT the resume nudge — and the conversation is
    // continued rather than started over.
    const [request, opts] = start.mock.calls[0];
    expect(request.prompt).toBe('still there?');
    expect(opts.resumeSessionId).toBe('sess-1');
    // A real run: reserved, counted, and reported to the Board like any other.
    expect(scheduler.activeRuns()).toEqual([
      { taskId: 'c1', runId: (result as { runId: string }).runId },
    ]);
  });

  it('resumes the step you selected, not its parent', () => {
    const { scheduler, start, chats } = setupChat({
      card: { status: 'in-progress' },
      steps: [
        { status: 'done', sessionId: 'sess-a' },
        { status: 'done', sessionId: 'sess-b' },
      ],
    });
    expect(scheduler.chatWithAgent('s2', 'why did you drop the index?')).toMatchObject({
      status: 'resumed',
      taskId: 's2',
    });
    expect(start.mock.calls[0][1].resumeSessionId).toBe('sess-b');
    expect(chats).toEqual([{ taskId: 's2', body: 'why did you drop the index?' }]);
  });

  it('resumes the card once its chain has finished', () => {
    const { scheduler, start } = setupChat({
      card: { status: 'in-progress' },
      steps: [{ status: 'done' }, { status: 'cancelled' }],
    });
    expect(scheduler.chatWithAgent('c1', 'how did that go?')).toMatchObject({ status: 'resumed' });
    expect(start.mock.calls[0][1].resumeSessionId).toBe('sess-1');
  });

  it('refuses to resume a card mid-chain — its steps hold the conversation', () => {
    for (const status of ['pending', 'failed', 'blocked-by-limit'] as const) {
      const { scheduler, start, chats } = setupChat({
        card: { status: 'in-progress' },
        steps: [{ status: 'done' }, { status }],
      });
      expect(scheduler.chatWithAgent('c1', 'what now?')).toEqual({
        status: 'refused',
        taskId: 'c1',
        reason: 'chain-busy',
      });
      expect(start).not.toHaveBeenCalled();
      expect(chats).toEqual([]);
    }
  });

  it('leaves a queued fix note for the retry it was written for', () => {
    const { scheduler, start } = setupChat({ card: { status: 'failed' } });
    const fixNotes = (scheduler as unknown as { fixNotes: Map<string, string> }).fixNotes;
    fixNotes.set('c1', 'the build broke');
    scheduler.chatWithAgent('c1', 'what failed?');
    // The chat prompt wins, and the note is still there for the real retry.
    expect(start.mock.calls[0][0].prompt).toBe('what failed?');
    expect(fixNotes.get('c1')).toBe('the build broke');
  });

  it('starts an assigned-but-not-started card on the first message (Phase 17)', () => {
    const { scheduler, start, comments, chats } = setupChat({
      card: { status: 'pending', sessionId: null },
    });
    expect(scheduler.chatWithAgent('c1', 'hello?')).toMatchObject({
      status: 'resumed',
      taskId: 'c1',
    });
    expect(start).toHaveBeenCalled();
    // Filed as a comment, not a chat line: there is no session to resume, so the message
    // has to reach the agent through the brief its FIRST run is built from.
    expect(comments).toEqual([{ taskId: 'c1', body: 'hello?' }]);
    expect(chats).toEqual([]);
  });

  it('refuses with never-ran when the card has no session AND no agent to start', () => {
    const { scheduler, start } = setupChat({
      card: { status: 'pending', sessionId: null, agentProjectId: null },
    });
    expect(scheduler.chatWithAgent('c1', 'hello?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'never-ran',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a limit-parked card with the limit reason, not a resume', () => {
    const { scheduler, start } = setupChat({ card: { status: 'blocked-by-limit' } });
    expect(scheduler.chatWithAgent('c1', 'any progress?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'limit',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses while the usage-limit gate is up — a resume would be killed at once', () => {
    const { scheduler, start } = setupChat({ card: { status: 'in-progress' } });
    const gate = (
      scheduler as unknown as {
        limitGate: { engage: (s: unknown, ids: string[]) => void; dispose: () => void };
      }
    ).limitGate;
    gate.engage({ status: 'rejected', rateLimitType: 'rolling', resetsAt: null }, []);
    expect(scheduler.chatWithAgent('c1', 'are you back?')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'limit',
    });
    expect(start).not.toHaveBeenCalled();
    gate.dispose(); // don't leave the reset timer armed for the rest of the suite
  });

  it('refuses an empty message and an unknown task', () => {
    const { scheduler, send } = setupChat({ liveFor: 'c1' });
    expect(scheduler.chatWithAgent('c1', '   ')).toEqual({
      status: 'refused',
      taskId: 'c1',
      reason: 'empty-message',
    });
    expect(scheduler.chatWithAgent('nope', 'hi')).toEqual({
      status: 'refused',
      taskId: 'nope',
      reason: 'unknown-task',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
