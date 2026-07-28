import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { currentSprintName } from './currentSprint';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  ...over,
});

describe('currentSprintName', () => {
  it('names the sprint when every JIRA card is in it', () => {
    const tasks = [
      task({ id: 'a', externalSprint: 'Sprint 12' }),
      task({ id: 'b', externalSprint: 'Sprint 12' }),
    ];
    expect(currentSprintName(tasks)).toBe('Sprint 12');
  });

  it('says nothing when the cards disagree — the bar must not pick one', () => {
    const tasks = [
      task({ id: 'a', externalSprint: 'Sprint 12' }),
      task({ id: 'b', externalSprint: 'Sprint 13' }),
    ];
    expect(currentSprintName(tasks)).toBeNull();
  });

  it('says nothing when a JIRA card has no sprint at all', () => {
    const tasks = [task({ id: 'a', externalSprint: 'Sprint 12' }), task({ id: 'b' })];
    expect(currentSprintName(tasks)).toBeNull();
  });

  it('ignores ad-hoc cards, which never have a sprint and never will', () => {
    const tasks = [
      task({ id: 'a', externalSprint: 'Sprint 12' }),
      task({ id: 'note', source: 'adhoc', externalSource: null }),
    ];
    expect(currentSprintName(tasks)).toBe('Sprint 12');
  });

  it('is null for an empty board and for a board of only ad-hoc cards', () => {
    expect(currentSprintName([])).toBeNull();
    expect(currentSprintName([task({ source: 'adhoc', externalSource: null })])).toBeNull();
  });

  it('treats a blank or whitespace sprint as no sprint', () => {
    expect(currentSprintName([task({ externalSprint: '   ' })])).toBeNull();
  });

  it('trims, so the same sprint spelled with stray spaces still agrees', () => {
    const tasks = [
      task({ id: 'a', externalSprint: 'Sprint 12' }),
      task({ id: 'b', externalSprint: ' Sprint 12 ' }),
    ];
    expect(currentSprintName(tasks)).toBe('Sprint 12');
  });
});
