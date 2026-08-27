import { describe, expect, it } from 'vitest';
import type { ClientPresence } from '@tm/protocol/wire';
import { desktopPresence, DESKTOP_PRESENCE_GRACE_MS } from './desktopPresence';

const LIVE: ClientPresence[] = [{ id: 'desktop-1', lastSeen: 0 }];
const GRACE_MS = 1_000;

describe('desktopPresence', () => {
  const cases: Array<{
    name: string;
    clients: ClientPresence[];
    missingSince: number | null;
    lastPolledAt: number | null;
    now: number;
    graceMs?: number;
    expected: 'unknown' | 'online' | 'offline';
  }> = [
    {
      name: 'no poll has ever come back',
      clients: [],
      missingSince: null,
      lastPolledAt: null,
      now: 10_000,
      expected: 'unknown',
    },
    {
      name: 'no poll has ever come back, even with a live client already recorded',
      clients: LIVE,
      missingSince: null,
      lastPolledAt: null,
      now: 10_000,
      expected: 'unknown',
    },
    {
      name: 'a live client is in the latest response',
      clients: LIVE,
      missingSince: null,
      lastPolledAt: 5_000,
      now: 10_000,
      expected: 'online',
    },
    {
      name: 'a live client is back even though it was missing a moment ago',
      clients: LIVE,
      missingSince: 4_000,
      lastPolledAt: 5_000,
      now: 10_000,
      expected: 'online',
    },
    {
      name: 'empty response but nothing has ever gone missing yet',
      clients: [],
      missingSince: null,
      lastPolledAt: 5_000,
      now: 5_000,
      expected: 'unknown',
    },
    {
      name: 'missing, but still inside the grace window',
      clients: [],
      missingSince: 5_000,
      lastPolledAt: 5_500,
      now: 5_500,
      graceMs: GRACE_MS,
      expected: 'unknown',
    },
    {
      name: 'missing, right at the edge of the grace window',
      clients: [],
      missingSince: 5_000,
      lastPolledAt: 5_999,
      now: 5_999,
      graceMs: GRACE_MS,
      expected: 'unknown',
    },
    {
      name: 'missing, past the grace window',
      clients: [],
      missingSince: 5_000,
      lastPolledAt: 6_001,
      now: 6_001,
      graceMs: GRACE_MS,
      expected: 'offline',
    },
    {
      name: 'missing for a long time',
      clients: [],
      missingSince: 0,
      lastPolledAt: 100_000,
      now: 100_000,
      graceMs: GRACE_MS,
      expected: 'offline',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        desktopPresence({
          clients: c.clients,
          missingSince: c.missingSince,
          lastPolledAt: c.lastPolledAt,
          now: c.now,
          graceMs: c.graceMs,
        }),
      ).toBe(c.expected);
    });
  }

  it('defaults its grace window to BACKOFF_CAP_MS when none is injected', () => {
    expect(DESKTOP_PRESENCE_GRACE_MS).toBeGreaterThan(0);
    expect(
      desktopPresence({
        clients: [],
        missingSince: 0,
        lastPolledAt: DESKTOP_PRESENCE_GRACE_MS - 1,
        now: DESKTOP_PRESENCE_GRACE_MS - 1,
      }),
    ).toBe('unknown');
    expect(
      desktopPresence({
        clients: [],
        missingSince: 0,
        lastPolledAt: DESKTOP_PRESENCE_GRACE_MS + 1,
        now: DESKTOP_PRESENCE_GRACE_MS + 1,
      }),
    ).toBe('offline');
  });
});
