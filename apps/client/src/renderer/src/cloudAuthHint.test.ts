import { describe, expect, it } from 'vitest';
import type { CloudConfigStatus } from '@shared/ipc';
import { cloudAuthHint, cloudTokenPlaceholder } from './cloudAuthHint';

function status(overrides: Partial<CloudConfigStatus> = {}): CloudConfigStatus {
  return {
    hasToken: false,
    encryptionAvailable: true,
    plainTextStorage: false,
    authState: 'no-token',
    authError: null,
    lastAcceptedAt: null,
    legacySignInRetired: false,
    ...overrides,
  };
}

describe('cloudAuthHint', () => {
  it('produces a distinct sentence for each state, none mentioning Sign in', () => {
    const sentences = [
      cloudAuthHint(status({ hasToken: false, authState: 'no-token' })),
      cloudAuthHint(status({ hasToken: true, authState: 'stored' })),
      cloudAuthHint(status({ hasToken: true, authState: 'active', lastAcceptedAt: 5_000 })),
      cloudAuthHint(status({ hasToken: true, authState: 'rejected' })),
      cloudAuthHint(status({ encryptionAvailable: false })),
    ];

    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence).not.toMatch(/sign in/i);
  });

  it('names both possible causes of a rejection and says where to get a new token', () => {
    const message = cloudAuthHint(status({ hasToken: true, authState: 'rejected' }));
    expect(message).toMatch(/revoked/i);
    expect(message).toMatch(/expired/i);
    expect(message).toMatch(/web app/i);
  });

  it('flags the OS secure store being unavailable ahead of every other state', () => {
    const message = cloudAuthHint(status({ encryptionAvailable: false, authState: 'active' }));
    expect(message).toMatch(/secure store is unavailable/i);
  });

  it('tells a legacy signed-in user their sign-in was replaced', () => {
    const message = cloudAuthHint(status({ legacySignInRetired: true }));
    expect(message).toMatch(/replaced by personal access tokens/i);
  });

  it('says nothing is stored when there is no status at all', () => {
    expect(cloudAuthHint(null)).toMatch(/paste a token/i);
  });
});

describe('cloudTokenPlaceholder', () => {
  it('shows a stored placeholder once a token is on file, and the prefix hint otherwise', () => {
    expect(cloudTokenPlaceholder(status({ hasToken: true }))).toMatch(/stored/i);
    expect(cloudTokenPlaceholder(status({ hasToken: false }))).toMatch(/tmpat_/);
    expect(cloudTokenPlaceholder(null)).toMatch(/tmpat_/);
  });
});
