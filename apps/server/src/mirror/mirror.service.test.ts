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
  };
  return {
    transaction: async (cb: (manager: unknown) => Promise<unknown>) => cb(manager),
  } as unknown as DataSource;
}

describe('MirrorService.createTask', () => {
  it('writes a task directly for an account with zero desktop syncs, and it shows up on GET /v1/board', async () => {
    const store = new FakeStore();
    const service = new MirrorService(
      fakeDataSource(store),
      fakeRepository<Client>([] as unknown as Client[]),
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
      fakeRepository<Client>([] as unknown as Client[]),
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
