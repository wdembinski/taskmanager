import { describe, expect, it } from 'vitest';
import { PAT_PREFIX } from '@tm/protocol/wire';
import { expiresAtFor, hashPat, looksLikePat, mintPatSecret, patUsable } from './pat';

const NOW = 1_700_000_000_000;

describe('mintPatSecret', () => {
  it('produces a token carrying the prefix, at the exact expected length, base64url only', () => {
    const { token } = mintPatSecret();
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(token.length).toBe(PAT_PREFIX.length + 43);
    expect(/^[A-Za-z0-9_-]+$/.test(token.slice(PAT_PREFIX.length))).toBe(true);
  });

  it('never mints the same token twice', () => {
    const first = mintPatSecret();
    const second = mintPatSecret();
    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
  });

  it('hashes the full token, including the prefix, stably and lowercase', () => {
    const { token, hash } = mintPatSecret();
    expect(hash).toBe(hashPat(token));
    expect(hash).toBe(hashPat(token));
    expect(hash).toBe(hash.toLowerCase());
    expect(hash).not.toBe(hashPat(token.slice(PAT_PREFIX.length)));
  });

  it('gives a hint that is a strict prefix of the token, revealing at most 6 secret characters', () => {
    const { token, hint } = mintPatSecret();
    expect(token.startsWith(hint)).toBe(true);
    expect(hint.length).toBe(PAT_PREFIX.length + 6);
  });
});

describe('looksLikePat', () => {
  it('accepts a freshly minted token', () => {
    expect(looksLikePat(mintPatSecret().token)).toBe(true);
  });

  it('rejects an IAM-shaped token', () => {
    expect(looksLikePat('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature')).toBe(false);
  });

  it('rejects the right prefix at the wrong length', () => {
    expect(looksLikePat(mintPatSecret().token + 'x')).toBe(false);
    expect(looksLikePat(mintPatSecret().token.slice(0, -1))).toBe(false);
  });

  it('rejects standard-base64 characters (+, /, =)', () => {
    const base = mintPatSecret().token;
    expect(looksLikePat(base.slice(0, -1) + '+')).toBe(false);
    expect(looksLikePat(base.slice(0, -1) + '/')).toBe(false);
    expect(looksLikePat(base.slice(0, -1) + '=')).toBe(false);
  });

  it('rejects the bare prefix and the empty string', () => {
    expect(looksLikePat(PAT_PREFIX)).toBe(false);
    expect(looksLikePat('')).toBe(false);
  });
});

describe('patUsable', () => {
  it('is revoked when revokedAt is set, even on an unexpired row', () => {
    expect(patUsable({ revokedAt: NOW - 1, expiresAt: NOW + 1_000 }, NOW)).toBe('revoked');
  });

  it('is expired exactly at expiresAt — the boundary is <=', () => {
    expect(patUsable({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('expired');
    expect(patUsable({ revokedAt: null, expiresAt: NOW + 1 }, NOW)).toBe('ok');
  });

  it('is ok when expiresAt is null', () => {
    expect(patUsable({ revokedAt: null, expiresAt: null }, NOW)).toBe('ok');
  });
});

describe('expiresAtFor', () => {
  it('is null when days is null or omitted', () => {
    expect(expiresAtFor(NOW, null)).toBeNull();
    expect(expiresAtFor(NOW, undefined)).toBeNull();
  });

  it('adds the days in milliseconds', () => {
    expect(expiresAtFor(NOW, 30)).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
  });
});
