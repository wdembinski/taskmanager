import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import type { AgentStep, WorkflowDoc } from '@tm/shared/workflow';
import { WORKFLOW_DOC_MAX, workflowDocBytes } from '@tm/shared/workflow';
import { WorkflowMirror } from '../entities/workflowMirror.entity';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/** The same hand-rolled `DataSource`/`Repository` stand-in `skills.controller.test.ts` uses. */
class FakeMirrorDb {
  workflows = new Map<string, WorkflowMirror>();

  private key(row: { accountId: string; id: string }): string {
    return `${row.accountId}:${row.id}`;
  }

  private matches(where: Record<string, unknown>) {
    return (row: unknown): boolean =>
      Object.entries(where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      );
  }

  manager = {
    upsert: async (
      _entity: unknown,
      rows: Record<string, unknown> | Record<string, unknown>[],
      _conflict: string[],
    ) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        this.workflows.set(this.key(row as { accountId: string; id: string }), row as never);
      }
    },
  };

  dataSource = { manager: this.manager } as unknown as DataSource;

  repo(): Repository<WorkflowMirror> {
    return {
      find: async (opts: { where: Record<string, unknown> }) =>
        [...this.workflows.values()].filter(this.matches(opts.where)),
      findOne: async (opts: { where: Record<string, unknown> }) =>
        [...this.workflows.values()].find(this.matches(opts.where)) ?? null,
    } as unknown as Repository<WorkflowMirror>;
  }
}

function buildController(): { controller: WorkflowsController; db: FakeMirrorDb } {
  const db = new FakeMirrorDb();
  const service = new WorkflowsService(db.dataSource, db.repo());
  return { controller: new WorkflowsController(service), db };
}

function makeAgentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: 'a1',
    kind: 'agent',
    title: 'Implement the feature',
    brief: 'Add the thing the ticket asks for.',
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    version: 1,
    id: 'workflow-1',
    name: 'Implement + test',
    steps: [makeAgentStep()],
    ...overrides,
  };
}

describe('WorkflowsController', () => {
  let controller: WorkflowsController;
  let db: FakeMirrorDb;

  beforeEach(() => {
    ({ controller, db } = buildController());
  });

  it('is guarded like every other /v1/* route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WorkflowsController)).toBeDefined();
  });

  it('round trips a workflow through PUT then GET', async () => {
    const workflow = makeWorkflow();
    const put = await controller.put('acct-1', workflow.id, workflow);
    expect(put).toEqual(workflow);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ workflows: [workflow], deletedWorkflowIds: [] });
  });

  it('accepts a doc of exactly WORKFLOW_DOC_MAX bytes', async () => {
    const base = makeWorkflow({ name: '' });
    const baseBytes = workflowDocBytes(base);
    const workflow = makeWorkflow({ name: 'x'.repeat(WORKFLOW_DOC_MAX - baseBytes) });
    expect(workflowDocBytes(workflow)).toBe(WORKFLOW_DOC_MAX);

    await expect(controller.put('acct-1', workflow.id, workflow)).resolves.toEqual(workflow);
  });

  it('refuses a doc one byte over WORKFLOW_DOC_MAX with the shared sentence', async () => {
    const base = makeWorkflow({ name: '' });
    const baseBytes = workflowDocBytes(base);
    const workflow = makeWorkflow({ name: 'x'.repeat(WORKFLOW_DOC_MAX - baseBytes + 1) });
    expect(workflowDocBytes(workflow)).toBe(WORKFLOW_DOC_MAX + 1);

    await expect(controller.put('acct-1', workflow.id, workflow)).rejects.toThrow(
      PayloadTooLargeException,
    );
    await expect(controller.put('acct-1', workflow.id, workflow)).rejects.toThrow(
      'too large to sync (65 KiB > 64 KiB)',
    );
  });

  it('refuses a body whose id does not match the path', async () => {
    const workflow = makeWorkflow({ id: 'workflow-1' });
    await expect(controller.put('acct-1', 'workflow-2', workflow)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an invalid doc', async () => {
    await expect(
      controller.put('acct-1', 'workflow-1', { id: 'workflow-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes a workflow: it drops out of workflows and lists in deletedWorkflowIds', async () => {
    const workflow = makeWorkflow();
    await controller.put('acct-1', workflow.id, workflow);

    await controller.remove('acct-1', workflow.id);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ workflows: [], deletedWorkflowIds: [workflow.id] });
  });

  it('records a tombstone for an id it never saw a PUT for', async () => {
    await controller.remove('acct-1', 'never-seen');

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ workflows: [], deletedWorkflowIds: ['never-seen'] });
  });

  it('is idempotent to delete twice', async () => {
    const workflow = makeWorkflow();
    await controller.put('acct-1', workflow.id, workflow);
    await controller.remove('acct-1', workflow.id);
    await expect(controller.remove('acct-1', workflow.id)).resolves.toBeUndefined();

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ workflows: [], deletedWorkflowIds: [workflow.id] });
  });

  it('revives a deleted workflow on PUT', async () => {
    const workflow = makeWorkflow();
    await controller.put('acct-1', workflow.id, workflow);
    await controller.remove('acct-1', workflow.id);

    const revived = { ...workflow, name: 'New name' };
    await controller.put('acct-1', workflow.id, revived);

    const listed = await controller.list('acct-1');
    expect(listed).toEqual({ workflows: [revived], deletedWorkflowIds: [] });
  });

  it('keeps accounts isolated: account B cannot see or overwrite account A’s workflow', async () => {
    const workflow = makeWorkflow();
    await controller.put('acct-1', workflow.id, workflow);

    const listedByB = await controller.list('acct-2');
    expect(listedByB).toEqual({ workflows: [], deletedWorkflowIds: [] });

    const hijack = { ...workflow, name: 'Hijacked' };
    await controller.put('acct-2', workflow.id, hijack);

    const listedByA = await controller.list('acct-1');
    expect(listedByA.workflows).toEqual([workflow]);
    const listedByBAfter = await controller.list('acct-2');
    expect(listedByBAfter.workflows).toEqual([hijack]);
  });
});
