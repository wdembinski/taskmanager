import { describe, expect, it } from 'vitest';
import type { ActivityRow } from '@tm/shared/activity';
import {
  EMPTY_FEED,
  type FeedState,
  compareActivity,
  feedAccepts,
  feedDividerIndex,
  feedLoadStarted,
  feedNewestCursor,
  feedPageArrived,
  feedScrolled,
  feedShowNew,
  feedStagedCount,
  isNewerThan,
  mergeRows,
} from './feedState';

function row(id: number, at: number, overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id,
    at,
    projectId: null,
    taskId: null,
    runId: null,
    kind: 'run-finished',
    outcome: 'done',
    origin: 'human',
    title: `row ${id}`,
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

describe('compareActivity', () => {
  it('orders by at, then by id, both descending', () => {
    expect(compareActivity(row(2, 500), row(1, 400))).toBeLessThan(0);
    expect(compareActivity(row(1, 400), row(2, 500))).toBeGreaterThan(0);
    expect(compareActivity(row(5, 300), row(4, 300))).toBeLessThan(0);
    expect(compareActivity(row(4, 300), row(4, 300))).toBe(0);
  });
});

describe('mergeRows', () => {
  it('unions two overlapping pages, each id once, sorted (at DESC, id DESC)', () => {
    const merged = mergeRows(
      [row(5, 500), row(4, 400), row(3, 300)],
      [row(4, 400), row(3, 300), row(2, 200)],
    );
    expect(merged.map((r) => r.id)).toEqual([5, 4, 3, 2]);
  });

  it('tie-breaks an equal `at` by id, descending', () => {
    const merged = mergeRows([], [row(1, 100), row(3, 100), row(2, 100)]);
    expect(merged.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('lets a re-read row with a changed field replace the old one', () => {
    const original = row(1, 100, { title: 'original title' });
    const reread = row(1, 100, { title: 'updated title' });

    expect(mergeRows([original], [reread])).toEqual([reread]);
  });
});

describe('older pages through feedPageArrived', () => {
  it('merges two overlapping older pages and advances nextCursor to the last page', () => {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedPageArrived(
      state,
      1,
      { rows: [row(5, 500), row(4, 400), row(3, 300)], nextCursor: 'c3' },
      'older',
    );
    state = feedPageArrived(
      state,
      1,
      { rows: [row(4, 400), row(3, 300), row(2, 200)], nextCursor: 'c2' },
      'older',
    );

    expect(state.rows.map((r) => r.id)).toEqual([5, 4, 3, 2]);
    expect(state.nextCursor).toBe('c2');
  });
});

describe('staging while scrolled away', () => {
  function loadedState(): FeedState {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedPageArrived(
      state,
      1,
      { rows: [row(3, 300), row(2, 200)], nextCursor: 'c1' },
      'older',
    );
    return state;
  }

  it('stages genuinely new ids from a head page while scrolled away, leaving rows as-is', () => {
    let state = feedScrolled(loadedState(), true);

    state = feedPageArrived(
      state,
      1,
      { rows: [row(5, 500), row(4, 400), row(3, 300)], nextCursor: null },
      'head',
    );

    expect(state.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(feedStagedCount(state)).toBe(2);
  });

  it('dedupes the same head page landing again', () => {
    let state = feedScrolled(loadedState(), true);
    const page = { rows: [row(5, 500), row(4, 400), row(3, 300)], nextCursor: null };
    state = feedPageArrived(state, 1, page, 'head');
    state = feedPageArrived(state, 1, page, 'head');

    expect(feedStagedCount(state)).toBe(2);
  });

  it('does not apply staged rows just by scrolling back to the top', () => {
    let state = feedScrolled(loadedState(), true);
    state = feedPageArrived(
      state,
      1,
      { rows: [row(5, 500), row(4, 400)], nextCursor: null },
      'head',
    );

    state = feedScrolled(state, false);

    expect(feedStagedCount(state)).toBe(2);
    expect(state.rows.map((r) => r.id)).toEqual([3, 2]);
  });

  it('feedShowNew merges staged rows into rows, in order, and clears staged', () => {
    let state = feedScrolled(loadedState(), true);
    state = feedPageArrived(
      state,
      1,
      { rows: [row(5, 500), row(4, 400)], nextCursor: null },
      'head',
    );

    state = feedShowNew(state);

    expect(state.rows.map((r) => r.id)).toEqual([5, 4, 3, 2]);
    expect(state.staged).toEqual([]);
  });

  it('applies head rows directly when not scrolled away, staging nothing', () => {
    let state = loadedState();

    state = feedPageArrived(
      state,
      1,
      { rows: [row(5, 500), row(4, 400)], nextCursor: null },
      'head',
    );

    expect(state.rows.map((r) => r.id)).toEqual([5, 4, 3, 2]);
    expect(state.staged).toEqual([]);
    expect(state.nextCursor).toBe('c1');
  });
});

describe('isNewerThan', () => {
  it('compares by at, then by id when at ties', () => {
    expect(isNewerThan(row(1, 200), { at: 100, id: 1 })).toBe(true);
    expect(isNewerThan(row(1, 100), { at: 200, id: 1 })).toBe(false);
    expect(isNewerThan(row(5, 100), { at: 100, id: 4 })).toBe(true);
    expect(isNewerThan(row(4, 100), { at: 100, id: 4 })).toBe(false);
  });
});

describe('feedDividerIndex', () => {
  const rows = [row(5, 500), row(4, 400), row(3, 300), row(2, 200)];

  it('is the count of leading rows newer than lastSeen', () => {
    expect(feedDividerIndex(rows, { at: 350, id: 1 })).toBe(2);
  });

  it('breaks a tie at the same `at` by id', () => {
    const tied = [row(5, 500), row(4, 300), row(3, 300), row(2, 200)];
    expect(feedDividerIndex(tied, { at: 300, id: 3 })).toBe(2);
  });

  it('is null when there is no lastSeen (first visit)', () => {
    expect(feedDividerIndex(rows, null)).toBeNull();
  });

  it('is null when nothing is newer than lastSeen', () => {
    expect(feedDividerIndex(rows, { at: 999, id: 1 })).toBeNull();
  });
});

describe('feedNewestCursor', () => {
  it('considers staged rows, not just rows', () => {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedPageArrived(state, 1, { rows: [row(3, 300)], nextCursor: null }, 'older');
    state = feedScrolled(state, true);
    state = feedPageArrived(state, 1, { rows: [row(5, 500)], nextCursor: null }, 'head');

    expect(state.staged).toEqual([row(5, 500)]);
    expect(feedNewestCursor(state)).toEqual({ at: 500, id: 5 });
  });
});

describe('stale seq', () => {
  it('keeps the newest answer no matter which order two loads settle in', () => {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedLoadStarted(state, 2, { reset: false });
    // The newer load's page lands first…
    state = feedPageArrived(state, 2, { rows: [row(2, 200)], nextCursor: null }, 'older');
    // …then the older load's page arrives late.
    const after = feedPageArrived(state, 1, { rows: [row(1, 100)], nextCursor: null }, 'older');

    expect(after).toBe(state);
    expect(after.rows.map((r) => r.id)).toEqual([2]);
  });

  it('keeps the newest answer when it arrives after the older one instead', () => {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedLoadStarted(state, 2, { reset: false });
    state = feedPageArrived(state, 1, { rows: [row(1, 100)], nextCursor: null }, 'older');
    state = feedPageArrived(state, 2, { rows: [row(2, 200)], nextCursor: null }, 'older');

    expect(state.rows.map((r) => r.id)).toEqual([2]);
  });

  it('refuses a feedLoadStarted carrying an older seq', () => {
    const state = feedLoadStarted(feedLoadStarted(EMPTY_FEED, 1, { reset: true }), 2, {
      reset: false,
    });

    const result = feedLoadStarted(state, 1, { reset: true });

    expect(result).toBe(state);
  });

  it('feedAccepts refuses an older seq once a newer load has started', () => {
    const state = feedLoadStarted(feedLoadStarted(EMPTY_FEED, 1, { reset: true }), 2, {
      reset: false,
    });
    expect(feedAccepts(state, 1)).toBe(false);
    expect(feedAccepts(state, 2)).toBe(true);
  });

  it('reset blanks rows, staged and nextCursor; non-reset keeps what is on screen', () => {
    let state = feedLoadStarted(EMPTY_FEED, 1, { reset: true });
    state = feedPageArrived(state, 1, { rows: [row(1, 100)], nextCursor: 'c1' }, 'older');

    const reloaded = feedLoadStarted(state, 2, { reset: false });
    expect(reloaded.rows).toEqual(state.rows);
    expect(reloaded.nextCursor).toBe('c1');
    expect(reloaded.loading).toBe(true);

    const resetState = feedLoadStarted(reloaded, 3, { reset: true });
    expect(resetState.rows).toEqual([]);
    expect(resetState.staged).toEqual([]);
    expect(resetState.nextCursor).toBeNull();
  });
});
