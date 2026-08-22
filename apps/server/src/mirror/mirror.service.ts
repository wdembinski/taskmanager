import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Repository } from 'typeorm';
import type {
  BoardResponse,
  ClientPresence,
  CommandRequest,
  CommandResult,
  CreateTaskRequest,
  ResultsResponse,
  SyncRequest,
  SyncResponse,
  UpdateTaskRequest,
} from '@tm/protocol/wire';
import { PROTOCOL_VERSION } from '@tm/protocol/wire';
import { columnForStatus, restingStatus } from '@tm/shared/board';
import { isManualStatus } from '@tm/shared/model';
import type { Task } from '@tm/shared/model';
import { resolveMove } from '@tm/shared/moveResolve';
import { buildAdhocTask } from '@tm/shared/taskBuilders';
import { Client } from '../entities/client.entity';
import { Command } from '../entities/command.entity';
import { CommandResultRow } from '../entities/commandResult.entity';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';
import { Tombstone } from '../entities/tombstone.entity';
import { EventBus } from '../events/eventBus';
import { PresenceService } from '../presence/presence.service';
import { applyMirrorDelta } from './applyMirrorDelta';
import { boardCursor } from './boardCursor';
import { clientInfoColumns, describeClients } from './clientInfo';
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
    @InjectRepository(Client) private readonly clients: Repository<Client>,
    @InjectRepository(TaskMirror) private readonly taskMirrors: Repository<TaskMirror>,
    @InjectRepository(ProjectMirror) private readonly projectMirrors: Repository<ProjectMirror>,
    @InjectRepository(Tombstone) private readonly tombstones: Repository<Tombstone>,
    @InjectRepository(CommandResultRow) private readonly results: Repository<CommandResultRow>,
    private readonly presence: PresenceService,
    private readonly events: EventBus,
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
   * round trip, and the resulting cadence rides back on this same response. So does
   * `eventListeners`, for the same reason: a desktop must not push a running agent's transcript
   * into the cloud for nobody, and asking "is anyone watching?" on its own route would be the
   * second request per tick this whole wire exists to avoid.
   *
   * `SyncRequest.info` rides that same registration write — see `clientInfo.ts` for why only
   * the fields a request actually carried are written, and `client.entity.ts` for why identity
   * is allowed on a row that deliberately refuses to store presence.
   */
  async sync(accountId: string, request: SyncRequest): Promise<SyncResponse> {
    const now = Date.now();
    const commands = await this.dataSource.transaction(async (manager) => {
      await manager.upsert(
        Client,
        { id: request.clientId, accountId, ...clientInfoColumns(request) },
        ['id'],
      );

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
      eventListeners: this.events.listeners(accountId, now),
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
   * `POST /v1/tasks` — an ad-hoc task, written straight into `task_mirrors` rather than
   * relayed to a desktop Client. See `CreateTaskRequest` on the wire for why this route
   * exists at all: a relayed `task:create` does nothing for an account no desktop Client is
   * currently polling for, and this is the server making the identical row itself.
   *
   * `projectId` and (if given) `projectTagId` are checked against `project_mirrors` for THIS
   * account — the same check `ipc.ts`'s `task:create` handler makes against its local store
   * before filing a card under an agent project, just re-pointed at the mirror because a
   * caller-supplied id here could as easily name another account's project as a typo.
   * `order` is computed the same way the desktop's own `nextOrder` query does: one past the
   * highest `order` any mirrored task in that project already has, or 0 for the first.
   */
  async createTask(accountId: string, request: CreateTaskRequest): Promise<Task> {
    const title = request.title.trim();
    if (!title) throw new BadRequestException('A task needs a title.');

    await this.assertProject(accountId, request.projectId);
    if (request.projectTagId) {
      await this.assertProject(accountId, request.projectTagId, { agentOnly: true });
    }

    const order = await this.nextTaskOrder(accountId, request.projectId);
    const task = buildAdhocTask(request.projectId, order, title, request);

    await this.dataSource.transaction((manager) =>
      applyMirrorDelta(manager, accountId, {
        tasks: [task],
        projects: [],
        deletedTaskIds: [],
        deletedProjectIds: [],
      }),
    );

    return task;
  }

  /**
   * `PATCH /v1/tasks/:id` — edit, move or hand-set the status of a mirrored task directly,
   * the write-endpoint sibling of `createTask` above. See `UpdateTaskRequest` on the wire for
   * why every field is optional and independent.
   *
   * `toColumn` is read before `status`, matching the precedence `ipc.ts` splits into two
   * handlers (`task:move` for the drag, `task:setStatus` for the dropdown): a request naming
   * both is answering the same "where does this card go" question twice, and the drag is the
   * more literal of the two. Either path goes through `resolveMove` (`@tm/shared/moveResolve`,
   * pure and lifted out of the desktop's own `jiraMove.ts` for exactly this) to decide the new
   * local status and, for a drop into Blocked, the column to restore later.
   *
   * There is no forge write-back here, unlike the desktop's `task:move`/`task:setStatus`: an
   * ad-hoc task made through this route family never carries a linked JIRA/GitHub issue (see
   * `createTask`), so `resolveMove`'s `jiraTransition` is always null for it and there is
   * nothing for `writeMoveToForge` to do. A task that DOES carry a link (mirrored down from a
   * desktop Client that has since gone offline) still gets its local status moved — the
   * tracker write simply waits for a Client to relay it, the same gap `POST /v1/commands`
   * already lives with.
   */
  async updateTask(accountId: string, taskId: string, request: UpdateTaskRequest): Promise<Task> {
    const existing = await this.ownedTask(accountId, taskId);

    if (request.projectTagId) {
      await this.assertProject(accountId, request.projectTagId, { agentOnly: true });
    }

    let next: Task = { ...existing };
    if (request.title !== undefined) {
      const title = request.title.trim();
      if (!title) throw new BadRequestException('A task needs a title.');
      next.title = title;
    }
    if (request.phase !== undefined) next.phase = request.phase.trim();
    if (request.type !== undefined) next.type = request.type;
    if (request.description !== undefined) {
      next.externalDescription = request.description?.trim() || null;
    }
    if (request.projectTagId !== undefined) next.projectTagId = request.projectTagId;

    if (request.toColumn !== undefined) {
      const move = resolveMove(next, request.toColumn);
      if (!move.noop) {
        next = { ...next, status: move.localStatus, preBlockStatus: move.preBlockStatus };
      }
    } else if (request.status !== undefined) {
      if (!isManualStatus(request.status)) {
        throw new BadRequestException(`"${request.status}" is not a hand-settable status.`);
      }
      if (restingStatus(next) !== request.status) {
        const move = resolveMove(next, columnForStatus(request.status));
        next = { ...next, status: request.status, preBlockStatus: move.preBlockStatus };
      }
    }

    await this.dataSource.transaction((manager) =>
      applyMirrorDelta(manager, accountId, {
        tasks: [next],
        projects: [],
        deletedTaskIds: [],
        deletedProjectIds: [],
      }),
    );

    return next;
  }

  /**
   * `DELETE /v1/tasks/:id` — drop a mirrored task, and every step mirrored under it, straight
   * from `task_mirrors`. The same cascade `store.ts`'s `deleteTaskDeep` does locally: an
   * orphaned step has no board column of its own and would be unreachable everywhere else.
   *
   * Idempotent: an id that names nothing (already deleted, or never this account's) is a
   * silent no-op, matching `ipc.ts`'s own `task:delete`, which returns rather than throws for
   * the same case. A live run DOES still refuse — a status a desktop's scheduler is holding
   * must not be deleted out from under it — the same guard `task:delete` applies before its
   * own `deleteTask`.
   */
  async deleteTask(accountId: string, taskId: string): Promise<void> {
    const row = await this.taskMirrors.findOne({ where: { id: taskId, accountId } });
    if (!row) return;
    const existing = row.data;

    // Steps mirror the same way a card does — their own `task_mirrors` row, scoped by
    // `parentTaskId` inside `data` rather than a column, so this reads the project the same
    // way `nextTaskOrder` does and filters in JS.
    const projectRows = await this.taskMirrors.find({
      where: { accountId, projectId: existing.projectId },
      select: { data: true },
    });
    const steps = projectRows.map((r) => r.data).filter((task) => task.parentTaskId === taskId);

    for (const task of [existing, ...steps]) {
      if (task.status === 'running' || task.status === 'waiting-input') {
        throw new BadRequestException('Stop the task before deleting it.');
      }
    }

    await this.dataSource.transaction((manager) =>
      applyMirrorDelta(manager, accountId, {
        tasks: [],
        projects: [],
        deletedTaskIds: [existing.id, ...steps.map((s) => s.id)],
        deletedProjectIds: [],
      }),
    );
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

    // NOT the maximum across the three streams. Each is paged on its own, so the highest
    // rowversion any of them reached is a promise the others cannot keep — see
    // `boardCursor.ts` for the hundred cards that used to fall through that gap.
    const cursor = boardCursor(
      [tasks, projects, deletions].map((page) => ({
        last: lastRowVersion(page.rows),
        hasMore: page.hasMore,
      })),
      sinceBuffer,
    );

    const cadence = clientId
      ? this.presence.beat(accountId, clientId, { kind: 'web', focused, at: now })
      : this.presence.cadence(accountId, now);

    const clients = await this.namedClients(accountId, now);

    return {
      cursor: rowVersionToCursor(cursor),
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
      clients,
    };
  }

  /**
   * The live desktop Clients, each carrying whatever it last told us it was.
   *
   * Presence decides WHO is in the list (in-memory, swept on read); the `clients` table only
   * decides what each one is CALLED. So this is a lookup by primary key over the handful of
   * ids presence just returned, not a scan — and it is skipped entirely when nobody is
   * polling, which is the case a board read hits on every idle account.
   */
  private async namedClients(accountId: string, now: number): Promise<ClientPresence[]> {
    const live = this.presence.clients(accountId, now);
    if (live.length === 0) return live;

    const rows = await this.clients.find({
      where: { accountId, id: In(live.map((client) => client.id)) },
      select: {
        id: true,
        name: true,
        platform: true,
        appVersion: true,
        protocolVersion: true,
      },
    });
    return describeClients(live, rows);
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

  /**
   * `Unknown project.` for both an id that names nothing and one that names another
   * account's row — same as `readAttachmentBlob`'s reasoning: distinguishing the two would
   * confirm the id exists, which a caller with no claim to it should never get for free.
   */
  private async assertProject(
    accountId: string,
    projectId: string,
    opts?: { agentOnly?: boolean },
  ): Promise<void> {
    const project = await this.projectMirrors.findOne({
      where: { id: projectId, accountId },
      select: { id: true, data: true },
    });
    if (!project || (opts?.agentOnly && project.data.kind !== 'agent')) {
      throw new BadRequestException('Unknown project.');
    }
  }

  /** `Task not found.` for both a missing id and another account's row — see `assertProject`. */
  private async ownedTask(accountId: string, taskId: string): Promise<Task> {
    const row = await this.taskMirrors.findOne({ where: { id: taskId, accountId } });
    if (!row) throw new NotFoundException('Task not found.');
    return row.data;
  }

  /** One past the highest `order` any mirrored task in this project already has. */
  private async nextTaskOrder(accountId: string, projectId: string): Promise<number> {
    const rows = await this.taskMirrors.find({
      where: { accountId, projectId },
      select: { data: true },
    });
    return rows.reduce((max, row) => Math.max(max, row.data.order), -1) + 1;
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
