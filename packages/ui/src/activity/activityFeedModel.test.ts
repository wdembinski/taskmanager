import { describe, expect, it } from 'vitest';
import type { ActivityRow } from '@tm/shared/activity';
import {
  EMPTY_FEED_FILTER,
  type FeedFilter,
  feedFilterIsEmpty,
  feedFilterKey,
  feedQueryFor,
  formatCost,
  groupRowsByDay,
  originLabel,
  rowSentence,
  rowTarget,
} from './activityFeedModel';

function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    at: 1_000,
    projectId: null,
    taskId: null,
    runId: null,
    kind: 'run-finished',
    outcome: 'done',
    origin: 'human',
    title: 'row',
    costUsd: null,
    detail: null,
    ...overrides,
  };
}

function filter(overrides: Partial<FeedFilter> = {}): FeedFilter {
  return { ...EMPTY_FEED_FILTER, ...overrides };
}

describe('feedQueryFor', () => {
  it('builds only sinceMs and limit for an empty filter', () => {
    expect(feedQueryFor(EMPTY_FEED_FILTER, { sinceMs: 100 })).toEqual({
      sinceMs: 100,
      limit: 50,
    });
  });

  it('expands and dedupes kind groups, in a stable order regardless of input order', () => {
    const a = feedQueryFor(filter({ kindGroups: ['gates', 'runs'] }), { sinceMs: 0 });
    const b = feedQueryFor(filter({ kindGroups: ['runs', 'gates'] }), { sinceMs: 0 });

    expect(a.kinds).toEqual([
      'run-started',
      'run-finished',
      'trigger-fired',
      'parked',
      'resumed',
      'plan-presented',
      'question-raised',
    ]);
    expect(b.kinds).toEqual(a.kinds);
  });

  it('implies kinds: [run-finished] when an outcome is picked with no kind group', () => {
    const query = feedQueryFor(filter({ outcomes: ['failed'] }), { sinceMs: 0 });
    expect(query.kinds).toEqual(['run-finished']);
    expect(query.outcomes).toEqual(['failed']);
  });

  it('leaves kind groups as-is when both a kind group and an outcome are picked', () => {
    const query = feedQueryFor(filter({ kindGroups: ['merges'], outcomes: ['failed'] }), {
      sinceMs: 0,
    });
    expect(query.kinds).toEqual([
      'merge-landed',
      'merge-conflict',
      'merge-failed',
      'release-published',
    ]);
    expect(query.outcomes).toEqual(['failed']);
  });

  it('never sends empty arrays', () => {
    const query = feedQueryFor(filter({ projectIds: [], outcomes: [], origins: [] }), {
      sinceMs: 0,
    });
    expect(query).not.toHaveProperty('projectIds');
    expect(query).not.toHaveProperty('kinds');
    expect(query).not.toHaveProperty('outcomes');
    expect(query).not.toHaveProperty('origins');
  });

  it('passes a cursor through, and never sets one when absent', () => {
    const withCursor = feedQueryFor(EMPTY_FEED_FILTER, { sinceMs: 0, cursor: 'abc' });
    expect(withCursor.cursor).toBe('abc');

    const withoutCursor = feedQueryFor(EMPTY_FEED_FILTER, { sinceMs: 0 });
    expect('cursor' in withoutCursor).toBe(false);
  });

  it('defaults limit to ACTIVITY_PAGE_SIZE but honours an explicit one', () => {
    expect(feedQueryFor(EMPTY_FEED_FILTER, { sinceMs: 0 }).limit).toBe(50);
    expect(feedQueryFor(EMPTY_FEED_FILTER, { sinceMs: 0, limit: 10 }).limit).toBe(10);
  });
});

describe('feedFilterIsEmpty', () => {
  it('is true only when every list is empty', () => {
    expect(feedFilterIsEmpty(EMPTY_FEED_FILTER)).toBe(true);
    expect(feedFilterIsEmpty(filter({ projectIds: ['p1'] }))).toBe(false);
    expect(feedFilterIsEmpty(filter({ origins: ['human'] }))).toBe(false);
  });
});

describe('feedFilterKey', () => {
  it('is stable across array order and duplicate entries', () => {
    const a = filter({ projectIds: ['p2', 'p1'], outcomes: ['failed', 'done'] });
    const b = filter({ projectIds: ['p1', 'p2', 'p1'], outcomes: ['done', 'failed'] });
    expect(feedFilterKey(a)).toBe(feedFilterKey(b));
  });

  it('changes when the resulting query would change', () => {
    const empty = feedFilterKey(EMPTY_FEED_FILTER);
    const withProject = feedFilterKey(filter({ projectIds: ['p1'] }));
    const withKind = feedFilterKey(filter({ kindGroups: ['runs'] }));
    expect(withProject).not.toBe(empty);
    expect(withKind).not.toBe(empty);
    expect(withKind).not.toBe(withProject);
  });
});

describe('rowTarget', () => {
  const live = new Set(['t1']);

  it('opens a live task', () => {
    expect(rowTarget(row({ taskId: 't1' }), live)).toEqual({ kind: 'open', taskId: 't1' });
  });

  it('reports a task id missing from the live set as deleted', () => {
    expect(rowTarget(row({ taskId: 't2' }), live)).toEqual({ kind: 'deleted' });
  });

  it('reports a null taskId as none', () => {
    expect(rowTarget(row({ taskId: null }), live)).toEqual({ kind: 'none' });
  });
});

describe('rowSentence', () => {
  it('appends the outcome to a finished run', () => {
    expect(rowSentence(row({ kind: 'run-finished', outcome: 'failed' }))).toBe(
      'Run finished — failed',
    );
  });

  it('reads the version out of a release row', () => {
    expect(
      rowSentence(row({ kind: 'release-published', outcome: null, detail: { version: '1.2.3' } })),
    ).toBe('Released v1.2.3');
  });

  it('reads from/to out of a moved row', () => {
    expect(
      rowSentence(
        row({ kind: 'status-moved', outcome: null, detail: { from: 'To Do', to: 'Done' } }),
      ),
    ).toBe('Moved To Do → Done');
  });

  it('falls back to the bare verb when detail is missing', () => {
    expect(rowSentence(row({ kind: 'release-published', outcome: null, detail: null }))).toBe(
      'Released',
    );
  });
});

describe('originLabel', () => {
  it('maps every fixed origin and the trigger template', () => {
    expect(originLabel('human')).toBe('You');
    expect(originLabel('chain')).toBe('Chain');
    expect(originLabel('resume')).toBe('Resume');
    expect(originLabel('auto-release')).toBe('Auto-release');
    expect(originLabel('trigger:abc')).toBe('Trigger');
    expect(originLabel(null)).toBeNull();
  });
});

describe('formatCost', () => {
  it('renders null as an em dash, never $0.00', () => {
    expect(formatCost(null)).toBe('—');
  });

  it('renders a genuine zero distinctly from unknown', () => {
    expect(formatCost(0)).not.toBe('—');
    expect(formatCost(0)).not.toBe('$0.00');
  });

  it('renders small and large costs', () => {
    expect(formatCost(0.0159)).toBe('$0.0159');
    expect(formatCost(12.3)).toBe('$12.30');
  });
});

describe('groupRowsByDay', () => {
  it('labels Today and Yesterday relative to now, in the viewer offset', () => {
    // now = 2026-01-15T10:00:00Z. Viewer is UTC-5 (tzOffsetMinutes: -300), so viewer-local
    // "today" started 2026-01-15T05:00:00Z.
    const now = Date.UTC(2026, 0, 15, 10, 0, 0);
    const todayRow = row({ id: 1, at: Date.UTC(2026, 0, 15, 6, 0, 0) });
    // This row is 2026-01-15T04:00:00Z — before viewer-local midnight, so it is
    // "yesterday" for the viewer even though its UTC calendar date matches todayRow's.
    const yesterdayRow = row({ id: 2, at: Date.UTC(2026, 0, 15, 4, 0, 0) });

    const groups = groupRowsByDay([todayRow, yesterdayRow], { now, tzOffsetMinutes: -300 });

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].rows).toEqual([todayRow]);
    expect(groups[1].rows).toEqual([yesterdayRow]);
  });

  it('labels a day further back with a plain date', () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const oldRow = row({ id: 1, at: Date.UTC(2026, 0, 1, 12, 0, 0) });

    const groups = groupRowsByDay([oldRow], { now, tzOffsetMinutes: 0 });

    expect(groups).toEqual([{ label: '1 Jan 2026', rows: [oldRow] }]);
  });

  it('returns an empty array for no rows', () => {
    expect(groupRowsByDay([], { now: Date.now(), tzOffsetMinutes: 0 })).toEqual([]);
  });
});
