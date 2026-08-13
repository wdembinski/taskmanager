/**
 * Unit tests for the usage-limit gate. The pure classifiers are checked directly;
 * the `LimitGate` state machine runs against a MOCK CLOCK and a fake timer, so we
 * can drive "the reset time arrives" instantly without any real waiting — exactly
 * the "gate transition logic is unit-tested with a mock clock" the roadmap asks
 * for.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLimit,
  computeResumeAt,
  decideLimitPark,
  detectLimitFailure,
  isBlockingLimitStatus,
  LimitGate,
  type LimitDetection,
  type LimitGateDeps,
  type LimitResultSlice,
} from './limitGate';
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

describe('isBlockingLimitStatus', () => {
  it('does NOT park on allowed / approaching-cap warnings / empty status', () => {
    // The false-weekly-park bug: a warning (or missing status) must not engage.
    expect(isBlockingLimitStatus('allowed')).toBe(false);
    expect(isBlockingLimitStatus('allowed_warning')).toBe(false);
    expect(isBlockingLimitStatus('warning')).toBe(false);
    expect(isBlockingLimitStatus('')).toBe(false);
    expect(isBlockingLimitStatus('   ')).toBe(false);
  });

  it('parks only on a hard rejection', () => {
    expect(isBlockingLimitStatus('rejected')).toBe(true);
    expect(isBlockingLimitStatus('rejected_weekly')).toBe(true);
    expect(isBlockingLimitStatus('rate_limited')).toBe(true);
    expect(isBlockingLimitStatus('quota_exceeded')).toBe(true);
    expect(isBlockingLimitStatus('BLOCKED')).toBe(true);
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

/**
 * A run that spent tokens before it stopped — the DEFAULT here, and the difference from
 * `authGate.test.ts`, where a dead start has spent none. A usage limit is hit mid-run, so
 * "no tokens" is never available as corroboration and must never be needed.
 */
const SPENT = {
  inputTokens: 12,
  outputTokens: 340,
  cacheCreationTokens: 0,
  cacheReadTokens: 151_869,
};

/** A `result` slice: a failed run with tokens spent, unless a test says otherwise. */
function result(over: Partial<LimitResultSlice> = {}): LimitResultSlice {
  return {
    success: false,
    resultText: '',
    stopReason: null,
    terminalReason: null,
    usage: SPENT,
    ...over,
  };
}

describe('detectLimitFailure', () => {
  /**
   * The canonical wall. The CLI labels it `api_error` like everything else, and the only
   * thing that names the cause — and the only thing that knows when it clears — is the
   * trailing epoch in `resultText`.
   */
  it('believes the CLI’s own message, epoch and all, from a run that spent tokens', () => {
    const signal = detectLimitFailure(
      result({
        resultText: 'Claude AI usage limit reached|1754870400',
        terminalReason: 'api_error',
        usage: SPENT,
      }),
    );
    expect(signal).toEqual({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: 1_754_870_400,
      tier: 'epoch',
    });
  });

  /** A blocking status, so the gate it feeds actually engages. */
  it('reports a status the gate treats as blocking', () => {
    const signal = detectLimitFailure(result({ resultText: 'Claude AI usage limit reached' }));
    expect(isBlockingLimitStatus(signal!.status)).toBe(true);
  });

  /**
   * The false positive that would hurt most: this repo's own agents write about usage
   * limits all day. A substring test fires on every one of them, so the phrase alone is
   * believed only when it is the WHOLE message.
   */
  it('does not stop the board because an agent wrote about usage limits', () => {
    const agent = result({
      resultText: [
        'Added the limit classifier. The CLI ends such a run with the sentence',
        '"Claude AI usage limit reached", which we now match anchored rather than as a',
        'substring — a bare substring test would have fired on this very answer.',
      ].join('\n'),
      terminalReason: 'error_during_execution',
    });
    expect(detectLimitFailure(agent)).toBeNull();
  });

  it('believes the same sentence when it is the entire message', () => {
    const signal = detectLimitFailure(result({ resultText: '  Claude AI usage limit reached  ' }));
    expect(signal).toMatchObject({ rateLimitType: 'five_hour', resetsAt: null, tier: 'text' });
  });

  /**
   * `api_error` is what a usage limit wears — and what every transient blip wears too.
   * Matching it is how one bad minute of network would park the board for five hours.
   */
  it('is null for the ordinary failures that must stay retryable', () => {
    expect(detectLimitFailure(result({ terminalReason: 'api_error' }))).toBeNull();
    expect(detectLimitFailure(result({ resultText: 'the tests failed: 3 red' }))).toBeNull();
    expect(detectLimitFailure(result())).toBeNull();
  });

  /** A run that finished its work hit no wall, whatever sentence it ended on. */
  it('ignores the exact sentence when the run succeeded', () => {
    expect(
      detectLimitFailure(
        result({ success: true, resultText: 'Claude AI usage limit reached|1754870400' }),
      ),
    ).toBeNull();
  });

  /**
   * Weekly is claimed only from the tier that cannot be prose. Without an epoch the same
   * wording stays rolling: `classifyLimit` matches on `/week/`, so trusting free text here
   * is how the phrase "next week" parks everything for seven days.
   */
  it('claims the weekly window only when an epoch backs the wording', () => {
    expect(
      detectLimitFailure(result({ resultText: 'Claude AI weekly usage limit reached|1754870400' })),
    ).toMatchObject({ rateLimitType: 'weekly', resetsAt: 1_754_870_400 });

    expect(
      detectLimitFailure(
        result({ resultText: 'Claude AI usage limit reached — your weekly limit resets Monday' }),
      ),
    ).toMatchObject({ rateLimitType: 'five_hour', resetsAt: null });
  });

  /** A limit-specific label needs no sentence: nothing else is called `rate_limit_error`. */
  it('reads a limit-specific label even with no message at all', () => {
    expect(detectLimitFailure(result({ terminalReason: 'rate_limit_error' }))).toMatchObject({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: null,
      tier: 'label',
    });
    expect(detectLimitFailure(result({ stopReason: 'rate_limited' }))).not.toBeNull();
    expect(detectLimitFailure(result({ terminalReason: 'http_429' }))).not.toBeNull();
  });
});

describe('decideLimitPark', () => {
  const proof = (over: Partial<LimitDetection> = {}): LimitDetection => ({
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: null,
    tier: 'text',
    ...over,
  });

  it('parks on an epoch no matter what the probe says', () => {
    const epoch = proof({ tier: 'epoch', resetsAt: 1_754_870_400 });
    expect(decideLimitPark(epoch, { sessionPct: 3, weeklyPct: 4 }, 9)).toBe('park');
  });

  it('parks when the probe agrees the window is spent', () => {
    expect(decideLimitPark(proof(), { sessionPct: 97, weeklyPct: 12 }, 0)).toBe('park');
    // …reading the WEEKLY figure when the detection named the weekly window.
    expect(
      decideLimitPark(proof({ rateLimitType: 'weekly' }), { sessionPct: 12, weeklyPct: 99 }, 0),
    ).toBe('park');
  });

  /** The probe contradicts the sentence, and the sentence is the weaker witness. */
  it('asks the human when the probe says there is budget left', () => {
    expect(decideLimitPark(proof(), { sessionPct: 40, weeklyPct: 99 }, 0)).toBe('ask');
    expect(decideLimitPark(proof({ tier: 'label' }), { sessionPct: 94, weeklyPct: null }, 0)).toBe(
      'ask',
    );
  });

  /**
   * No reading at all — offline, CLI busy, `/usage` unavailable. Parking costs a wait;
   * not parking costs a card blamed for the account. So park, but only twice in a row for
   * one task: past that, nothing has ever confirmed this and a human should look.
   */
  it('parks an unverifiable reading, down to the two-in-a-row floor', () => {
    expect(decideLimitPark(proof(), null, 0)).toBe('park');
    expect(decideLimitPark(proof(), null, 1)).toBe('park');
    expect(decideLimitPark(proof(), null, 2)).toBe('ask');
    // A reading that omits the window in question is no reading of that window.
    expect(decideLimitPark(proof(), { sessionPct: null, weeklyPct: 3 }, 0)).toBe('park');
    expect(decideLimitPark(proof(), { sessionPct: null, weeklyPct: 3 }, 2)).toBe('ask');
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

  it('resumeNow() lifts the gate immediately — resumes parked tasks and clears', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1', 't2']); // resumeAt is 100_000, far in the future
    expect(h.resumed).toEqual([]);

    h.gate.resumeNow(); // the "Resume now" button, well before the timer
    expect(h.resumed).toHaveLength(1);
    expect(h.resumed[0].parkedTaskIds).toEqual(['t1', 't2']);
    expect(h.gate.active).toBe(false);
    expect(h.hasTimer()).toBe(false);
    expect(h.changes.at(-1)).toBeNull();
  });

  it('resumeNow() is a no-op when no limit is in force', () => {
    const h = harness(0);
    h.gate.resumeNow();
    expect(h.resumed).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it('park() adds work the limit stopped that was never running', () => {
    const h = harness(0);
    h.gate.engage(rolling, ['t1']);
    // The next step of a chain, which had no run of its own to be parked by `engage`.
    expect(h.gate.park(['s2'])).toEqual(['s2']);
    expect(h.gate.state!.parkedTaskIds).toEqual(['t1', 's2']);
    expect(h.changes.at(-1)).toEqual(h.gate.state); // persisted, so it survives a restart
    // Idempotent: parking the same task twice must not resume it twice at the reset.
    expect(h.gate.park(['s2', 't1'])).toEqual([]);
    expect(h.gate.state!.parkedTaskIds).toEqual(['t1', 's2']);
    h.advanceTo(100_000);
    expect(h.resumed[0].parkedTaskIds).toEqual(['t1', 's2']);
  });

  it('park() is a no-op with no gate up — the caller should just run the task', () => {
    const h = harness(0);
    expect(h.gate.park(['s2'])).toEqual([]);
    expect(h.gate.active).toBe(false);
    expect(h.changes).toEqual([]);
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
