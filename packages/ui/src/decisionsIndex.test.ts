import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { decisionProjectId, groupDecisions } from './decisionsIndex';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'personal',
    phase: '',
    title: `Card ${overrides.id}`,
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

const NAMES: Record<string, string> = { billing: 'Billing', app: 'App', personal: 'Personal' };
const nameOf = (id: string): string => NAMES[id] ?? id;

describe('decisionProjectId', () => {
  it('prefers the filing, then the delegation, then the board', () => {
    expect(
      decisionProjectId(task({ id: '1', projectTagId: 'billing', agentProjectId: 'app' })),
    ).toBe('billing');
    expect(decisionProjectId(task({ id: '2', agentProjectId: 'app' }))).toBe('app');
    expect(decisionProjectId(task({ id: '3' }))).toBe('personal');
  });
});

describe('groupDecisions', () => {
  it('is empty when no card has an open decision', () => {
    expect(
      groupDecisions([task({ id: '1' }), task({ id: '2', decisionQuestion: null })], nameOf),
    ).toEqual([]);
  });

  it('groups by project, sorted by name, with decisions oldest first', () => {
    const groups = groupDecisions(
      [
        task({ id: 'b2', projectTagId: 'billing', decisionQuestion: 'Q b2', decisionAskedAt: 300 }),
        task({ id: 'a1', projectTagId: 'app', decisionQuestion: 'Q a1', decisionAskedAt: 500 }),
        task({ id: 'b1', projectTagId: 'billing', decisionQuestion: 'Q b1', decisionAskedAt: 100 }),
        task({ id: 'x', projectTagId: 'billing' }),
      ],
      nameOf,
    );
    expect(groups.map((g) => g.projectName)).toEqual(['App', 'Billing']);
    expect(groups[1]?.decisions.map((d) => d.taskId)).toEqual(['b1', 'b2']);
    expect(groups[1]?.decisions[0]).toEqual({
      taskId: 'b1',
      title: 'Card b1',
      question: 'Q b1',
      askedAt: 100,
    });
  });

  it('sorts an untimed decision after every timed one', () => {
    const [group] = groupDecisions(
      [
        task({ id: 'n', decisionQuestion: 'untimed' }),
        task({ id: 't', decisionQuestion: 'timed', decisionAskedAt: 900 }),
      ],
      nameOf,
    );
    expect(group?.decisions.map((d) => d.taskId)).toEqual(['t', 'n']);
    expect(group?.decisions[1]?.askedAt).toBeNull();
  });

  it('leaves an archived card out', () => {
    expect(
      groupDecisions([task({ id: '1', decisionQuestion: 'Q', archivedAt: 1 })], nameOf),
    ).toEqual([]);
  });
});
