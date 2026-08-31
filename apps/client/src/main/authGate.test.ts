/**
 * The sign-in gate's two jobs, tested apart: recognising an authentication failure in
 * the CLI's own `result`, and remembering what it stopped.
 *
 * The classifier carries the risk here. Believing an agent's prose would stop the whole
 * board over one card, and disbelieving the CLI would leave the queue feeding cards into
 * a dead credential — so both directions are pinned, not just the happy one.
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthGate, detectAuthFailure, isAuthFailureText, type AuthResultSlice } from './authGate';
import type { AuthState } from '@shared/auth';

/** A `result` slice: no tokens spent unless a test says so, as a dead start has none. */
function result(over: Partial<AuthResultSlice> = {}): AuthResultSlice {
  return {
    resultText: '',
    stopReason: null,
    terminalReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...over,
  };
}

/** A run that actually worked — the thing that separates an agent's words from the CLI's. */
const SPENT = {
  inputTokens: 12,
  outputTokens: 340,
  cacheCreationTokens: 0,
  cacheReadTokens: 151_869,
};

describe('detectAuthFailure', () => {
  /**
   * The exact failure that locked two cards on 5 Aug 2026. The CLI put `api_error` in
   * `terminalReason` — which is what every classifier downstream was reading — and the
   * sentence naming the cause in `resultText`, which nothing read at all.
   */
  it('reads the real message out of a run the CLI labelled api_error', () => {
    const reason = detectAuthFailure(
      result({
        resultText: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        stopReason: 'stop_sequence',
        terminalReason: 'api_error',
      }),
    );
    expect(reason).toBe('Failed to authenticate: OAuth session expired and could not be refreshed');
  });

  it('recognises the CLI’s other ways of saying it', () => {
    for (const text of [
      'Claude is installed but not logged in. Run `claude` once and sign in, then retry.',
      'OAuth token is no longer valid',
      'Your credentials are expired — please run `/login`',
      'session expired',
    ]) {
      expect(detectAuthFailure(result({ resultText: text })), text).toBe(text);
    }
  });

  /**
   * The false positive that would hurt most: a card whose whole job is authentication.
   * Its answer names the same words, but it necessarily ran turns to produce them — so
   * the ambiguous wording is believed only when the model was demonstrably never called.
   */
  it('does not stop the board because an agent wrote about auth', () => {
    const agent = result({
      resultText: 'Fixed the 401 Unauthorized on /session — the authentication_error is gone.',
      terminalReason: 'error_during_execution',
      usage: SPENT,
    });
    expect(detectAuthFailure(agent)).toBeNull();
  });

  it('believes the same ambiguous wording from a run that never called the model', () => {
    const dead = result({ resultText: '401 Unauthorized', terminalReason: 'api_error' });
    expect(detectAuthFailure(dead)).toBe('401 Unauthorized');
  });

  /**
   * An omitted `usage` is not evidence of anything. The CLI drops the field in some
   * shapes, and treating that as "no tokens" is how three legitimate runs were once
   * misfiled as dead starts.
   */
  it('treats a missing usage block as no proof, not as proof of a dead start', () => {
    expect(detectAuthFailure(result({ resultText: '401 Unauthorized', usage: null }))).toBeNull();
    // …while unambiguous CLI wording still lands, because it needs no corroboration.
    expect(
      detectAuthFailure(result({ resultText: 'Failed to authenticate: bad token', usage: null })),
    ).toBe('Failed to authenticate: bad token');
  });

  it('is null for the ordinary failures that must stay retryable', () => {
    expect(detectAuthFailure(result({ terminalReason: 'api_error' }))).toBeNull();
    expect(detectAuthFailure(result({ resultText: 'the tests failed: 3 red', usage: SPENT }))).toBe(
      null,
    );
    expect(detectAuthFailure(result())).toBeNull();
  });

  it('exposes the text-only judgement for callers that hold no event', () => {
    expect(isAuthFailureText('Failed to authenticate: whatever')).toBe(true);
    expect(isAuthFailureText('api_error')).toBe(false);
  });
});

describe('AuthGate', () => {
  function gate() {
    const onChanged = vi.fn();
    const onResumeDue = vi.fn();
    const g = new AuthGate({ now: () => 1_000, onResumeDue, onChanged });
    return { g, onChanged, onResumeDue };
  }

  it('holds work from the first failure and names what the CLI said', () => {
    const { g, onChanged } = gate();
    expect(g.active).toBe(false);
    const state = g.engage('OAuth session expired', ['t1', 't2']);
    expect(g.active).toBe(true);
    expect(state).toEqual({
      since: 1_000,
      reason: 'OAuth session expired',
      source: 'run',
      parkedTaskIds: ['t1', 't2'],
    });
    expect(onChanged).toHaveBeenCalledWith(state);
  });

  /**
   * The queue drains into the same wall within seconds. Keeping the first reason stops
   * the banner rewriting itself once per card, and the later cards still get parked.
   */
  it('keeps the first reason but collects every later casualty', () => {
    const { g } = gate();
    g.engage('OAuth session expired', ['t1']);
    const state = g.engage('401 Unauthorized', ['t1', 't2']);
    expect(state.reason).toBe('OAuth session expired');
    expect(state.parkedTaskIds).toEqual(['t1', 't2']);
  });

  /** The gate names the host whose run actually proved the credential dead. */
  it('stamps the failing host on first engage', () => {
    const { g } = gate();
    const target = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;
    const state = g.engage('OAuth session expired', ['t1'], target);
    expect(state.target).toEqual(target);
  });

  /**
   * A task parked from a DIFFERENT host must not repaint the gate as though that host
   * failed — the gate keeps naming the one that did, exactly as it keeps the first reason.
   */
  it('does not let a later task from another host repaint the gate', () => {
    const { g } = gate();
    const failing = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;
    g.engage('OAuth session expired', ['t1'], failing);
    const state = g.engage('unrelated', ['t2'], { kind: 'local' });
    expect(state.target).toEqual(failing);
  });

  /**
   * The rule the usage-limit gate had to learn the hard way: nothing else re-enters a
   * chain, so a step stopped by the gate has to be parked IN the gate or the card sits
   * at 2/4 for ever.
   */
  it('parks later work into a gate that is already up, and only what is new', () => {
    const { g } = gate();
    g.engage('OAuth session expired', ['t1']);
    expect(g.park(['t2', 't1'])).toEqual(['t2']);
    expect(g.park(['t2'])).toEqual([]);
    expect(g.state?.parkedTaskIds).toEqual(['t1', 't2']);
  });

  it('parks nothing when no gate is up, so the caller knows to just run it', () => {
    const { g } = gate();
    expect(g.park(['t1'])).toEqual([]);
  });

  it('forgets a task the human stopped without lifting the gate', () => {
    const { g } = gate();
    g.engage('OAuth session expired', ['t1', 't2']);
    g.unpark(['t1']);
    expect(g.state?.parkedTaskIds).toEqual(['t2']);
    expect(g.active).toBe(true);
  });

  it('resumes everything it parked when it lifts, exactly once', () => {
    const { g, onChanged, onResumeDue } = gate();
    g.engage('OAuth session expired', ['t1', 't2']);
    g.lift();
    expect(onResumeDue).toHaveBeenCalledTimes(1);
    expect(onResumeDue.mock.calls[0][0].parkedTaskIds).toEqual(['t1', 't2']);
    expect(onChanged).toHaveBeenLastCalledWith(null);
    expect(g.active).toBe(false);
    g.lift(); // a second press of the button changes nothing
    expect(onResumeDue).toHaveBeenCalledTimes(1);
  });

  /** A restored gate has not been re-confirmed this session, and must say so. */
  it('re-raises a persisted gate as restored', () => {
    const { g, onChanged } = gate();
    const saved: AuthState = {
      since: 5,
      reason: 'OAuth session expired',
      source: 'run',
      parkedTaskIds: ['t1'],
    };
    g.restore(saved);
    expect(g.state).toEqual({ ...saved, source: 'restored' });
    expect(onChanged).toHaveBeenCalledWith(g.state);
  });
});
