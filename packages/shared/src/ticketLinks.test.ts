import { describe, expect, it } from 'vitest';
import type { TicketLink } from './model';
import { canLinkTickets, linksFor, TICKET_LINK_VOCABULARY } from './ticketLinks';

const link = (over: Partial<TicketLink>): TicketLink => ({
  id: 'l1',
  fromTaskId: 'a',
  toTaskId: 'b',
  type: 'blocks',
  createdAt: 0,
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
