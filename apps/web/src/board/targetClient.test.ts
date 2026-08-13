import { describe, expect, it } from 'vitest';
import {
  describeClient,
  describeClientDetail,
  resolveTargetClientId,
  setPreferredClientId,
  versionSkew,
} from './targetClient';

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

  it('honours a picked Client over the most recently seen one', () => {
    const storage = fakeStorage();
    setPreferredClientId(storage, 'desktop-2');

    expect(
      resolveTargetClientId(storage, [
        { id: 'desktop-1', lastSeen: 100 },
        { id: 'desktop-2', lastSeen: 50 },
      ]),
    ).toBe('desktop-2');
  });

  it('falls back to a live Client while the picked one is offline', () => {
    const storage = fakeStorage();
    setPreferredClientId(storage, 'desktop-2');

    expect(resolveTargetClientId(storage, [{ id: 'desktop-1', lastSeen: 100 }])).toBe('desktop-1');
  });

  it('gives the picked Client the target back the moment it polls again', () => {
    const storage = fakeStorage();
    setPreferredClientId(storage, 'desktop-2');
    resolveTargetClientId(storage, [{ id: 'desktop-1', lastSeen: 100 }]);

    expect(
      resolveTargetClientId(storage, [
        { id: 'desktop-1', lastSeen: 200 },
        { id: 'desktop-2', lastSeen: 150 },
      ]),
    ).toBe('desktop-2');
  });
});

describe('describeClient', () => {
  it('uses the machine name the desktop reported', () => {
    expect(describeClient({ id: 'abc', lastSeen: 0, info: { name: 'WORKSTATION' } })).toBe(
      'WORKSTATION',
    );
  });

  it('shortens the id for a desktop too old to have named itself', () => {
    expect(describeClient({ id: '0f8b2c4e-1111-2222-3333-444455556666', lastSeen: 0 })).toBe(
      'desktop 0f8b2c4e',
    );
  });

  it('adds the version and platform in the picker, and skips what it was not told', () => {
    expect(
      describeClientDetail({
        id: 'abc',
        lastSeen: 0,
        info: { name: 'WORKSTATION', appVersion: '0.84.5', platform: 'win32' },
      }),
    ).toBe('WORKSTATION · v0.84.5 · win32');
    expect(describeClientDetail({ id: 'abcdefghij', lastSeen: 0 })).toBe('desktop abcdefgh');
  });
});

describe('versionSkew', () => {
  const client = (protocolVersion?: number) => ({
    id: 'abc',
    lastSeen: 0,
    ...(protocolVersion === undefined ? {} : { info: { protocolVersion } }),
  });

  it('is silent when there is no Client to compare against', () => {
    expect(versionSkew(null, 2)).toBeNull();
  });

  it('is silent about a desktop that never said which version it speaks', () => {
    // Every desktop predating this feature is in exactly this state; warning here would
    // fire on all of them the day it ships.
    expect(versionSkew(client(), 2)).toBeNull();
  });

  it('is silent when the two agree', () => {
    expect(versionSkew(client(2), 2)).toBeNull();
  });

  it('names the desktop as the old one — what ipcRegistry would refuse for', () => {
    expect(versionSkew(client(1), 2)).toBe('desktop-older');
  });

  it('names this tab as the old one when the desktop is ahead', () => {
    expect(versionSkew(client(3), 2)).toBe('desktop-newer');
  });
});
