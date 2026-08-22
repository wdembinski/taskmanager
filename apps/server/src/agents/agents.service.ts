import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type {
  AddAgentProfileInput,
  AgentProfile as AgentProfileModel,
  AgentProfilePatch,
  Assignment as AssignmentModel,
  AssignmentStatus,
  ClaimAssignmentInput,
  CreateAssignmentInput,
  ReportAssignmentInput,
} from '@tm/shared/agent';
import { MODELS } from '@tm/shared/model';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import { AgentProfile } from '../entities/agentProfile.entity';
import { Assignment } from '../entities/assignment.entity';
import { TaskMirror } from '../entities/taskMirror.entity';

const MODEL_SET = new Set<string>(MODELS);
const PERMISSION_MODE_SET = new Set<string>(Object.keys(PERMISSION_MODE_LABELS));

function toProfile(row: AgentProfile): AgentProfileModel {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    permissionMode: row.permissionMode,
    defaultProjectId: row.defaultProjectId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toAssignment(row: Assignment): AssignmentModel {
  return {
    id: row.id,
    projectId: row.projectId,
    ticketId: row.ticketId,
    profileId: row.profileId,
    status: row.status,
    claimedByClientId: row.claimedByClientId,
    claimedAt: row.claimedAt?.getTime() ?? null,
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
    runId: row.runId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Agent profiles and the assignment queue's server-side writes — `@tm/shared/agent`'s
 * own docstring has the "why a queue, not `Task.agentProjectId`" story.
 *
 * Every write goes through `manager.upsert(..., ['id'])`, the same convention
 * `TicketsService` uses; the claim/report transitions additionally run inside
 * `dataSource.transaction(...)` because they read-then-write a status guard
 * (queued-only for a claim, claimant-only for a report) that a bare upsert can't
 * express atomically.
 */
@Injectable()
export class AgentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AgentProfile) private readonly profiles: Repository<AgentProfile>,
    @InjectRepository(Assignment) private readonly assignments: Repository<Assignment>,
    @InjectRepository(TaskMirror) private readonly taskMirrors: Repository<TaskMirror>,
  ) {}

  async listProfiles(accountId: string): Promise<AgentProfileModel[]> {
    const rows = await this.profiles.find({ where: { accountId } });
    return rows.map(toProfile);
  }

  async createProfile(accountId: string, input: AddAgentProfileInput): Promise<AgentProfileModel> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name is required.');
    if (!MODEL_SET.has(input.model)) {
      throw new BadRequestException(`Not a usable model: ${String(input.model)}`);
    }
    if (!PERMISSION_MODE_SET.has(input.permissionMode)) {
      throw new BadRequestException(
        `Not a usable permission mode: ${String(input.permissionMode)}`,
      );
    }

    const now = new Date();
    const row: AgentProfile = {
      id: randomUUID(),
      accountId,
      name,
      model: input.model,
      permissionMode: input.permissionMode,
      defaultProjectId: input.defaultProjectId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.dataSource.manager.upsert(AgentProfile, row, ['id']);
    return toProfile(row);
  }

  async updateProfile(
    accountId: string,
    id: string,
    patch: AgentProfilePatch,
  ): Promise<AgentProfileModel> {
    const row = await this.profiles.findOne({ where: { id, accountId } });
    if (!row) throw new NotFoundException(`No agent profile ${id} on this account.`);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('name is required.');
      row.name = name;
    }
    if (patch.model !== undefined) {
      if (!MODEL_SET.has(patch.model)) {
        throw new BadRequestException(`Not a usable model: ${String(patch.model)}`);
      }
      row.model = patch.model;
    }
    if (patch.permissionMode !== undefined) {
      if (!PERMISSION_MODE_SET.has(patch.permissionMode)) {
        throw new BadRequestException(
          `Not a usable permission mode: ${String(patch.permissionMode)}`,
        );
      }
      row.permissionMode = patch.permissionMode;
    }
    if (patch.defaultProjectId !== undefined) row.defaultProjectId = patch.defaultProjectId;
    row.updatedAt = new Date();

    await this.dataSource.manager.upsert(AgentProfile, row, ['id']);
    return toProfile(row);
  }

  async listAssignments(
    accountId: string,
    filter: { status?: AssignmentStatus; projectId?: string },
  ): Promise<AssignmentModel[]> {
    const where: Record<string, unknown> = { accountId };
    if (filter.status) where.status = filter.status;
    if (filter.projectId) where.projectId = filter.projectId;
    const rows = await this.assignments.find({ where });
    return rows.map(toAssignment);
  }

  /**
   * Queues one ticket against one profile. Refuses a mismatched `projectId`/`ticketId`
   * pair up front — the desktop poller trusts `Assignment.projectId` to decide whether
   * an assignment is one of "its" projects without a second lookup, so a wrong pairing
   * here would silently misroute which desktop ever sees it.
   */
  async createAssignment(
    accountId: string,
    input: CreateAssignmentInput,
  ): Promise<AssignmentModel> {
    const ticket = await this.taskMirrors.findOne({
      where: { id: input.ticketId, accountId },
    });
    if (!ticket) throw new NotFoundException(`No ticket ${input.ticketId} on this account.`);
    if (ticket.projectId !== input.projectId) {
      throw new BadRequestException(
        `Ticket ${input.ticketId} belongs to project ${ticket.projectId}, not ${input.projectId}.`,
      );
    }
    const profile = await this.profiles.findOne({ where: { id: input.profileId, accountId } });
    if (!profile)
      throw new NotFoundException(`No agent profile ${input.profileId} on this account.`);

    const now = new Date();
    const row: Assignment = {
      id: randomUUID(),
      accountId,
      projectId: input.projectId,
      ticketId: input.ticketId,
      profileId: input.profileId,
      status: 'queued',
      claimedByClientId: null,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      runId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.dataSource.manager.upsert(Assignment, row, ['id']);
    return toAssignment(row);
  }

  /**
   * The one race the queue has to guard against: two desktops serving the same project
   * both polling `queued` and both trying to run the same ticket. Reading and writing
   * `status` inside one transaction is what makes only the first caller see `queued`.
   */
  async claim(
    accountId: string,
    id: string,
    input: ClaimAssignmentInput,
  ): Promise<AssignmentModel> {
    const clientId = input.clientId?.trim();
    if (!clientId) throw new BadRequestException('clientId is required.');

    return this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(Assignment, { where: { id, accountId } });
      if (!row) throw new NotFoundException(`No assignment ${id} on this account.`);
      if (row.status !== 'queued') {
        throw new BadRequestException(`Assignment ${id} is already ${row.status}.`);
      }

      const now = new Date();
      row.status = 'claimed';
      row.claimedByClientId = clientId;
      row.claimedAt = now;
      row.updatedAt = now;
      await manager.upsert(Assignment, row, ['id']);
      return toAssignment(row);
    });
  }

  /**
   * What a claimer reports as it works its own claim: `running` once it actually
   * started a session, `done`/`failed` once that session finishes. Refuses a report
   * from anyone but the client that holds the claim, and a transition that skips or
   * reverses the state machine (`@tm/shared/agent`'s `AssignmentStatus` docstring).
   */
  async report(
    accountId: string,
    id: string,
    input: ReportAssignmentInput,
  ): Promise<AssignmentModel> {
    const clientId = input.clientId?.trim();
    if (!clientId) throw new BadRequestException('clientId is required.');

    return this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(Assignment, { where: { id, accountId } });
      if (!row) throw new NotFoundException(`No assignment ${id} on this account.`);
      if (row.claimedByClientId !== clientId) {
        throw new BadRequestException(`Assignment ${id} is not claimed by client ${clientId}.`);
      }

      const now = new Date();
      if (input.status === 'running') {
        if (row.status !== 'claimed') {
          throw new BadRequestException(`Cannot mark ${row.status} as running.`);
        }
        row.status = 'running';
        row.startedAt = now;
      } else {
        if (row.status !== 'claimed' && row.status !== 'running') {
          throw new BadRequestException(`Cannot finish an assignment that is ${row.status}.`);
        }
        row.status = input.status;
        row.completedAt = now;
      }
      if (input.runId !== undefined) row.runId = input.runId ?? null;
      row.updatedAt = now;

      await manager.upsert(Assignment, row, ['id']);
      return toAssignment(row);
    });
  }
}
