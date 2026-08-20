import { describe, expect, it } from 'vitest';
import type { PersonalAccessToken } from '@tm/protocol/wire';
import { describeExpiry, describeLastUsed, sortTokens, validateTokenName } from './tokensView';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pat(overrides: Partial<PersonalAccessToken> = {}): PersonalAccessToken {
  return {
    id: 'pat-1',
    name: 'laptop',
    hint: 'tmpat_ab',
    createdAt: NOW - DAY_MS,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('describeExpiry', () => {
  it('reads "Never expires" for a null expiry', () => {
    expect(describeExpiry(pat({ expiresAt: null }), NOW)).toBe('Never expires');
  });

  it('reads "Expired" exactly at and past the boundary', () => {
    expect(describeExpiry(pat({ expiresAt: NOW }), NOW)).toBe('Expired');
    expect(describeExpiry(pat({ expiresAt: NOW - 1 }), NOW)).toBe('Expired');
  });

  it('reads "Expires today" inside the last day', () => {
    expect(describeExpiry(pat({ expiresAt: NOW + DAY_MS - 1 }), NOW)).toBe('Expires today');
  });

  it('reads "Expires in N days" beyond a day', () => {
    expect(describeExpiry(pat({ expiresAt: NOW + 12 * DAY_MS }), NOW)).toBe('Expires in 12 days');
  });
});

describe('describeLastUsed', () => {
  it('reads "Never used" for a null lastUsedAt', () => {
    expect(describeLastUsed(pat({ lastUsedAt: null }), NOW)).toBe('Never used');
  });

  it('reads "Used today" within the last day', () => {
    expect(describeLastUsed(pat({ lastUsedAt: NOW - 1_000 }), NOW)).toBe('Used today');
  });

  it('reads "Used N days ago" beyond a day', () => {
    expect(describeLastUsed(pat({ lastUsedAt: NOW - 3 * DAY_MS }), NOW)).toBe('Used 3 days ago');
  });
});

describe('sortTokens', () => {
  it('puts a revoked token last, newest first within each group', () => {
    const active1 = pat({ id: 'a1', createdAt: 1, revokedAt: null });
    const active2 = pat({ id: 'a2', createdAt: 2, revokedAt: null });
    const revoked = pat({ id: 'r1', createdAt: 3, revokedAt: NOW });

    expect(sortTokens([revoked, active1, active2]).map((t) => t.id)).toEqual(['a2', 'a1', 'r1']);
  });
});

describe('validateTokenName', () => {
  it('rejects a blank name', () => {
    expect(validateTokenName('   ')).not.toBeNull();
  });

  it('rejects a name over 100 characters', () => {
    expect(validateTokenName('x'.repeat(101))).not.toBeNull();
  });

  it('accepts a normal name', () => {
    expect(validateTokenName('laptop')).toBeNull();
  });
});
