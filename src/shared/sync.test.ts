import { describe, expect, it } from 'vitest';
import {
  nextSyncLabel,
  syncAgeLabel,
  syncRemaining,
  syncTooltip,
  type ServiceSyncState,
  type SyncState,
} from './sync';

const MINUTE = 60_000;
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

const service = (over: Partial<ServiceSyncState> = {}): ServiceSyncState => ({
  id: 'jira',
  label: 'JIRA',
  enabled: true,
  lastSyncAt: NOW,
  error: null,
  ...over,
});

const state = (over: Partial<SyncState> = {}): SyncState => ({
  intervalMs: 5 * MINUTE,
  lastSyncAt: NOW,
  syncing: false,
  services: [service()],
  ...over,
});

describe('syncRemaining', () => {
  it('drains from full to empty across the interval', () => {
    expect(syncRemaining(state(), NOW)).toBe(1);
    expect(syncRemaining(state(), NOW + 2.5 * MINUTE)).toBeCloseTo(0.5);
    expect(syncRemaining(state(), NOW + 4 * MINUTE)).toBeCloseTo(0.2);
  });

  // Empty means the request has gone out. A poll that is late — a slow sync, a laptop that
  // was asleep — must sit there rather than wind backwards through a second lap.
  it('clamps at empty rather than going negative when a poll is late', () => {
    expect(syncRemaining(state(), NOW + 5 * MINUTE)).toBe(0);
    expect(syncRemaining(state(), NOW + 90 * MINUTE)).toBe(0);
  });

  // A full ring reads as "not waiting on anything", which is exactly right for both: there
  // is no countdown to draw, and a half-drained ring would imply one.
  it('stays full when there is nothing to count down to', () => {
    expect(syncRemaining(state({ intervalMs: 0 }), NOW + 90 * MINUTE)).toBe(1);
    expect(syncRemaining(state({ lastSyncAt: null }), NOW)).toBe(1);
  });

  it('survives a clock that has gone backwards', () => {
    // System time can move; a ring that had drained past full would render an arc longer
    // than its own circumference.
    expect(syncRemaining(state(), NOW - MINUTE)).toBe(1);
  });
});

describe('syncAgeLabel', () => {
  it('says how stale the mirror is, in the unit a human would use', () => {
    expect(syncAgeLabel(NOW, NOW + 3_000)).toBe('just now');
    expect(syncAgeLabel(NOW, NOW + 30_000)).toBe('30s ago');
    expect(syncAgeLabel(NOW, NOW + 4 * MINUTE)).toBe('4m ago');
    expect(syncAgeLabel(NOW, NOW + 65 * MINUTE)).toBe('1h 5m ago');
  });

  it('distinguishes "never" from "a moment ago"', () => {
    // A freshly launched app has fetched nothing; claiming it synced just now would be the
    // one lie this whole indicator exists to prevent.
    expect(syncAgeLabel(null, NOW)).toBe('not synced yet');
  });
});

describe('nextSyncLabel', () => {
  it('counts down, and says when a poll is due', () => {
    expect(nextSyncLabel(state(), NOW + 4.5 * MINUTE)).toBe('next in 30s');
    // The switch to minutes is at a full minute, not below it: "next in 60s" would be a
    // second reading of the same number.
    expect(nextSyncLabel(state(), NOW + 4 * MINUTE)).toBe('next in 1m');
    expect(nextSyncLabel(state(), NOW + 2 * MINUTE)).toBe('next in 3m');
    expect(nextSyncLabel(state(), NOW + 5 * MINUTE)).toBe('due now');
  });

  it('is null when nothing is scheduled', () => {
    expect(nextSyncLabel(state({ intervalMs: 0 }), NOW)).toBeNull();
    expect(nextSyncLabel(state({ lastSyncAt: null }), NOW)).toBeNull();
  });
});

describe('syncTooltip', () => {
  it('leads with the shared clock, then a line per enabled service', () => {
    // One interval and one timer, so the countdown is said ONCE at the top — the per-service
    // lines are only for what the shared line cannot carry.
    const tip = syncTooltip(
      state({
        services: [service(), service({ id: 'gitlab', label: 'GitLab', lastSyncAt: NOW })],
      }),
      NOW + 2 * MINUTE,
    );
    expect(tip.split('\n')).toEqual([
      'Synced 2m ago · next in 3m',
      'JIRA — 2m ago',
      'GitLab — 2m ago',
    ]);
  });

  it('says so plainly while a sweep is running', () => {
    expect(syncTooltip(state({ syncing: true }), NOW)).toContain('Syncing now');
  });

  it('names auto-sync being off rather than leaving the ring unexplained', () => {
    expect(syncTooltip(state({ intervalMs: 0 }), NOW)).toContain('auto-sync off');
  });

  // The reason the per-service lines survive a single shared ring: one broken tracker is
  // otherwise invisible behind the others succeeding, and it is the fact you most need.
  it('names the service that failed, not just that something did', () => {
    const tip = syncTooltip(
      state({
        services: [
          service(),
          service({ id: 'gitlab', label: 'GitLab', error: 'GitLab 401 Unauthorized' }),
        ],
      }),
      NOW,
    );
    expect(tip).toContain('GitLab — failed: GitLab 401 Unauthorized');
    expect(tip).toContain('JIRA — just now');
  });

  it('leaves a switched-off integration out entirely', () => {
    // A line about something you have turned off is noise pretending to be information.
    const tip = syncTooltip(
      state({ services: [service(), service({ id: 'gitlab', label: 'GitLab', enabled: false })] }),
      NOW,
    );
    expect(tip).not.toContain('GitLab');
  });
});
