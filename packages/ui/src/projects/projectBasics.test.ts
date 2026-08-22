import { describe, expect, it } from 'vitest';
import type { Project } from '@tm/shared/model';
import { ticketModeOf, ticketPrefixError } from './projectBasics';

let seq = 0;
/** A minimal project fixture — only the fields this module reads are worth naming. */
function project(overrides: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: `p${seq}`,
    name: 'Untitled',
    path: '',
    planPath: '',
    defaultModel: 'sonnet',
    planningModel: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: true,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoIntegrate: null,
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: '',
    target: { kind: 'local' },
    instructions: '',
    color: '',
    createdAt: 0,
    ...overrides,
  };
}

describe('ticketModeOf', () => {
  it('reads a project with no prefix as personal', () => {
    expect(ticketModeOf(project({ ticketPrefix: '' }))).toBe('personal');
  });

  it('reads a project with a prefix as tickets', () => {
    expect(ticketModeOf(project({ ticketPrefix: 'TM' }))).toBe('tickets');
  });
});

describe('ticketPrefixError', () => {
  it('is always null in personal mode, even for an unusable prefix', () => {
    expect(ticketPrefixError({ mode: 'personal', prefix: '', projects: [] })).toBeNull();
    expect(ticketPrefixError({ mode: 'personal', prefix: '123', projects: [] })).toBeNull();
  });

  it('leaves an empty prefix in tickets mode for the store to derive one', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: '', projects: [] })).toBeNull();
    expect(ticketPrefixError({ mode: 'tickets', prefix: '   ', projects: [] })).toBeNull();
  });

  it('rejects a prefix with no letters', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: '123', projects: [] })).toBe(
      'Not a usable prefix — needs at least one letter, and cannot be just digits.',
    );
  });

  it('rejects a prefix already used by another project', () => {
    const other = project({ ticketPrefix: 'TM', name: 'Task Manager' });
    expect(ticketPrefixError({ mode: 'tickets', prefix: 'tm', projects: [other] })).toBe(
      'Already used by Task Manager.',
    );
  });

  it('does not collide with the project being edited', () => {
    const mine = project({ id: 'mine', ticketPrefix: 'TM' });
    expect(
      ticketPrefixError({
        mode: 'tickets',
        prefix: 'TM',
        projects: [mine],
        editingId: 'mine',
      }),
    ).toBeNull();
  });

  it('accepts a usable, unclaimed prefix', () => {
    expect(ticketPrefixError({ mode: 'tickets', prefix: 'TM', projects: [] })).toBeNull();
  });
});
