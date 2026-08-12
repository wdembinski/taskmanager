import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import type {
  BoardResponse,
  CommandRequest,
  CommandResult,
  ResultsResponse,
  SyncRequest,
  SyncResponse,
} from '@tm/protocol/wire';
import { PROTOCOL_VERSION } from '@tm/protocol/wire';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { PresenceService } from '../presence/presence.service';
import { applyMirrorDelta } from './applyMirrorDelta';
import { acknowledgeable, leaseCutoff } from './commandQueue';
import { toCommandEnvelope } from './commandMapping';
import {
  cursorToRowVersion,
  maxRowVersion,
  rowVersionToCursor,
  ZERO_ROWVERSION,
} from './rowVersion';

/**
 * Backs the four mirror routes (MirrorController): POST /v1/sync,
 * POST /v1/commands, GET /v1/board and GET /v1/results. See
 * docs/plan/README.md Phase 25 for the wire contract's shape and why
 * /v1/sync returns commands rather than task/project deltas (a desktop Client
 * already has its own local mirror; a web session, read by /v1/board, does
 * not), and Phase 26 for the relay this grew into.
 */

/**
 * How many mirror rows one `GET /v1/board` may return, per entity type.
 *
 * The push side has been bounded since `SYNC_BYTES_LIMIT` and `OUTBOX_LIMIT`; the read side
 * was not — no `take`, no byte cap — so a first poll against a mature board asked for every
 * row that account had ever mirrored, in one response, and the browser waited for all of it.
 * The page is generous, because the common case is a delta of nothing; `hasMore` is what
 * makes a big first read finish, in several bounded trips instead of one unbounded one.
 */
export const BOARD_PAGE_LIMIT = 500;

/**
 * And a byte cap on top of the row cap, because rows are not the same size: `Task.data` is
 * the whole domain object, and a card with a long description is orders of magnitude bigger
 * than an empty one. Matches `SYNC_BYTES_LIMIT`'s order on the push side.
 */
export const BOARD_BYTES_LIMIT = 1_000_000;

@Injectable()
export class MirrorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(TaskMirror) private readonly taskMirrors: Repository<TaskMirror>,
    @InjectRepository(ProjectMirror) private readonly projectMirrors: Repository<ProjectMirror>,
    @InjectRepository(Tombstone) private readonly tombstones: Repository<Tombstone>,
    @InjectRepository(CommandResultRow) private readonly results: Repository<CommandResultRow>,
    private readonly presence: PresenceService,
  ) {}

  /**
   * One transaction: register the caller's Client id if this is its first beat, apply its
   * outgoing deltas, retire the commands it acked, persist the results it carried, then
   * collect and lease whatever is still owed to it. Applying and delivering in the same
   * transaction means a Client's push is never acknowledged without its own changes having
   * actually landed, and vice versa.
   *
   * The queue read is `deliverable`, not `deliveredAt IS NULL` — see commandQueue.ts for why
   * that distinction is the difference between the at-least-once this contract promises and
   * the at-most-once it used to give.
   *
   * `request.focused` doubles as this Client's presence beat — recording it costs no extra
   * round trip, and the resulting cadence rides back on this same response.
   */
  async sync(accountId: string, request: SyncRequest): Promise<SyncResponse> {
    const now = Date.now();
    const commands = await this.dataSource.transaction(async (manager) => {
      await manager.upsert(Client, { id: request.clientId, accountId }, ['id']);

      await applyMirrorDelta(manager, accountId, request.deltas);

      // Results first: a result names a command this Client is about to ack, and storing it
      // after the ack would leave a window where the row is retired and its answer is not
      // yet readable — a browser polling in that window would see neither.
      await this.storeResults(manager, accountId, request.results ?? []);

      // Retire what the Client says it applied, filtered against rows it actually owns —
      // `ackedCommandIds` is caller-supplied. Scoped to THIS Client's rows for the same
      // reason.
      const owned = await manager.find(Command, {
        where: { accountId, targetClientId: request.clientId, ackedAt: IsNull() },
        select: { id: true, deliveredAt: true, ackedAt: true },
      });
      const toAck = acknowledgeable(owned, request.ackedCommandIds ?? []);
      if (toAck.length > 0) {
        await manager.update(Command, toAck, { ackedAt: new Date(now) });
      }

      const queued = await manager.find(Command, {
        where: [
          // Never delivered.
          { accountId, targetClientId: request.clientId, ackedAt: IsNull(), deliveredAt: IsNull() },
          // Delivered, never acked, and its lease has run out.
          {
            accountId,
            targetClientId: request.clientId,
            ackedAt: IsNull(),
            deliveredAt: LessThan(leaseCutoff(now)),
          },
        ],
        order: { createdAt: 'ASC' },
      });
      if (queued.length > 0) {
        // Re-lease, so a redelivery that is also lost waits a full lease before the next one
        // rather than going out on every tick.
        await manager.update(
          Command,
          queued.map((c) => c.id),
          { deliveredAt: new Date(now) },
        );
      }
      return queued;
    });

    const cadence = this.presence.beat(accountId, request.clientId, {
      kind: 'client',
      focused: request.focused,
      at: now,
    });

    return {
      cursor: rowVersionToCursor(await this.currentRowVersion(accountId)),
      cadence,
      commands: commands.map(toCommandEnvelope),
    };
  }

  /**
   * Enqueues one command for delivery on the target Client's next sync.
   *
   * Idempotent: the primary key is caller-supplied (`CommandEnvelope.id`), so a browser that
   * retried a `POST /v1/commands` whose response it never saw used to get a 500 on the
   * duplicate-key violation — for a command the server had accepted perfectly well. Since
   * the id is the caller's own and the payload with it, the second arrival is the same
   * command; the right answer is the 202 it asked for.
   */
  async enqueueCommand(accountId: string, request: CommandRequest): Promise<void> {
    const existing = await this.dataSource.manager.findOne(Command, {
      where: { id: request.command.id },
      select: { id: true },
    });
    if (existing) return;

    await this.dataSource.manager.insert(Command, {
      id: request.command.id,
      accountId,
      targetClientId: request.targetClientId,
      issuedAt: String(request.command.issuedAt),
      issuedBy: request.command.issuedBy,
      kind: request.command.kind,
      payload: request.command.payload,
      deliveredAt: null,
      ackedAt: null,
    });
  }

  /**
   * The web app's read path: every task/project whose `rowVersion` is past `since`, in
   * rowVersion order, plus the ids deleted since then.
   *
   * The deletions used to be hardcoded empty, which meant a card deleted on the desktop sat
   * on an open web tab until somebody reloaded — `cloudBoardStore.applyBoardResponse` has
   * always handled `deletedTaskIds` correctly and simply never received any. `Tombstone` is
   * where they come from now.
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

    const [tasks, projects, deletions] = await Promise.all([
      this.rowsSince(this.taskMirrors, accountId, sinceBuffer),
      this.rowsSince(this.projectMirrors, accountId, sinceBuffer),
      this.rowsSince(this.tombstones, accountId, sinceBuffer),
    ]);

    const newest = maxRowVersion(
      maxRowVersion(lastRowVersion(tasks.rows), lastRowVersion(projects.rows)),
      lastRowVersion(deletions.rows),
    );

    const cadence = clientId
      ? this.presence.beat(accountId, clientId, { kind: 'web', focused, at: now })
      : this.presence.cadence(accountId, now);

    return {
      cursor: rowVersionToCursor(newest ?? sinceBuffer ?? ZERO_ROWVERSION),
      cadence,
      protocolVersion: PROTOCOL_VERSION,
      hasMore: tasks.hasMore || projects.hasMore || deletions.hasMore,
      deltas: {
        tasks: tasks.rows.map((row) => row.data),
        projects: projects.rows.map((row) => row.data),
        deletedTaskIds: deletions.rows.filter((r) => r.entity === 'task').map((r) => r.entityId),
        deletedProjectIds: deletions.rows
          .filter((r) => r.entity === 'project')
          .map((r) => r.entityId),
      },
      clients: this.presence.clients(accountId, now),
    };
  }

  /**
   * What the desktop answered, for the commands THIS caller issued.
   *
   * Scoped to `accountId` **and** `issuedBy`, which is the part that matters: a board is
   * account-wide, but a result belongs to the one browser tab holding an unresolved promise
   * for it. Without the second scope, a second tab would resolve promises it never made —
   * and, worse, drain the first tab's results past its own cursor.
   */
  async resultsSince(
    accountId: string,
    issuedBy: string,
    since: string | undefined,
  ): Promise<ResultsResponse> {
    const sinceBuffer = since ? cursorToRowVersion(since) : null;
    const qb = this.results
      .createQueryBuilder('result')
      .where('result.accountId = :accountId', { accountId })
      .andWhere('result.issuedBy = :issuedBy', { issuedBy })
      .orderBy('result.rowVersion', 'ASC')
      .take(BOARD_PAGE_LIMIT);
    if (sinceBuffer) qb.andWhere('result.rowVersion > :since', { since: sinceBuffer });
    const rows = await qb.getMany();

    return {
      results: rows.map(toCommandResult),
      cursor: rowVersionToCursor(lastRowVersion(rows) ?? sinceBuffer ?? ZERO_ROWVERSION),
    };
  }

  /**
   * Persist the results riding along on a sync. `upsert` rather than `insert`: a redelivered
   * command answers a second time (from the applying Client's replay ledger, so with the
   * same answer), and that must not 500 the whole sync.
   */
  private async storeResults(
    manager: DataSource['manager'],
    accountId: string,
    results: readonly CommandResult[],
  ): Promise<void> {
    if (results.length === 0) return;
    // `issuedBy` lives on the command, and the result is read back by it — so it is copied
    // across here rather than joined for on every read. A result for a command this account
    // never queued is dropped: nothing is awaiting it, and inventing a scope for it would be
    // inventing a reader.
    const commands = await manager.find(Command, {
      where: results.map((r) => ({ id: r.commandId, accountId })),
      select: { id: true, issuedBy: true },
    });
    const issuers = new Map(commands.map((c) => [c.id, c.issuedBy]));

    const rows = results
      .filter((r) => issuers.has(r.commandId))
      .map((r) => ({
        commandId: r.commandId,
        accountId,
        issuedBy: issuers.get(r.commandId)!,
        ok: r.ok,
        value: r.value === undefined ? null : JSON.stringify(r.value),
        error: r.error ?? null,
      }));
    if (rows.length > 0) await manager.upsert(CommandResultRow, rows, ['commandId']);
  }

  /**
   * One page of mirror rows past `since`, plus whether the cap cut it short.
   *
   * Reads one row more than the page so "there is more" is a fact rather than the guess
   * `rows.length === limit` would be, then applies the byte cap on top — always keeping at
   * least one row, the same "a single oversized entity still goes" rule `cloudDelta.ts` uses
   * on the push side, because dropping it would block everything behind it forever.
   */
  private async rowsSince<T extends { rowVersion: Buffer }>(
    repository: Repository<T>,
    accountId: string,
    since: Buffer | null,
  ): Promise<{ rows: T[]; hasMore: boolean }> {
    const qb = repository
      .createQueryBuilder('mirror')
      .where('mirror.accountId = :accountId', { accountId })
      .orderBy('mirror.rowVersion', 'ASC')
      .take(BOARD_PAGE_LIMIT + 1);
    if (since) qb.andWhere('mirror.rowVersion > :since', { since });
    const read = await qb.getMany();

    let hasMore = read.length > BOARD_PAGE_LIMIT;
    const page = hasMore ? read.slice(0, BOARD_PAGE_LIMIT) : read;

    let bytes = 0;
    const rows: T[] = [];
    for (const row of page) {
      bytes += approximateBytes(row);
      if (rows.length > 0 && bytes > BOARD_BYTES_LIMIT) {
        hasMore = true;
        break;
      }
      rows.push(row);
    }
    return { rows, hasMore };
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

/** A row's serialized `data`, or a small constant for a row that has none (a tombstone). */
function approximateBytes(row: unknown): number {
  const data = (row as { data?: unknown }).data;
  if (data === undefined) return 128;
  return JSON.stringify(data).length;
}

function toCommandResult(row: CommandResultRow): CommandResult {
  const result: CommandResult = { commandId: row.commandId, ok: row.ok };
  if (row.value !== null) result.value = JSON.parse(row.value) as unknown;
  if (row.error !== null) result.error = row.error;
  return result;
}
