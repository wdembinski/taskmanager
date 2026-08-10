/**
 * Unit tests for the pure status-summary logic. These run under Vitest with no
 * Electron, no filesystem, and no `claude` binary — we just feed in the raw
 * facts and assert the flags + message the UI will see.
 */
import { describe, expect, it } from 'vitest';
import { summarizeClaudeStatus } from './claudeStatus';

describe('summarizeClaudeStatus', () => {
  it('reports a healthy subscription setup', () => {
    const s = summarizeClaudeStatus({
      version: '2.1.200',
      authenticated: true,
      apiKeyDetected: false,
    });
    expect(s.installed).toBe(true);
    expect(s.version).toBe('2.1.200');
    expect(s.message).toContain('2.1.200');
    expect(s.message).toContain('subscription');
  });

  it('flags a missing CLI first, above all other issues', () => {
    const s = summarizeClaudeStatus({
      version: null,
      authenticated: false,
      apiKeyDetected: true,
    });
    expect(s.installed).toBe(false);
    expect(s.message).toContain('not found');
  });

  it('warns when an API key would cause paid-API billing', () => {
    const s = summarizeClaudeStatus({
      version: '2.1.200',
      authenticated: true,
      apiKeyDetected: true,
    });
    expect(s.message).toContain('ANTHROPIC_API_KEY');
  });

  it('tells an installed-but-logged-out user to sign in', () => {
    const s = summarizeClaudeStatus({
      version: '2.1.200',
      authenticated: false,
      apiKeyDetected: false,
    });
    expect(s.message).toContain('not logged in');
  });
});
