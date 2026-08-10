import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_TTL_MS } from '@tm/protocol/cadence';
import { PresenceController } from './presence.controller';
import { PresenceRegistry } from './presence.registry';
import { PresenceService } from './presence.service';

describe('PresenceController', () => {
  let controller: PresenceController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    controller = new PresenceController(new PresenceService(new PresenceRegistry()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is active for a focused web beat', () => {
    const response = controller.beat('dev-account', { clientId: 'web-1', focused: true });
    expect(response.cadence.tier).toBe('active');
  });

  it('is idle for a beat that arrived recently but said focused: false', () => {
    const response = controller.beat('dev-account', { clientId: 'web-1', focused: false });
    expect(response.cadence.tier).toBe('idle');
  });

  it('goes idle once a focused beat ages past the presence TTL', () => {
    controller.beat('dev-account', { clientId: 'web-1', focused: true });

    vi.setSystemTime(PRESENCE_TTL_MS + 1);
    const response = controller.beat('dev-account', { clientId: 'web-2', focused: false });

    expect(response.cadence.tier).toBe('idle');
  });
});
