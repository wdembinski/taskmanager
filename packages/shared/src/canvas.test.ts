import { describe, expect, it } from 'vitest';
import { WINDOW_CANVAS, windowSchemeFor } from './canvas';

describe('windowSchemeFor', () => {
  it('lets an explicit light/dark setting win over the OS, both ways', () => {
    expect(windowSchemeFor('light', true)).toBe('light');
    expect(windowSchemeFor('dark', false)).toBe('dark');
  });

  it('follows the OS under system, both ways', () => {
    expect(windowSchemeFor('system', true)).toBe('dark');
    expect(windowSchemeFor('system', false)).toBe('light');
  });

  it('falls back to the OS for a junk or missing value', () => {
    for (const value of [undefined, null, '', 'neon', 42]) {
      expect(windowSchemeFor(value, true)).toBe('dark');
      expect(windowSchemeFor(value, false)).toBe('light');
    }
  });
});

describe('WINDOW_CANVAS', () => {
  it('has a light and dark entry', () => {
    expect(WINDOW_CANVAS.light).toBe('#F7F8FA');
    expect(WINDOW_CANVAS.dark).toBe('#202326');
  });
});
