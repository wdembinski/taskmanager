/**
 * The pure sentence-builders the sign-in banner, its timeline note and the readiness
 * panel all share, so naming a WSL distro's host cannot drift between the three.
 */
import { describe, expect, it } from 'vitest';
import { describeAuthFailure, signInCommandText, type AuthState } from './auth';

const WSL = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;

describe('signInCommandText', () => {
  it('is the bare CLI for a local gate', () => {
    expect(signInCommandText()).toBe('claude');
    expect(signInCommandText({ kind: 'local' })).toBe('claude');
  });

  it('names the distro for a WSL gate', () => {
    expect(signInCommandText(WSL)).toBe('wsl -d Ubuntu-24.04 claude');
  });
});

describe('describeAuthFailure', () => {
  function state(over: Partial<AuthState> = {}): AuthState {
    return {
      since: 0,
      reason: 'OAuth session expired',
      source: 'run',
      parkedTaskIds: [],
      ...over,
    };
  }

  it('reads exactly as before for a local gate', () => {
    expect(describeAuthFailure(state())).toBe(
      'Claude could not authenticate: OAuth session expired',
    );
    expect(describeAuthFailure(state({ source: 'restored' }))).toBe(
      'Claude could not authenticate when the app last ran: OAuth session expired',
    );
  });

  it('names the host for a WSL gate', () => {
    expect(describeAuthFailure(state({ target: WSL }))).toBe(
      'Claude could not authenticate on wsl:Ubuntu-24.04: OAuth session expired',
    );
    expect(describeAuthFailure(state({ target: WSL, source: 'restored' }))).toBe(
      'Claude could not authenticate on wsl:Ubuntu-24.04 when the app last ran: OAuth session expired',
    );
  });
});
