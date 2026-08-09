import { describe, expect, it } from 'vitest';
import { PresenceRegistry } from './presence.registry';
import { PresenceService } from './presence.service';

describe('PresenceService.clients', () => {
  it('is empty for an account nobody has beaten on', () => {
    const service = new PresenceService(new PresenceRegistry());
    expect(service.clients('acct-1', 0)).toEqual([]);
  });

  it('excludes web sessions — only desktop Clients are valid command targets', () => {
    const service = new PresenceService(new PresenceRegistry());
    service.beat('acct-1', 'web-1', { kind: 'web', focused: true, at: 0 });

    expect(service.clients('acct-1', 0)).toEqual([]);
  });

  it('lists a desktop Client, most recently seen first', () => {
    const service = new PresenceService(new PresenceRegistry());
    service.beat('acct-1', 'client-old', { kind: 'client', focused: false, at: 0 });
    service.beat('acct-1', 'client-new', { kind: 'client', focused: false, at: 500 });

    expect(service.clients('acct-1', 500)).toEqual([
      { id: 'client-new', lastSeen: 500 },
      { id: 'client-old', lastSeen: 0 },
    ]);
  });

  it('drops a Client once its beat ages past the presence TTL', () => {
    const service = new PresenceService(new PresenceRegistry());
    service.beat('acct-1', 'client-1', { kind: 'client', focused: false, at: 0 });

    expect(service.clients('acct-1', 90_001)).toEqual([]);
  });
});
