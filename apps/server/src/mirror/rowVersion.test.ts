import { describe, expect, it } from 'vitest';
import {
  cursorToRowVersion,
  maxRowVersion,
  rowVersionToCursor,
  ZERO_ROWVERSION,
} from './rowVersion';

describe('rowVersionToCursor / cursorToRowVersion', () => {
  it('round-trips a buffer through a cursor string', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0, 42]);
    expect(cursorToRowVersion(rowVersionToCursor(buf))).toEqual(buf);
  });

  it('prefixes the cursor with 0x', () => {
    expect(rowVersionToCursor(Buffer.from([1, 2]))).toBe('0x0102');
  });

  it('accepts a cursor with or without the 0x prefix', () => {
    const withPrefix = cursorToRowVersion('0x0102');
    const withoutPrefix = cursorToRowVersion('0102');
    expect(withPrefix).toEqual(withoutPrefix);
  });
});

describe('maxRowVersion', () => {
  const low = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
  const high = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]);

  it('picks the bytewise-greater of two buffers', () => {
    expect(maxRowVersion(low, high)).toBe(high);
    expect(maxRowVersion(high, low)).toBe(high);
  });

  it('treats null as "no value yet", not as the lowest value', () => {
    expect(maxRowVersion(null, low)).toBe(low);
    expect(maxRowVersion(low, null)).toBe(low);
    expect(maxRowVersion(null, null)).toBeNull();
  });
});

describe('ZERO_ROWVERSION', () => {
  it('is 8 bytes of zero', () => {
    expect(ZERO_ROWVERSION).toEqual(Buffer.alloc(8, 0));
  });
});
