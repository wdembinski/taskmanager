import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task, type TicketLink } from './model';
import {
  blockersOf,
  canLinkTickets,
  linksFor,
  startReadiness,
  TICKET_LINK_VOCABULARY,
} from './ticketLinks';

const link = (over: Partial<TicketLink>): TicketLink => ({
  id: 'l1',
  fromTaskId: 'a',
  toTaskId: 'b',
  type: 'blocks',
  createdAt: 0,
  ...over,
});

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
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

describe('TICKET_LINK_VOCABULARY', () => {
  it('reads the same in both directions only for the symmetric type', () => {
    for (const [type, entry] of Object.entries(TICKET_LINK_VOCABULARY)) {
      if (type === 'relates') {
        expect(entry.symmetric).toBe(true);
        expect(entry.outward).toBe(entry.inward);
      } else {
        expect(entry.symmetric).toBe(false);
        expect(entry.outward).not.toBe(entry.inward);
      }
    }
  });
});

describe('linksFor', () => {
  it('reads outward from the from end and inward from the to end of the same row', () => {
    const l = link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' });
    expect(linksFor([l], 'a')).toEqual([{ link: l, otherTaskId: 'b', phrase: 'blocks' }]);
    expect(linksFor([l], 'b')).toEqual([{ link: l, otherTaskId: 'a', phrase: 'is blocked by' }]);
  });

  it('is empty for a task the link does not touch', () => {
    expect(linksFor([link({})], 'z')).toEqual([]);
  });
});

describe('canLinkTickets', () => {
  it('refuses when either end is missing', () => {
    expect(canLinkTickets([], undefined, { id: 'b' }, 'blocks')).toBe('missing');
    expect(canLinkTickets([], { id: 'a' }, undefined, 'blocks')).toBe('missing');
  });

  it('refuses a ticket linking to itself', () => {
    expect(canLinkTickets([], { id: 'a' }, { id: 'a' }, 'blocks')).toBe('self');
  });

  it('refuses the exact same row drawn twice', () => {
    const existing = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    expect(canLinkTickets(existing, { id: 'a' }, { id: 'b' }, 'blocks')).toBe('duplicate');
  });

  it('allows a directed type drawn the other way round — a different fact', () => {
    const existing = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    expect(canLinkTickets(existing, { id: 'b' }, { id: 'a' }, 'blocks')).toBeNull();
  });

  it('refuses the mirrored row of a symmetric type — A relates B and B relates A are one fact', () => {
    const existing = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'relates' })];
    expect(canLinkTickets(existing, { id: 'b' }, { id: 'a' }, 'relates')).toBe('duplicate');
    expect(canLinkTickets(existing, { id: 'a' }, { id: 'b' }, 'relates')).toBe('duplicate');
  });

  it('allows a fresh link with no conflict', () => {
    expect(canLinkTickets([], { id: 'a' }, { id: 'b' }, 'blocks')).toBeNull();
  });
});

describe('blockersOf', () => {
  it('returns the from end of blocks links naming taskId as the to end', () => {
    const l = link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' });
    expect(blockersOf([l], 'b')).toEqual(['a']);
  });

  it('ignores non-blocks links', () => {
    const l = link({ fromTaskId: 'a', toTaskId: 'b', type: 'relates' });
    expect(blockersOf([l], 'b')).toEqual([]);
  });

  it('does not treat the blocker as blocked by its own target', () => {
    const l = link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' });
    expect(blockersOf([l], 'a')).toEqual([]);
  });
});

describe('startReadiness', () => {
  it('is ready when there are no links', () => {
    const t = task({ id: 'b', status: 'pending' });
    expect(startReadiness(t, [], new Map())).toEqual({ kind: 'ready' });
  });

  it('is ready when every blocker is done', () => {
    const t = task({ id: 'b', status: 'pending' });
    const blocker = task({ id: 'a', status: 'done' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    const byId = new Map([['a', blocker]]);
    expect(startReadiness(t, links, byId)).toEqual({ kind: 'ready' });
  });

  it('is waiting on the one blocker still open', () => {
    const t = task({ id: 'b', status: 'pending' });
    const blocker = task({ id: 'a', status: 'pending' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    const byId = new Map([['a', blocker]]);
    expect(startReadiness(t, links, byId)).toEqual({
      kind: 'waiting',
      open: [{ id: 'a', task: blocker }],
    });
  });

  it('reads a blocker by its resting status, not a borrowed running one', () => {
    const t = task({ id: 'b', status: 'pending' });
    const blocker = task({ id: 'a', status: 'running', preRunStatus: 'done' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    const byId = new Map([['a', blocker]]);
    expect(startReadiness(t, links, byId)).toEqual({ kind: 'ready' });
  });

  it('treats an unknown blocker id as still open', () => {
    const t = task({ id: 'b', status: 'pending' });
    const links = [link({ fromTaskId: 'ghost', toTaskId: 'b', type: 'blocks' })];
    expect(startReadiness(t, links, new Map())).toEqual({
      kind: 'waiting',
      open: [{ id: 'ghost', task: undefined }],
    });
  });

  it('ignores non-blocks links when deciding readiness', () => {
    const t = task({ id: 'b', status: 'pending' });
    const other = task({ id: 'a', status: 'pending' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'relates' })];
    const byId = new Map([['a', other]]);
    expect(startReadiness(t, links, byId)).toEqual({ kind: 'ready' });
  });

  it('does not read the blocker as blocked by its own target', () => {
    const blockerAsTask = task({ id: 'a', status: 'pending' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    expect(startReadiness(blockerAsTask, links, new Map())).toEqual({ kind: 'ready' });
  });

  it('is done for a ticket already in the done column, before its blockers are read', () => {
    const t = task({ id: 'b', status: 'done' });
    const blocker = task({ id: 'a', status: 'pending' });
    const links = [link({ fromTaskId: 'a', toTaskId: 'b', type: 'blocks' })];
    const byId = new Map([['a', blocker]]);
    expect(startReadiness(t, links, byId)).toEqual({ kind: 'done' });
  });
});
