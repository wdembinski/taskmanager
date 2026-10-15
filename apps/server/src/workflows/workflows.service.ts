import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { WorkflowDoc } from '@tm/shared/workflow';
import {
  validateWorkflow,
  workflowDocBytes,
  workflowTooLargeMessage,
  WORKFLOW_DOC_MAX,
} from '@tm/shared/workflow';
import { WorkflowMirror } from '../entities/workflowMirror.entity';
import type { WorkflowsResponse } from '@tm/protocol/wire';

/**
 * Server-side writes for the workflow mirror (F8.12) — `WorkflowMirror`'s own docstring
 * has the "why composite key, why the tombstone lives here" story, mirroring `SkillsService`
 * (F7.11). Every write is a full-row `upsert`, which is what makes `put` clearing a prior
 * `deletedAt` and `remove` recording one both come for free: there is no partial-column
 * update path for either to miss.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(WorkflowMirror) private readonly workflows: Repository<WorkflowMirror>,
  ) {}

  async list(accountId: string): Promise<WorkflowsResponse> {
    const rows = await this.workflows.find({ where: { accountId } });
    const workflows: WorkflowDoc[] = [];
    const deletedWorkflowIds: string[] = [];
    for (const row of rows) {
      if (row.deletedAt !== null || row.data === null) {
        deletedWorkflowIds.push(row.id);
      } else {
        workflows.push(row.data);
      }
    }
    return { workflows, deletedWorkflowIds };
  }

  /**
   * Upserts `body` as workflow `id`. 400 unless it is a well-formed {@link WorkflowDoc}
   * (per {@link validateWorkflow}) whose own `id` matches the path; 413 when its whole-doc
   * byte count is over {@link WORKFLOW_DOC_MAX}. The upsert always writes `deletedAt:
   * null`, so a `PUT` of a previously deleted id revives it — same rule `SkillsService.put`
   * applies.
   */
  async put(accountId: string, id: string, body: unknown): Promise<WorkflowDoc> {
    const result = validateWorkflow(body);
    if (!result.ok) {
      throw new BadRequestException(result.issues.join(' '));
    }
    const doc = result.doc;
    if (doc.id !== id) {
      throw new BadRequestException(`Request body must be a workflow whose id is ${id}.`);
    }

    const bytes = workflowDocBytes(doc);
    if (bytes > WORKFLOW_DOC_MAX) {
      throw new PayloadTooLargeException(workflowTooLargeMessage(bytes));
    }

    const row: WorkflowMirror = {
      accountId,
      id,
      data: doc,
      deletedAt: null,
      updatedAt: String(Date.now()),
    };
    await this.dataSource.manager.upsert(WorkflowMirror, row, ['accountId', 'id']);
    return doc;
  }

  /**
   * Tombstones workflow `id`: `deletedAt` set, `data` nulled to free the body. Idempotent,
   * and also writes a tombstone for an id this account never mirrored at all — same
   * reasoning as `SkillsService.remove`.
   */
  async remove(accountId: string, id: string): Promise<void> {
    const now = String(Date.now());
    const row: WorkflowMirror = { accountId, id, data: null, deletedAt: now, updatedAt: now };
    await this.dataSource.manager.upsert(WorkflowMirror, row, ['accountId', 'id']);
  }
}
