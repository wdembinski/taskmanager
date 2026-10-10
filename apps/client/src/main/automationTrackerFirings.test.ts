/**
 * Unit tests for `trackerFirings` (pure) and `fireTrackerSweep` (the thin impure wrapper).
 * `AutomationRunner.fire` is a fake per its own `Pick<AutomationRunner, 'fire'>` contract, so
 * these never touch a real Store or Scheduler — see `automationRunner.test.ts` for that side.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fireTrackerSweep,
  trackerFirings,
  type FireTrackerSweepDeps,
  type TrackerSweep,
} from './automationTrackerFirings';
import type { Automation, AutomationRun } from '@shared/automation';
import type { Task } from '@shared/model';
import type { AutomationRunner } from './automationRunner';

const NOW = 1_700_000_000_000;
const LOCAL_CLIENT_ID = 'client-local';

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    revision: 1,
    name: 'Agent label triage',
    enabled: true,
    ownerClientId: null,
    timeZone: 'Europe/Warsaw',
    trigger: {
      kind: 'tracker',
      tracker: { source: 'jira', event: 'entered-status', status: 'To Do', allLabels: ['agent'] },
    },
    action: {
      agentProjectId: 'agent-1',
      titleTemplate: '',
      briefTemplate: 'Work this ticket.',
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

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    phase: '',
    title: 'Fix the thing',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'jira',
    isContract: false,
    isScaffold: false,
    externalKey: 'TM-1',
    externalStatus: 'Backlog',
    labels: [],
    ...overrides,
  };
}

describe('trackerFirings', () => {
  it('fires once for a matching status + label transition, and not for a disabled twin', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];
    const automation = baseAutomation();
    const disabledTwin = baseAutomation({ id: 'auto-2', enabled: false });

    const firings = trackerFirings([automation, disabledTwin], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings).toHaveLength(1);
    expect(firings[0].automation.id).toBe('auto-1');
    expect(firings[0].firing.taskId).toBe('task-1');
    expect(firings[0].firing.occurrenceKey).toBe('tracker:task-1:entered-status:to do');
  });

  it('yields nothing when the sweep is truncated', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];

    const firings = trackerFirings([baseAutomation()], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
      truncated: true,
    });

    expect(firings).toEqual([]);
  });

  it('yields nothing for a schedule automation', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];
    const scheduleAutomation = baseAutomation({
      trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } },
    });

    const firings = trackerFirings([scheduleAutomation], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings).toEqual([]);
  });

  it('yields nothing for an automation owned by another client', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];
    const automation = baseAutomation({ ownerClientId: 'other-client' });

    const firings = trackerFirings([automation], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings).toEqual([]);
  });

  it('yields nothing for an automation with enabledAt: null', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];
    const automation = baseAutomation({ enabledAt: null });

    const firings = trackerFirings([automation], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings).toEqual([]);
  });

  it('yields nothing for a card unchanged between before and upserts', () => {
    const unchanged = card({ externalStatus: 'To Do', labels: ['agent'] });

    const firings = trackerFirings([baseAutomation()], [unchanged], [unchanged], {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings).toEqual([]);
  });

  it('two automations matching the same card yield two firings', () => {
    const before = [card({ externalStatus: 'Backlog', labels: ['agent'] })];
    const upserts = [card({ externalStatus: 'To Do', labels: ['agent'] })];
    const automation1 = baseAutomation({ id: 'auto-1' });
    const automation2 = baseAutomation({ id: 'auto-2' });

    const firings = trackerFirings([automation1, automation2], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings.map((f) => f.automation.id).sort()).toEqual(['auto-1', 'auto-2']);
  });

  it('one automation yields one firing per matching card', () => {
    const before = [
      card({ id: 'task-1', externalKey: 'TM-1', externalStatus: 'Backlog', labels: ['agent'] }),
      card({ id: 'task-2', externalKey: 'TM-2', externalStatus: 'Backlog', labels: ['agent'] }),
    ];
    const upserts = [
      card({ id: 'task-1', externalKey: 'TM-1', externalStatus: 'To Do', labels: ['agent'] }),
      card({ id: 'task-2', externalKey: 'TM-2', externalStatus: 'To Do', labels: ['agent'] }),
    ];

    const firings = trackerFirings([baseAutomation()], before, upserts, {
      now: NOW,
      localClientId: LOCAL_CLIENT_ID,
    });

    expect(firings.map((f) => f.firing.taskId).sort()).toEqual(['task-1', 'task-2']);
  });
});

describe('fireTrackerSweep', () => {
  function createDeps(automations: Automation[]) {
    const fire = vi.fn(() => ({ status: 'started' }) as AutomationRun);
    const runner: Pick<AutomationRunner, 'fire'> = { fire };
    const deps: FireTrackerSweepDeps = {
      runner,
      getAutomations: vi.fn(() => automations),
      localClientId: LOCAL_CLIENT_ID,
      log: vi.fn(),
    };
    return { deps, fire };
  }

  function baseSweep(overrides: Partial<TrackerSweep> = {}): TrackerSweep {
    return {
      source: 'JIRA',
      before: [card({ externalStatus: 'Backlog', labels: ['agent'] })],
      upserts: [card({ externalStatus: 'To Do', labels: ['agent'] })],
      now: NOW,
      ...overrides,
    };
  }

  it('calls nothing for a null sweep', () => {
    const { deps, fire } = createDeps([baseAutomation()]);

    fireTrackerSweep(deps, null);

    expect(fire).not.toHaveBeenCalled();
    expect(deps.getAutomations).not.toHaveBeenCalled();
  });

  it('still fires the second firing when the first throws, and never throws itself', () => {
    const automation1 = baseAutomation({ id: 'auto-1' });
    const automation2 = baseAutomation({ id: 'auto-2' });
    const { deps, fire } = createDeps([automation1, automation2]);
    fire.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => fireTrackerSweep(deps, baseSweep())).not.toThrow();

    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('does not let getAutomations throwing escape', () => {
    const { deps } = createDeps([]);
    deps.getAutomations = vi.fn(() => {
      throw new Error('store is down');
    });

    expect(() => fireTrackerSweep(deps, baseSweep())).not.toThrow();
  });
});
