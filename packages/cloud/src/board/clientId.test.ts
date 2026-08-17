import { describe, expect, it } from 'vitest';
import { getOrCreateClientId } from './clientId';

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

describe('getOrCreateClientId', () => {
  it('mints a web-prefixed id when none is stored', () => {
    const id = getOrCreateClientId(fakeStorage());
    expect(id).toMatch(/^web-/);
  });

  it('persists the minted id for the next call', () => {
    const storage = fakeStorage();
    const first = getOrCreateClientId(storage);
    const second = getOrCreateClientId(storage);
    expect(second).toBe(first);
  });

  it('reuses an id already on file', () => {
    const storage = fakeStorage();
    storage.setItem('tm.cloud.clientId', 'web-existing');
    expect(getOrCreateClientId(storage)).toBe('web-existing');
  });
});
