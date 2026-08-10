import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, isOnPalette, normalizeHex } from './color';
import { PALETTE } from './ColorSwatches';

describe('normalizeHex', () => {
  it('accepts the four spellings of the same colour', () => {
    for (const input of ['#aabbcc', 'aabbcc', '#AABBCC', '  #AaBbCc  ']) {
      expect(normalizeHex(input)).toBe('#aabbcc');
    }
  });

  it('expands shorthand, so two spellings of one colour compare equal', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('#abc')).toBe(normalizeHex('#aabbcc'));
  });

  it('rejects anything that is not a 3- or 6-digit hex', () => {
    for (const bad of [
      '',
      '#',
      '#ab',
      '#abcd', // 4-digit alpha shorthand
      '#abcde',
      '#abcdefa',
      '#aabbccdd', // 8-digit alpha
      'red',
      'rgb(1,2,3)',
      '#gggggg',
      '#12 34 56',
      'javascript:alert(1)',
      '#aabbcc; background: url(x)',
    ]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe('isOnPalette', () => {
  it('recognises every palette colour, however it is spelled', () => {
    for (const color of PALETTE) {
      expect(isOnPalette(color)).toBe(true);
      expect(isOnPalette(color.toLowerCase().replace('#', ''))).toBe(true);
    }
  });

  it('is false for an off-palette colour and for junk', () => {
    expect(isOnPalette('#123456')).toBe(false);
    expect(isOnPalette('')).toBe(false);
    expect(isOnPalette('nope')).toBe(false);
  });
});

describe('hexToHsv / hsvToHex', () => {
  it('round-trips every palette colour without drift', () => {
    for (const color of PALETTE) {
      const hsv = hexToHsv(color);
      expect(hsv).not.toBeNull();
      expect(hsvToHex(hsv!)).toBe(color.toLowerCase());
    }
  });

  it('gets the primaries and the greys right', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });

    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe('#0000ff');
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe('#ffffff');
  });

  it('clamps out-of-range values instead of emitting a broken hex', () => {
    expect(hsvToHex({ h: 720, s: 5, v: 5 })).toBe('#ff0000');
    expect(hsvToHex({ h: -60, s: -1, v: 0.5 })).toBe('#808080');
  });

  it('returns null for a hex it cannot read', () => {
    expect(hexToHsv('nope')).toBeNull();
  });
});
