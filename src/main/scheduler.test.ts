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
      { id: 'a1', status: 'done' as const, order: 0, title: 'a', dependsOn: [], phase: '', isContract: false, isScaffold: false },
      { id: 'a2', status: 'pending' as const, order: 1, title: 'a', dependsOn: [], phase: '', isContract: false, isScaffold: false },
      { id: 'b', status: 'pending' as const, order: 2, title: 'b', dependsOn: ['a'], phase: '', isContract: false, isScaffold: false },
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
    const prompt = buildTaskPrompt('Orchestrator', task, { branch: 'orch/abc123', hasContract: true });
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
});

describe('Scheduler.schedulerStates', () => {
  function bareScheduler() {
    const emitScheduler = vi.fn();
    const store = { getSettings: () => ({ limitJitterMs: 0 }) } as unknown as Store;
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
    expect(start.mock.calls[0][0]).toMatchObject({ model: 'sonnet', permissionMode: 'acceptEdits' });
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

  it('stopTask ends that task’s run and marks it stopped', () => {
    const { scheduler, stop, task } = makeAgentScheduler();
    scheduler.runTask('t1');
    expect(scheduler.stopTask('t1')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('stopped');
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
    const store = { getSettings: () => ({ limitJitterMs: 0 }) } as unknown as Store;
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
    const store = { getSettings: () => ({ limitJitterMs: 0 }) } as unknown as Store;
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
    } as unknown as Store;
    const start = vi.fn((_req: unknown, _opts: unknown) => ({ runId: 'r2' }));
    const stop = vi.fn();
    const sessions = { start, stop } as unknown as SessionManager;
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
    return { scheduler, task, start, emitAttention, fire };
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
    } as unknown as Store;
    const send = vi.fn();
    const sessions = { send, stop: vi.fn() } as unknown as SessionManager;
    const emitAttention = vi.fn();
    const scheduler = new Scheduler(store, sessions, vi.fn(), vi.fn(), emitAttention, vi.fn(), vi.fn());
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
  function setup(steps: Array<Partial<Task>> = [{ id: 's1' }, { id: 's2' }]) {
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
    const added: Array<{ title: string; description?: string | null }> = [];
    const comments: string[] = [];
    const store = {
      getTask: (id: string) => byId.get(id),
      getProject: (id: string) => (id === 'agent-1' ? agentProject : undefined),
      getTasks: () => [parent, ...children],
      getSubtasks: (parentId: string) => children.filter((c) => c.parentTaskId === parentId),
      getTaskActivity: () => [],
      addSubtask: (_p: string, input: { title: string; description?: string | null }) => {
        added.push(input);
        return undefined;
      },
      addComment: (_p: string, _t: string, body: string) => comments.push(body),
      updateTask: (id: string, patch: Partial<Task>) => {
        const task = byId.get(id);
        if (task) Object.assign(task, patch);
        return task;
      },
      appendTaskEvent: vi.fn(),
      appendTokenUsage: vi.fn(),
      getSettings: () => ({ maxAutoRetries: 0, limitJitterMs: 0, concurrency: 1 }),
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
    expect(children[1].status).toBe('done');
    // The parent is NEVER auto-completed: it waits in progress for a human.
    expect(parent.status).toBe('in-progress');
    expect(comments.join(' ')).toContain('Ready for review');
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
});
