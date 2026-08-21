import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

/**
 * A minimal in-memory stand-in for the slice of TypeORM's `DataSource`/`Repository` API
 * `TicketsService` actually calls (`findOne`/`find`/`upsert`/`increment`, and
 * `transaction` running its callback against the same store) — there is no in-memory or
 * sqlite driver in this package (only `mssql`, see `apps/server/package.json`), so a real
 * DB round-trip isn't an option here the way it is for `apps/client`'s better-sqlite3
 * store. This still exercises the real `TicketsService`/`TicketsController` code, end to
 * end, including the one thing a unit test with mocked methods could not prove: that an
 * upsert actually bumps `rowVersion` the way a desktop-pushed sync delta does.
 */
class FakeMirrorDb {
  projects = new Map<string, ProjectMirror>();
  tasks = new Map<string, TaskMirror>();
  private version = 0;

  /** Stands in for SQL Server's own ROWVERSION: strictly increasing across every write,
   *  whichever table it lands on — matching the real column's cross-table guarantee. */
  private bump(): Buffer {
    this.version += 1;
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(this.version, 4);
    return buf;
  }

  private tableFor(entity: unknown): Map<string, { id: string; rowVersion: Buffer }> {
    if (entity === ProjectMirror) return this.projects as unknown as Map<string, ProjectMirror>;
    if (entity === TaskMirror) return this.tasks as unknown as Map<string, TaskMirror>;
    throw new Error(`Unfaked entity: ${String(entity)}`);
  }

  private matches(where: Record<string, unknown>) {
    return (row: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
  }

  manager = {
    findOne: async (entity: unknown, opts: { where: Record<string, unknown> }) => {
      const table = this.tableFor(entity);
      return [...table.values()].find(this.matches(opts.where)) ?? null;
    },
    find: async (entity: unknown, opts: { where: Record<string, unknown> }) => {
      const table = this.tableFor(entity);
      return [...table.values()].filter(this.matches(opts.where));
    },
    upsert: async (
      entity: unknown,
      rows: Record<string, unknown> | Record<string, unknown>[],
      _conflict: string[],
    ) => {
      const table = this.tableFor(entity);
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const id = row.id as string;
        const existing = table.get(id);
        table.set(id, { ticketSeq: 0, ...existing, ...row, rowVersion: this.bump() } as never);
      }
    },
    increment: async (
      entity: unknown,
      criteria: Record<string, unknown>,
      column: string,
      amount: number,
    ) => {
      const table = this.tableFor(entity);
      const row = [...table.values()].find(this.matches(criteria)) as
        (Record<string, number> & { rowVersion: Buffer }) | undefined;
      if (row) {
        row[column] = (row[column] ?? 0) + amount;
        // A real SQL Server ROWVERSION bumps on ANY update, including a bare increment.
        row.rowVersion = this.bump();
      }
    },
  };

  dataSource = {
    manager: this.manager,
    transaction: async <T>(cb: (manager: typeof this.manager) => Promise<T>): Promise<T> =>
      cb(this.manager),
  } as unknown as DataSource;

  repo<T extends { id: string }>(table: Map<string, T>): Repository<T> {
    return {
      find: async (opts: { where: Record<string, unknown> }) =>
        [...table.values()].filter(this.matches(opts.where as Record<string, unknown>)),
    } as unknown as Repository<T>;
  }
}

function buildController(): { controller: TicketsController; db: FakeMirrorDb } {
  const db = new FakeMirrorDb();
  const service = new TicketsService(db.dataSource, db.repo(db.projects), db.repo(db.tasks));
  return { controller: new TicketsController(service), db };
}

describe('TicketsController', () => {
  let controller: TicketsController;
  let db: FakeMirrorDb;

  beforeEach(() => {
    ({ controller, db } = buildController());
  });

  it('creates a ticket project with a minted id and the repo-less defaults forced', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.kind).toBe('ticket');
    expect(project.ticketPrefix).toBe('TM');
    // Falls back to the prefix when no name was given — same as the desktop store.
    expect(project.name).toBe('TM');
    expect(project.path).toBe('');
    expect(project.useWorktrees).toBe(false);
  });

  it('refuses to create anything but a ticket-kind project', async () => {
    await expect(
      controller.createProject('acct-1', { path: '/repo', kind: 'plan' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists only the calling account’s projects', async () => {
    await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm', name: 'Mine' });
    await controller.createProject('acct-2', { path: '', ticketPrefix: 'x', name: 'Theirs' });

    const mine = await controller.listProjects('acct-1');
    expect(mine.map((p) => p.name)).toEqual(['Mine']);
  });

  it('allocates sequential ticket keys off the project’s own counter, not MAX(number)', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });

    const first = await controller.createTicket('acct-1', project.id, { title: 'First' });
    const second = await controller.createTicket('acct-1', project.id, { title: 'Second' });

    expect(first.ticketKey).toBe('TM-1');
    expect(second.ticketKey).toBe('TM-2');
    expect(second.order).toBe(first.order + 1);
    expect(second.id).not.toBe(first.id);
    expect(second.source).toBe('ticket');
    expect(second.issueType).toBe('task');
  });

  it('bumps rowVersion on every write, the same way a desktop-pushed delta does', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    const afterCreate = db.projects.get(project.id)!.rowVersion;

    await controller.createTicket('acct-1', project.id, { title: 'Ticket' });
    const afterTicket = db.projects.get(project.id)!.rowVersion;

    expect(Buffer.compare(afterTicket, afterCreate)).toBeGreaterThan(0);
  });

  it('refuses a ticket for a project with no usable prefix', async () => {
    const project = await controller.createProject('acct-1', { path: '' });
    await expect(
      controller.createTicket('acct-1', project.id, { title: 'Nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an empty title', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    await expect(
      controller.createTicket('acct-1', project.id, { title: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is a 404 for a project on somebody else’s account', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    await expect(
      controller.createTicket('acct-2', project.id, { title: 'Nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('re-keys every issued ticket when the project’s prefix changes', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    const ticket = await controller.createTicket('acct-1', project.id, { title: 'Ticket' });
    expect(ticket.ticketKey).toBe('TM-1');

    const renamed = await controller.updateProject('acct-1', project.id, { ticketPrefix: 'plat' });
    expect(renamed.ticketPrefix).toBe('PLAT');

    const [rekeyed] = await controller.listTickets('acct-1', project.id);
    expect(rekeyed?.ticketKey).toBe('PLAT-1');
    // The durable half of the key is untouched by a rename.
    expect(rekeyed?.ticketNumber).toBe(1);
  });

  it('refuses to clear a prefix once it has issued a ticket', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    await controller.createTicket('acct-1', project.id, { title: 'Ticket' });

    const patched = await controller.updateProject('acct-1', project.id, { ticketPrefix: '' });
    expect(patched.ticketPrefix).toBe('TM');
  });

  it('updates a ticket’s title, status and ticket-specific fields', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    const ticket = await controller.createTicket('acct-1', project.id, { title: 'Ticket' });

    const updated = await controller.updateTicket('acct-1', ticket.id, {
      title: 'Renamed',
      status: 'in-progress',
      storyPoints: 3,
      labels: ['Backend', 'backend'],
    });

    expect(updated.title).toBe('Renamed');
    expect(updated.status).toBe('in-progress');
    expect(updated.storyPoints).toBe(3);
    expect(updated.labels).toEqual(['Backend']);
    // The key is never rewritten by a ticket-level update.
    expect(updated.ticketKey).toBe('TM-1');
  });

  it('refuses a status a human may not set by hand', async () => {
    const project = await controller.createProject('acct-1', { path: '', ticketPrefix: 'tm' });
    const ticket = await controller.createTicket('acct-1', project.id, { title: 'Ticket' });

    await expect(
      controller.updateTicket('acct-1', ticket.id, { status: 'running' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is a 404 for a ticket id nothing on this account owns', async () => {
    await expect(
      controller.updateTicket('acct-1', 'no-such-id', { title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
