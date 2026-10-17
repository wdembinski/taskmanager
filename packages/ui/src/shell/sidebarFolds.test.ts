import { describe, expect, it } from 'vitest';
import { parseFolds, serializeFolds } from './sidebarFolds';

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
