import { describe, expect, it } from 'vitest';
import {
  INITIAL_ISSUE_VIEW,
  isKeyTargetEditable,
  issueBreadcrumb,
  issueViewReduce,
  peekEpic,
  type IssueViewState,
  type IssueViewTicket,
} from './issueView';

function selected(over: Partial<IssueViewState> = {}): IssueViewState {
  return {
    selectedId: 't1',
    layout: 'peek',
    label: 'TM-1',
    seen: true,
    notice: null,
    ...over,
  };
}

function ticket(over: Partial<IssueViewTicket> = {}): IssueViewTicket {
  return { id: 't1', ticketKey: 'TM-1', title: 'Fix the thing', ...over };
}

describe('issueViewReduce', () => {
  describe('space', () => {
    it('does nothing without a selection', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, { type: 'space' });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });

    it('does nothing in full', () => {
      const full = selected({ layout: 'full' });
      const state = issueViewReduce(full, { type: 'space' });
      expect(state).toEqual(full);
    });

    it('opens peek from closed', () => {
      const closed = selected({ layout: 'closed' });
      const state = issueViewReduce(closed, { type: 'space' });
      expect(state.layout).toBe('peek');
    });

    it('closes back from peek', () => {
      const peek = selected({ layout: 'peek' });
      const state = issueViewReduce(peek, { type: 'space' });
      expect(state.layout).toBe('closed');
    });
  });

  describe('enter', () => {
    it('does nothing without a selection', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, { type: 'enter' });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });

    it('goes full from peek', () => {
      const peek = selected({ layout: 'peek' });
      const state = issueViewReduce(peek, { type: 'enter' });
      expect(state.layout).toBe('full');
    });

    it('goes full from closed too', () => {
      const closed = selected({ layout: 'closed' });
      const state = issueViewReduce(closed, { type: 'enter' });
      expect(state.layout).toBe('full');
    });
  });

  describe('escape', () => {
    it('steps back one level per press: full -> peek -> closed -> no selection', () => {
      let state = selected({ layout: 'full' });

      state = issueViewReduce(state, { type: 'escape' });
      expect(state.layout).toBe('peek');
      expect(state.selectedId).toBe('t1');

      state = issueViewReduce(state, { type: 'escape' });
      expect(state.layout).toBe('closed');
      expect(state.selectedId).toBe('t1');

      state = issueViewReduce(state, { type: 'escape' });
      expect(state.layout).toBe('closed');
      expect(state.selectedId).toBeNull();
      expect(state.label).toBeNull();
      expect(state.seen).toBe(false);
    });

    it('does nothing when already closed with no selection', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, { type: 'escape' });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });
  });

  describe('select', () => {
    it('opens peek from closed', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, {
        type: 'select',
        id: 't1',
        label: 'TM-1',
      });
      expect(state.layout).toBe('peek');
      expect(state.selectedId).toBe('t1');
      expect(state.label).toBe('TM-1');
      expect(state.seen).toBe(false);
    });

    it('keeps full in full, so a sub-issue link followed in full stays in full', () => {
      const full = selected({ layout: 'full', selectedId: 't1' });
      const state = issueViewReduce(full, { type: 'select', id: 't2', label: 'TM-2' });
      expect(state.layout).toBe('full');
      expect(state.selectedId).toBe('t2');
    });

    it('clears any notice', () => {
      const withNotice = selected({ notice: 'TM-9 was deleted, so its panel closed.' });
      const state = issueViewReduce(withNotice, { type: 'select', id: 't2', label: 'TM-2' });
      expect(state.notice).toBeNull();
    });
  });

  describe('open', () => {
    it('selects the ticket and goes straight to full', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, {
        type: 'open',
        id: 't1',
        label: 'TM-1',
      });
      expect(state.layout).toBe('full');
      expect(state.selectedId).toBe('t1');
      expect(state.seen).toBe(false);
    });
  });

  describe('expand and close', () => {
    it('expand goes to full', () => {
      const peek = selected({ layout: 'peek' });
      const state = issueViewReduce(peek, { type: 'expand' });
      expect(state.layout).toBe('full');
    });

    it('expand without a selection does nothing', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, { type: 'expand' });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });

    it('close goes to closed, keeping the selection', () => {
      const full = selected({ layout: 'full' });
      const state = issueViewReduce(full, { type: 'close' });
      expect(state.layout).toBe('closed');
      expect(state.selectedId).toBe('t1');
    });
  });

  describe('tickets', () => {
    it('refreshes the label and marks the selection seen when still present', () => {
      const state = issueViewReduce(selected({ seen: false, label: 'old label' }), {
        type: 'tickets',
        tickets: [ticket({ id: 't1', ticketKey: 'TM-1', title: 'Renamed' })],
      });
      expect(state.seen).toBe(true);
      expect(state.label).toBe('TM-1');
    });

    it('falls back to the title when the ticket carries no key', () => {
      const state = issueViewReduce(selected({ seen: false }), {
        type: 'tickets',
        tickets: [ticket({ id: 't1', ticketKey: null, title: 'Renamed' })],
      });
      expect(state.label).toBe('Renamed');
    });

    it('closes a deleted ticket with a message carrying its key', () => {
      const state = issueViewReduce(selected({ seen: true, label: 'TM-1' }), {
        type: 'tickets',
        tickets: [],
      });
      expect(state.selectedId).toBeNull();
      expect(state.layout).toBe('closed');
      expect(state.notice).toBe('TM-1 was deleted, so its panel closed.');
    });

    it('does not treat a never-seen (cross-project) id as deleted', () => {
      const state = issueViewReduce(selected({ seen: false, layout: 'peek' }), {
        type: 'tickets',
        tickets: [],
      });
      expect(state.selectedId).toBe('t1');
      expect(state.layout).toBe('peek');
      expect(state.notice).toBeNull();
    });

    it('does nothing with no selection', () => {
      const state = issueViewReduce(INITIAL_ISSUE_VIEW, { type: 'tickets', tickets: [] });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });
  });

  describe('dismissNotice', () => {
    it('clears the notice', () => {
      const withNotice = selected({ notice: 'TM-1 was deleted, so its panel closed.' });
      const state = issueViewReduce(withNotice, { type: 'dismissNotice' });
      expect(state.notice).toBeNull();
    });
  });

  describe('reset', () => {
    it('returns to the initial state', () => {
      const state = issueViewReduce(selected({ layout: 'full', notice: 'something' }), {
        type: 'reset',
      });
      expect(state).toEqual(INITIAL_ISSUE_VIEW);
    });
  });
});

describe('issueBreadcrumb', () => {
  const project = { name: 'Task Manager' };
  const milestones = [{ id: 'm4', name: 'M4 Reach' }];
  const ticketsById = new Map([['e4', { title: 'F14 Milestone archiving' }]]);

  it('includes the project, milestone and epic when every link resolves', () => {
    const crumbs = issueBreadcrumb(
      { milestoneId: 'm4', epicTaskId: 'e4' },
      project,
      milestones,
      ticketsById,
    );
    expect(crumbs).toEqual(['Task Manager', 'M4 Reach', 'F14 Milestone archiving']);
  });

  it('drops a missing milestone', () => {
    const crumbs = issueBreadcrumb(
      { milestoneId: 'unknown', epicTaskId: 'e4' },
      project,
      milestones,
      ticketsById,
    );
    expect(crumbs).toEqual(['Task Manager', 'F14 Milestone archiving']);
  });

  it('drops a missing epic', () => {
    const crumbs = issueBreadcrumb(
      { milestoneId: 'm4', epicTaskId: 'unknown' },
      project,
      milestones,
      ticketsById,
    );
    expect(crumbs).toEqual(['Task Manager', 'M4 Reach']);
  });

  it('drops both when neither link is set, never rendering a placeholder', () => {
    const crumbs = issueBreadcrumb(
      { milestoneId: null, epicTaskId: null },
      project,
      milestones,
      ticketsById,
    );
    expect(crumbs).toEqual(['Task Manager']);
  });
});

describe('peekEpic', () => {
  const ticketsById = new Map([['e4', { title: 'F14 Milestone archiving' }]]);

  it('prefers the linked epic title', () => {
    expect(peekEpic({ epicTaskId: 'e4', externalEpicName: 'Milestone archive' }, ticketsById)).toBe(
      'F14 Milestone archiving',
    );
  });

  it("falls back to a mirrored card's tracker epic by name", () => {
    expect(peekEpic({ epicTaskId: null, externalEpicName: 'Milestone archive' }, ticketsById)).toBe(
      'Milestone archive',
    );
    expect(
      peekEpic({ epicTaskId: 'unknown', externalEpicName: 'Milestone archive' }, ticketsById),
    ).toBe('Milestone archive');
  });

  it('is undefined when neither is set', () => {
    expect(peekEpic({ epicTaskId: null, externalEpicName: null }, ticketsById)).toBeUndefined();
  });
});

describe('isKeyTargetEditable', () => {
  it('is false for null/undefined', () => {
    expect(isKeyTargetEditable(null)).toBe(false);
    expect(isKeyTargetEditable(undefined)).toBe(false);
  });

  it('is false for a plain element', () => {
    expect(isKeyTargetEditable({ tagName: 'DIV' })).toBe(false);
  });

  it('is true for input, textarea and select', () => {
    expect(isKeyTargetEditable({ tagName: 'INPUT' })).toBe(true);
    expect(isKeyTargetEditable({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isKeyTargetEditable({ tagName: 'SELECT' })).toBe(true);
  });

  it('is true for contentEditable', () => {
    expect(isKeyTargetEditable({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is true inside a Fluent dialog, menu or listbox portal', () => {
    const makeTarget = (closestResult: unknown) => ({
      tagName: 'DIV',
      closest: (_selectors: string) => closestResult,
    });
    expect(isKeyTargetEditable(makeTarget({}))).toBe(true);
    expect(isKeyTargetEditable(makeTarget(null))).toBe(false);
  });
});
