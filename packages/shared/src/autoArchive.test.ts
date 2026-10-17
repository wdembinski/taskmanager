import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import {
  WEEK_MS,
  dueForAutoArchive,
  type AutoArchivableMilestone,
  type AutoArchivableTicket,
} from './autoArchive';

const NOW = Date.UTC(2026, 9, 17);

function milestone(
  over: Partial<AutoArchivableMilestone> & { id: string },
): AutoArchivableMilestone {
  return { archivedAt: null, ...over };
}

function ticket(
  over: Partial<AutoArchivableTicket> & { id: string; milestoneId: string },
): AutoArchivableTicket {
  return { status: 'done', updatedAt: NOW, ...over };
}

describe('dueForAutoArchive', () => {
  it('does nothing when off by default (DEFAULT_SETTINGS value)', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 100 * WEEK_MS })];
    expect(
      dueForAutoArchive(
        milestones,
        tickets,
        new Map(),
        NOW,
        DEFAULT_SETTINGS.ticketAutoArchiveWeeks,
      ),
    ).toEqual([]);
  });

  it('returns nothing for a non-finite or non-positive weeks value', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 100 * WEEK_MS })];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 0)).toEqual([]);
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, -1)).toEqual([]);
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, NaN)).toEqual([]);
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, Infinity)).toEqual([]);
  });

  it('an open ticket blocks the milestone', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [
      ticket({ id: 't1', milestoneId: 'm1', status: 'done', updatedAt: NOW - 10 * WEEK_MS }),
      ticket({ id: 't2', milestoneId: 'm1', status: 'in-progress', updatedAt: NOW - 10 * WEEK_MS }),
    ];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual([]);
  });

  it('a milestone with no tickets is never archived', () => {
    const milestones = [milestone({ id: 'm1' })];
    expect(dueForAutoArchive(milestones, [], new Map(), NOW, 2)).toEqual([]);
  });

  it('archives at exactly N weeks and not at N weeks minus 1ms', () => {
    const milestones = [milestone({ id: 'm1' })];
    const exactly = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 2 * WEEK_MS })];
    expect(dueForAutoArchive(milestones, exactly, new Map(), NOW, 2)).toEqual(['m1']);

    const oneMsShort = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 2 * WEEK_MS + 1 })];
    expect(dueForAutoArchive(milestones, oneMsShort, new Map(), NOW, 2)).toEqual([]);
  });

  it('a missing log row falls back to updatedAt', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 3 * WEEK_MS })];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual(['m1']);
  });

  it('a log row wins over a newer updatedAt', () => {
    const milestones = [milestone({ id: 'm1' })];
    // updatedAt alone would read as too recent to archive, but the log row says it closed
    // long enough ago — the log row must win.
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW })];
    const doneTimes = new Map([['t1', NOW - 3 * WEEK_MS]]);
    expect(dueForAutoArchive(milestones, tickets, doneTimes, NOW, 2)).toEqual(['m1']);
  });

  it('an undatable ticket (no log row, no updatedAt) blocks the milestone', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: null })];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual([]);
  });

  it('an already-archived milestone is skipped', () => {
    const milestones = [milestone({ id: 'm1', archivedAt: NOW - 100 * WEEK_MS })];
    const tickets = [ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 100 * WEEK_MS })];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual([]);
  });

  it('returns ids in input order, across multiple milestones', () => {
    const milestones = [milestone({ id: 'm2' }), milestone({ id: 'm1' })];
    const tickets = [
      ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 10 * WEEK_MS }),
      ticket({ id: 't2', milestoneId: 'm2', updatedAt: NOW - 10 * WEEK_MS }),
    ];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual(['m2', 'm1']);
  });

  it('the oldest-closing ticket on a milestone does not block a still-recent one', () => {
    const milestones = [milestone({ id: 'm1' })];
    const tickets = [
      ticket({ id: 't1', milestoneId: 'm1', updatedAt: NOW - 10 * WEEK_MS }),
      ticket({ id: 't2', milestoneId: 'm1', updatedAt: NOW - 1 * WEEK_MS }),
    ];
    expect(dueForAutoArchive(milestones, tickets, new Map(), NOW, 2)).toEqual([]);
  });
});
