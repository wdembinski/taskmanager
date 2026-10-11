import { describe, expect, it } from 'vitest';
import {
  type ActivityRow,
  decodeCursor,
  encodeCursor,
  isActivityKind,
  isActivityOrigin,
  isActivityOutcome,
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
