/**
 * Proves the three `archive:*` handler bodies through the SAME path a browser tab actually
 * takes: a real `RelayRegistry`, dispatching to handlers built by `createArchiveHandlers` — no
 * Electron, no real `Store`. The store methods themselves (the refusal rules, `at` on the
 * right column) are `store.ts`'s own concern; this is the routing and push wiring around them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createArchiveHandlers, type ArchiveHandlersDeps } from './archiveHandlers';
import { RelayRegistry } from './ipcRegistry';
import type { Milestone } from '@shared/model';
import type { ArchiveResult, ArchivedListing } from '@shared/trackerArchive';

const NOW = 1_700_000_000_000;

const OK_MILESTONE: ArchiveResult = {
  ok: true,
  projectId: 'proj-1',
  changedTaskIds: ['task-1', 'task-2'],
  milestonesChanged: true,
};
const OK_EPIC: ArchiveResult = {
  ok: true,
  projectId: 'proj-1',
  changedTaskIds: ['task-3'],
  milestonesChanged: false,
};
const OK_PROJECT: ArchiveResult = {
  ok: true,
  projectId: 'proj-1',
  changedTaskIds: [],
  milestonesChanged: false,
};
const REFUSED: ArchiveResult = {
  ok: false,
  reason: 'not-found',
  message: 'Milestone not found',
};

interface Harness {
  registry: RelayRegistry;
  archiveMilestone: Mock;
  restoreMilestone: Mock;
  archiveEpic: Mock;
  restoreEpic: Mock;
  archiveTicketProject: Mock;
  restoreTicketProject: Mock;
  listArchived: Mock;
  pushMilestones: Mock;
  pushTasks: Mock;
}

function buildHarness(): Harness {
  const archiveMilestone = vi.fn((): ArchiveResult => OK_MILESTONE);
  const restoreMilestone = vi.fn((): ArchiveResult => OK_MILESTONE);
  const archiveEpic = vi.fn((): ArchiveResult => OK_EPIC);
  const restoreEpic = vi.fn((): ArchiveResult => OK_EPIC);
  const archiveTicketProject = vi.fn((): ArchiveResult => OK_PROJECT);
  const restoreTicketProject = vi.fn((): ArchiveResult => OK_PROJECT);
  const listArchived = vi.fn((): ArchivedListing => ({ projects: [], milestones: [], epics: [] }));
  const pushMilestones = vi.fn((): Milestone[] => []);
  const pushTasks = vi.fn();

  const deps: ArchiveHandlersDeps = {
    store: {
      archiveMilestone,
      restoreMilestone,
      archiveEpic,
      restoreEpic,
      archiveTicketProject,
      restoreTicketProject,
      listArchived,
    },
    pushMilestones,
    pushTasks,
    now: () => NOW,
  };

  const handlers = createArchiveHandlers(deps);
  const registry = new RelayRegistry();
  for (const channel of Object.keys(handlers) as (keyof typeof handlers)[]) {
    registry.register(channel, handlers[channel] as never);
  }

  return {
    registry,
    archiveMilestone,
    restoreMilestone,
    archiveEpic,
    restoreEpic,
    archiveTicketProject,
    restoreTicketProject,
    listArchived,
    pushMilestones,
    pushTasks,
  };
}

async function invokeArchive(
  harness: Harness,
  channel: 'archive:apply' | 'archive:restore',
  args: readonly unknown[],
): Promise<ArchiveResult> {
  const result = await harness.registry.invoke(channel, args);
  expect(result.ok).toBe(true);
  return result.value as ArchiveResult;
}

describe('archive handlers — routing', () => {
  it('routes a milestone target to archiveMilestone with the choice and now()', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [
      { kind: 'milestone', id: 'm1' },
      { kind: 'backlog' },
    ]);

    expect(harness.archiveMilestone).toHaveBeenCalledWith('m1', { kind: 'backlog' }, NOW);
  });

  it('forwards an omitted choice as undefined, not left out', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'milestone', id: 'm1' }]);

    expect(harness.archiveMilestone).toHaveBeenCalledWith('m1', undefined, NOW);
  });

  it('routes an epic target to archiveEpic with now()', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'epic', id: 'e1' }]);

    expect(harness.archiveEpic).toHaveBeenCalledWith('e1', NOW);
  });

  it('routes a project target to archiveTicketProject with now()', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'project', id: 'p1' }]);

    expect(harness.archiveTicketProject).toHaveBeenCalledWith('p1', NOW);
  });

  it('routes a milestone target to restoreMilestone', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:restore', [{ kind: 'milestone', id: 'm1' }]);

    expect(harness.restoreMilestone).toHaveBeenCalledWith('m1');
  });

  it('routes an epic target to restoreEpic', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:restore', [{ kind: 'epic', id: 'e1' }]);

    expect(harness.restoreEpic).toHaveBeenCalledWith('e1');
  });

  it('routes a project target to restoreTicketProject', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:restore', [{ kind: 'project', id: 'p1' }]);

    expect(harness.restoreTicketProject).toHaveBeenCalledWith('p1');
  });

  it('refuses an unknown kind as data, never throwing', async () => {
    const harness = buildHarness();

    const applyResult = await invokeArchive(harness, 'archive:apply', [
      { kind: 'bogus', id: 'x1' },
    ]);
    const restoreResult = await invokeArchive(harness, 'archive:restore', [
      { kind: 'bogus', id: 'x1' },
    ]);

    expect(applyResult).toEqual({
      ok: false,
      reason: 'not-found',
      message: 'Unknown archive target',
    });
    expect(restoreResult).toEqual({
      ok: false,
      reason: 'not-found',
      message: 'Unknown archive target',
    });
    expect(harness.archiveMilestone).not.toHaveBeenCalled();
    expect(harness.archiveEpic).not.toHaveBeenCalled();
    expect(harness.archiveTicketProject).not.toHaveBeenCalled();
    expect(harness.pushMilestones).not.toHaveBeenCalled();
    expect(harness.pushTasks).not.toHaveBeenCalled();
  });
});

describe('archive handlers — pushes', () => {
  it('resolves a refusal with the store result and pushes nothing', async () => {
    const harness = buildHarness();
    harness.archiveMilestone.mockReturnValueOnce(REFUSED);

    const result = await invokeArchive(harness, 'archive:apply', [{ kind: 'milestone', id: 'm1' }]);

    expect(result).toEqual(REFUSED);
    expect(harness.pushMilestones).not.toHaveBeenCalled();
    expect(harness.pushTasks).not.toHaveBeenCalled();
  });

  it('pushes milestones and tasks on a milestone success', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'milestone', id: 'm1' }]);

    expect(harness.pushMilestones).toHaveBeenCalledTimes(1);
    expect(harness.pushTasks).toHaveBeenCalledWith('proj-1');
  });

  it('pushes tasks only on an epic success', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'epic', id: 'e1' }]);

    expect(harness.pushMilestones).not.toHaveBeenCalled();
    expect(harness.pushTasks).toHaveBeenCalledWith('proj-1');
  });

  it('pushes neither on a project success', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:apply', [{ kind: 'project', id: 'p1' }]);

    expect(harness.pushMilestones).not.toHaveBeenCalled();
    expect(harness.pushTasks).not.toHaveBeenCalled();
  });

  it('pushes the same way on restore', async () => {
    const harness = buildHarness();

    await invokeArchive(harness, 'archive:restore', [{ kind: 'milestone', id: 'm1' }]);

    expect(harness.pushMilestones).toHaveBeenCalledTimes(1);
    expect(harness.pushTasks).toHaveBeenCalledWith('proj-1');
  });
});

describe('archive handlers — list', () => {
  it('forwards archive:list to store.listArchived with the given projectId', async () => {
    const harness = buildHarness();

    const result = await harness.registry.invoke('archive:list', ['proj-1']);

    expect(harness.listArchived).toHaveBeenCalledWith('proj-1');
    expect(result).toEqual({ ok: true, value: { projects: [], milestones: [], epics: [] } });
  });

  it('forwards an omitted projectId as undefined', async () => {
    const harness = buildHarness();

    await harness.registry.invoke('archive:list', []);

    expect(harness.listArchived).toHaveBeenCalledWith(undefined);
  });
});
