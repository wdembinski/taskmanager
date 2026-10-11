import { describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import { buildProject } from '@tm/shared/projectBuilders';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { EventBus } from '../events/eventBus';
import { PresenceRegistry } from '../presence/presence.registry';
import { PresenceService } from '../presence/presence.service';
import { AutomationMirror } from '../entities/automationMirror.entity';
import { AutomationRunMirror } from '../entities/automationRunMirror.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { SettingsMirror } from '../entities/settingsMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { MirrorService } from './mirror.service';

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

/**
 * A hand-rolled stand-in for the slice of TypeORM `MirrorService` actually calls: `upsert`
 * and `delete` inside a transaction, `findOne`/`find` for the two validation reads, and the
 * `createQueryBuilder().where().andWhere().orderBy().take().getMany()` chain `rowsSince` uses.
 * Real SQL Server is the only backend this app's tests can run against for real (see
 * `docker-compose.yml`) — nothing here spins one up — so this fakes just enough of the ORM's
 * surface to prove `createTask` and `board` agree with each other, on the same in-memory rows.
 */
class FakeStore {
  readonly projectRows: ProjectMirror[] = [];
  readonly taskRows: TaskMirror[] = [];
  readonly settingsRows: SettingsMirror[] = [];
  readonly automationRows: AutomationMirror[] = [];
  readonly automationRunRows: AutomationRunMirror[] = [];
  readonly tombstoneRows: Tombstone[] = [];
  readonly clientRows: Client[] = [];
  readonly commandRows: Command[] = [];
  private counter = 0n;

  /** Mimics SQL Server's ROWVERSION: an 8-byte value strictly greater on every write. */
  nextRowVersion(): Buffer {
    this.counter += 1n;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(this.counter);
    return buffer;
  }

  arrayFor<T>(entity: unknown): T[] {
    if (entity === ProjectMirror) return this.projectRows as unknown as T[];
    if (entity === TaskMirror) return this.taskRows as unknown as T[];
    if (entity === SettingsMirror) return this.settingsRows as unknown as T[];
    if (entity === AutomationMirror) return this.automationRows as unknown as T[];
    if (entity === AutomationRunMirror) return this.automationRunRows as unknown as T[];
    if (entity === Tombstone) return this.tombstoneRows as unknown as T[];
    if (entity === Client) return this.clientRows as unknown as T[];
    if (entity === Command) return this.commandRows as unknown as T[];
    throw new Error(`FakeStore: unhandled entity ${String(entity)}`);
  }
}

interface AccountRow {
  accountId: string;
  rowVersion: Buffer;
}

class FakeQueryBuilder<T extends AccountRow> {
  /** Every equality param an `andWhere` has been given, keyed by its SQL parameter name —
   *  `accountId` is just the first one that ever existed here, not special-cased any more. */
  private equality: Record<string, unknown> = {};
  private since?: Buffer;
  private max?: number;
  private orderColumn = 'rowVersion';
  private descending = false;

  constructor(private readonly rows: T[]) {}

  where(_sql: string, params: Record<string, unknown> = {}): this {
    return this.andWhere(_sql, params);
  }

  andWhere(_sql: string, params: Record<string, unknown> = {}): this {
    for (const [key, value] of Object.entries(params)) {
      // `since` compares against `rowVersion` (a monotonic cursor), not a column named
      // `since` — every other param is a plain equality filter on its own column.
      if (key === 'since') this.since = value as Buffer;
      else this.equality[key] = value;
    }
    return this;
  }

  /** `mirror.at` → `at`: only the column name after the alias matters to this fake. */
  orderBy(column?: string, direction?: 'ASC' | 'DESC'): this {
    this.descending = direction === 'DESC';
    if (column) this.orderColumn = column.split('.').pop()!;
    return this;
  }

  take(n: number): this {
    this.max = n;
    return this;
  }

  /** `currentRowVersion` uses `.limit(1)`, not `.take` — same effect for this fake. */
  limit(n: number): this {
    this.max = n;
    return this;
  }

  async getMany(): Promise<T[]> {
    const matching = this.rows
      .filter((row) =>
        Object.entries(this.equality).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      )
      .filter((row) => this.since === undefined || Buffer.compare(row.rowVersion, this.since) > 0)
      .sort((a, b) => {
        const left = (a as Record<string, unknown>)[this.orderColumn];
        const right = (b as Record<string, unknown>)[this.orderColumn];
        const cmp =
          Buffer.isBuffer(left) && Buffer.isBuffer(right)
            ? Buffer.compare(left, right)
            : Number(left) - Number(right);
        return (this.descending ? -1 : 1) * cmp;
      });
    return this.max === undefined ? matching : matching.slice(0, this.max);
  }

  /** `currentRowVersion`'s DESC-ordered `.limit(1).getOne()`. */
  async getOne(): Promise<T | null> {
    const rows = await this.getMany();
    return rows[0] ?? null;
  }
}

function fakeRepository<T extends object>(rows: T[]): Repository<T> {
  return {
    createQueryBuilder: () => new FakeQueryBuilder(rows as unknown as (T & AccountRow)[]),
    // `putSettings` upserts the settings row through the repo directly (not the transaction
    // manager) — the same conflict-path shape the manager's `upsert` uses above.
    upsert: async (entityOrArray: unknown, conflictPaths: string[]) => {
      const toWrite = Array.isArray(entityOrArray) ? entityOrArray : [entityOrArray];
      const key = conflictPaths[0]!;
      const arr = rows as unknown as Record<string, unknown>[];
      for (const row of toWrite as Record<string, unknown>[]) {
        const idx = arr.findIndex((r) => r[key] === row[key]);
        if (idx >= 0) arr[idx] = { ...arr[idx], ...row };
        else arr.push({ ...row });
      }
    },
    findOne: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ) ?? null,
    find: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ),
  } as unknown as Repository<T>;
}

/** `In([...])`'s public `.value` getter is what's actually read back here — see `FindOperator`. */
function idsFrom(criterion: unknown): string[] {
  if (criterion && typeof criterion === 'object' && 'value' in criterion) {
    return (criterion as { value: string[] }).value;
  }
  return [criterion as string];
}

function fakeDataSource(store: FakeStore): DataSource {
  const manager = {
    upsert: async (entity: unknown, entityOrArray: unknown, conflictPaths: string[]) => {
      const rows = Array.isArray(entityOrArray) ? entityOrArray : [entityOrArray];
      const key = conflictPaths[0]!;
      const arr = store.arrayFor<Record<string, unknown>>(entity);
      for (const row of rows as Record<string, unknown>[]) {
        const idx = arr.findIndex((r) => r[key] === row[key]);
        const stored = { ...row, rowVersion: store.nextRowVersion() };
        if (idx >= 0) arr[idx] = stored;
        else arr.push(stored);
      }
    },
    // Generic over the criteria's keys, not just `id`: `applyAutomationDelta` deletes
    // `AutomationRunMirror` rows by `automationId`, not by its own `id`, the one case the
    // original `{ id }`-only shape here never had to cover.
    delete: async (entity: unknown, criteria: Record<string, unknown>) => {
      const arr = store.arrayFor<Record<string, unknown>>(entity);
      const kept = arr.filter(
        (row) =>
          !Object.entries(criteria).every(([key, value]) =>
            idsFrom(value).includes(row[key] as string),
          ),
      );
      arr.length = 0;
      arr.push(...kept);
    },
    // `writeTombstones` (applyMirrorDelta.ts) always deletes then inserts, so `deleteTask`'s
    // path is the first thing in this suite to exercise it — the earlier `createTask` test
    // never deletes anything.
    insert: async (entity: unknown, entityOrArray: unknown) => {
      const rows = Array.isArray(entityOrArray) ? entityOrArray : [entityOrArray];
      const arr = store.arrayFor<Record<string, unknown>>(entity);
      for (const row of rows as Record<string, unknown>[]) {
        arr.push({ ...row, rowVersion: store.nextRowVersion() });
      }
    },
    // `enqueueCommand` (via `replayToDesktops`) reads and writes `Command` rows straight off
    // `dataSource.manager`, outside any `.transaction()` call — so this has to work standalone,
    // not only as the callback argument above.
    findOne: async (entity: unknown, { where }: { where: Record<string, unknown> }) => {
      const arr = store.arrayFor<Record<string, unknown>>(entity);
      return (
        arr.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null
      );
    },
    // `sync()` reads the account's queued commands with `find`. The settings-push test drives
    // it with no command rows, so a plain-equality filter (FindOperators like `IsNull()` treated
    // as "matches") is enough — nothing is in the array to match wrongly.
    find: async (entity: unknown, options?: { where?: unknown }) => {
      const arr = store.arrayFor<Record<string, unknown>>(entity);
      const where = options?.where;
      if (where === undefined) return [...arr];
      const clauses = Array.isArray(where) ? where : [where];
      return arr.filter((row) =>
        (clauses as Record<string, unknown>[]).some((clause) =>
          Object.entries(clause).every(([key, value]) => {
            if (value && typeof value === 'object' && 'value' in (value as object)) return true;
            return row[key] === value;
          }),
        ),
      );
    },
  };
  return {
    manager,
    transaction: async (cb: (manager: unknown) => Promise<unknown>) => cb(manager),
  } as unknown as DataSource;
}

describe('MirrorService.createTask', () => {
  it('writes a task directly for an account with zero desktop syncs, and it shows up on GET /v1/board', async () => {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );

    const accountId = 'account-1';
    // Standing in for a project this account already has — WITHOUT any `POST /v1/sync` ever
    // having run for it, which is exactly the gap this route exists to close.
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });

    const task = await service.createTask(accountId, {
      projectId: project.id,
      title: '  Ship the write endpoint  ',
    });

    expect(task.title).toBe('Ship the write endpoint');
    expect(task.projectId).toBe(project.id);
    expect(task.order).toBe(0);
    expect(task.status).toBe('pending');

    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.tasks).toHaveLength(1);
    expect(board.deltas.tasks[0]?.id).toBe(task.id);
    expect(board.deltas.tasks[0]?.title).toBe('Ship the write endpoint');
  });
});

describe('MirrorService.updateTask / deleteTask', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  it('edits, moves and deletes an ad-hoc task, each reflected on GET /v1/board', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });

    const created = await service.createTask(accountId, {
      projectId: project.id,
      title: 'Write the endpoint',
    });

    // Field edit.
    const edited = await service.updateTask(accountId, created.id, {
      title: '  Ship the write endpoint  ',
      description: 'Covers edit, move and delete',
    });
    expect(edited.title).toBe('Ship the write endpoint');
    expect(edited.externalDescription).toBe('Covers edit, move and delete');
    expect(edited.status).toBe('pending');

    let board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.tasks[0]?.title).toBe('Ship the write endpoint');

    // Move — the board drag path.
    const moved = await service.updateTask(accountId, created.id, { toColumn: 'in-progress' });
    expect(moved.status).toBe('in-progress');

    board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.tasks[0]?.status).toBe('in-progress');

    // Hand-set status — the detail pane's dropdown path.
    const statused = await service.updateTask(accountId, created.id, { status: 'blocked' });
    expect(statused.status).toBe('blocked');
    // Blocked locally (this ad-hoc task has no linked issue), so the column it came from
    // is remembered for un-blocking.
    expect(statused.preBlockStatus).toBe('in-progress');

    // Delete.
    await service.deleteTask(accountId, created.id);
    board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.tasks).toHaveLength(0);
    expect(board.deltas.deletedTaskIds).toContain(created.id);
  });

  it('refuses an unknown project on projectTagId, and a blank title', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });
    const created = await service.createTask(accountId, {
      projectId: project.id,
      title: 'A task',
    });

    await expect(
      service.updateTask(accountId, created.id, { projectTagId: 'no-such-project' }),
    ).rejects.toThrow('Unknown project.');

    await expect(service.updateTask(accountId, created.id, { title: '   ' })).rejects.toThrow(
      'A task needs a title.',
    );
  });

  it('throws 404 for a task belonging to another account', async () => {
    const { service, store } = buildService();
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId: 'account-1',
      data: project,
      rowVersion: store.nextRowVersion(),
    });
    const created = await service.createTask('account-1', {
      projectId: project.id,
      title: 'A task',
    });

    await expect(
      service.updateTask('account-2', created.id, { title: 'Hijacked' }),
    ).rejects.toThrow('Task not found.');
  });

  it('deleteTask is a silent no-op for an id that names nothing', async () => {
    const { service } = buildService();
    await expect(service.deleteTask('account-1', 'no-such-task')).resolves.toBeUndefined();
  });

  it('deleteTask refuses while the task is running, and cascades to its steps', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });
    const card = await service.createTask(accountId, { projectId: project.id, title: 'Card' });

    // A step mirrored under the card — same task_mirrors table, `parentTaskId` set.
    const stepId = 'step-1';
    store.taskRows.push({
      id: stepId,
      accountId,
      projectId: project.id,
      data: { ...card, id: stepId, parentTaskId: card.id, title: 'Step 1' },
      rowVersion: store.nextRowVersion(),
    });

    // Running blocks the delete.
    const runningRow = store.taskRows.find((r) => r.id === card.id)!;
    runningRow.data = { ...runningRow.data, status: 'running' };
    await expect(service.deleteTask(accountId, card.id)).rejects.toThrow(
      'Stop the task before deleting it.',
    );

    // Settled: deleting the card takes its step with it.
    runningRow.data = { ...runningRow.data, status: 'done' };
    await service.deleteTask(accountId, card.id);
    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.tasks).toHaveLength(0);
    expect(board.deltas.deletedTaskIds).toEqual(expect.arrayContaining([card.id, stepId]));
  });
});

describe('MirrorService.createProject / updateProject / deleteProject', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  it('writes a project directly, and it shows up on GET /v1/board', async () => {
    const { service } = buildService();
    const accountId = 'account-1';

    const project = await service.createProject(accountId, { path: '/repo', planPath: '' });

    expect(project.path).toBe('/repo');
    expect(project.planPath).toBe('');

    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.projects).toHaveLength(1);
    expect(board.deltas.projects[0]?.id).toBe(project.id);
  });

  it('edits a project, reflected on GET /v1/board', async () => {
    const { service } = buildService();
    const accountId = 'account-1';
    const project = await service.createProject(accountId, { path: '/repo' });

    const edited = await service.updateProject(accountId, project.id, {
      name: 'Renamed',
      color: '  #0091FF  ',
      instructions: '  Build with pnpm  ',
      jiraEpicKeys: ['abc-100', 'ABC-100', ' '],
    });

    expect(edited.name).toBe('Renamed');
    expect(edited.color).toBe('#0091FF');
    expect(edited.instructions).toBe('Build with pnpm');
    expect(edited.jiraEpicKeys).toEqual(['ABC-100']);

    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.projects[0]?.name).toBe('Renamed');
  });

  it('throws 404 for a project belonging to another account', async () => {
    const { service } = buildService();
    const project = await service.createProject('account-1', { path: '/repo' });

    await expect(
      service.updateProject('account-2', project.id, { name: 'Hijacked' }),
    ).rejects.toThrow('Project not found.');
  });

  it('deletes a project, cascading to its mirrored tasks', async () => {
    const { service } = buildService();
    const accountId = 'account-1';
    const project = await service.createProject(accountId, { path: '/repo', planPath: '' });
    const task = await service.createTask(accountId, { projectId: project.id, title: 'A task' });

    await service.deleteProject(accountId, project.id);

    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.projects).toHaveLength(0);
    expect(board.deltas.tasks).toHaveLength(0);
    expect(board.deltas.deletedProjectIds).toContain(project.id);
    expect(board.deltas.deletedTaskIds).toContain(task.id);
  });

  it('deleteProject is a silent no-op for an id that names nothing', async () => {
    const { service } = buildService();
    await expect(service.deleteProject('account-1', 'no-such-project')).resolves.toBeUndefined();
  });
});

describe('MirrorService replay to a desktop Client', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  it('queues an ipc-invoke replay for a known desktop Client that is offline right now', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });

    // A desktop this account has synced from before — its Client row is on record, but there
    // is no presence beat for it (no `sync()` call in this test), i.e. it is offline right now.
    store.clientRows.push({
      id: 'desktop-1',
      accountId,
      name: 'WORKSTATION',
      platform: 'win32',
      appVersion: '0.90.0',
      protocolVersion: 2,
      createdAt: new Date(),
    });

    const task = await service.createTask(accountId, { projectId: project.id, title: 'Ship it' });

    expect(store.commandRows).toHaveLength(1);
    const command = store.commandRows[0]!;
    expect(command.targetClientId).toBe('desktop-1');
    expect(command.accountId).toBe(accountId);
    expect(command.kind).toBe('ipc-invoke');
    expect(command.payload).toMatchObject({
      channel: 'task:create',
      args: [project.id, { title: 'Ship it' }],
    });
    // The mirror's own row and the desktop's future replay are deliberately different tasks —
    // see `createTask`'s own comment on why `task:create` cannot be told to reuse an id.
    expect((command.payload as { args: unknown[] }).args[0]).toBe(task.projectId);
  });

  it('queues nothing when the account has no desktop Client on record', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });

    await service.createTask(accountId, { projectId: project.id, title: 'Ship it' });

    expect(store.commandRows).toHaveLength(0);
  });

  it('replays an edit as one command per changed, replayable field', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = buildProject({ path: '/repo', planPath: '' }, DEFAULT_SETTINGS);
    store.projectRows.push({
      id: project.id,
      accountId,
      data: project,
      rowVersion: store.nextRowVersion(),
    });
    store.clientRows.push({
      id: 'desktop-1',
      accountId,
      name: null,
      platform: null,
      appVersion: null,
      protocolVersion: null,
      createdAt: new Date(),
    });

    const task = await service.createTask(accountId, { projectId: project.id, title: 'A task' });
    store.commandRows.length = 0; // Only care about the update's own replays from here.

    await service.updateTask(accountId, task.id, {
      description: 'New brief',
      toColumn: 'in-progress',
    });

    const channels = store.commandRows.map((row) => (row.payload as { channel: string }).channel);
    expect(channels).toEqual(expect.arrayContaining(['task:setDescription', 'task:move']));
    expect(channels).toHaveLength(2);
  });

  it('replays a project delete to a known desktop Client, by the same id', async () => {
    const { service, store } = buildService();
    const accountId = 'account-1';
    const project = await service.createProject(accountId, { path: '/repo', planPath: '' });
    store.clientRows.push({
      id: 'desktop-1',
      accountId,
      name: null,
      platform: null,
      appVersion: null,
      protocolVersion: null,
      createdAt: new Date(),
    });
    store.commandRows.length = 0;

    await service.deleteProject(accountId, project.id);

    expect(store.commandRows).toHaveLength(1);
    expect(store.commandRows[0]?.payload).toMatchObject({
      channel: 'project:remove',
      args: [project.id],
    });
  });
});

describe('MirrorService settings mirror', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  function knownDesktop(store: FakeStore, accountId: string): void {
    store.clientRows.push({
      id: 'desktop-1',
      accountId,
      name: null,
      platform: null,
      appVersion: null,
      protocolVersion: null,
      createdAt: new Date(),
    });
  }

  it('getSettings returns stock defaults for an account that has never synced or saved', async () => {
    const { service } = buildService();
    expect(await service.getSettings('account-1')).toEqual(DEFAULT_SETTINGS);
  });

  it('putSettings merges a global patch, returns the whole blob, and reads back the same', async () => {
    const { service } = buildService();

    const saved = await service.putSettings('account-1', { branchPrefix: 'wd', concurrency: 3 });

    expect(saved.branchPrefix).toBe('wd');
    expect(saved.concurrency).toBe(3);
    expect(saved.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel); // untouched fields keep defaults
    expect(await service.getSettings('account-1')).toEqual(saved);
  });

  it('putSettings never stores a machine-local field, even when a browser echoes one back', async () => {
    const { service } = buildService();

    // Cloud web loads the whole blob and saves it whole, so `fontSizePx` rides along at its
    // default — it must be dropped, not written, or one browser would set every desktop's font.
    const saved = await service.putSettings('account-1', { branchPrefix: 'wd', fontSizePx: 99 });

    expect(saved.branchPrefix).toBe('wd');
    expect(saved.fontSizePx).toBe(DEFAULT_SETTINGS.fontSizePx);
  });

  it('putSettings replays ONLY the global keys to desktops — never a machine-local field', async () => {
    const { service, store } = buildService();
    knownDesktop(store, 'account-1');

    await service.putSettings('account-1', { branchPrefix: 'wd', fontSizePx: 99 });

    expect(store.commandRows).toHaveLength(1);
    const payload = store.commandRows[0]!.payload as { channel: string; args: unknown[] };
    expect(payload.channel).toBe('settings:save');
    // The load-bearing invariant: the replayed patch carries the global key and NOT the local
    // one, so the desktop's `mergeAppSettings` leaves its own `fontSizePx` untouched.
    expect(payload.args[0]).toEqual({ branchPrefix: 'wd' });
  });

  it('a desktop sync push seeds the mirror (global only) and replays nothing back to it', async () => {
    const { service, store } = buildService();

    await service.sync('account-1', {
      clientId: 'desktop-1',
      cursor: null,
      focused: false,
      deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
      ackedCommandIds: [],
      settings: { branchPrefix: 'from-desktop', fontSizePx: 30 },
    });

    const stored = await service.getSettings('account-1');
    expect(stored.branchPrefix).toBe('from-desktop');
    expect(stored.fontSizePx).toBe(DEFAULT_SETTINGS.fontSizePx); // local field stripped on the way in
    // The pushing desktop is the source — nothing is replayed back to it.
    expect(store.commandRows).toHaveLength(0);
  });

  it('a sync with no settings field leaves the mirror untouched', async () => {
    const { service } = buildService();
    await service.putSettings('account-1', { branchPrefix: 'wd' });

    await service.sync('account-1', {
      clientId: 'desktop-1',
      cursor: null,
      focused: false,
      deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
      ackedCommandIds: [],
    });

    expect((await service.getSettings('account-1')).branchPrefix).toBe('wd');
  });
});

describe('MirrorService.sync automation mirror', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  it('a v2-shaped SyncRequest, carrying no automation fields, syncs cleanly', async () => {
    const { service } = buildService();

    await expect(
      service.sync('account-1', {
        clientId: 'desktop-1',
        cursor: null,
        focused: false,
        deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
        ackedCommandIds: [],
      }),
    ).resolves.toBeDefined();
  });

  it('a sync carrying an automation and a run mirrors both, readable through the account routes', async () => {
    const { service } = buildService();
    const automation = buildAutomation();
    const run = buildRun({ automationId: automation.id });

    await service.sync('account-1', {
      clientId: 'desktop-1',
      cursor: null,
      focused: false,
      deltas: {
        tasks: [],
        projects: [],
        deletedTaskIds: [],
        deletedProjectIds: [],
        automations: [automation],
        automationRuns: [run],
      },
      ackedCommandIds: [],
    });

    const automations = await service.automations('account-1');
    expect(automations.automations).toHaveLength(1);
    expect(automations.automations[0]?.id).toBe(automation.id);

    const runs = await service.automationRuns('account-1', automation.id, 50);
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]?.id).toBe(run.id);
  });

  it('deletes an automation and its runs off a later sync carrying deletedAutomationIds', async () => {
    const { service } = buildService();
    const automation = buildAutomation();
    const run = buildRun({ automationId: automation.id });

    await service.sync('account-1', {
      clientId: 'desktop-1',
      cursor: null,
      focused: false,
      deltas: {
        tasks: [],
        projects: [],
        deletedTaskIds: [],
        deletedProjectIds: [],
        automations: [automation],
        automationRuns: [run],
      },
      ackedCommandIds: [],
    });

    await service.sync('account-1', {
      clientId: 'desktop-1',
      cursor: null,
      focused: false,
      deltas: {
        tasks: [],
        projects: [],
        deletedTaskIds: [],
        deletedProjectIds: [],
        deletedAutomationIds: [automation.id],
      },
      ackedCommandIds: [],
    });

    expect((await service.automations('account-1')).automations).toHaveLength(0);
    await expect(service.automationRuns('account-1', automation.id, 50)).rejects.toThrow(
      'Automation not found.',
    );
  });
});

describe('MirrorService.automations / automationRuns', () => {
  function buildService(): { service: MirrorService; store: FakeStore } {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository(store.clientRows),
      fakeRepository(store.taskRows),
      fakeRepository(store.projectRows),
      fakeRepository(store.settingsRows),
      fakeRepository(store.automationRows),
      fakeRepository(store.automationRunRows),
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );
    return { service, store };
  }

  it('automationRuns 404s for an automation belonging to another account', async () => {
    const { service, store } = buildService();
    const automation = buildAutomation();
    store.automationRows.push({
      id: automation.id,
      accountId: 'account-1',
      clientId: 'desktop-1',
      data: automation,
      updatedAt: String(automation.updatedAt),
    });

    await expect(service.automationRuns('account-2', automation.id, 50)).rejects.toThrow(
      'Automation not found.',
    );
  });

  it('caps automationRuns at MAX_AUTOMATION_RUNS_PAGE regardless of the requested limit, newest first', async () => {
    const { service, store } = buildService();
    const automation = buildAutomation();
    store.automationRows.push({
      id: automation.id,
      accountId: 'account-1',
      clientId: 'desktop-1',
      data: automation,
      updatedAt: String(automation.updatedAt),
    });

    for (let i = 0; i < 150; i++) {
      const run = buildRun({
        id: `run-${i}`,
        automationId: automation.id,
        at: 1_700_000_000_000 + i,
      });
      store.automationRunRows.push({
        id: run.id,
        accountId: 'account-1',
        automationId: automation.id,
        data: run,
        at: String(run.at),
      });
    }

    const result = await service.automationRuns('account-1', automation.id, 1000);
    expect(result.runs).toHaveLength(100);
    expect(result.runs[0]?.id).toBe('run-149'); // newest first
    expect(result.runs[99]?.id).toBe('run-50');
  });
});
