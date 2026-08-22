import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID } from './model';
import { buildAdhocTask, buildTicketTask } from './taskBuilders';

describe('buildAdhocTask', () => {
  it('builds a pending, ad-hoc task with the given order and defaults', () => {
    const task = buildAdhocTask(PERSONAL_PROJECT_ID, 3, 'Write docs', {});
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.projectId).toBe(PERSONAL_PROJECT_ID);
    expect(task.title).toBe('Write docs');
    expect(task.status).toBe('pending');
    expect(task.sessionId).toBeNull();
    expect(task.order).toBe(3);
    expect(task.source).toBe('adhoc');
    expect(task.dependsOn).toEqual([]);
    expect(task.isContract).toBe(false);
    expect(task.isScaffold).toBe(false);
    expect(task.phase).toBe('');
    expect(task.type).toBeNull();
    expect(task.externalDescription).toBeNull();
    expect(task.projectTagId).toBeNull();
  });

  it('trims the phase and description, and carries through type/projectTagId', () => {
    const task = buildAdhocTask(PERSONAL_PROJECT_ID, 0, 'Fix bug', {
      phase: '  Phase 1  ',
      type: 'bug',
      description: '  repro steps  ',
      projectTagId: 'tag-1',
    });
    expect(task.phase).toBe('Phase 1');
    expect(task.type).toBe('bug');
    expect(task.externalDescription).toBe('repro steps');
    expect(task.projectTagId).toBe('tag-1');
  });

  it('mints a fresh id every call', () => {
    const a = buildAdhocTask(PERSONAL_PROJECT_ID, 0, 'a', {});
    const b = buildAdhocTask(PERSONAL_PROJECT_ID, 0, 'b', {});
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildTicketTask', () => {
  it('builds a native ticket keyed under the given prefix and number', () => {
    const task = buildTicketTask(PERSONAL_PROJECT_ID, 5, 'TM', 42, 'Ship it', {
      title: 'Ship it',
    });
    expect(task.projectId).toBe(PERSONAL_PROJECT_ID);
    expect(task.order).toBe(5);
    expect(task.source).toBe('ticket');
    expect(task.ticketKey).toBe('TM-42');
    expect(task.ticketNumber).toBe(42);
    expect(task.issueType).toBe('task');
    expect(task.labels).toEqual([]);
    expect(task.epicTaskId).toBeNull();
    expect(task.milestoneId).toBeNull();
    expect(task.storyPoints).toBeNull();
    expect(task.estimateDays).toBeNull();
    expect(task.startAt).toBeNull();
    expect(task.dueAt).toBeNull();
    expect(task.assigneeId).toBeNull();
    expect(task.reporterId).toBeNull();
  });

  it('carries through issueType, labels (normalized) and the rest of the ticket fields', () => {
    const task = buildTicketTask(PERSONAL_PROJECT_ID, 0, 'TM', 1, 'Epic thing', {
      title: 'Epic thing',
      issueType: 'epic',
      labels: ['Backend', 'backend', '  Frontend  ', ''],
      priority: '  High  ',
      description: '  brief  ',
      epicTaskId: 'epic-1',
      milestoneId: 'ms-1',
      storyPoints: 3,
      estimateDays: 2,
      startAt: 100,
      dueAt: 200,
      assigneeId: 'person-1',
      reporterId: 'person-2',
      phase: '  Backlog  ',
    });
    expect(task.issueType).toBe('epic');
    expect(task.labels).toEqual(['Backend', 'Frontend']);
    expect(task.externalPriority).toBe('High');
    expect(task.externalDescription).toBe('brief');
    expect(task.epicTaskId).toBe('epic-1');
    expect(task.milestoneId).toBe('ms-1');
    expect(task.storyPoints).toBe(3);
    expect(task.estimateDays).toBe(2);
    expect(task.startAt).toBe(100);
    expect(task.dueAt).toBe(200);
    expect(task.assigneeId).toBe('person-1');
    expect(task.reporterId).toBe('person-2');
    expect(task.phase).toBe('Backlog');
  });
});
