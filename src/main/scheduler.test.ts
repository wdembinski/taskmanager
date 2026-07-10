/**
 * Unit tests for the scheduler's pure decision logic — no store, no processes.
 * The class that wires this to SQLite and the SessionManager is exercised by
 * hand / verify; here we prove the selection rule and prompt shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildTaskPrompt, Scheduler, selectNextPending, type Schedulable } from './scheduler';
import type { PermissionMode } from '@shared/session';
import type { Project, Task } from '@shared/model';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';

const t = (id: string, status: Schedulable['status'], order: number): Schedulable => ({
  id,
  status,
  order,
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
