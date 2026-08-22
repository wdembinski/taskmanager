import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { AgentProfile } from '../entities/agentProfile.entity';
import { Assignment } from '../entities/assignment.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * The same hand-rolled `DataSource`/`Repository` stand-in `tickets.controller.test.ts`
 * uses, extended with the two new tables — see that file's own docstring for why this
 * exists instead of an in-memory driver (there is none for `mssql`).
 */
class FakeMirrorDb {
  profiles = new Map<string, AgentProfile>();
  assignments = new Map<string, Assignment>();
  tasks = new Map<string, TaskMirror>();

  private tableFor(entity: unknown): Map<string, { id: string }> {
    if (entity === AgentProfile) return this.profiles as unknown as Map<string, AgentProfile>;
    if (entity === Assignment) return this.assignments as unknown as Map<string, Assignment>;
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
        table.set(row.id as string, row as never);
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
      findOne: async (opts: { where: Record<string, unknown> }) =>
        [...table.values()].find(this.matches(opts.where as Record<string, unknown>)) ?? null,
    } as unknown as Repository<T>;
  }
}

function buildController(): { controller: AgentsController; db: FakeMirrorDb } {
  const db = new FakeMirrorDb();
  const service = new AgentsService(
    db.dataSource,
    db.repo(db.profiles),
    db.repo(db.assignments),
    db.repo(db.tasks),
  );
  return { controller: new AgentsController(service), db };
}

function seedTicket(db: FakeMirrorDb, accountId: string, projectId: string, id: string): void {
  db.tasks.set(id, {
    id,
    accountId,
    projectId,
    data: { id, projectId, title: 'A ticket' },
  } as unknown as TaskMirror);
}

describe('AgentsController', () => {
  let controller: AgentsController;
  let db: FakeMirrorDb;

  beforeEach(() => {
    ({ controller, db } = buildController());
  });

  it('creates an agent profile with a minted id', async () => {
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(profile.name).toBe('Reviewer');
    expect(profile.defaultProjectId).toBeNull();
  });

  it('refuses a profile with an unusable model or permission mode', async () => {
    await expect(
      controller.createProfile('acct-1', {
        name: 'X',
        model: 'gpt-5' as never,
        permissionMode: 'acceptEdits',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.createProfile('acct-1', {
        name: 'X',
        model: 'sonnet',
        permissionMode: 'yolo' as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists only the calling account’s profiles', async () => {
    await controller.createProfile('acct-1', {
      name: 'Mine',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    await controller.createProfile('acct-2', {
      name: 'Theirs',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    const mine = await controller.listProfiles('acct-1');
    expect(mine.map((p) => p.name)).toEqual(['Mine']);
  });

  it('patches a profile', async () => {
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      defaultProjectId: 'proj-1',
    });

    const patched = await controller.updateProfile('acct-1', profile.id, {
      model: 'opus',
      defaultProjectId: null,
    });

    expect(patched.model).toBe('opus');
    expect(patched.defaultProjectId).toBeNull();
    expect(patched.name).toBe('Reviewer');
  });

  it('is a 404 patching a profile on somebody else’s account', async () => {
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    await expect(
      controller.updateProfile('acct-2', profile.id, { name: 'Hijacked' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('queues an assignment for a ticket the account owns', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    const assignment = await controller.createAssignment('acct-1', {
      projectId: 'proj-1',
      ticketId: 'ticket-1',
      profileId: profile.id,
    });

    expect(assignment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(assignment.status).toBe('queued');
    expect(assignment.claimedByClientId).toBeNull();
  });

  it('refuses to queue a ticket against the wrong project', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    await expect(
      controller.createAssignment('acct-1', {
        projectId: 'proj-2',
        ticketId: 'ticket-1',
        profileId: profile.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is a 404 queuing a ticket nothing on this account owns', async () => {
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    await expect(
      controller.createAssignment('acct-1', {
        projectId: 'proj-1',
        ticketId: 'no-such-ticket',
        profileId: profile.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets exactly one client claim a queued assignment', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    const assignment = await controller.createAssignment('acct-1', {
      projectId: 'proj-1',
      ticketId: 'ticket-1',
      profileId: profile.id,
    });

    const claimed = await controller.claim('acct-1', assignment.id, { clientId: 'desktop-a' });
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedByClientId).toBe('desktop-a');

    await expect(
      controller.claim('acct-1', assignment.id, { clientId: 'desktop-b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('walks claimed → running → done, recording the runId', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    const assignment = await controller.createAssignment('acct-1', {
      projectId: 'proj-1',
      ticketId: 'ticket-1',
      profileId: profile.id,
    });
    await controller.claim('acct-1', assignment.id, { clientId: 'desktop-a' });

    const running = await controller.complete('acct-1', assignment.id, {
      status: 'running',
      clientId: 'desktop-a',
      runId: 'run-1',
    });
    expect(running.status).toBe('running');
    expect(running.runId).toBe('run-1');
    expect(running.startedAt).not.toBeNull();

    const done = await controller.complete('acct-1', assignment.id, {
      status: 'done',
      clientId: 'desktop-a',
    });
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    // A field omitted from a later report is left as it was.
    expect(done.runId).toBe('run-1');
  });

  it('refuses a report from a client that never claimed it', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    const assignment = await controller.createAssignment('acct-1', {
      projectId: 'proj-1',
      ticketId: 'ticket-1',
      profileId: profile.id,
    });
    await controller.claim('acct-1', assignment.id, { clientId: 'desktop-a' });

    await expect(
      controller.complete('acct-1', assignment.id, { status: 'running', clientId: 'desktop-b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists assignments filtered by status and project', async () => {
    seedTicket(db, 'acct-1', 'proj-1', 'ticket-1');
    seedTicket(db, 'acct-1', 'proj-2', 'ticket-2');
    const profile = await controller.createProfile('acct-1', {
      name: 'Reviewer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    const a = await controller.createAssignment('acct-1', {
      projectId: 'proj-1',
      ticketId: 'ticket-1',
      profileId: profile.id,
    });
    await controller.createAssignment('acct-1', {
      projectId: 'proj-2',
      ticketId: 'ticket-2',
      profileId: profile.id,
    });
    await controller.claim('acct-1', a.id, { clientId: 'desktop-a' });

    const queuedForProj2 = await controller.listAssignments('acct-1', 'queued', 'proj-2');
    expect(queuedForProj2.map((row) => row.ticketId)).toEqual(['ticket-2']);
  });
});
