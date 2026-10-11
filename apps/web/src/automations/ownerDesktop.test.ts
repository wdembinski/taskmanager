import { describe, expect, it } from 'vitest';
import type { ClientPresence } from '@tm/protocol/wire';
import {
  mergeLastSeen,
  ownerDesktopState,
  ownerDisplayName,
  OWNER_DESKTOP_GRACE_MS,
} from './ownerDesktop';

describe('ownerDesktopState', () => {
  const GRACE_MS = 1_000;

  const cases: Array<{
    name: string;
    lastSeen: number | null;
    now: number;
    graceMs?: number;
    expected: 'live' | 'stale' | 'never-synced';
  }> = [
    {
      name: 'this tab has never seen the owner at all',
      lastSeen: null,
      now: 10_000,
      expected: 'never-synced',
    },
    { name: 'seen just now', lastSeen: 5_000, now: 5_000, graceMs: GRACE_MS, expected: 'live' },
    {
      name: 'seen a moment ago, still inside the grace window',
      lastSeen: 5_000,
      now: 5_500,
      graceMs: GRACE_MS,
      expected: 'live',
    },
    {
      name: 'right at the edge of the grace window',
      lastSeen: 5_000,
      now: 5_999,
      graceMs: GRACE_MS,
      expected: 'live',
    },
    {
      name: 'just past the grace window',
      lastSeen: 5_000,
      now: 6_001,
      graceMs: GRACE_MS,
      expected: 'stale',
    },
    {
      name: 'seen a long time ago',
      lastSeen: 0,
      now: 100_000,
      graceMs: GRACE_MS,
      expected: 'stale',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(ownerDesktopState({ lastSeen: c.lastSeen, now: c.now, graceMs: c.graceMs })).toBe(
        c.expected,
      );
    });
  }

  it('defaults its grace window to OWNER_DESKTOP_GRACE_MS when none is injected', () => {
    expect(OWNER_DESKTOP_GRACE_MS).toBeGreaterThan(0);
    expect(ownerDesktopState({ lastSeen: 0, now: OWNER_DESKTOP_GRACE_MS - 1 })).toBe('live');
    expect(ownerDesktopState({ lastSeen: 0, now: OWNER_DESKTOP_GRACE_MS + 1 })).toBe('stale');
  });
});

describe('mergeLastSeen', () => {
  it('starts empty and learns a client the first time it is seen', () => {
    const clients: ClientPresence[] = [{ id: 'desktop-1', lastSeen: 1_000 }];
    const next = mergeLastSeen(new Map(), clients);
    expect(next.get('desktop-1')?.lastSeen).toBe(1_000);
  });

  it('refreshes a client already known, to the newer lastSeen', () => {
    const prev = new Map([['desktop-1', { lastSeen: 1_000 }]]);
    const clients: ClientPresence[] = [{ id: 'desktop-1', lastSeen: 2_000 }];
    const next = mergeLastSeen(prev, clients);
    expect(next.get('desktop-1')?.lastSeen).toBe(2_000);
  });

  it('remembers a client that has since dropped out of the live list', () => {
    const prev = new Map([['desktop-1', { lastSeen: 1_000 }]]);
    const next = mergeLastSeen(prev, []);
    expect(next.get('desktop-1')?.lastSeen).toBe(1_000);
  });

  it('carries a client’s info forward once learned, even after it drops out of the live list', () => {
    const prev = new Map([['desktop-1', { lastSeen: 1_000, info: { name: 'WORKSTATION' } }]]);
    const next = mergeLastSeen(prev, []);
    expect(next.get('desktop-1')?.info?.name).toBe('WORKSTATION');
  });

  it('does not mutate the map it was given', () => {
    const prev = new Map([['desktop-1', { lastSeen: 1_000 }]]);
    mergeLastSeen(prev, [{ id: 'desktop-1', lastSeen: 2_000 }]);
    expect(prev.get('desktop-1')?.lastSeen).toBe(1_000);
  });
});

describe('ownerDisplayName', () => {
  it('names a client this tab has learned a name for', () => {
    const remembered = new Map([['desktop-1', { lastSeen: 1_000, info: { name: 'WORKSTATION' } }]]);
    expect(ownerDisplayName('desktop-1', remembered)).toBe('WORKSTATION');
  });

  it('falls back to a short id when no name has ever been learned', () => {
    expect(ownerDisplayName('abcdef1234567890', new Map())).toBe('desktop abcdef12');
  });

  it('falls back to a short id when the client is known but carries no info', () => {
    const remembered = new Map([['abcdef1234567890', { lastSeen: 1_000 }]]);
    expect(ownerDisplayName('abcdef1234567890', remembered)).toBe('desktop abcdef12');
  });
});
