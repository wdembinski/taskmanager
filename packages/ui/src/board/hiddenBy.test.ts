import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { type BoardViewState, hiddenBy, hiddenByMessage } from './hiddenBy';

const card = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p',
  phase: '',
  title: id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...overrides,
});

/** A state where every filter is wide open — nothing is hidden. */
const VISIBLE_STATE: BoardViewState = {
  loadedIds: new Set(['t1']),
  scopeName: 'Personal',
  focusIds: null,
  currentSprintOnly: false,
  currentSprint: null,
  hiddenColumns: [],
};

describe('hiddenBy', () => {
  it('returns null for a card nothing hides', () => {
    const t = card('t1');
    expect(hiddenBy(t, null, VISIBLE_STATE)).toBeNull();
  });

  it('names archived first, however many other filters would also apply', () => {
    const t = card('t1', { archivedAt: 123 });
    expect(hiddenBy(t, null, VISIBLE_STATE)).toEqual({ kind: 'archived' });
  });

  it('names the scope when the card is not in loadedIds', () => {
    const t = card('other');
    const state = { ...VISIBLE_STATE, loadedIds: new Set(['t1']) };
    expect(hiddenBy(t, null, state)).toEqual({ kind: 'scope', boardName: 'Personal' });
  });

  describe('current sprint', () => {
    const state: BoardViewState = {
      ...VISIBLE_STATE,
      currentSprintOnly: true,
      currentSprint: 'Sprint 7',
    };

    it('names current-sprint for a JIRA card in a different sprint', () => {
      const t = card('t1', { externalSource: 'jira', externalSprint: 'Sprint 6' });
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'current-sprint', sprint: 'Sprint 7' });
    });

    it('names current-sprint for a JIRA card with no sprint at all', () => {
      const t = card('t1', { externalSource: 'jira', externalSprint: null });
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'current-sprint', sprint: 'Sprint 7' });
    });

    it('is not hidden for a JIRA card in the current sprint', () => {
      const t = card('t1', { externalSource: 'jira', externalSprint: 'Sprint 7' });
      expect(hiddenBy(t, null, state)).toBeNull();
    });

    it('never hides a native card, sprint or not', () => {
      const t = card('t1');
      expect(hiddenBy(t, null, state)).toBeNull();
    });

    it('never hides an ad-hoc card', () => {
      const t = card('t1', { externalSource: null });
      expect(hiddenBy(t, null, state)).toBeNull();
    });
  });

  describe('focus', () => {
    it('names focus when the anchor is outside focusIds', () => {
      const t = card('t1');
      const state = { ...VISIBLE_STATE, focusIds: new Set(['other']) };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'focus' });
    });

    it('is not hidden when the anchor is inside focusIds', () => {
      const t = card('t1');
      const state = { ...VISIBLE_STATE, focusIds: new Set(['t1']) };
      expect(hiddenBy(t, null, state)).toBeNull();
    });
  });

  describe('column', () => {
    it('names column when the card sits in a folded column', () => {
      const t = card('t1', { status: 'done' });
      const state = { ...VISIBLE_STATE, hiddenColumns: ['done' as const] };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'column', column: 'done' });
    });

    it('is not hidden when the card sits in an open column', () => {
      const t = card('t1', { status: 'done' });
      const state = { ...VISIBLE_STATE, hiddenColumns: ['todo' as const] };
      expect(hiddenBy(t, null, state)).toBeNull();
    });
  });

  describe('a step', () => {
    it('is judged by its parent column, not its own', () => {
      const parent = card('p1', { status: 'done' });
      const step = card('s1', { parentTaskId: 'p1', status: 'pending' });
      const state = {
        ...VISIBLE_STATE,
        loadedIds: new Set(['p1', 's1']),
        hiddenColumns: ['done' as const],
      };
      expect(hiddenBy(step, parent, state)).toEqual({ kind: 'column', column: 'done' });
    });

    it('is judged by its parent for focus, not its own id', () => {
      const parent = card('p1');
      const step = card('s1', { parentTaskId: 'p1' });
      const state = {
        ...VISIBLE_STATE,
        loadedIds: new Set(['p1', 's1']),
        focusIds: new Set(['p1']),
      };
      expect(hiddenBy(step, parent, state)).toBeNull();
    });

    it('an orphaned step with no resolved parent anchors to itself', () => {
      const step = card('s1', { parentTaskId: 'missing' });
      const state = { ...VISIBLE_STATE, loadedIds: new Set(['s1']), focusIds: new Set(['s1']) };
      expect(hiddenBy(step, null, state)).toBeNull();
    });
  });

  describe('precedence', () => {
    it('archived outranks scope', () => {
      const t = card('other', { archivedAt: 1 });
      const state = { ...VISIBLE_STATE, loadedIds: new Set(['t1']) };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'archived' });
    });

    it('current sprint outranks focus', () => {
      const t = card('t1', { externalSource: 'jira', externalSprint: 'Sprint 6' });
      const state: BoardViewState = {
        ...VISIBLE_STATE,
        currentSprintOnly: true,
        currentSprint: 'Sprint 7',
        focusIds: new Set(['other']),
      };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'current-sprint', sprint: 'Sprint 7' });
    });

    it('scope outranks focus and column', () => {
      const t = card('other', { status: 'done' });
      const state: BoardViewState = {
        ...VISIBLE_STATE,
        loadedIds: new Set(['t1']),
        focusIds: new Set(['other']),
        hiddenColumns: ['todo' as const],
      };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'scope', boardName: 'Personal' });
    });

    it('focus outranks column', () => {
      const t = card('t1', { status: 'done' });
      const state = {
        ...VISIBLE_STATE,
        focusIds: new Set(['other']),
        hiddenColumns: ['done' as const],
      };
      expect(hiddenBy(t, null, state)).toEqual({ kind: 'focus' });
    });
  });
});

describe('hiddenByMessage', () => {
  const t = card('t1', { externalKey: 'TM-42' });
  const native = card('t1', { ticketKey: 'TM-7' });
  const plain = card('t1', { title: 'Write the docs' });

  it('archived', () => {
    expect(hiddenByMessage(t, { kind: 'archived' })).toEqual({
      text: 'TM-42 is archived',
      action: 'Restore',
    });
  });

  it('current-sprint, with a named sprint', () => {
    expect(hiddenByMessage(t, { kind: 'current-sprint', sprint: 'Sprint 7' })).toEqual({
      text: 'TM-42 is not in Sprint 7',
      action: 'Turn off Current sprint',
    });
  });

  it('current-sprint, with no clear current sprint', () => {
    expect(hiddenByMessage(t, { kind: 'current-sprint', sprint: null })).toEqual({
      text: 'TM-42 is not in the current sprint',
      action: 'Turn off Current sprint',
    });
  });

  it('scope', () => {
    expect(hiddenByMessage(t, { kind: 'scope', boardName: 'Billing' })).toEqual({
      text: 'TM-42 is on Billing',
      action: 'Switch to Billing',
    });
  });

  it('focus', () => {
    expect(hiddenByMessage(t, { kind: 'focus' })).toEqual({
      text: 'TM-42 is outside this chain',
      action: 'Turn off Chain focus',
    });
  });

  it('column', () => {
    expect(hiddenByMessage(t, { kind: 'column', column: 'done' })).toEqual({
      text: 'TM-42 is in DONE',
      action: 'Show DONE',
    });
  });

  it('prefers externalKey, then the native ticketKey, then the title', () => {
    expect(hiddenByMessage(native, { kind: 'archived' }).text).toBe('TM-7 is archived');
    expect(hiddenByMessage(plain, { kind: 'archived' }).text).toBe('Write the docs is archived');
  });
});
