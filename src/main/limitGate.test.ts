/**
 * Unit tests for the usage-limit gate. The pure classifiers are checked directly;
 * the `LimitGate` state machine runs against a MOCK CLOCK and a fake timer, so we
 * can drive "the reset time arrives" instantly without any real waiting — exactly
 * the "gate transition logic is unit-tested with a mock clock" the roadmap asks
 * for.
 */
import { describe, expect, it } from 'vitest';
import { classifyLimit, computeResumeAt, LimitGate, type LimitGateDeps } from './limitGate';
import type { LimitState } from '@shared/limit';

describe('classifyLimit', () => {
  it('recognizes the weekly cap by its wording', () => {
    expect(classifyLimit('weekly')).toBe('weekly');
    expect(classifyLimit('seven_day')).toBe('weekly');
    expect(classifyLimit('opus_7d')).toBe('weekly');
  });

  it('treats the 5-hour window (and anything unknown) as rolling', () => {
    expect(classifyLimit('five_hour')).toBe('rolling');
    expect(classifyLimit('default')).toBe('rolling');
    expect(classifyLimit('')).toBe('rolling');
  });
});

describe('computeResumeAt', () => {
  const now = 1_000_000;

  it('uses the CLI reset time (seconds → ms) plus jitter', () => {
    // resetsAt is in seconds; 2000s = 2_000_000ms, comfortably after `now`.
    expect(computeResumeAt(2000, 'rolling', now, 500)).toBe(2_000_500);
  });

  it('never resumes in the past — clamps a stale reset to now', () => {
    expect(computeResumeAt(1, 'rolling', now, 0)).toBe(now);
  });

  it('falls back to a conservative wait when the reset time is unknown', () => {
    expect(computeResumeAt(null, 'rolling', now, 0)).toBe(now + 5 * 60 * 60 * 1000);
    expect(computeResumeAt(null, 'weekly', now, 0)).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });
});

/** A fake timer + clock so gate transitions can be driven synchronously. */
function harness(startNow = 0) {
  let clock = startNow;
  let scheduled: { at: number; cb: () => void } | null = null;
  const changes: Array<LimitState | null> = [];
  const resumed: LimitState[] = [];

  const deps: LimitGateDeps = {
    now: () => clock,
    jitter: () => 0, // deterministic: no jitter in tests
    setTimer: (ms, cb) => {
      scheduled = { at: clock + ms, cb };
      return scheduled;
    },
    clearTimer: () => {
      scheduled = null;
    },
    onResumeDue: (state) => resumed.push(state),
    onChanged: (state) => changes.push(state),
  };

  return {
    gate: new LimitGate(deps),
    changes,
    resumed,
    /** Advance the clock; fire the timer if its deadline has passed. */
    advanceTo(t: number) {
      clock = t;
      if (scheduled && clock >= scheduled.at) {
        const { cb } = scheduled;
        scheduled = null;
        cb();
      }
    },
    hasTimer: () => scheduled !== null,
  };
}

describe('LimitGate', () => {
  const rolling = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 100 };

  it('engages on a non-allowed signal, parking the given tasks', () => {
    const h = harness(0);
    const state = h.gate.engage(rolling, ['t1', 't2']);
    expect(h.gate.active).toBe(true);
    expect(state).toMatchObject({
      limitType: 'rolling',
      resetsAt: 100,
      resumeAt: 100_000, // 100s → ms, no jitter
      parkedTaskIds: ['t1', 't2'],
    });
    expect(h.changes).toEqual([state]);
  });

  it('ignores an "allowed" signal (the limit is not in force)', () => {
    const h = harness(0);
    expect(h.gate.engage({ ...rolling, status: 'allowed' }, ['t1'])).toBeNull();
    expect(h.gate.active).toBe(false);
    expect(h.changes).toEqual([]);
  });

  it('resumes the parked set when the reset time arrives, then clears', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1', 't2']);
    expect(h.resumed).toEqual([]);

    h.advanceTo(100_000); // reach resumeAt → timer fires
    expect(h.resumed).toHaveLength(1);
    expect(h.resumed[0].parkedTaskIds).toEqual(['t1', 't2']);
    expect(h.gate.active).toBe(false);
    expect(h.changes.at(-1)).toBeNull(); // last change clears the gate
  });

  it('merges a second limit: waits for the LATER reset and prefers weekly', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1']); // resets at 100s
    h.gate.engage({ status: 'rejected', rateLimitType: 'weekly', resetsAt: 500 }, ['t2']);

    const state = h.gate.state!;
    expect(state.limitType).toBe('weekly');
    expect(state.resumeAt).toBe(500_000); // the later of 100s / 500s
    expect(state.parkedTaskIds).toEqual(['t1', 't2']);

    // The earlier reset must NOT trigger a resume.
    h.advanceTo(100_000);
    expect(h.resumed).toEqual([]);
    h.advanceTo(500_000);
    expect(h.resumed).toHaveLength(1);
  });

  it('restore() re-arms the timer and fires immediately if the reset already passed', () => {
    const persisted: LimitState = {
      limitType: 'rolling',
      resetsAt: 100,
      resumeAt: 100_000,
      parkedTaskIds: ['t1'],
    };
    const h = harness(200_000); // "now" is already past resumeAt (app was closed)
    h.gate.restore(persisted);
    // arm() scheduled a 0ms timer; advancing (even to the same instant) fires it.
    h.advanceTo(200_000);
    expect(h.resumed).toEqual([persisted]);
    expect(h.gate.active).toBe(false);
  });

  it('unpark() drops tasks without lifting the gate', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1', 't2', 't3']);
    h.gate.unpark(['t2']);
    expect(h.gate.state!.parkedTaskIds).toEqual(['t1', 't3']);
    expect(h.gate.active).toBe(true);
  });

  it('dispose() cancels the timer and never resumes', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1']);
    h.gate.dispose();
    expect(h.gate.active).toBe(false);
    expect(h.hasTimer()).toBe(false);
    h.advanceTo(100_000);
    expect(h.resumed).toEqual([]);
  });
});
