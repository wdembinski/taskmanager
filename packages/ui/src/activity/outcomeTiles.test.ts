import { describe, expect, it } from 'vitest';
import type { ActivityOverview, ActivityQuery } from '@tm/shared/activity';
import { OUTCOME_TILES, activeTile, applyTile, tileCount } from './outcomeTiles';

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return { sinceMs: 0, limit: 50, ...overrides };
}

function overview(overrides: Partial<ActivityOverview> = {}): ActivityOverview {
  return {
    period: '24h',
    sinceMs: 0,
    running: 0,
    needsYou: 0,
    outcomes: { done: 0, failed: 0, stopped: 0, needsInput: 0 },
    byProject: {},
    ...overrides,
  };
}

describe('applyTile', () => {
  it('sets the running tile as a kinds filter and clears outcomes', () => {
    const next = applyTile(query({ outcomes: ['done'] }), 'running');
    expect(next.kinds).toEqual(['run-started']);
    expect(next.outcomes).toBeUndefined();
  });

  it('sets the needsYou tile as a kinds filter', () => {
    const next = applyTile(query(), 'needsYou');
    expect(next.kinds).toEqual(['parked', 'question-raised', 'merge-conflict']);
    expect(next.outcomes).toBeUndefined();
  });

  it('sets the completed tile as an outcomes filter of done only', () => {
    const next = applyTile(query(), 'completed');
    expect(next.outcomes).toEqual(['done']);
    expect(next.kinds).toBeUndefined();
  });

  it('sets the failed tile as an outcomes filter that includes empty', () => {
    const next = applyTile(query(), 'failed');
    expect(next.outcomes).toEqual(['failed', 'empty']);
    expect(next.kinds).toBeUndefined();
  });

  it('toggles the tile off on a second click', () => {
    const once = applyTile(query(), 'failed');
    const twice = applyTile(once, 'failed');
    expect(twice.kinds).toBeUndefined();
    expect(twice.outcomes).toBeUndefined();
  });

  it('switches cleanly between tiles, leaving no filter from the old one', () => {
    const onFailed = applyTile(query(), 'failed');
    const onRunning = applyTile(onFailed, 'running');
    expect(onRunning.kinds).toEqual(['run-started']);
    expect(onRunning.outcomes).toBeUndefined();
  });

  it('preserves projectIds and origins untouched', () => {
    const next = applyTile(query({ projectIds: ['p1'], origins: ['human'] }), 'completed');
    expect(next.projectIds).toEqual(['p1']);
    expect(next.origins).toEqual(['human']);
  });

  it('does not alias the constant filter arrays', () => {
    const next = applyTile(query(), 'failed');
    next.outcomes!.push('stopped');
    const again = applyTile(query(), 'failed');
    expect(again.outcomes).toEqual(['failed', 'empty']);
  });
});

describe('activeTile', () => {
  it('is null on a query with no tile filter', () => {
    expect(activeTile(query())).toBeNull();
  });

  it('recognizes each tile after applyTile sets it', () => {
    for (const tile of OUTCOME_TILES) {
      expect(activeTile(applyTile(query(), tile))).toBe(tile);
    }
  });

  it('is order-insensitive for a multi-kind tile', () => {
    expect(activeTile(query({ kinds: ['merge-conflict', 'question-raised', 'parked'] }))).toBe(
      'needsYou',
    );
  });

  it('is order-insensitive for a multi-outcome tile', () => {
    expect(activeTile(query({ outcomes: ['empty', 'failed'] }))).toBe('failed');
  });

  it('is null for a foreign kinds filter set by hand', () => {
    expect(activeTile(query({ kinds: ['merge-landed'] }))).toBeNull();
  });

  it('is null for a mixed filter that sets both kinds and outcomes', () => {
    expect(activeTile(query({ kinds: ['run-started'], outcomes: ['done'] }))).toBeNull();
  });
});

describe('tileCount', () => {
  it('reads running and needsYou straight off the overview', () => {
    const o = overview({ running: 3, needsYou: 2 });
    expect(tileCount(o, 'running')).toBe(3);
    expect(tileCount(o, 'needsYou')).toBe(2);
  });

  it('reads completed from outcomes.done and failed from outcomes.failed', () => {
    const o = overview({ outcomes: { done: 5, failed: 4, stopped: 1, needsInput: 0 } });
    expect(tileCount(o, 'completed')).toBe(5);
    expect(tileCount(o, 'failed')).toBe(4);
  });
});
