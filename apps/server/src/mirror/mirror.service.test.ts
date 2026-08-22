import { describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import { buildProject } from '@tm/shared/projectBuilders';
import { EventBus } from '../events/eventBus';
import { PresenceRegistry } from '../presence/presence.registry';
import { PresenceService } from '../presence/presence.service';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { MirrorService } from './mirror.service';

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
    if (entity === Tombstone) return this.tombstoneRows as unknown as T[];
    if (entity === Command) return this.commandRows as unknown as T[];
    throw new Error(`FakeStore: unhandled entity ${String(entity)}`);
  }
}

interface AccountRow {
  accountId: string;
  rowVersion: Buffer;
}

class FakeQueryBuilder<T extends AccountRow> {
  private accountId?: string;
  private since?: Buffer;
  private limit?: number;

  constructor(private readonly rows: T[]) {}

  where(_sql: string, params: Record<string, unknown> = {}): this {
    return this.andWhere(_sql, params);
  }

  andWhere(_sql: string, params: Record<string, unknown> = {}): this {
    if ('accountId' in params) this.accountId = params.accountId as string;
    if ('since' in params) this.since = params.since as Buffer;
    return this;
  }

  orderBy(): this {
    return this;
  }

  take(n: number): this {
    this.limit = n;
    return this;
  }

  async getMany(): Promise<T[]> {
    const matching = this.rows
      .filter((row) => this.accountId === undefined || row.accountId === this.accountId)
      .filter((row) => this.since === undefined || Buffer.compare(row.rowVersion, this.since) > 0)
      .sort((a, b) => Buffer.compare(a.rowVersion, b.rowVersion));
    return this.limit === undefined ? matching : matching.slice(0, this.limit);
  }
}

function fakeRepository<T extends object>(rows: T[]): Repository<T> {
  return {
    createQueryBuilder: () => new FakeQueryBuilder(rows as unknown as (T & AccountRow)[]),
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
    delete: async (entity: unknown, criteria: { id: unknown }) => {
      const ids = idsFrom(criteria.id);
      const arr = store.arrayFor<{ id: string }>(entity);
      const kept = arr.filter((row) => !ids.includes(row.id));
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
      fakeRepository(store.tombstoneRows),
      fakeRepository<CommandResultRow>([] as unknown as CommandResultRow[]),
      new PresenceService(new PresenceRegistry()),
      new EventBus(),
    );

    const accountId = 'account-1';
    // Standing in for a project this account already has — WITHOUT any `POST /v1/sync` ever
    // having run for it, which is exactly the gap this route exists to close.
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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

    const project = await service.createProject(accountId, { path: '/repo', kind: 'agent' });

    expect(project.path).toBe('/repo');
    expect(project.kind).toBe('agent');

    const board = await service.board(accountId, undefined, undefined, false);
    expect(board.deltas.projects).toHaveLength(1);
    expect(board.deltas.projects[0]?.id).toBe(project.id);
  });

  it('edits a project, reflected on GET /v1/board', async () => {
    const { service } = buildService();
    const accountId = 'account-1';
    const project = await service.createProject(accountId, { path: '/repo', kind: 'plan' });

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
    const project = await service.createProject(accountId, { path: '/repo', kind: 'agent' });
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = buildProject({ path: '/repo', kind: 'agent' }, DEFAULT_SETTINGS);
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
    const project = await service.createProject(accountId, { path: '/repo', kind: 'agent' });
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
