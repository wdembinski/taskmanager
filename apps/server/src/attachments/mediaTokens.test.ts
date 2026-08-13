import { describe, expect, it } from 'vitest';
import { MEDIA_READ_SCOPE, MEDIA_TOKEN_TTL_MS, MediaTokenRegistry } from './mediaTokens';

const NOW = 1_000_000;

describe('MediaTokenRegistry', () => {
  it('resolves a freshly minted token to its account', () => {
    const registry = new MediaTokenRegistry();
    const { token, expiresAt } = registry.issue('account-1', NOW);
    expect(expiresAt).toBe(NOW + MEDIA_TOKEN_TTL_MS);
    expect(registry.resolve(token, MEDIA_READ_SCOPE, NOW + 1)).toBe('account-1');
  });

  it('mints a distinct token every time', () => {
    const registry = new MediaTokenRegistry();
    const first = registry.issue('account-1', NOW).token;
    const second = registry.issue('account-1', NOW).token;
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(32);
  });

  it('answers nothing for an unknown token', () => {
    const registry = new MediaTokenRegistry();
    expect(registry.resolve('made-up', MEDIA_READ_SCOPE, NOW)).toBeNull();
  });

  it('stops answering the moment the ticket expires', () => {
    const registry = new MediaTokenRegistry();
    const { token } = registry.issue('account-1', NOW);
    expect(registry.resolve(token, MEDIA_READ_SCOPE, NOW + MEDIA_TOKEN_TTL_MS - 1)).toBe(
      'account-1',
    );
    expect(registry.resolve(token, MEDIA_READ_SCOPE, NOW + MEDIA_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses a scope it was not minted for — the whole point of it being narrow', () => {
    const registry = new MediaTokenRegistry();
    const { token } = registry.issue('account-1', NOW);
    expect(registry.resolve(token, 'board:read', NOW)).toBeNull();
  });

  it('does not grow without bound: minting sweeps what has expired', () => {
    const registry = new MediaTokenRegistry();
    registry.issue('account-1', NOW);
    registry.issue('account-2', NOW);
    expect(registry.size()).toBe(2);

    registry.issue('account-3', NOW + MEDIA_TOKEN_TTL_MS + 1);
    expect(registry.size()).toBe(1);
  });

  it('forgets an expired token it happened to be asked about', () => {
    const registry = new MediaTokenRegistry();
    const { token } = registry.issue('account-1', NOW);
    registry.resolve(token, MEDIA_READ_SCOPE, NOW + MEDIA_TOKEN_TTL_MS);
    expect(registry.size()).toBe(0);
  });
});
