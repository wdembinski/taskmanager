import { describe, expect, it } from 'vitest';
import { isFolded, parseFolds, serializeFolds, toggleStoredFold } from './sidebarFolds';

describe('parseFolds', () => {
  it('reads back a JSON array of ids', () => {
    expect(parseFolds('["milestone:m1","epic:m1:e1"]')).toEqual(['milestone:m1', 'epic:m1:e1']);
  });

  it('falls back to [] for a never-written key', () => {
    expect(parseFolds(null)).toEqual([]);
    expect(parseFolds(undefined)).toEqual([]);
  });

  it('falls back to [] for invalid JSON', () => {
    expect(parseFolds('not json')).toEqual([]);
  });

  it('falls back to [] for JSON that is not an array', () => {
    expect(parseFolds('{"a":1}')).toEqual([]);
    expect(parseFolds('"just a string"')).toEqual([]);
  });

  it('drops any array element that is not a string', () => {
    expect(parseFolds('["a",1,null,"b"]')).toEqual(['a', 'b']);
  });
});

describe('serializeFolds', () => {
  it('round-trips through parseFolds', () => {
    const folds = ['milestone:m1', 'epic:m1:e1'];
    expect(parseFolds(serializeFolds(folds))).toEqual(folds);
  });

  it('serialises an empty list', () => {
    expect(serializeFolds([])).toBe('[]');
  });
});

describe('isFolded', () => {
  it('returns true when the id is explicitly stored', () => {
    expect(isFolded(new Set(['milestone:m1']), 'milestone:m1', false)).toBe(true);
  });

  it('returns false when the negated id is explicitly stored', () => {
    expect(isFolded(new Set(['!milestone:m1']), 'milestone:m1', true)).toBe(false);
  });

  it('falls back to defaultFolded when neither id nor !id is stored', () => {
    expect(isFolded(new Set(), 'milestone:m1', true)).toBe(true);
    expect(isFolded(new Set(), 'milestone:m1', false)).toBe(false);
  });
});

describe('toggleStoredFold', () => {
  it('adds the id when toggling away from a false default', () => {
    expect(toggleStoredFold([], 'milestone:m1', false)).toEqual(['milestone:m1']);
  });

  it('adds the negated id when toggling away from a true default', () => {
    expect(toggleStoredFold([], 'milestone:m1', true)).toEqual(['!milestone:m1']);
  });

  it('removes the override when toggling back onto the default', () => {
    expect(toggleStoredFold(['milestone:m1'], 'milestone:m1', false)).toEqual([]);
    expect(toggleStoredFold(['!milestone:m1'], 'milestone:m1', true)).toEqual([]);
  });

  it('removes a stale opposite entry before adding the new one', () => {
    expect(toggleStoredFold(['!milestone:m1'], 'milestone:m1', false)).toEqual(['milestone:m1']);
  });

  it('leaves other ids untouched', () => {
    expect(toggleStoredFold(['epic:m1:e1', 'milestone:m1'], 'milestone:m1', false)).toEqual([
      'epic:m1:e1',
    ]);
  });
});
