import { describe, expect, it } from 'vitest';
import { foldedCardSet, toggleFoldedCard } from './foldedSteps';

const board = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('toggleFoldedCard', () => {
  it('folds a card that was open', () => {
    expect(toggleFoldedCard([], 'a', board('a', 'b'))).toEqual(['a']);
  });

  it('unfolds a card that was folded', () => {
    expect(toggleFoldedCard(['a', 'b'], 'a', board('a', 'b'))).toEqual(['b']);
  });

  it('keeps the order of the cards it leaves alone', () => {
    expect(toggleFoldedCard(['a', 'b'], 'c', board('a', 'b', 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('drops ids that have left the board', () => {
    // `gone` was folded before its card was deleted (or archived, or dropped by a sync);
    // the next write is the moment it stops being carried.
    expect(toggleFoldedCard(['gone', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });

  it('does not drop the card being folded just because the list is stale', () => {
    expect(toggleFoldedCard(['gone'], 'a', board('a'))).toEqual(['a']);
  });

  it('collapses a duplicated id rather than leaving a copy folded', () => {
    expect(toggleFoldedCard(['a', 'a'], 'a', board('a'))).toEqual([]);
    expect(toggleFoldedCard(['a', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });
});

describe('foldedCardSet', () => {
  it('answers for a card in the list', () => {
    expect(foldedCardSet(['a']).has('a')).toBe(true);
    expect(foldedCardSet(['a']).has('b')).toBe(false);
  });

  it('is empty when nothing has been saved yet', () => {
    expect(foldedCardSet(undefined).size).toBe(0);
  });
});
