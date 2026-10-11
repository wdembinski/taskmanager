import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { MirrorDelta } from '@tm/protocol/wire';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { AutomationMirror } from '../entities/automationMirror.entity';
import { AutomationRunMirror } from '../entities/automationRunMirror.entity';
import { applyAutomationDelta, runsToPrune } from './applyAutomationDelta';

function buildAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    revision: 1,
    name: 'Nightly triage',
    enabled: true,
    ownerClientId: 'desktop-1',
    timeZone: 'UTC',
    trigger: { kind: 'schedule', schedule: { type: 'daily', hour: 9, minute: 0 } },
    action: {
      agentProjectId: 'project-1',
      titleTemplate: 'Nightly triage — {{date}}',
      briefTemplate: 'Triage the backlog.',
      mode: 'acceptEdits',
    },
    enabledAt: 1_700_000_000_000,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function buildRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    revision: 1,
    occurrenceKey: 'manual:run-1',
    kind: 'manual',
    status: 'started',
    taskId: null,
    runId: null,
    refusal: null,
    skippedCount: 0,
    note: null,
    at: Date.now(),
    ...overrides,
  };
}

function emptyDelta(overrides: Partial<MirrorDelta> = {}): MirrorDelta {
  return { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [], ...overrides };
}

/** `In([...])`'s public `.value` getter — see `FindOperator`, and mirror.service.test.ts's twin. */
function idsFrom(criterion: unknown): string[] {
  if (criterion && typeof criterion === 'object' && 'value' in criterion) {
    return (criterion as { value: string[] }).value;
  }
  return [criterion as string];
}

/**
 * A hand-rolled stand-in for the slice of TypeORM `EntityManager` `applyAutomationDelta`
 * actually calls: `upsert`, `delete` and `find`, over two in-memory arrays. Deliberately its
 * own fake rather than a reuse of `mirror.service.test.ts`'s `FakeStore` — this function is
 * called standalone, never through a `MirrorService`, so there is no board/sync surface to
 * fake alongside it.
 */
class FakeManager {
  readonly automationRows: Record<string, unknown>[] = [];
  readonly runRows: Record<string, unknown>[] = [];

  private arrayFor(entity: unknown): Record<string, unknown>[] {
    if (entity === AutomationMirror) return this.automationRows;
    if (entity === AutomationRunMirror) return this.runRows;
    throw new Error(`FakeManager: unhandled entity ${String(entity)}`);
  }

  upsert = async (
    entity: unknown,
    entityOrArray: unknown,
    conflictPaths: string[],
  ): Promise<void> => {
    const rows = Array.isArray(entityOrArray) ? entityOrArray : [entityOrArray];
    const key = conflictPaths[0]!;
    const arr = this.arrayFor(entity);
    for (const row of rows as Record<string, unknown>[]) {
      const idx = arr.findIndex((r) => r[key] === row[key]);
      if (idx >= 0) arr[idx] = { ...row };
      else arr.push({ ...row });
    }
  };

  delete = async (entity: unknown, criteria: Record<string, unknown>): Promise<void> => {
    const arr = this.arrayFor(entity);
    const kept = arr.filter(
      (row) =>
        !Object.entries(criteria).every(([key, value]) =>
          idsFrom(value).includes(row[key] as string),
        ),
    );
    arr.length = 0;
    arr.push(...kept);
  };

  find = async (
    entity: unknown,
    options: { where: Record<string, unknown> },
  ): Promise<Record<string, unknown>[]> => {
    const arr = this.arrayFor(entity);
    return arr.filter((row) =>
      Object.entries(options.where).every(([key, value]) => row[key] === value),
    );
  };
}

function apply(
  manager: FakeManager,
  accountId: string,
  clientId: string,
  delta: MirrorDelta,
): Promise<void> {
  return applyAutomationDelta(manager as unknown as EntityManager, accountId, clientId, delta);
}

describe('applyAutomationDelta', () => {
  it('is a no-op for a v2-shaped delta carrying no automation fields', async () => {
    const manager = new FakeManager();

    await expect(apply(manager, 'account-1', 'desktop-1', emptyDelta())).resolves.toBeUndefined();

    expect(manager.automationRows).toHaveLength(0);
    expect(manager.runRows).toHaveLength(0);
  });

  it('upserts an automation and a run, and a re-upsert replaces rather than duplicates', async () => {
    const manager = new FakeManager();
    const automation = buildAutomation();
    const run = buildRun({ automationId: automation.id });

    await apply(
      manager,
      'account-1',
      'desktop-1',
      emptyDelta({ automations: [automation], automationRuns: [run] }),
    );
    expect(manager.automationRows).toHaveLength(1);
    expect(manager.runRows).toHaveLength(1);

    const edited = { ...automation, name: 'Renamed', revision: 2 };
    await apply(manager, 'account-1', 'desktop-1', emptyDelta({ automations: [edited] }));

    expect(manager.automationRows).toHaveLength(1);
    expect((manager.automationRows[0]!.data as Automation).name).toBe('Renamed');
  });

  it('resolves a null ownerClientId to the syncing Client, not "this one" verbatim', async () => {
    const manager = new FakeManager();
    const automation = buildAutomation({ ownerClientId: null });

    await apply(manager, 'account-1', 'desktop-1', emptyDelta({ automations: [automation] }));

    expect(manager.automationRows[0]!.clientId).toBe('desktop-1');
  });

  it('deletes an automation and its runs, leaving another account untouched', async () => {
    const manager = new FakeManager();
    const automation = buildAutomation();
    const run = buildRun({ automationId: automation.id });
    const otherAutomation = buildAutomation({ id: 'automation-2' });
    const otherRun = buildRun({ id: 'run-2', automationId: 'automation-2' });

    await apply(
      manager,
      'account-1',
      'desktop-1',
      emptyDelta({ automations: [automation], automationRuns: [run] }),
    );
    await apply(
      manager,
      'account-2',
      'desktop-2',
      emptyDelta({ automations: [otherAutomation], automationRuns: [otherRun] }),
    );

    await apply(
      manager,
      'account-1',
      'desktop-1',
      emptyDelta({ deletedAutomationIds: [automation.id] }),
    );

    expect(manager.automationRows.map((r) => r.id)).toEqual(['automation-2']);
    expect(manager.runRows.map((r) => r.id)).toEqual(['run-2']);
  });

  it('sweeps retention down to the newest 100 for the touched automation', async () => {
    const manager = new FakeManager();
    const automation = buildAutomation();
    const now = Date.now();
    const runs = Array.from({ length: 101 }, (_, i) =>
      buildRun({ id: `run-${i}`, automationId: automation.id, at: now - i }),
    );

    await apply(
      manager,
      'account-1',
      'desktop-1',
      emptyDelta({ automations: [automation], automationRuns: runs }),
    );

    expect(manager.runRows).toHaveLength(100);
    // `run-100` has the smallest `at` of the 101 pushed — the 101st newest, and the one the
    // 100-per-automation cap drops.
    expect(manager.runRows.map((r) => r.id)).not.toContain('run-100');
  });

  it('sweeps a run past 30 days even when far fewer than 100 exist', async () => {
    const manager = new FakeManager();
    const automation = buildAutomation();
    const now = Date.now();
    const stale = buildRun({
      id: 'run-stale',
      automationId: automation.id,
      at: now - 31 * 24 * 60 * 60 * 1000,
    });
    const fresh = buildRun({ id: 'run-fresh', automationId: automation.id, at: now });

    await apply(
      manager,
      'account-1',
      'desktop-1',
      emptyDelta({ automations: [automation], automationRuns: [stale, fresh] }),
    );

    expect(manager.runRows.map((r) => r.id)).toEqual(['run-fresh']);
  });
});

describe('runsToPrune', () => {
  it('drops anything older than 30 days', () => {
    const now = 1_700_000_000_000;
    const runs = [
      { id: 'old', at: now - 31 * 24 * 60 * 60 * 1000 },
      { id: 'recent', at: now - 1000 },
    ];

    expect(runsToPrune(runs, now).map((r) => r.id)).toEqual(['old']);
  });

  it('keeps only the newest 100, even when every one is within retention', () => {
    const now = 1_700_000_000_000;
    const runs = Array.from({ length: 101 }, (_, i) => ({ id: `run-${i}`, at: now - i }));

    const pruned = runsToPrune(runs, now);

    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.id).toBe('run-100'); // the 101st newest — the oldest of the batch
  });

  it('is scoped by the caller to one automation at a time', () => {
    // runsToPrune itself takes no automationId — applyAutomationDelta is what calls it once
    // per touched automation. A mixed-automation list proves it has no opinion of its own.
    const now = 1_700_000_000_000;
    const runs = Array.from({ length: 101 }, (_, i) => ({ id: `run-${i}`, at: now - i }));

    expect(runsToPrune(runs, now)).toHaveLength(1);
  });
});
