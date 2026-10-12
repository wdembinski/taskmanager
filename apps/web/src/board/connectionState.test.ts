import { describe, expect, it } from 'vitest';
import type { ClientPresence } from '@tm/protocol/wire';
import { connectionStripText, worstConnectionState } from './connectionState';
import { describeClient } from './targetClient';

const client = (overrides: Partial<ClientPresence> = {}): ClientPresence => ({
  id: 'abc',
  lastSeen: 0,
  ...overrides,
});

describe('worstConnectionState', () => {
  it('is null when nothing is set', () => {
    expect(worstConnectionState(null, null, null)).toBeNull();
  });

  it('reports unreachable alone', () => {
    expect(worstConnectionState('board read failed (401)', null, null)).toEqual({
      kind: 'unreachable',
      message: 'board read failed (401)',
    });
  });

  it('reports stale alone', () => {
    expect(worstConnectionState(null, { everSeenClient: true }, null)).toEqual({
      kind: 'stale',
      everSeenClient: true,
    });
  });

  it('reports skew alone', () => {
    const c = client();
    expect(worstConnectionState(null, null, { skew: 'desktop-older', client: c })).toEqual({
      kind: 'skew',
      skew: 'desktop-older',
      client: c,
    });
  });

  it('ranks unreachable over stale and skew', () => {
    const c = client();
    expect(
      worstConnectionState(
        'board read failed (401)',
        { everSeenClient: true },
        {
          skew: 'desktop-older',
          client: c,
        },
      ),
    ).toEqual({ kind: 'unreachable', message: 'board read failed (401)' });
  });

  it('ranks stale over skew', () => {
    const c = client();
    expect(
      worstConnectionState(null, { everSeenClient: false }, { skew: 'desktop-newer', client: c }),
    ).toEqual({ kind: 'stale', everSeenClient: false });
  });
});

describe('connectionStripText', () => {
  it('is an error for unreachable', () => {
    expect(
      connectionStripText({ kind: 'unreachable', message: 'board read failed (401)' }),
    ).toEqual({
      intent: 'error',
      text: expect.stringContaining('board read failed (401)'),
    });
  });

  it('is a warning for stale', () => {
    const result = connectionStripText({ kind: 'stale', everSeenClient: true });
    expect(result.intent).toBe('warning');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('distinguishes stale wording for an account that never had a Client', () => {
    const everHad = connectionStripText({ kind: 'stale', everSeenClient: true });
    const neverHad = connectionStripText({ kind: 'stale', everSeenClient: false });
    expect(everHad.text).not.toBe(neverHad.text);
  });

  it('is a warning for skew, naming the client via describeClient', () => {
    const c = client({ info: { name: 'WORKSTATION' } });
    const result = connectionStripText({ kind: 'skew', skew: 'desktop-older', client: c });
    expect(result.intent).toBe('warning');
    expect(result.text).toContain(describeClient(c));
  });
});
