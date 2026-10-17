import { describe, expect, it } from 'vitest';
import type { ActiveRun } from './scheduler';
import type { AttentionItem } from './attention';
import {
  ACTIVITY_PAGE_MAX,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PERIOD_MS,
  ACTIVITY_PERIODS,
  type ActivityRow,
  buildActivityOverview,
  decodeCursor,
  encodeCursor,
  isActivityKind,
  isActivityOrigin,
  isActivityOutcome,
  isActivityPeriod,
  laterActivityCursor,
  normalizeActivityQuery,
  summarizeOutcomes,
} from './activity';

/** A finished row with just the fields `summarizeOutcomes` reads, everything else defaulted. */
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

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor', () => {
    const cursor = { at: 1_700_000_000_000, id: 42 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips at = 0', () => {
    const cursor = { at: 0, id: 1 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a large epoch value and a large id', () => {
    const cursor = { at: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('encodes to a string with no +, / or =', () => {
    const encoded = encodeCursor({ at: 1_700_000_000_000, id: 999_999 });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('decodeCursor rejecting malformed input', () => {
  it.each([
    [''],
    ['not even close to base64url'],
    ['!!!not-valid-base64!!!'],
    ['abc.1'],
    ['1'],
    ['1.2.3'],
    ['-1.2'],
    ['1.0'],
  ])('returns null for %j', (value) => {
    expect(decodeCursor(value)).toBeNull();
  });

  it('returns null for an at/id beyond Number.MAX_SAFE_INTEGER', () => {
    const tooBig = `${Number.MAX_SAFE_INTEGER}0.1`;
    const encoded = btoa(tooBig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null for a non-string value', () => {
    expect(decodeCursor(12345 as unknown as string)).toBeNull();
    expect(decodeCursor(null as unknown as string)).toBeNull();
    expect(decodeCursor(undefined as unknown as string)).toBeNull();
  });
});

describe('summarizeOutcomes', () => {
  it('counts empty as failed', () => {
    const { total } = summarizeOutcomes([row({ outcome: 'empty' })]);
    expect(total).toEqual({ done: 0, failed: 1, stopped: 0, needsInput: 0 });
  });

  it('counts a run once, at its final outcome, whatever order the rows arrive in', () => {
    const started = row({ id: 1, at: 100, runId: 'run-1', outcome: 'needs-input' });
    const finished = row({ id: 2, at: 200, runId: 'run-1', outcome: 'done' });

    const forward = summarizeOutcomes([started, finished]);
    expect(forward.total).toEqual({ done: 1, failed: 0, stopped: 0, needsInput: 0 });

    const backward = summarizeOutcomes([finished, started]);
    expect(backward.total).toEqual({ done: 1, failed: 0, stopped: 0, needsInput: 0 });
  });

  it('ignores non-run-finished kinds', () => {
    const { total } = summarizeOutcomes([
      row({ kind: 'parked', outcome: null }),
      row({ kind: 'merge-failed', outcome: null }),
    ]);
    expect(total).toEqual({ done: 0, failed: 0, stopped: 0, needsInput: 0 });
  });

  it('splits counts per project, with a null project counting only in total', () => {
    const { total, byProject } = summarizeOutcomes([
      row({ id: 1, projectId: 'proj-a', outcome: 'done', runId: 'run-a' }),
      row({ id: 2, projectId: 'proj-b', outcome: 'failed', runId: 'run-b' }),
      row({ id: 3, projectId: null, outcome: 'stopped', runId: 'run-c' }),
    ]);

    expect(total).toEqual({ done: 1, failed: 1, stopped: 1, needsInput: 0 });
    expect(byProject).toEqual({
      'proj-a': { done: 1, failed: 0, stopped: 0, needsInput: 0 },
      'proj-b': { done: 0, failed: 1, stopped: 0, needsInput: 0 },
    });
  });

  it('gives zero counts for empty input', () => {
    const { total, byProject } = summarizeOutcomes([]);
    expect(total).toEqual({ done: 0, failed: 0, stopped: 0, needsInput: 0 });
    expect(byProject).toEqual({});
  });

  it('counts each run-finished row with no runId on its own', () => {
    const { total } = summarizeOutcomes([
      row({ id: 1, runId: null, outcome: 'done' }),
      row({ id: 2, runId: null, outcome: 'done' }),
    ]);
    expect(total.done).toBe(2);
  });
});

describe('isActivityKind', () => {
  it('accepts every listed kind', () => {
    for (const kind of [
      'run-started',
      'run-finished',
      'parked',
      'resumed',
      'plan-presented',
      'question-raised',
      'merge-landed',
      'merge-conflict',
      'merge-failed',
      'release-published',
      'status-moved',
      'trigger-fired',
      'milestone-archived',
    ]) {
      expect(isActivityKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isActivityKind('something-else')).toBe(false);
  });
});

describe('isActivityOutcome', () => {
  it('accepts every listed outcome', () => {
    for (const outcome of ['done', 'failed', 'stopped', 'empty', 'needs-input']) {
      expect(isActivityOutcome(outcome)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isActivityOutcome('cancelled')).toBe(false);
  });
});

describe('isActivityOrigin', () => {
  it('accepts every fixed origin plus a trigger id', () => {
    for (const origin of ['human', 'chain', 'auto-release', 'resume', 'trigger:abc']) {
      expect(isActivityOrigin(origin)).toBe(true);
    }
  });

  it('rejects a bare "trigger:" with no id', () => {
    expect(isActivityOrigin('trigger:')).toBe(false);
  });

  it('rejects an unknown string', () => {
    expect(isActivityOrigin('robot')).toBe(false);
  });
});

describe('isActivityPeriod', () => {
  it('accepts every listed period', () => {
    for (const period of ACTIVITY_PERIODS) {
      expect(isActivityPeriod(period)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isActivityPeriod('1h')).toBe(false);
  });
});

describe('normalizeActivityQuery', () => {
  it('clamps a limit above the max down to ACTIVITY_PAGE_MAX', () => {
    expect(normalizeActivityQuery({ sinceMs: 0, limit: 10_000 }).limit).toBe(ACTIVITY_PAGE_MAX);
  });

  it('clamps a limit below 1 up to 1', () => {
    expect(normalizeActivityQuery({ sinceMs: 0, limit: 0 }).limit).toBe(1);
    expect(normalizeActivityQuery({ sinceMs: 0, limit: -5 }).limit).toBe(1);
  });

  it('defaults to ACTIVITY_PAGE_SIZE when limit is not a finite number', () => {
    expect(normalizeActivityQuery({ sinceMs: 0, limit: Number.NaN }).limit).toBe(
      ACTIVITY_PAGE_SIZE,
    );
    expect(
      normalizeActivityQuery({ sinceMs: 0, limit: undefined as unknown as number }).limit,
    ).toBe(ACTIVITY_PAGE_SIZE);
  });

  it('rejects a cursor decodeCursor would reject, with a user-facing message', () => {
    expect(() =>
      normalizeActivityQuery({ sinceMs: 0, limit: 10, cursor: 'not-a-real-cursor' }),
    ).toThrow('This activity page is out of date — reload the feed');
  });

  it('passes a good cursor through unchanged', () => {
    const cursor = encodeCursor({ at: 1000, id: 1 });
    expect(normalizeActivityQuery({ sinceMs: 0, limit: 10, cursor }).cursor).toBe(cursor);
  });
});

describe('ACTIVITY_PERIOD_MS', () => {
  it('orders the three windows from shortest to longest', () => {
    expect(ACTIVITY_PERIOD_MS['24h']).toBeLessThan(ACTIVITY_PERIOD_MS['7d']);
    expect(ACTIVITY_PERIOD_MS['7d']).toBeLessThan(ACTIVITY_PERIOD_MS['30d']);
  });
});

describe('laterActivityCursor', () => {
  it('returns the reported cursor outright when nothing is stored yet', () => {
    const reported = { at: 100, id: 1 };
    expect(laterActivityCursor(null, reported)).toEqual(reported);
  });

  it('keeps the stored cursor when reported is at an earlier `at`', () => {
    const stored = { at: 200, id: 1 };
    expect(laterActivityCursor(stored, { at: 100, id: 99 })).toEqual(stored);
  });

  it('adopts the reported cursor when it is at a later `at`', () => {
    const reported = { at: 200, id: 1 };
    expect(laterActivityCursor({ at: 100, id: 99 }, reported)).toEqual(reported);
  });

  it('breaks a tied `at` by the higher id', () => {
    const reported = { at: 100, id: 5 };
    expect(laterActivityCursor({ at: 100, id: 2 }, reported)).toEqual(reported);
    expect(laterActivityCursor({ at: 100, id: 9 }, reported)).toEqual({ at: 100, id: 9 });
  });

  it('never regresses on an exactly equal cursor', () => {
    const cursor = { at: 100, id: 5 };
    expect(laterActivityCursor(cursor, { at: 100, id: 5 })).toEqual(cursor);
  });
});

describe('buildActivityOverview', () => {
  const emptyOutcomes = { done: 0, failed: 0, stopped: 0, needsInput: 0 };

  it('counts running as distinct task ids, not run count', () => {
    const activeRuns: ActiveRun[] = [
      { taskId: 't1', runId: 'r1' },
      { taskId: 't1', runId: 'r2' },
      { taskId: 't2', runId: 'r3' },
    ];
    const overview = buildActivityOverview({
      period: '24h',
      now: 1_000_000,
      activeRuns,
      attention: [],
      outcomes: { total: emptyOutcomes, byProject: {} },
    });
    expect(overview.running).toBe(2);
  });

  it('counts needsYou as the attention list length', () => {
    const attention = [{ id: 'a1' }, { id: 'a2' }] as unknown as AttentionItem[];
    const overview = buildActivityOverview({
      period: '24h',
      now: 1_000_000,
      activeRuns: [],
      attention,
      outcomes: { total: emptyOutcomes, byProject: {} },
    });
    expect(overview.needsYou).toBe(2);
  });

  it('passes outcomes and byProject through untouched, and derives sinceMs from the period', () => {
    const outcomes = { done: 3, failed: 1, stopped: 0, needsInput: 0 };
    const byProject = { 'proj-1': outcomes };
    const overview = buildActivityOverview({
      period: '7d',
      now: 1_000_000,
      activeRuns: [],
      attention: [],
      outcomes: { total: outcomes, byProject },
    });
    expect(overview.outcomes).toBe(outcomes);
    expect(overview.byProject).toBe(byProject);
    expect(overview.sinceMs).toBe(1_000_000 - ACTIVITY_PERIOD_MS['7d']);
    expect(overview.period).toBe('7d');
  });
});
