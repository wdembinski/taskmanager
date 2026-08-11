import { describe, expect, it } from 'vitest';
import { foldedStepsSet, toggleFoldedSteps } from './foldedSteps';

const board = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('toggleFoldedSteps', () => {
  it('folds a card that was open', () => {
    expect(toggleFoldedSteps([], 'a', board('a', 'b'))).toEqual(['a']);
  });

  it('unfolds a card that was folded', () => {
    expect(toggleFoldedSteps(['a', 'b'], 'a', board('a', 'b'))).toEqual(['b']);
  });

  it('keeps the order of the cards it leaves alone', () => {
    expect(toggleFoldedSteps(['a', 'b'], 'c', board('a', 'b', 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('drops ids that have left the board', () => {
    // `gone` was folded before its card was deleted (or archived, or dropped by a sync);
    // the next write is the moment it stops being carried.
    expect(toggleFoldedSteps(['gone', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });

  it('does not drop the card being folded just because the list is stale', () => {
    expect(toggleFoldedSteps(['gone'], 'a', board('a'))).toEqual(['a']);
  });

  it('collapses a duplicated id rather than leaving a copy folded', () => {
    expect(toggleFoldedSteps(['a', 'a'], 'a', board('a'))).toEqual([]);
    expect(toggleFoldedSteps(['a', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });
});

describe('foldedStepsSet', () => {
  it('answers for a card in the list', () => {
    expect(foldedStepsSet(['a']).has('a')).toBe(true);
    expect(foldedStepsSet(['a']).has('b')).toBe(false);
  });

  it('is empty when nothing has been saved yet', () => {
    expect(foldedStepsSet(undefined).size).toBe(0);
  });
});
