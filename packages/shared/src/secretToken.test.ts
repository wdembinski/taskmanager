import { describe, expect, it } from 'vitest';
import { sanitizeToken, tokenHadNoise } from './secretToken';

/**
 * Built by code point rather than typed: the whole point of these characters is that they
 * are invisible, and a test whose intent you cannot see in the source is no test at all.
 */
const ch = (code: number): string => String.fromCharCode(code);
const NBSP = ch(0x00a0);
const ZERO_WIDTH_SPACE = ch(0x200b);
const ZERO_WIDTH_JOINER = ch(0x200d);
const BOM = ch(0xfeff);

describe('sanitizeToken', () => {
  it('leaves a clean token exactly as it is', () => {
    expect(sanitizeToken('ATATT3xFfGF0abc-123_XY=')).toBe('ATATT3xFfGF0abc-123_XY=');
    expect(tokenHadNoise('ATATT3xFfGF0abc-123_XY=')).toBe(false);
  });

  it.each([
    ['a trailing newline', 'abc123\n'],
    ['a leading space', ' abc123'],
    ['whitespace at both ends', '\t abc123 \r\n'],
    ['a soft-wrapped paste', 'abc\n123'],
    ['a non-breaking space', `abc${NBSP}123`],
    ['a zero-width space', `abc${ZERO_WIDTH_SPACE}123`],
    ['a zero-width joiner', `abc${ZERO_WIDTH_JOINER}123`],
    ['a byte-order mark', `${BOM}abc123`],
  ])('strips %s — the invisible reason a valid token 401s', (_label, raw) => {
    expect(sanitizeToken(raw)).toBe('abc123');
    expect(tokenHadNoise(raw)).toBe(true);
  });

  it('keeps every character a token is actually made of', () => {
    const token = 'AbC-123_x.y=+/~';
    expect(sanitizeToken(` ${token}\n`)).toBe(token);
  });
});
