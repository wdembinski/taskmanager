import { describe, expect, it } from 'vitest';
import { normalizeIssueTypes, normalizeProjects } from './createMeta';

describe('normalizeProjects', () => {
  it('reads the Cloud paged shape and the Server flat array alike', () => {
    const paged = { values: [{ key: 'ENG', name: 'Engineering' }] };
    const flat = [{ key: 'ENG', name: 'Engineering' }];
    expect(normalizeProjects(paged)).toEqual([{ key: 'ENG', name: 'Engineering' }]);
    expect(normalizeProjects(flat)).toEqual(normalizeProjects(paged));
  });

  it('sorts by name and de-duplicates by key', () => {
    const raw = [
      { key: 'OPS', name: 'Operations' },
      { key: 'ENG', name: 'Engineering' },
      { key: 'ENG', name: 'Engineering (duplicate scheme)' },
    ];
    expect(normalizeProjects(raw).map((p) => p.key)).toEqual(['ENG', 'OPS']);
  });

  it('falls back to the key when a project has no name', () => {
    expect(normalizeProjects([{ key: 'ENG' }])).toEqual([{ key: 'ENG', name: 'ENG' }]);
  });

  it('returns nothing for garbage rather than throwing', () => {
    for (const value of [null, undefined, 42, 'nope', {}, [{}], [null]]) {
      expect(normalizeProjects(value)).toEqual([]);
    }
  });
});

describe('normalizeIssueTypes', () => {
  const bug = { id: '1', name: 'Bug', iconUrl: 'https://j/bug.png' };
  const sub = { id: '2', name: 'Sub-task', subtask: true };

  it('reads the Cloud `values` shape', () => {
    expect(normalizeIssueTypes({ values: [bug] })).toEqual([
      { id: '1', name: 'Bug', iconUrl: 'https://j/bug.png' },
    ]);
  });

  it('reads the legacy nested createmeta shape', () => {
    const raw = { projects: [{ key: 'ENG', issuetypes: [bug] }] };
    expect(normalizeIssueTypes(raw)).toMatchObject([{ id: '1', name: 'Bug' }]);
  });

  it('keeps only the asked-for project when the nested shape carries several', () => {
    const raw = {
      projects: [
        { key: 'ENG', issuetypes: [bug] },
        { key: 'OPS', issuetypes: [{ id: '9', name: 'Incident' }] },
      ],
    };
    expect(normalizeIssueTypes(raw, 'OPS').map((t) => t.name)).toEqual(['Incident']);
    expect(normalizeIssueTypes(raw, 'ENG').map((t) => t.name)).toEqual(['Bug']);
    // With no key, everything the instance returned is offered.
    expect(normalizeIssueTypes(raw)).toHaveLength(2);
  });

  it('never offers a subtask type — it would need a parent we cannot ask for', () => {
    expect(normalizeIssueTypes({ values: [bug, sub] }).map((t) => t.id)).toEqual(['1']);
    expect(
      normalizeIssueTypes({ values: [{ id: '3', name: 'Subtask', hierarchyLevel: -1 }] }),
    ).toEqual([]);
  });

  it('drops entries missing an id or a name, and de-duplicates', () => {
    const raw = { values: [bug, bug, { id: '4' }, { name: 'Nameless id' }] };
    expect(normalizeIssueTypes(raw).map((t) => t.id)).toEqual(['1']);
  });

  it('returns nothing for garbage rather than throwing', () => {
    for (const value of [null, undefined, 42, 'nope', {}, { projects: [] }]) {
      expect(normalizeIssueTypes(value)).toEqual([]);
    }
  });
});
