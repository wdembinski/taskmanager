import { describe, expect, it } from 'vitest';
import type { ActivityRow } from '@tm/shared/activity';
import { compareCursor, countsAsUnread, laterCursor, unreadActivityCount } from './activityUnread';

/** A row with just the fields these helpers read, everything else defaulted. */
function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    at: 0,
    projectId: null,
    taskId: null,
    runId: null,
    kind: 'run-finished',
    outcome: 'done',
    origin: 'human',
    title: 'a card',
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

describe('compareCursor', () => {
  it('orders by at first', () => {
    expect(compareCursor({ at: 100, id: 1 }, { at: 200, id: 1 })).toBeLessThan(0);
    expect(compareCursor({ at: 200, id: 1 }, { at: 100, id: 1 })).toBeGreaterThan(0);
  });

  it('breaks a tied at by id', () => {
    expect(compareCursor({ at: 100, id: 1 }, { at: 100, id: 2 })).toBeLessThan(0);
    expect(compareCursor({ at: 100, id: 2 }, { at: 100, id: 1 })).toBeGreaterThan(0);
  });

  it('is zero for an identical cursor', () => {
    expect(compareCursor({ at: 100, id: 1 }, { at: 100, id: 1 })).toBe(0);
  });
});

describe('countsAsUnread', () => {
  it('excludes your own column move', () => {
    expect(countsAsUnread(row({ kind: 'status-moved', origin: 'human' }))).toBe(false);
  });

  it('counts a chain-driven column move', () => {
    expect(countsAsUnread(row({ kind: 'status-moved', origin: 'chain' }))).toBe(true);
  });

  it('counts every other kind regardless of origin', () => {
    expect(countsAsUnread(row({ kind: 'run-finished', origin: 'human' }))).toBe(true);
    expect(countsAsUnread(row({ kind: 'merge-landed', origin: 'chain' }))).toBe(true);
  });
});

describe('unreadActivityCount', () => {
  it('reads 0 for a null lastSeen', () => {
    expect(unreadActivityCount([row({ id: 1, at: 100 })], null)).toBe(0);
  });

  it('does not count a row exactly equal to lastSeen', () => {
    const lastSeen = { at: 100, id: 5 };
    expect(unreadActivityCount([row({ id: 5, at: 100 })], lastSeen)).toBe(0);
  });

  it('counts a row with the same at but a higher id', () => {
    const lastSeen = { at: 100, id: 5 };
    expect(unreadActivityCount([row({ id: 6, at: 100 })], lastSeen)).toBe(1);
  });

  it('excludes your own column move but counts a chain-driven one', () => {
    const lastSeen = { at: 100, id: 5 };
    const rows = [
      row({ id: 6, at: 100, kind: 'status-moved', origin: 'human' }),
      row({ id: 7, at: 100, kind: 'status-moved', origin: 'chain' }),
    ];
    expect(unreadActivityCount(rows, lastSeen)).toBe(1);
  });
});

describe('laterCursor', () => {
  it('never regresses on an older reported cursor', () => {
    const stored = { at: 200, id: 1 };
    expect(laterCursor(stored, { at: 100, id: 99 })).toEqual(stored);
  });

  it('adopts a newer reported cursor', () => {
    const reported = { at: 300, id: 1 };
    expect(laterCursor({ at: 200, id: 1 }, reported)).toEqual(reported);
  });
});
