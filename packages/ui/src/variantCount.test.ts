import { describe, expect, it } from 'vitest';
import { variantCountNote } from './variantCount';

describe('variantCountNote', () => {
  it('says nothing for ×1 — that is Assign agent as it always was, not a variant group', () => {
    expect(variantCountNote(1, 1)).toBeNull();
    expect(variantCountNote(1, 5)).toBeNull();
  });

  it('counts the sessions for ×2/×3 when the project can run them all at once', () => {
    expect(variantCountNote(2, 2)).toBe('≈ 2 sessions');
    expect(variantCountNote(3, 3)).toBe('≈ 3 sessions');
    expect(variantCountNote(3, 5)).toBe('≈ 3 sessions');
  });

  it('adds the sequential note when the project’s concurrency is below the count', () => {
    expect(variantCountNote(3, 1)).toBe('≈ 3 sessions — runs one after another');
    expect(variantCountNote(2, 1)).toBe('≈ 2 sessions — runs one after another');
  });
});
