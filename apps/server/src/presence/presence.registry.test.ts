import { describe, expect, it } from 'vitest';
import { PRESENCE_TTL_MS } from '@tm/protocol/cadence';
import { PresenceRegistry } from './presence.registry';

describe('PresenceRegistry', () => {
  it('returns nothing for an account that has never beaten', () => {
    const registry = new PresenceRegistry();
    expect(registry.sessions('acct-1', 0)).toEqual([]);
  });

  it('reflects a recorded beat back as cadence input', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'web-1', { kind: 'web', focused: true, at: 1_000 });

    expect(registry.sessions('acct-1', 1_000)).toEqual([
      { clientId: 'web-1', source: 'web', focused: true, lastSeen: 1_000 },
    ]);
  });

  it('keeps a beat right at the TTL boundary', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'c-1', { kind: 'client', focused: true, at: 0 });

    expect(registry.sessions('acct-1', PRESENCE_TTL_MS)).toHaveLength(1);
  });

  it('sweeps a beat the instant it ages past the TTL', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'c-1', { kind: 'client', focused: true, at: 0 });

    expect(registry.sessions('acct-1', PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it('does not resurrect a swept beat on a later read', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'c-1', { kind: 'client', focused: true, at: 0 });
    registry.sessions('acct-1', PRESENCE_TTL_MS + 1); // sweeps it out of the account map

    expect(registry.sessions('acct-1', PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it('keeps accounts independent', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'c-1', { kind: 'client', focused: true, at: 0 });

    expect(registry.sessions('acct-2', 0)).toEqual([]);
  });

  it('overwrites a session on a repeat beat rather than accumulating history', () => {
    const registry = new PresenceRegistry();
    registry.record('acct-1', 'c-1', { kind: 'client', focused: true, at: 0 });
    registry.record('acct-1', 'c-1', { kind: 'client', focused: false, at: 500 });

    expect(registry.sessions('acct-1', 500)).toEqual([
      { clientId: 'c-1', source: 'client', focused: false, lastSeen: 500 },
    ]);
  });
});
