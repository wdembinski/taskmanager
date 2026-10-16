import { describe, expect, it } from 'vitest';
import { parseFold } from './deviceFold';

describe('parseFold', () => {
  it('reads "1" and "0" as true and false', () => {
    expect(parseFold('1', false)).toBe(true);
    expect(parseFold('0', true)).toBe(false);
  });

  it('falls back for a never-written key', () => {
    expect(parseFold(null, true)).toBe(true);
    expect(parseFold(undefined, false)).toBe(false);
  });

  it('falls back for anything that is not "1" or "0"', () => {
    expect(parseFold('true', false)).toBe(false);
    expect(parseFold('garbage', true)).toBe(true);
  });
});
