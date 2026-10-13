import { describe, expect, it } from 'vitest';
import { readWebLastSeen, saveWebLastSeen, webLastSeenKey } from './webLastSeen';

/** A minimal `Storage` a test can inspect without touching `window` — same helper as
 *  `auth/cloudAuth.test.ts`'s `fakeStorage`. */
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

/** A `Storage` whose every method throws — private browsing, a disabled store, a full quota. */
function throwingStorage(): Storage {
  const boom = (name: string) => () => {
    throw new Error(`${name} disabled`);
  };
  return {
    getItem: boom('getItem'),
    setItem: boom('setItem'),
    removeItem: boom('removeItem'),
    clear: boom('clear'),
    key: boom('key'),
    get length(): number {
      throw new Error('length disabled');
    },
  } as Storage;
}

describe('webLastSeenKey', () => {
  it('namespaces the key per desktop', () => {
    expect(webLastSeenKey('desktop-1')).not.toBe(webLastSeenKey('desktop-2'));
  });
});

describe('readWebLastSeen', () => {
  it('reads null with nothing stored yet', () => {
    expect(readWebLastSeen(fakeStorage(), 'desktop-1')).toBeNull();
  });

  it('reads null for a null desktop id, even with something stored', () => {
    const storage = fakeStorage();
    storage.setItem(webLastSeenKey('desktop-1'), JSON.stringify({ at: 1, id: 1 }));
    expect(readWebLastSeen(storage, null)).toBeNull();
  });

  it('reads a corrupt stored value as null rather than throwing', () => {
    const storage = fakeStorage();
    storage.setItem(webLastSeenKey('desktop-1'), 'not json');
    expect(readWebLastSeen(storage, 'desktop-1')).toBeNull();

    storage.setItem(webLastSeenKey('desktop-1'), JSON.stringify({ at: 'nope', id: 1 }));
    expect(readWebLastSeen(storage, 'desktop-1')).toBeNull();

    storage.setItem(webLastSeenKey('desktop-1'), JSON.stringify([1, 2]));
    expect(readWebLastSeen(storage, 'desktop-1')).toBeNull();
  });

  it('never throws when the storage itself throws on getItem', () => {
    expect(() => readWebLastSeen(throwingStorage(), 'desktop-1')).not.toThrow();
    expect(readWebLastSeen(throwingStorage(), 'desktop-1')).toBeNull();
  });
});

describe('saveWebLastSeen', () => {
  it('round-trips the first report through readWebLastSeen', () => {
    const storage = fakeStorage();
    const saved = saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 });
    expect(saved).toEqual({ at: 100, id: 7 });
    expect(readWebLastSeen(storage, 'desktop-1')).toEqual({ at: 100, id: 7 });
  });

  it('is forward-only: an older report never regresses the cursor', () => {
    const storage = fakeStorage();
    saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 });
    const saved = saveWebLastSeen(storage, 'desktop-1', { at: 50, id: 3 });
    expect(saved).toEqual({ at: 100, id: 7 });
    expect(readWebLastSeen(storage, 'desktop-1')).toEqual({ at: 100, id: 7 });
  });

  it('still advances for a genuinely newer report', () => {
    const storage = fakeStorage();
    saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 });
    const saved = saveWebLastSeen(storage, 'desktop-1', { at: 200, id: 1 });
    expect(saved).toEqual({ at: 200, id: 1 });
  });

  it('isolates two desktops under their own keys', () => {
    const storage = fakeStorage();
    saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 });
    saveWebLastSeen(storage, 'desktop-2', { at: 5, id: 1 });

    expect(readWebLastSeen(storage, 'desktop-1')).toEqual({ at: 100, id: 7 });
    expect(readWebLastSeen(storage, 'desktop-2')).toEqual({ at: 5, id: 1 });
  });

  it('never writes for a null desktop id, but still returns the reported cursor', () => {
    const storage = fakeStorage();
    const saved = saveWebLastSeen(storage, null, { at: 100, id: 7 });
    expect(saved).toEqual({ at: 100, id: 7 });
    expect(storage.length).toBe(0);
  });

  it('never throws when the storage itself throws, and still returns the newer cursor', () => {
    const storage = throwingStorage();
    expect(() => saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 })).not.toThrow();
    expect(saveWebLastSeen(storage, 'desktop-1', { at: 100, id: 7 })).toEqual({ at: 100, id: 7 });
  });
});
