import { describe, expect, it } from 'vitest';
import {
  BACKOFF_CAP_MS,
  CADENCE_MS,
  PRESENCE_TTL_MS,
  nextPollDelayMs,
  resolveCadence,
  type PresenceBeat,
} from './cadence';

const midpoint = () => 0.5; // jitterFactor === 1 regardless of jitterRatio

describe('resolveCadence', () => {
  it('is idle with reason no-focus for an empty session list', () => {
    expect(resolveCadence([], 0)).toEqual({
      tier: 'idle',
      intervalMs: CADENCE_MS.idle,
      reason: 'no-focus',
    });
  });

  it('is active with reason web-focused when a web session is focused and recent', () => {
    const sessions: PresenceBeat[] = [
      { clientId: 'w1', source: 'web', focused: true, lastSeen: 1_000 },
    ];
    expect(resolveCadence(sessions, 1_000)).toEqual({
      tier: 'active',
      intervalMs: CADENCE_MS.active,
      reason: 'web-focused',
    });
  });

  it('is active with reason client-focused when a desktop session is focused and recent', () => {
    const sessions: PresenceBeat[] = [
      { clientId: 'c1', source: 'client', focused: true, lastSeen: 1_000 },
    ];
    expect(resolveCadence(sessions, 1_000)).toEqual({
      tier: 'active',
      intervalMs: CADENCE_MS.active,
      reason: 'client-focused',
    });
  });

  it('is idle when every session on the account is unfocused', () => {
    const sessions: PresenceBeat[] = [
      { clientId: 'w1', source: 'web', focused: false, lastSeen: 1_000 },
      { clientId: 'c1', source: 'client', focused: false, lastSeen: 1_000 },
    ];
    expect(resolveCadence(sessions, 1_000).reason).toBe('no-focus');
  });

  it('still counts a focused session at exactly the presence TTL boundary', () => {
    const sessions: PresenceBeat[] = [
      { clientId: 'w1', source: 'web', focused: true, lastSeen: 0 },
    ];
    expect(resolveCadence(sessions, PRESENCE_TTL_MS).tier).toBe('active');
  });

  it('drops a focused session the instant it ages past the presence TTL', () => {
    const sessions: PresenceBeat[] = [
      { clientId: 'w1', source: 'web', focused: true, lastSeen: 0 },
    ];
    expect(resolveCadence(sessions, PRESENCE_TTL_MS + 1)).toEqual({
      tier: 'idle',
      intervalMs: CADENCE_MS.idle,
      reason: 'no-focus',
    });
  });
});

describe('nextPollDelayMs', () => {
  it('picks the server interval when it is faster than the local tier', () => {
    const delay = nextPollDelayMs({
      serverIntervalMs: 1_000,
      localFocused: false,
      consecutiveFailures: 0,
      jitterRatio: 0,
      random: midpoint,
    });
    expect(delay).toBe(1_000);
  });

  it('picks the local active tier when it is faster than the server interval', () => {
    const delay = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.idle,
      localFocused: true,
      consecutiveFailures: 0,
      jitterRatio: 0,
      random: midpoint,
    });
    expect(delay).toBe(CADENCE_MS.active);
  });

  it('grows the delay exponentially with consecutive failures', () => {
    const delay = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.idle,
      localFocused: false,
      consecutiveFailures: 2,
      jitterRatio: 0,
      random: midpoint,
    });
    expect(delay).toBe(CADENCE_MS.idle * 4);
  });

  it('caps exponential backoff at BACKOFF_CAP_MS', () => {
    const delay = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.idle,
      localFocused: false,
      consecutiveFailures: 20,
      jitterRatio: 0,
      random: midpoint,
    });
    expect(delay).toBe(BACKOFF_CAP_MS);
  });

  it('never jitters the active tier, no matter how high jitterRatio is', () => {
    const delay = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.active,
      localFocused: true,
      consecutiveFailures: 0,
      jitterRatio: 1,
      random: () => 0,
    });
    expect(delay).toBe(CADENCE_MS.active);
  });

  it('jitters the idle tier within ±jitterRatio', () => {
    const jitterRatio = 0.2;
    const low = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.idle,
      localFocused: false,
      consecutiveFailures: 0,
      jitterRatio,
      random: () => 0,
    });
    const high = nextPollDelayMs({
      serverIntervalMs: CADENCE_MS.idle,
      localFocused: false,
      consecutiveFailures: 0,
      jitterRatio,
      random: () => 1,
    });
    expect(low).toBe(Math.round(CADENCE_MS.idle * (1 - jitterRatio)));
    expect(high).toBe(Math.round(CADENCE_MS.idle * (1 + jitterRatio)));
  });
});
