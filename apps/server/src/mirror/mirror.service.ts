import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import type { BoardResponse, CommandRequest, SyncRequest, SyncResponse } from '@tm/protocol/wire';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { PresenceService } from '../presence/presence.service';
import { applyMirrorDelta } from './applyMirrorDelta';
import { toCommandEnvelope } from './commandMapping';
import {
  cursorToRowVersion,
  maxRowVersion,
  rowVersionToCursor,
  ZERO_ROWVERSION,
} from './rowVersion';

/**
 * Backs the three mirror routes (MirrorController): POST /v1/sync,
 * POST /v1/commands and GET /v1/board. See docs/plan/README.md Phase 25 for
 * the wire contract's shape and why /v1/sync returns commands rather than
 * task/project deltas (a desktop Client already has its own local mirror; a
 * web session, read by /v1/board, does not).
 */
@Injectable()
export class MirrorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(TaskMirror) private readonly taskMirrors: Repository<TaskMirror>,
    @InjectRepository(ProjectMirror) private readonly projectMirrors: Repository<ProjectMirror>,
    private readonly presence: PresenceService,
  ) {}

  /**
   * One transaction: register the caller's Client id if this is its first
   * beat, apply its outgoing deltas, then collect and mark-delivered whatever
   * commands were queued for it. Applying and delivering in the same
   * transaction means a Client's push is never acknowledged (commands marked
   * delivered) without its own changes having actually landed, and vice
   * versa.
   *
   * `request.focused` doubles as this Client's presence beat — recording it
   * costs no extra round trip, and the resulting cadence rides back on this
   * same response.
   */
  async sync(accountId: string, request: SyncRequest): Promise<SyncResponse> {
    const commands = await this.dataSource.transaction(async (manager) => {
      await manager.upsert(Client, { id: request.clientId, accountId }, ['id']);

      await applyMirrorDelta(manager, accountId, request.deltas);

      const queued = await manager.find(Command, {
        where: {
          accountId,
          targetClientId: request.clientId,
          deliveredAt: IsNull(),
        },
        order: { createdAt: 'ASC' },
      });
      if (queued.length > 0) {
        await manager.update(
          Command,
          queued.map((c) => c.id),
          { deliveredAt: new Date() },
        );
      }
      return queued;
    });

    const cadence = this.presence.beat(accountId, request.clientId, {
      kind: 'client',
      focused: request.focused,
      at: Date.now(),
    });

    return {
      cursor: rowVersionToCursor(await this.currentRowVersion(accountId)),
      cadence,
      commands: commands.map(toCommandEnvelope),
    };
  }

  /** Enqueues one command for delivery on the target Client's next sync. */
  async enqueueCommand(accountId: string, request: CommandRequest): Promise<void> {
    await this.dataSource.manager.insert(Command, {
      id: request.command.id,
      accountId,
      targetClientId: request.targetClientId,
      issuedAt: String(request.command.issuedAt),
      issuedBy: request.command.issuedBy,
      kind: request.command.kind,
      payload: request.command.payload,
      deliveredAt: null,
    });
  }

  /**
   * The web app's read path: every task/project whose `rowVersion` is past
   * `since`, in rowVersion order. No `deletedTaskIds`/`deletedProjectIds` —
   * the mirror keeps no tombstones (see applyMirrorDelta.ts), so a row this
   * account deleted is simply absent from the result, not listed as removed.
   *
   * `focused`/`clientId` come off the `X-TM-Focus`/`X-TM-Client-Id` headers — a GET carries
   * no body, so this is the read path's own presence beat. `clientId` is optional only
   * because a caller predating that header shouldn't 500; without it there's no session to
   * key a beat on, so this just resolves the account's current cadence instead.
   */
  async board(
    accountId: string,
    since: string | undefined,
    clientId: string | undefined,
    focused: boolean,
  ): Promise<BoardResponse> {
    const sinceBuffer = since ? cursorToRowVersion(since) : null;
    const now = Date.now();

    const [taskRows, projectRows] = await Promise.all([
      this.rowsSince(this.taskMirrors, accountId, sinceBuffer),
      this.rowsSince(this.projectMirrors, accountId, sinceBuffer),
    ]);

    const newest = maxRowVersion(lastRowVersion(taskRows), lastRowVersion(projectRows));

    const cadence = clientId
      ? this.presence.beat(accountId, clientId, { kind: 'web', focused, at: now })
      : this.presence.cadence(accountId, now);

    return {
      cursor: rowVersionToCursor(newest ?? sinceBuffer ?? ZERO_ROWVERSION),
      cadence,
      deltas: {
        tasks: taskRows.map((row) => row.data),
        projects: projectRows.map((row) => row.data),
        deletedTaskIds: [],
        deletedProjectIds: [],
      },
    };
  }

  private rowsSince<T extends { rowVersion: Buffer }>(
    repository: Repository<T>,
    accountId: string,
    since: Buffer | null,
  ): Promise<T[]> {
    const qb = repository
      .createQueryBuilder('mirror')
      .where('mirror.accountId = :accountId', { accountId })
      .orderBy('mirror.rowVersion', 'ASC');
    if (since) qb.andWhere('mirror.rowVersion > :since', { since });
    return qb.getMany();
  }

  private async currentRowVersion(accountId: string): Promise<Buffer> {
    const [latestTask, latestProject] = await Promise.all([
      this.taskMirrors
        .createQueryBuilder('mirror')
        .where('mirror.accountId = :accountId', { accountId })
        .orderBy('mirror.rowVersion', 'DESC')
        .limit(1)
        .getOne(),
      this.projectMirrors
        .createQueryBuilder('mirror')
        .where('mirror.accountId = :accountId', { accountId })
        .orderBy('mirror.rowVersion', 'DESC')
        .limit(1)
        .getOne(),
    ]);
    return (
      maxRowVersion(latestTask?.rowVersion ?? null, latestProject?.rowVersion ?? null) ??
      ZERO_ROWVERSION
    );
  }
}

function lastRowVersion(rows: readonly { rowVersion: Buffer }[]): Buffer | null {
  return rows.length > 0 ? rows[rows.length - 1]!.rowVersion : null;
}
