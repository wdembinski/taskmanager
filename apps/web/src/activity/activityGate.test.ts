import { describe, expect, it } from 'vitest';
import { activityGate } from './activityGate';

describe('activityGate', () => {
  it('is unreachable when pollError is set, regardless of presence', () => {
    expect(
      activityGate({
        pollError: 'board read failed (401)',
        presence: 'online',
        targetClientId: 'abc',
      }),
    ).toEqual({ kind: 'unreachable', message: 'board read failed (401)' });
  });

  it('ranks pollError over an offline presence', () => {
    expect(
      activityGate({ pollError: 'Failed to fetch', presence: 'offline', targetClientId: null }),
    ).toEqual({ kind: 'unreachable', message: 'Failed to fetch' });
  });

  it('is unreachable when presence is offline and there is no pollError', () => {
    const result = activityGate({ pollError: null, presence: 'offline', targetClientId: 'abc' });
    expect(result.kind).toBe('unreachable');
  });

  it('is checking while presence is still unknown', () => {
    expect(activityGate({ pollError: null, presence: 'unknown', targetClientId: null })).toEqual({
      kind: 'checking',
    });
  });

  it('is checking when presence is online but no target has been picked yet', () => {
    expect(activityGate({ pollError: null, presence: 'online', targetClientId: null })).toEqual({
      kind: 'checking',
    });
  });

  it('is ready once presence is online and a target exists', () => {
    expect(
      activityGate({ pollError: null, presence: 'online', targetClientId: 'desktop-1' }),
    ).toEqual({ kind: 'ready' });
  });
});
