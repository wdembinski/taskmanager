/**
 * Unit tests for `AutomationRunner.fire` — every dependency is a fake, per the module's own
 * `AutomationRunnerDeps` contract, so these never touch a real Store or Scheduler.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AutomationRunner,
  type AutomationFiring,
  type AutomationRunnerDeps,
} from './automationRunner';
import type { Automation, AutomationRun } from '@shared/automation';
import type { Project, Task } from '@shared/model';
import { RUN_REFUSAL_MESSAGE, type RunOutcome } from '@shared/scheduler';

const NOW = 1_700_000_000_000;

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    revision: 1,
    name: 'Nightly triage',
    enabled: true,
    ownerClientId: null,
    timeZone: 'Europe/Warsaw',
    trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
    action: {
      boardProjectId: 'board-1',
      agentProjectId: 'agent-1',
      titleTemplate: 'Nightly — {{date}}',
      briefTemplate: 'Triage new tickets.',
      mode: 'bypassPermissions',
    },
    enabledAt: NOW - 1000,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    ...overrides,
  };
}

function baseFiring(overrides: Partial<AutomationFiring> = {}): AutomationFiring {
  return {
    kind: 'scheduled',
    occurrenceKey: `schedule:${NOW}`,
    occurrenceAt: NOW,
    skippedCount: 0,
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'board-1',
    phase: '',
    title: 'Nightly — 2026-01-01',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

function priorStartedRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-0',
    automationId: 'auto-1',
    revision: 1,
    occurrenceKey: 'schedule:prev',
    kind: 'scheduled',
    status: 'started',
    taskId: 'task-prev',
    runId: 'run-0',
    refusal: null,
    skippedCount: 0,
    note: null,
    at: NOW - 1000,
    ...overrides,
  };
}

/**
 * A fresh set of fakes wired for the happy path: a board project exists, the card creates
 * and delegates cleanly, and `getAutomations`/`saveAutomation` share one mutable record so
 * the strike counter can be observed across several `fire` calls, the same way the real
 * Store's row would change underneath the clock that re-fires an automation.
 */
function createDeps(automation: Automation) {
  let stored = automation;

  const store = {
    reserveAutomationRun: vi.fn(() => true),
    updateAutomationRun: vi.fn(() => undefined as AutomationRun | undefined),
    getAutomationRuns: vi.fn(() => [] as AutomationRun[]),
    getAutomations: vi.fn(() => [stored]),
    saveAutomation: vi.fn((a: Automation) => {
      stored = a;
    }),
    getTask: vi.fn(() => undefined as Task | undefined),
    getProject: vi.fn(() => ({ id: 'board-1' }) as unknown as Project),
    createTask: vi.fn((projectId: string, input: { title: string; description?: string | null }) =>
      fakeTask({ projectId, title: input.title }),
    ),
    updateTask: vi.fn((_id: string, _patch: Partial<Task>) => fakeTask()),
    addComment: vi.fn(() => undefined),
  };

  const deps: AutomationRunnerDeps = {
    store,
    delegate: vi.fn((taskId: string) => fakeTask({ id: taskId })),
    startTaskNow: vi.fn(() => ({ runId: 'run-1' }) as RunOutcome),
    isTaskWorking: vi.fn(() => false),
    attention: { automationDisabled: vi.fn() },
    now: () => NOW,
  };

  return { deps, store, getAutomation: () => stored };
}

describe('AutomationRunner.fire — duplicate key', () => {
  it('launches nothing when the occurrence is already reserved', () => {
    const automation = baseAutomation();
    const { deps, store } = createDeps(automation);
    store.reserveAutomationRun.mockReturnValue(false);

    const result = new AutomationRunner(deps).fire(automation, baseFiring());

    expect(result).toEqual({ status: 'duplicate' });
    expect(deps.delegate).not.toHaveBeenCalled();
    expect(deps.startTaskNow).not.toHaveBeenCalled();
    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.updateAutomationRun).not.toHaveBeenCalled();
  });
});

describe('AutomationRunner.fire — parked refusal', () => {
  it('is not a strike', () => {
    const automation = baseAutomation({ consecutiveFailures: 1 });
    const { deps, store, getAutomation } = createDeps(automation);
    deps.startTaskNow = vi.fn(() => ({ refused: 'limit' }) as RunOutcome);

    const result = new AutomationRunner(deps).fire(automation, baseFiring()) as AutomationRun;

    expect(result.status).toBe('parked');
    expect(result.refusal).toBe('limit');
    expect(store.saveAutomation).not.toHaveBeenCalled();
    expect(deps.attention.automationDisabled).not.toHaveBeenCalled();
    expect(getAutomation().consecutiveFailures).toBe(1);
  });
});

describe('AutomationRunner.fire — three dropped refusals', () => {
  it('disable the automation on the third', () => {
    const automation = baseAutomation({ consecutiveFailures: 0 });
    const { deps, getAutomation } = createDeps(automation);
    deps.startTaskNow = vi.fn(() => ({ refused: 'already-running' }) as RunOutcome);
    const runner = new AutomationRunner(deps);

    runner.fire(automation, baseFiring({ occurrenceKey: 'schedule:1' }));
    expect(getAutomation().enabled).toBe(true);
    expect(deps.attention.automationDisabled).not.toHaveBeenCalled();

    runner.fire(automation, baseFiring({ occurrenceKey: 'schedule:2' }));
    expect(getAutomation().enabled).toBe(true);
    expect(deps.attention.automationDisabled).not.toHaveBeenCalled();

    runner.fire(automation, baseFiring({ occurrenceKey: 'schedule:3' }));
    expect(getAutomation().consecutiveFailures).toBe(3);
    expect(getAutomation().enabled).toBe(false);
    expect(deps.attention.automationDisabled).toHaveBeenCalledTimes(1);
    expect(deps.attention.automationDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: automation.id }),
      RUN_REFUSAL_MESSAGE['already-running'],
    );
  });
});

describe('AutomationRunner.fire — started', () => {
  it('resets the strike counter', () => {
    const automation = baseAutomation({ consecutiveFailures: 2 });
    const { deps, getAutomation } = createDeps(automation);
    deps.startTaskNow = vi.fn(() => ({ runId: 'run-77' }) as RunOutcome);

    const result = new AutomationRunner(deps).fire(automation, baseFiring()) as AutomationRun;

    expect(result.status).toBe('started');
    expect(result.runId).toBe('run-77');
    expect(getAutomation().consecutiveFailures).toBe(0);
    expect(getAutomation().enabled).toBe(true);
    expect(deps.attention.automationDisabled).not.toHaveBeenCalled();
  });
});

describe('AutomationRunner.fire — overlap', () => {
  it('is skipped rather than launched, and is not a strike', () => {
    const automation = baseAutomation({ consecutiveFailures: 0 });
    const { deps, store, getAutomation } = createDeps(automation);
    store.getAutomationRuns.mockReturnValue([priorStartedRun()]);
    deps.isTaskWorking = vi.fn((taskId: string) => taskId === 'task-prev');

    const result = new AutomationRunner(deps).fire(automation, baseFiring()) as AutomationRun;

    expect(result.status).toBe('skipped');
    expect(deps.delegate).not.toHaveBeenCalled();
    expect(deps.startTaskNow).not.toHaveBeenCalled();
    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.saveAutomation).not.toHaveBeenCalled();
    expect(getAutomation().consecutiveFailures).toBe(0);
  });
});

describe('AutomationRunner.fire — Task.status', () => {
  it('is never part of the patch the runner asks the store to write', () => {
    const automation = baseAutomation();
    const { deps, store } = createDeps(automation);
    deps.startTaskNow = vi.fn(() => ({ runId: 'run-1' }) as RunOutcome);

    new AutomationRunner(deps).fire(automation, baseFiring());

    expect(store.updateTask).toHaveBeenCalled();
    for (const call of store.updateTask.mock.calls) {
      expect(call[1]).not.toHaveProperty('status');
    }
  });
});
