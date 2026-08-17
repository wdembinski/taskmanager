import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project } from './model';
import { boardScopes, resolveBoardScope, scopeLabel, type BoardScope } from './boardScope';

type ScopeInput = Pick<Project, 'id' | 'kind' | 'name' | 'ticketPrefix'>;

const project = (over: Partial<ScopeInput>): ScopeInput => ({
  id: 'p1',
  kind: 'ticket',
  name: 'Platform',
  ticketPrefix: 'PLAT',
  ...over,
});

describe('boardScopes', () => {
  it('puts Personal first even when no project row for it was passed', () => {
    const scopes = boardScopes([project({})]);
    expect(scopes[0]).toEqual({
      projectId: PERSONAL_PROJECT_ID,
      name: 'Personal',
      ticketPrefix: '',
    });
  });

  it('is just Personal when there are no ticket projects', () => {
    expect(boardScopes([])).toEqual([
      { projectId: PERSONAL_PROJECT_ID, name: 'Personal', ticketPrefix: '' },
    ]);
  });

  it('excludes agent and plan projects', () => {
    const scopes = boardScopes([
      project({ id: 'a', kind: 'agent', name: 'Repo' }),
      project({ id: 'p', kind: 'plan', name: 'Legacy' }),
    ]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].projectId).toBe(PERSONAL_PROJECT_ID);
  });

  it('includes a ticket project with no prefix yet', () => {
    const scopes = boardScopes([project({ id: 't1', ticketPrefix: '' })]);
    expect(scopes).toContainEqual({ projectId: 't1', name: 'Platform', ticketPrefix: '' });
  });

  it('does not double Personal if its own row is among the projects passed', () => {
    const scopes = boardScopes([
      project({ id: PERSONAL_PROJECT_ID, kind: 'plan', name: 'Personal', ticketPrefix: '' }),
      project({ id: 't1' }),
    ]);
    expect(scopes.filter((s) => s.projectId === PERSONAL_PROJECT_ID)).toHaveLength(1);
    expect(scopes).toHaveLength(2);
  });
});

describe('resolveBoardScope', () => {
  const personal: BoardScope = {
    projectId: PERSONAL_PROJECT_ID,
    name: 'Personal',
    ticketPrefix: '',
  };
  const platform: BoardScope = { projectId: 't1', name: 'Platform', ticketPrefix: 'PLAT' };
  const scopes = [personal, platform];

  it('finds the scope the id names', () => {
    expect(resolveBoardScope(scopes, 't1')).toEqual(platform);
  });

  it('falls back to Personal (first) for a null id', () => {
    expect(resolveBoardScope(scopes, null)).toEqual(personal);
  });

  it('falls back to Personal for an undefined id', () => {
    expect(resolveBoardScope(scopes, undefined)).toEqual(personal);
  });

  // The project a saved scope named was removed since — the id is now dangling.
  it('falls back to Personal for an id no longer among the scopes', () => {
    expect(resolveBoardScope(scopes, 'deleted-project')).toEqual(personal);
  });

  it('still answers Personal even when handed an empty scope list', () => {
    expect(resolveBoardScope([], 't1')).toEqual(personal);
  });
});

describe('scopeLabel', () => {
  it('is the bare name for Personal', () => {
    expect(scopeLabel({ projectId: PERSONAL_PROJECT_ID, name: 'Personal', ticketPrefix: '' })).toBe(
      'Personal',
    );
  });

  it('is the bare name for a ticket project with no prefix yet', () => {
    expect(scopeLabel({ projectId: 't1', name: 'Platform', ticketPrefix: '' })).toBe('Platform');
  });

  it('appends the ticket prefix in parentheses when the project has one', () => {
    expect(scopeLabel({ projectId: 't1', name: 'Platform', ticketPrefix: 'PLAT' })).toBe(
      'Platform (PLAT)',
    );
  });
});
