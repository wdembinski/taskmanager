import { describe, expect, it } from 'vitest';
import {
  nextSyncLabel,
  syncAgeLabel,
  syncRemaining,
  syncTooltip,
  type ServiceSyncState,
} from './sync';

const MINUTE = 60_000;
const NOW = Date.parse('2026-07-31T12:00:00.000Z');

const state = (over: Partial<ServiceSyncState> = {}): ServiceSyncState => ({
  id: 'jira',
  label: 'JIRA',
  enabled: true,
  intervalMs: 5 * MINUTE,
  lastSyncAt: NOW,
  syncing: false,
  error: null,
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
  it('reads as one sentence: what, how stale, what next', () => {
    expect(syncTooltip(state(), NOW + 2 * MINUTE)).toBe('JIRA — synced 2m ago · next in 3m');
  });

  it('says so plainly while a sync is actually running', () => {
    expect(syncTooltip(state({ syncing: true }), NOW)).toBe('JIRA — syncing now');
  });

  it('names auto-sync being off rather than leaving the ring unexplained', () => {
    expect(syncTooltip(state({ intervalMs: 0 }), NOW)).toContain('auto-sync off');
  });

  // A service that has quietly stopped working is the case this indicator is most useful
  // for, so the reason belongs where the staleness is, not only in the log.
  it('carries the last failure', () => {
    expect(syncTooltip(state({ error: 'GitLab 401 Unauthorized' }), NOW)).toContain(
      'last attempt failed: GitLab 401 Unauthorized',
    );
  });
});
