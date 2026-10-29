/**
 * Collected by the root `vitest.config.ts` the same way `shotModules.test.mjs` is. Covers the
 * per-arg spec's `argIndex` twice: in `partitionChannels`, and in the built in-page stub itself,
 * evaluated against a bare `window` so the lookup a real row hits is the one under test.
 */
import { describe, expect, it } from 'vitest';
import { buildApiStub, partitionChannels } from './apiStub.mjs';

/** Evaluates `buildApiStub`'s script against a fresh `window` and returns its `window.api`. */
function stubApi(bootChannels) {
  const script = buildApiStub({
    defaultSettings: { board: {} },
    fixture: { SETTINGS_OVERRIDES: {}, BOOT_CHANNELS: bootChannels },
  });
  const window = {};
  new Function('window', script)(window);
  return window.api;
}

describe('partitionChannels', () => {
  it('defaults argIndex to 0', () => {
    const { byArg } = partitionChannels({ 'task:get': { byArgTable: { a: 1 }, fallback: null } });

    expect(byArg['task:get']).toEqual({ table: { a: 1 }, fallback: null, argIndex: 0 });
  });

  it('keeps an explicit argIndex', () => {
    const { byArg } = partitionChannels({
      'review:subjectFile': { byArgTable: { 'src/a.ts': 1 }, fallback: null, argIndex: 2 },
    });

    expect(byArg['review:subjectFile'].argIndex).toBe(2);
  });
});

describe('buildApiStub boot', () => {
  it('hands the merged settings and material to window.api.boot', () => {
    const window = {};
    new Function(
      'window',
      buildApiStub({
        defaultSettings: {
          board: {},
          appearance: 'system',
          transparency: 'system',
          fontSizePx: 14,
        },
        fixture: { SETTINGS_OVERRIDES: {}, BOOT_CHANNELS: {} },
        settingsOverrides: { appearance: 'dark', transparency: 'full' },
        nativeMaterial: 'mica',
      }),
    )(window);

    expect(window.api.boot).toEqual({
      appearance: 'dark',
      transparency: 'full',
      fontSizePx: 14,
      nativeMaterial: 'mica',
    });
  });

  it('defaults the material to none', () => {
    expect(stubApi({}).boot.nativeMaterial).toBeNull();
  });
});

describe('buildApiStub per-arg lookup', () => {
  it('keys on the first argument by default', async () => {
    const api = stubApi({ 'task:get': { byArgTable: { a: 'A', b: 'B' }, fallback: 'none' } });

    expect(await api.invoke('task:get', 'b', 'a')).toBe('B');
    expect(await api.invoke('task:get', 'z', 'a')).toBe('none');
  });

  it('keys on the argument argIndex names', async () => {
    const api = stubApi({
      'review:subjectFile': {
        byArgTable: { 'src/a.ts': 'A', 'src/b.ts': 'B' },
        fallback: 'none',
        argIndex: 2,
      },
    });

    expect(await api.invoke('review:subjectFile', 'gl-7-412', 'diff-1', 'src/b.ts')).toBe('B');
    // The first argument matching a table key must not win when argIndex points elsewhere.
    expect(await api.invoke('review:subjectFile', 'src/a.ts', 'diff-1', 'src/x.ts')).toBe('none');
  });
});
