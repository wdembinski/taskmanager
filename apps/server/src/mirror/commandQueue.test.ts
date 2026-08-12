import { describe, expect, it } from 'vitest';
import {
  acknowledgeable,
  COMMAND_LEASE_MS,
  isDeliverable,
  leaseCutoff,
  type LeasableCommand,
} from './commandQueue';

const NOW = 1_800_000_000_000;

const row = (over: Partial<LeasableCommand> = {}): LeasableCommand => ({
  id: 'c1',
  deliveredAt: null,
  ackedAt: null,
  ...over,
});

describe('isDeliverable', () => {
  it('delivers a command that has never been delivered', () => {
    expect(isDeliverable(row(), NOW)).toBe(true);
  });

  it('withholds one whose lease is still running', () => {
    const deliveredAt = new Date(NOW - COMMAND_LEASE_MS + 1);
    expect(isDeliverable(row({ deliveredAt }), NOW)).toBe(false);
  });

  it('redelivers one whose lease has expired without an ack', () => {
    const deliveredAt = new Date(NOW - COMMAND_LEASE_MS - 1);
    expect(isDeliverable(row({ deliveredAt }), NOW)).toBe(true);
  });

  it('never redelivers an acked command, however long ago it was delivered', () => {
    const deliveredAt = new Date(NOW - COMMAND_LEASE_MS * 100);
    expect(isDeliverable(row({ deliveredAt, ackedAt: new Date(NOW) }), NOW)).toBe(false);
  });

  it('holds the lease exactly at its boundary, and releases it one tick later', () => {
    const at = (age: number) => isDeliverable(row({ deliveredAt: new Date(NOW - age) }), NOW);
    expect(at(COMMAND_LEASE_MS)).toBe(false);
    expect(at(COMMAND_LEASE_MS + 1)).toBe(true);
  });

  it('is long enough for a minutes-scale relayed handler to finish', () => {
    // `jira:sync`/`gitlab:sync` are the slowest channels a browser can relay, and the drain
    // is serial. A lease under a couple of minutes would redeliver work still in progress.
    expect(COMMAND_LEASE_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });
});

describe('leaseCutoff', () => {
  it('agrees with isDeliverable — the SQL predicate and the check are one rule', () => {
    const cutoff = leaseCutoff(NOW);
    for (const age of [0, 1, COMMAND_LEASE_MS - 1, COMMAND_LEASE_MS, COMMAND_LEASE_MS + 1]) {
      const deliveredAt = new Date(NOW - age);
      const sqlWouldSelect = deliveredAt.getTime() < cutoff.getTime();
      expect(sqlWouldSelect).toBe(isDeliverable(row({ deliveredAt }), NOW));
    }
  });
});

describe('acknowledgeable', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', ackedAt: new Date(NOW) }), row({ id: 'c' })];

  it('takes the ids that name an unacked row', () => {
    expect(acknowledgeable(rows, ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('ignores an id that is already acked, rather than moving its timestamp', () => {
    expect(acknowledgeable(rows, ['b'])).toEqual([]);
  });

  it('ignores an id this Client has no row for', () => {
    // A command belonging to another Client, or one that never existed. Acking it would
    // retire something that was never delivered.
    expect(acknowledgeable(rows, ['someone-elses'])).toEqual([]);
  });

  it('does nothing at all for an empty ack list', () => {
    expect(acknowledgeable(rows, [])).toEqual([]);
  });
});
