import { describe, expect, it } from 'vitest';
import { cardProjectColor, type BoardColorSource } from './projectColor';
import { PERSONAL_PROJECT_ID, type Project, type Task } from './model';

const filingProject = (
  over: Partial<Pick<Project, 'id' | 'color'>>,
): Pick<Project, 'id' | 'color'> => ({
  id: 'p1',
  color: '#111111',
  ...over,
});

const task = (
  over: Partial<Pick<Task, 'projectId' | 'projectTagId'>> = {},
): Pick<Task, 'projectId' | 'projectTagId'> => ({
  projectId: PERSONAL_PROJECT_ID,
  ...over,
});

const boards = (
  scope: string,
  entries: [string, { id: string; color: string }][] = [],
): BoardColorSource => ({
  scope,
  boardsById: new Map(entries),
});

describe('cardProjectColor', () => {
  it("wins with the filed project's colour over the board's", () => {
    const billing = filingProject({ id: 'p-billing', color: '#abc123' });
    const t = task({ projectId: 'p-web', projectTagId: 'p-billing' });
    const src = boards('all', [['p-web', { id: 'p-web', color: '#000000' }]]);
    expect(cardProjectColor(t, [billing], src)).toBe('#abc123');
  });

  it('finds a repo-less filing project’s colour', () => {
    // A ticket-only/personal-space project has no repo — exactly what `agentProjectsOf`
    // would have filtered out before this shared resolver existed.
    const ticketOnly = filingProject({ id: 'p-tickets', color: '#ff00ff' });
    const t = task({ projectTagId: 'p-tickets' });
    expect(cardProjectColor(t, [ticketOnly], boards('all'))).toBe('#ff00ff');
  });

  it('draws no stripe at all on a single-board scope with no filing', () => {
    const t = task({ projectId: 'p-web' });
    const src = boards('p-web', [['p-web', { id: 'p-web', color: '#000000' }]]);
    expect(cardProjectColor(t, [], src)).toBeUndefined();
  });

  it("on All, an unfiled card takes its own board project's colour", () => {
    const t = task({ projectId: 'p-web' });
    const src = boards('all', [['p-web', { id: 'p-web', color: '#0000ff' }]]);
    expect(cardProjectColor(t, [], src)).toBe('#0000ff');
  });

  it('never lends the Personal board’s colour', () => {
    const t = task({ projectId: PERSONAL_PROJECT_ID });
    const src = boards('all', [
      [PERSONAL_PROJECT_ID, { id: PERSONAL_PROJECT_ID, color: '#123456' }],
    ]);
    expect(cardProjectColor(t, [], src)).toBeUndefined();
  });

  it('falls through to the board when the projectTagId names no project in the list', () => {
    const t = task({ projectId: 'p-web', projectTagId: 'p-deleted' });
    const src = boards('all', [['p-web', { id: 'p-web', color: '#0000ff' }]]);
    expect(cardProjectColor(t, [], src)).toBe('#0000ff');
  });

  it('falls through when the filing project has no colour of its own', () => {
    const billing = filingProject({ id: 'p-billing', color: '' });
    const t = task({ projectId: 'p-web', projectTagId: 'p-billing' });
    const src = boards('all', [['p-web', { id: 'p-web', color: '#0000ff' }]]);
    expect(cardProjectColor(t, [billing], src)).toBe('#0000ff');
  });

  it('answers undefined when the board itself has no colour', () => {
    const t = task({ projectId: 'p-web' });
    const src = boards('all', [['p-web', { id: 'p-web', color: '' }]]);
    expect(cardProjectColor(t, [], src)).toBeUndefined();
  });
});
