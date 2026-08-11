import { describe, expect, it } from 'vitest';
import { DEFAULT_BODY_LIMIT, bodyLimit, isBodyLimit } from './bodyLimit';

describe('bodyLimit', () => {
  it("defaults well past express's 100 kB, which is what 413'd a sync backfill", () => {
    expect(bodyLimit({})).toBe(DEFAULT_BODY_LIMIT);
    expect(DEFAULT_BODY_LIMIT).toBe('8mb');
  });

  it('honours a configured override', () => {
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '32mb' })).toBe('32mb');
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '512kb' })).toBe('512kb');
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '1048576' })).toBe('1048576');
  });

  it('trims and lowercases, because an env var is pasted by hand', () => {
    expect(bodyLimit({ CLOUD_BODY_LIMIT: ' 16MB ' })).toBe('16mb');
  });

  it('falls back to the default rather than refusing to boot on nonsense', () => {
    // A typo in a size string must not take the whole API down; main.ts prints the
    // rejection instead, so it is still findable.
    expect(bodyLimit({ CLOUD_BODY_LIMIT: 'lots' })).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '8 mb' })).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '-1mb' })).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '   ' })).toBe(DEFAULT_BODY_LIMIT);
  });

  it('refuses a zero limit, which would reject every request', () => {
    expect(isBodyLimit('0')).toBe(false);
    expect(isBodyLimit('0mb')).toBe(false);
    expect(bodyLimit({ CLOUD_BODY_LIMIT: '0' })).toBe(DEFAULT_BODY_LIMIT);
  });

  it('recognises the sizes it accepts', () => {
    expect(isBodyLimit('8mb')).toBe(true);
    expect(isBodyLimit('1.5gb')).toBe(true);
    expect(isBodyLimit('2048')).toBe(true);
    expect(isBodyLimit('8mib')).toBe(false);
  });
});
