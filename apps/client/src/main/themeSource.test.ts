import { describe, expect, it } from 'vitest';
import { themeSourceFor } from './themeSource';

describe('themeSourceFor', () => {
  it('forces the explicit light and dark settings', () => {
    expect(themeSourceFor('light')).toBe('light');
    expect(themeSourceFor('dark')).toBe('dark');
  });

  it('leaves system on the OS', () => {
    expect(themeSourceFor('system')).toBe('system');
  });

  it('treats a missing or junk value as system', () => {
    expect(themeSourceFor(undefined)).toBe('system');
    expect(themeSourceFor('blue')).toBe('system');
    expect(themeSourceFor(42)).toBe('system');
  });
});
