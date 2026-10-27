/**
 * Collected by the root `vitest.config.ts` the same way `apiStub.test.mjs` is. Covers a `'web'`
 * row's `channelOverrides` as the relay answers them: the per-arg spec's `argIndex`, and an
 * override winning over one of the relay's own explicit channel cases.
 */
import { describe, expect, it } from 'vitest';
import { answerFromBootChannels, handleIpcInvoke } from './fakeRelay.mjs';

const FIXTURE = { BOOT_CHANNELS: { 'task:get': { byArgTable: { a: 'A' }, fallback: 'none' } } };

describe('answerFromBootChannels', () => {
  it('keys on the first argument by default', () => {
    expect(answerFromBootChannels(FIXTURE.BOOT_CHANNELS, 'task:get', ['a', 'z'])).toBe('A');
  });

  it('keys on the argument argIndex names', () => {
    const spec = { byArgTable: { 'src/a.ts': 'A' }, fallback: 'none', argIndex: 2 };
    const channels = { 'review:subjectFile': spec };

    expect(answerFromBootChannels(channels, 'review:subjectFile', ['s', 'd', 'src/a.ts'])).toBe(
      'A',
    );
    expect(answerFromBootChannels(channels, 'review:subjectFile', ['src/a.ts', 'd', 'x'])).toBe(
      'none',
    );
  });
});

describe('handleIpcInvoke channelOverrides', () => {
  const state = () => ({ channelOverrides: {}, diffSummaries: new Map() });

  it('answers an explicit channel from the relay when nothing overrides it', () => {
    expect(handleIpcInvoke(state(), FIXTURE, 'task:diffSummary', ['t1'])).toEqual({
      ok: true,
      value: { status: 'no-branch' },
    });
  });

  it('lets a row override win over an explicit channel case', () => {
    const s = state();
    s.channelOverrides = { 'task:diffSummary': { byArgTable: { t1: 'ok' }, fallback: 'miss' } };

    expect(handleIpcInvoke(s, FIXTURE, 'task:diffSummary', ['t1']).value).toBe('ok');
    expect(handleIpcInvoke(s, FIXTURE, 'task:diffSummary', ['t2']).value).toBe('miss');
  });
});
