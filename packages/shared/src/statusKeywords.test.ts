import { describe, expect, it } from 'vitest';
import { statusNoteColor, type StatusKeyword } from './statusKeywords';

const vocab: StatusKeyword[] = [
  { keyword: 'blocked', color: '#E5484D' },
  { keyword: 'review', color: '#30A46C' },
];

describe('statusNoteColor', () => {
  it('paints a note containing a keyword', () => {
    expect(statusNoteColor('blocked on the cert renewal', vocab)).toBe('#E5484D');
  });

  it('ignores case on both sides', () => {
    expect(statusNoteColor('BLOCKED on infra', vocab)).toBe('#E5484D');
    expect(statusNoteColor('blocked', [{ keyword: 'BLOCKED', color: '#fff' }])).toBe('#fff');
  });

  it('matches inside a longer word, so "blocker" counts as "blocked" would not', () => {
    expect(statusNoteColor('waiting for review', vocab)).toBe('#30A46C');
    expect(statusNoteColor('reviewing the PR now', vocab)).toBe('#30A46C');
  });

  // Order is how the user says which meaning wins.
  it('lets the first keyword in the list win', () => {
    expect(statusNoteColor('blocked until review', vocab)).toBe('#E5484D');
    expect(statusNoteColor('blocked until review', [...vocab].reverse())).toBe('#30A46C');
  });

  it('is null when nothing matches, so the note keeps the ordinary colour', () => {
    expect(statusNoteColor('reproduced, fixing now', vocab)).toBeNull();
  });

  it('is null with no note or no vocabulary', () => {
    expect(statusNoteColor(null, vocab)).toBeNull();
    expect(statusNoteColor('', vocab)).toBeNull();
    expect(statusNoteColor('blocked', [])).toBeNull();
    expect(statusNoteColor('blocked', undefined)).toBeNull();
  });

  // A blank keyword is a half-typed row in the Settings editor; if it matched, every
  // card on the board would take that colour at once.
  it('never lets a blank keyword or a colourless row match everything', () => {
    expect(statusNoteColor('anything at all', [{ keyword: '   ', color: '#fff' }])).toBeNull();
    expect(statusNoteColor('anything at all', [{ keyword: 'any', color: '' }])).toBeNull();
  });
});
