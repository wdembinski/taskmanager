import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type {
  AddProjectInput,
  ManualStatus,
  Project,
  ProjectPatch,
  Task,
  TicketInput,
  TicketPatch,
} from '@tm/shared/model';
import { isManualStatus } from '@tm/shared/model';
import { DEFAULT_SETTINGS } from '@tm/shared/settings';
import { formatTicketKey, normalizeTicketPrefix } from '@tm/shared/ticketKey';
import { isIssueType, normalizeLabels } from '@tm/shared/tickets';
import { ProjectMirror } from '../entities/projectMirror.entity';
import { TaskMirror } from '../entities/taskMirror.entity';

/**
 * What updating a native ticket sends beyond {@link TicketPatch} — the fields a caller sets
 * at creation time ({@link TicketInput}) that are just as reasonable to edit afterwards, and
 * belong to no other surface. `ticketKey`/`ticketNumber` stay absent for the same reason
 * `TicketPatch` itself omits them: a key is a permanent name, and only a project's own
 * prefix rename (`TicketsService.updateProject`) may ever rewrite one.
 */
export type TicketUpdateRequest = TicketPatch & {
  title?: string;
  phase?: string;
  status?: ManualStatus;
  description?: string | null;
  priority?: string | null;
};

/**
 * The server's own authoritative writes for `Project`/`Task` rows — as opposed to
 * `MirrorService`, which only ever relays a desktop Client's OWN deltas back to itself.
 * `TicketsController` is the cloud's first door into the mirror it does not merely echo: a
 * project or a ticket created here exists nowhere else until a desktop pulls it down (the
 * next step of "cloud as central control for projects").
 *
 * Scoped to `kind: 'ticket'` projects for now — a `plan`/`agent` project is a directory on
 * some machine, and there is no machine on the other end of an HTTP request to put one on.
 * Ids are minted with `randomUUID()`, exactly like the desktop store, so no separate
 * id-allocation scheme is needed once a desktop pulls a cloud-authored row down.
 *
 * Every write goes through `manager.upsert(..., ['id'])`, exactly like `applyMirrorDelta` —
 * an insert or an update either way bumps `rowVersion` (the DB-maintained SQL Server
 * ROWVERSION column), so `GET /v1/board?since=` picks a row written here up unchanged, with
 * no second code path to keep in sync.
 */
@Injectable()
export class TicketsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ProjectMirror) private readonly projectMirrors: Repository<ProjectMirror>,
    @InjectRepository(TaskMirror) private readonly taskMirrors: Repository<TaskMirror>,
  ) {}

  async listProjects(accountId: string): Promise<Project[]> {
    const rows = await this.projectMirrors.find({ where: { accountId } });
    return rows.map((row) => row.data);
  }

  /**
   * Mirrors `store.ts`'s `addProject` for the one kind this API originates: no repo, no
   * plan file, no worktrees — those three are forced regardless of what the caller sent,
   * the same way the desktop forces them for a ticket-kind project.
   */
  async createProject(accountId: string, input: AddProjectInput): Promise<Project> {
    if (input.kind !== undefined && input.kind !== 'ticket') {
      throw new BadRequestException('Only kind: "ticket" projects can be created via this API.');
    }
    const ticketPrefix = normalizeTicketPrefix(input.ticketPrefix ?? '') ?? '';

    const project: Project = {
      id: randomUUID(),
      name: input.name?.trim() || ticketPrefix,
      path: '',
      planPath: '',
      defaultModel: input.defaultModel ?? DEFAULT_SETTINGS.defaultModel,
      planningModel:
        input.planningModel !== undefined
          ? input.planningModel
          : (DEFAULT_SETTINGS.defaultPlanningModel ?? null),
      defaultPermissionMode: input.defaultPermissionMode ?? DEFAULT_SETTINGS.defaultPermissionMode,
      concurrency: Math.max(1, Math.round(input.concurrency ?? DEFAULT_SETTINGS.concurrency)),
      useWorktrees: false,
      baseBranch: '',
      writeBackPlan: false,
      autoRelease: input.autoRelease ?? false,
      autoIntegrate: input.autoIntegrate ?? null,
      planAligned: input.planAligned ?? true,
      kind: 'ticket',
      jiraEpicKeys: [],
      ticketPrefix,
      target: DEFAULT_SETTINGS.defaultExecTarget,
      instructions: input.instructions?.trim() ?? '',
      color: input.color?.trim() ?? '',
      createdAt: Date.now(),
    };

    await this.dataSource.manager.upsert(
      ProjectMirror,
      { id: project.id, accountId, data: project },
      ['id'],
    );
    return project;
  }

  /**
   * A prefix rename re-keys every ticket the project has already issued, in the same
   * transaction — the same invariant `store.ts`'s `updateProject` enforces, and for the
   * same reason: `ticketKey` is denormalised onto every `TaskMirror` row, and leaving it
   * stale would show a prefix the project no longer has.
   *
   * Clearing the prefix is refused once a key has been issued (nothing can un-name a
   * ticket that already has a permanent one); every other field is a plain overwrite.
   */
  async updateProject(accountId: string, id: string, patch: ProjectPatch): Promise<Project> {
    return this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(ProjectMirror, { where: { id, accountId } });
      if (!row) throw new NotFoundException(`No project ${id} on this account.`);
      const project = row.data;
      const next: Project = { ...project };

      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.color !== undefined) next.color = patch.color.trim();
      if (patch.instructions !== undefined) next.instructions = patch.instructions.trim();
      if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel;
      if (patch.planningModel !== undefined) next.planningModel = patch.planningModel;
      if (patch.defaultPermissionMode !== undefined) {
        next.defaultPermissionMode = patch.defaultPermissionMode;
      }
      if (patch.concurrency !== undefined) {
        next.concurrency = Math.max(1, Math.round(patch.concurrency));
      }
      if (patch.autoRelease !== undefined) next.autoRelease = patch.autoRelease;
      if (patch.autoIntegrate !== undefined) next.autoIntegrate = patch.autoIntegrate;
      if (patch.planAligned !== undefined) next.planAligned = patch.planAligned;

      let rekeyPrefix: string | null = null;
      if (patch.ticketPrefix !== undefined && project.kind === 'ticket') {
        const wanted = normalizeTicketPrefix(patch.ticketPrefix);
        const issued = row.ticketSeq > 0;
        if (wanted !== null || !issued) {
          next.ticketPrefix = wanted ?? '';
          if (wanted !== null && wanted !== (project.ticketPrefix || null)) rekeyPrefix = wanted;
        }
      }

      await manager.upsert(ProjectMirror, { id, accountId, data: next }, ['id']);

      if (rekeyPrefix) {
        const tickets = await manager.find(TaskMirror, { where: { accountId, projectId: id } });
        const toRekey = tickets.filter((t) => t.data.ticketNumber != null);
        if (toRekey.length > 0) {
          await manager.upsert(
            TaskMirror,
            toRekey.map((t) => ({
              id: t.id,
              accountId,
              projectId: id,
              data: { ...t.data, ticketKey: formatTicketKey(rekeyPrefix!, t.data.ticketNumber!) },
            })),
            ['id'],
          );
        }
      }

      return next;
    });
  }

  async listTasks(accountId: string, projectId: string): Promise<Task[]> {
    const rows = await this.taskMirrors.find({ where: { accountId, projectId } });
    return rows.map((row) => row.data);
  }

  /**
   * Allocate a key and insert a ticket, atomically — the server's counterpart to
   * `store.ts`'s `createTicketTx`. The bump and the insert are one transaction so a
   * refused create never burns a number, and the number comes from the project's own
   * `ticketSeq` counter, never from `MAX(ticketNumber)`: deleting a ticket must not make
   * the next one reissue its key.
   */
  async createTicket(accountId: string, projectId: string, input: TicketInput): Promise<Task> {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('title is required.');
    if (input.issueType != null && !isIssueType(input.issueType)) {
      throw new BadRequestException(`Not a usable issue type: ${String(input.issueType)}`);
    }

    return this.dataSource.transaction(async (manager) => {
      const projectRow = await manager.findOne(ProjectMirror, {
        where: { id: projectId, accountId },
      });
      if (!projectRow) throw new NotFoundException(`No project ${projectId} on this account.`);
      const project = projectRow.data;
      if (project.kind !== 'ticket') {
        throw new BadRequestException(`Project ${projectId} is not a ticket project.`);
      }
      const prefix = normalizeTicketPrefix(project.ticketPrefix);
      if (!prefix) {
        throw new BadRequestException(`Project ${projectId} has no ticket prefix to issue from.`);
      }

      await manager.increment(ProjectMirror, { id: projectId, accountId }, 'ticketSeq', 1);
      const bumped = await manager.findOne(ProjectMirror, { where: { id: projectId, accountId } });
      const ticketNumber = bumped!.ticketSeq;

      const siblings = await manager.find(TaskMirror, { where: { accountId, projectId } });
      const order = siblings.reduce((max, row) => Math.max(max, row.data.order), -1) + 1;

      const task: Task = {
        id: randomUUID(),
        projectId,
        phase: input.phase?.trim() ?? '',
        title,
        status: 'pending',
        sessionId: null,
        order,
        source: 'ticket',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
        externalDescription: input.description?.trim() || null,
        externalPriority: input.priority?.trim() || null,
        ticketKey: formatTicketKey(prefix, ticketNumber),
        ticketNumber,
        issueType: input.issueType ?? 'task',
        epicTaskId: input.epicTaskId ?? null,
        milestoneId: input.milestoneId ?? null,
        labels: normalizeLabels(input.labels),
        storyPoints: input.storyPoints ?? null,
        estimateDays: input.estimateDays ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        assigneeId: input.assigneeId ?? null,
        reporterId: input.reporterId ?? null,
      };

      await manager.upsert(TaskMirror, { id: task.id, accountId, projectId, data: task }, ['id']);
      return task;
    });
  }

  async updateTask(accountId: string, id: string, patch: TicketUpdateRequest): Promise<Task> {
    if (patch.status !== undefined && !isManualStatus(patch.status)) {
      throw new BadRequestException(
        `Not a status a human may set by hand: ${String(patch.status)}`,
      );
    }
    if (patch.issueType != null && !isIssueType(patch.issueType)) {
      throw new BadRequestException(`Not a usable issue type: ${String(patch.issueType)}`);
    }

    return this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(TaskMirror, { where: { id, accountId } });
      if (!row) throw new NotFoundException(`No task ${id} on this account.`);
      const next: Task = { ...row.data };

      if (patch.title !== undefined) next.title = patch.title.trim();
      if (patch.phase !== undefined) next.phase = patch.phase.trim();
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.description !== undefined) {
        next.externalDescription = patch.description?.trim() || null;
      }
      if (patch.priority !== undefined) next.externalPriority = patch.priority?.trim() || null;
      if (patch.issueType !== undefined) next.issueType = patch.issueType;
      if (patch.epicTaskId !== undefined) next.epicTaskId = patch.epicTaskId;
      if (patch.milestoneId !== undefined) next.milestoneId = patch.milestoneId;
      if (patch.labels !== undefined) next.labels = normalizeLabels(patch.labels);
      if (patch.storyPoints !== undefined) next.storyPoints = patch.storyPoints;
      if (patch.estimateDays !== undefined) next.estimateDays = patch.estimateDays;
      if (patch.startAt !== undefined) next.startAt = patch.startAt;
      if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
      if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
      if (patch.reporterId !== undefined) next.reporterId = patch.reporterId;

      await manager.upsert(TaskMirror, { id, accountId, projectId: row.projectId, data: next }, [
        'id',
      ]);
      return next;
    });
  }
}
