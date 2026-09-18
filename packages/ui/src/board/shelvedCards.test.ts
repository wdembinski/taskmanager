import { describe, expect, it } from 'vitest';
import { ensureShelvedCard, shelvedCardSet, toggleShelvedCard } from './shelvedCards';

const board = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('toggleShelvedCard', () => {
  it('shelves a card that was on the board', () => {
    expect(toggleShelvedCard([], 'a', board('a', 'b'))).toEqual(['a']);
  });

  it('returns a shelved card to the board', () => {
    expect(toggleShelvedCard(['a', 'b'], 'a', board('a', 'b'))).toEqual(['b']);
  });

  it('keeps the order of the cards it leaves alone', () => {
    expect(toggleShelvedCard(['a', 'b'], 'c', board('a', 'b', 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('drops ids that have left the board', () => {
    expect(toggleShelvedCard(['gone', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });

  it('does not drop the card being shelved just because the list is stale', () => {
    expect(toggleShelvedCard(['gone'], 'a', board('a'))).toEqual(['a']);
  });

  it('collapses a duplicated id rather than leaving a copy shelved', () => {
    expect(toggleShelvedCard(['a', 'a'], 'a', board('a'))).toEqual([]);
    expect(toggleShelvedCard(['a', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });
});

describe('ensureShelvedCard', () => {
  it('adds a card that was not shelved', () => {
    expect(ensureShelvedCard([], 'a', board('a', 'b'))).toEqual(['a']);
  });

  it('is idempotent for a card that is already shelved', () => {
    expect(ensureShelvedCard(['a'], 'a', board('a', 'b'))).toEqual(['a']);
  });

  it('keeps the order of the cards it leaves alone', () => {
    expect(ensureShelvedCard(['a', 'b'], 'c', board('a', 'b', 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('drops ids that have left the board', () => {
    expect(ensureShelvedCard(['gone', 'a'], 'b', board('a', 'b'))).toEqual(['a', 'b']);
  });

  it('collapses a duplicated id rather than leaving a copy shelved', () => {
    expect(ensureShelvedCard(['a', 'a'], 'a', board('a'))).toEqual(['a']);
  });
});

describe('shelvedCardSet', () => {
  it('answers for a card in the list', () => {
    expect(shelvedCardSet(['a']).has('a')).toBe(true);
    expect(shelvedCardSet(['a']).has('b')).toBe(false);
  });

  it('is empty when nothing has been saved yet', () => {
    expect(shelvedCardSet(undefined).size).toBe(0);
  });
});
