import { describe, expect, it } from 'vitest';
import {
  gateCommandHash,
  isCommandTrusted,
  preserveLocalTrust,
  withTrustedHash,
} from './gateTrust';

describe('gateCommandHash', () => {
  it('hashes the same command to the same digest', () => {
    expect(gateCommandHash('pnpm test')).toBe(gateCommandHash('pnpm test'));
  });

  // The whole point of exact-byte hashing: a trust decision is about one specific string,
  // and an edit — even whitespace — must not silently carry trust over to a different one.
  it('changes on a single edited character', () => {
    expect(gateCommandHash('pnpm test')).not.toBe(gateCommandHash('pnpm tests'));
  });

  it('changes on a trailing space', () => {
    expect(gateCommandHash('pnpm test')).not.toBe(gateCommandHash('pnpm test '));
  });
});

describe('isCommandTrusted / withTrustedHash', () => {
  it('trusts a command once its hash has been added', () => {
    const trusted = withTrustedHash([], gateCommandHash('pnpm test'));
    expect(isCommandTrusted(trusted, 'pnpm test')).toBe(true);
  });

  // Acceptance: an edited command — one changed character, or a trailing space — is
  // untrusted again, even though the original command stays trusted.
  it('leaves an edited command untrusted, one changed character', () => {
    const trusted = withTrustedHash([], gateCommandHash('pnpm test'));
    expect(isCommandTrusted(trusted, 'pnpm tests')).toBe(false);
  });

  it('leaves an edited command untrusted, a trailing space', () => {
    const trusted = withTrustedHash([], gateCommandHash('pnpm test'));
    expect(isCommandTrusted(trusted, 'pnpm test ')).toBe(false);
  });

  it('is untrusted when the set is empty', () => {
    expect(isCommandTrusted([], 'pnpm test')).toBe(false);
  });

  it('dedups adding the same hash twice', () => {
    const hash = gateCommandHash('pnpm test');
    const once = withTrustedHash([], hash);
    const twice = withTrustedHash(once, hash);
    expect(twice).toEqual(once);
    expect(twice).toHaveLength(1);
  });

  it('preserves order and existing entries when adding a new hash', () => {
    const a = gateCommandHash('pnpm test');
    const b = gateCommandHash('pnpm build');
    const trusted = withTrustedHash([a], b);
    expect(trusted).toEqual([a, b]);
  });

  it('does not mutate the array it was given', () => {
    const trusted: string[] = [];
    withTrustedHash(trusted, gateCommandHash('pnpm test'));
    expect(trusted).toEqual([]);
  });
});

describe('preserveLocalTrust', () => {
  // The acceptance: a relayed or stale blob carrying a different list is ignored outright —
  // the machine's own stored list always wins, since trust is a fact about this desktop and
  // never travels on `settings:save`.
  it('ignores a relayed or stale blob carrying a different list', () => {
    const stored = { trustedGateCommands: ['own-hash'] };
    const incoming = { trustedGateCommands: ['someone-elses-hash'] };
    expect(preserveLocalTrust(stored, incoming)).toEqual(['own-hash']);
  });

  it('returns an empty stored list rather than adopting a non-empty incoming one', () => {
    const stored = { trustedGateCommands: [] };
    const incoming = { trustedGateCommands: ['stale-hash'] };
    expect(preserveLocalTrust(stored, incoming)).toEqual([]);
  });
});
