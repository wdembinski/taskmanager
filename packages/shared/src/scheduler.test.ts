import { describe, expect, it } from 'vitest';
import {
  CARD_RECORDS_PARK,
  RUN_REFUSAL_MESSAGE,
  isParkedRefusal,
  type ParkedRefusal,
  type RunRefusal,
} from './scheduler';

/**
 * Every refusal the engine can give, written out by hand.
 *
 * The annotation is half the test: adding a member to `RunRefusal` without adding it here
 * is not a type error (a short array still satisfies `RunRefusal[]`), but the totality
 * checks below then fail on the count — which is the point. Removing or misspelling one
 * IS a type error. Between the two, a new refusal cannot reach a human unworded.
 */
const ALL_REFUSALS: RunRefusal[] = [
  'unknown-task',
  'already-running',
  'no-project',
  'limit',
  'signed-out',
  'shutting-down',
];

const PARKED: ParkedRefusal[] = ['limit', 'signed-out'];

describe('RUN_REFUSAL_MESSAGE', () => {
  // The whole reason the refusal is a value: the human's next action is chosen entirely
  // from this sentence, so a refusal with no sentence is worse than the `null` it replaced.
  it('says something for every refusal, and nothing more', () => {
    expect(Object.keys(RUN_REFUSAL_MESSAGE).sort()).toEqual([...ALL_REFUSALS].sort());
    for (const refusal of ALL_REFUSALS) {
      expect(RUN_REFUSAL_MESSAGE[refusal].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('isParkedRefusal', () => {
  it('is true for exactly the two gates', () => {
    expect(ALL_REFUSALS.filter(isParkedRefusal)).toEqual(PARKED);
  });

  /**
   * The agreement that matters. `startTaskNow` parks behind a gate and refuses, and the
   * sentence promises the card starts by itself — so the set that promises a self-start and
   * the set the engine actually parks have to be the same set. If they drift, the app either
   * promises a resume nobody arranged, or leaves a parked card telling its human to press a
   * button the engine is about to press for them.
   */
  it('agrees with the sentence that promises a self-start', () => {
    const promisesSelfStart = ALL_REFUSALS.filter((refusal) =>
      RUN_REFUSAL_MESSAGE[refusal].includes('starts by itself'),
    );
    expect(promisesSelfStart).toEqual(PARKED);
  });

  it('never promises a resume for a refusal that dropped the work', () => {
    for (const refusal of ALL_REFUSALS.filter((r) => !isParkedRefusal(r))) {
      expect(RUN_REFUSAL_MESSAGE[refusal]).not.toMatch(/by itself|waiting behind/);
    }
  });
});

describe('CARD_RECORDS_PARK', () => {
  it('answers for every parked refusal, and only those', () => {
    expect(Object.keys(CARD_RECORDS_PARK).sort()).toEqual([...PARKED].sort());
  });

  /**
   * The asymmetry this map exists to state: `parkForLimit` writes `blocked-by-limit` onto
   * the card, `parkForSignIn` deliberately writes no status at all (an auth-parked task
   * stays `pending`, which is what `resumeAfterSignIn` matches on). So a limit park is
   * legible from the task alone and a sign-out park is not — which is why only the former
   * may be reported by returning.
   */
  it('is true for the limit alone', () => {
    expect(CARD_RECORDS_PARK.limit).toBe(true);
    expect(Object.entries(CARD_RECORDS_PARK).filter(([, records]) => records)).toEqual([
      ['limit', true],
    ]);
  });
});
