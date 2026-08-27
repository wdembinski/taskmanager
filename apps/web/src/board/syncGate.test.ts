import { describe, expect, it } from 'vitest';
import {
  boardIsReady,
  syncBusyLabel,
  syncCurtainText,
  syncStatusLabel,
  type SyncProgress,
} from './syncGate';

function progress(overrides: Partial<SyncProgress> = {}): SyncProgress {
  return {
    polling: false,
    draining: false,
    initialSyncComplete: false,
    failures: 0,
    lastError: null,
    ...overrides,
  };
}

describe('boardIsReady', () => {
  it('is false before any response has landed', () => {
    expect(boardIsReady(progress())).toBe(false);
  });

  it('is blocked on page 1 of a paged first load, even though a poll has already landed', () => {
    // lastPolledAt would already be set by the time this response is applied — the gate
    // must not key off that, only off the latch itself.
    expect(boardIsReady(progress({ draining: true, initialSyncComplete: false }))).toBe(false);
  });

  it('is true once the latch has been set, regardless of polling or draining right now', () => {
    expect(
      boardIsReady(progress({ initialSyncComplete: true, polling: true, draining: true })),
    ).toBe(true);
  });

  it('stays true through a later failure — the latch never goes back false', () => {
    expect(
      boardIsReady(progress({ initialSyncComplete: true, failures: 3, lastError: 'boom' })),
    ).toBe(true);
  });
});

describe('syncCurtainText', () => {
  it('reports loading before the first page has come back', () => {
    const text = syncCurtainText(progress());
    expect(text.label).toMatch(/loading/i);
  });

  it('reports catching up while draining a paged first load', () => {
    const text = syncCurtainText(progress({ draining: true }));
    expect(text.label).toMatch(/loading/i);
    expect(text.detail).toMatch(/large account/i);
  });

  it('surfaces the last error once a failure has happened', () => {
    const text = syncCurtainText(progress({ failures: 1, lastError: 'network down' }));
    expect(text.detail).toBe('network down');
  });

  it('falls back to a generic retry message when a failure has no error text', () => {
    const text = syncCurtainText(progress({ failures: 1, lastError: null }));
    expect(text.detail.length).toBeGreaterThan(0);
  });
});

describe('syncStatusLabel', () => {
  it('says first sync pending before any poll has landed', () => {
    expect(syncStatusLabel(progress(), null, 1_000)).toBe('first sync pending');
  });

  it('reports the age of the last poll once one has landed', () => {
    expect(syncStatusLabel(progress({ initialSyncComplete: true }), 0, 12_000)).toBe(
      'synced 12s ago',
    );
  });

  it('says syncing during a later paged catch-up, even after the board is already latched ready', () => {
    expect(
      syncStatusLabel(progress({ initialSyncComplete: true, draining: true }), 0, 12_000),
    ).toBe('syncing…');
  });
});

describe('syncBusyLabel', () => {
  it('is null when nothing is outstanding', () => {
    expect(syncBusyLabel(progress(), 0)).toBeNull();
  });

  it('says loading while relays are outstanding', () => {
    expect(syncBusyLabel(progress(), 1)).toBe('loading…');
  });

  it('says syncing while draining, with no relays outstanding', () => {
    expect(syncBusyLabel(progress({ draining: true }), 0)).toBe('syncing…');
  });

  it('lets outstanding relays win over draining — the ticket’s actual complaint', () => {
    expect(syncBusyLabel(progress({ draining: true }), 1)).toBe('loading…');
  });
});
