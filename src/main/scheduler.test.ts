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
  Scheduler,
  selectNextPending,
  shouldAutoRetry,
  type Schedulable,
} from './scheduler';
import type { PermissionMode } from '@shared/session';
import type { Project, Task } from '@shared/model';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';

// `title` defaults to `id` so dependencies (referenced by title) can name other
// rows by their id in these tests.
const t = (
  id: string,
  status: Schedulable['status'],
  order: number,
  dependsOn: string[] = [],
  opts: { phase?: string; isContract?: boolean } = {},
): Schedulable => ({
  id,
  status,
  order,
  title: id,
  dependsOn,
  phase: opts.phase ?? '',
  isContract: opts.isContract ?? false,
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
      { id: 'a1', status: 'done' as const, order: 0, title: 'a', dependsOn: [], phase: '', isContract: false },
      { id: 'a2', status: 'pending' as const, order: 1, title: 'a', dependsOn: [], phase: '', isContract: false },
      { id: 'b', status: 'pending' as const, order: 2, title: 'b', dependsOn: ['a'], phase: '', isContract: false },
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
