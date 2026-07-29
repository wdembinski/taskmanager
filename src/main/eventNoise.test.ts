import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@shared/session';
import {
  isBenignToolFailure,
  MAX_TOOL_ERROR_CHARS,
  shouldSurfaceEvent,
  toolResultText,
} from './eventNoise';

describe('toolResultText', () => {
  it('takes a bare string', () => {
    expect(toolResultText('  boom  ')).toBe('boom');
  });

  it('joins the text of a block array, skipping blocks that carry none', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'first' },
        { type: 'image', source: {} },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('tolerates a raw string inside the array', () => {
    expect(toolResultText(['a', { type: 'text', text: 'b' }])).toBe('a\nb');
  });

  it.each([null, undefined, 42, {}, [], [null], [{ type: 'text' }]])(
    'is empty for %p rather than throwing',
    (input) => {
      expect(toolResultText(input)).toBe('');
    },
  );
});

describe('isBenignToolFailure', () => {
  it.each([
    'String to replace not found in file',
    'File has not been read yet. Read it first.',
    'File has been modified since read, either by the user or by a linter',
    'No such tool available: Frobnicate',
    'The user doesn’t want to take this action right now. It was cancelled.',
    'Request interrupted by user',
    'Found 3 matches of the string in the file',
  ])('folds away %s', (text) => {
    expect(isBenignToolFailure(text)).toBe(true);
  });

  it('folds away an error with nothing to say — it cannot be reported usefully', () => {
    expect(isBenignToolFailure('')).toBe(true);
    expect(isBenignToolFailure('   ')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isBenignToolFailure('STRING TO REPLACE NOT FOUND')).toBe(true);
  });

  it.each([
    'error: TS2322: Type string is not assignable to type never',
    'npm ERR! code ELIFECYCLE',
    'Permission denied (publickey)',
    'fatal: refusing to merge unrelated histories',
    'Command failed with exit code 1',
  ])('shows %s', (text) => {
    expect(isBenignToolFailure(text)).toBe(false);
  });

  it('defaults to SHOWN when the wording drifts, not hidden', () => {
    // The whole point of matching literal phrases: a CLI reword must degrade to noisy,
    // never to silent. Hiding a real failure is the expensive mistake.
    expect(isBenignToolFailure('the text you asked me to swap could not be located')).toBe(false);
  });
});

describe('shouldSurfaceEvent', () => {
  const rateLimit = (status: string): SessionEvent => ({
    kind: 'rate-limit',
    status,
    rateLimitType: 'five_hour',
    resetsAt: null,
  });

  it.each(['', 'allowed', 'allowed_warning', 'approaching_warning'])(
    'hides a healthy rate-limit signal (%s) — the account is fine',
    (status) => {
      // The literal complaint: `Usage limit: allowed (five_hour)` painted in red.
      expect(shouldSurfaceEvent(rateLimit(status))).toBe(false);
    },
  );

  it.each(['rejected', 'rate_limited', 'exceeded'])('shows a real block (%s)', (status) => {
    expect(shouldSurfaceEvent(rateLimit(status))).toBe(true);
  });

  it('shows every other kind of event, including a benign tool failure', () => {
    // A benign failure is still EMITTED — it is what resolves the paired tool-use's
    // spinner. It is folded away by the renderer, not dropped here.
    const events: SessionEvent[] = [
      { kind: 'assistant', text: 'hi' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool-use', name: 'Edit', toolId: 't1' },
      { kind: 'tool-result', toolId: 't1', isError: true, errorText: 'x', benign: true },
      { kind: 'stderr', text: 'warn' },
      { kind: 'exited', code: 0 },
    ];
    for (const event of events) expect(shouldSurfaceEvent(event)).toBe(true);
  });
});

describe('MAX_TOOL_ERROR_CHARS', () => {
  it('is big enough for a real compiler error and small enough for a table', () => {
    expect(MAX_TOOL_ERROR_CHARS).toBeGreaterThan(500);
    expect(MAX_TOOL_ERROR_CHARS).toBeLessThan(10_000);
  });
});
