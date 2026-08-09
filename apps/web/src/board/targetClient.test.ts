import { describe, expect, it } from 'vitest';
import { resolveTargetClientId } from './targetClient';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('resolveTargetClientId', () => {
  it('is null for an account that has never had a live desktop Client', () => {
    expect(resolveTargetClientId(fakeStorage(), [])).toBeNull();
  });

  it('picks the most recently seen live Client', () => {
    const storage = fakeStorage();
    const id = resolveTargetClientId(storage, [
      { id: 'desktop-1', lastSeen: 100 },
      { id: 'desktop-2', lastSeen: 50 },
    ]);
    expect(id).toBe('desktop-1');
  });

  it('remembers the last-known Client once the live list goes empty', () => {
    const storage = fakeStorage();
    resolveTargetClientId(storage, [{ id: 'desktop-1', lastSeen: 100 }]);
    expect(resolveTargetClientId(storage, [])).toBe('desktop-1');
  });
});
