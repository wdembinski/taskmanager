/**
 * Unit tests for the pure question detector. Permissions are covered by
 * permissionPolicy.test.ts (and exercised through the broker, not here).
 */
import { describe, expect, it } from 'vitest';
import { detectAttention, detectQuestion, NEEDS_INPUT_SENTINEL } from './attention';
import type { SessionEvent } from '@shared/session';

describe('detectQuestion — the @@NEEDS_INPUT@@ contract', () => {
  it('extracts a free-text question that follows the sentinel', () => {
    expect(detectQuestion(`${NEEDS_INPUT_SENTINEL} Which database should I use?`)).toEqual({
      kind: 'question',
      prompt: 'Which database should I use?',
      options: [],
    });
  });

  it('parses following "- " bullets as multiple-choice options', () => {
    const text = `Some preamble.\n${NEEDS_INPUT_SENTINEL} Which storage backend?\n- SQLite (embedded)\n- Postgres (needs a server)`;
    expect(detectQuestion(text)).toEqual({
      kind: 'question',
      prompt: 'Which storage backend?',
      options: ['SQLite (embedded)', 'Postgres (needs a server)'],
    });
  });

  it('does NOT fire on prose that merely contains a question mark', () => {
    expect(detectQuestion('I wondered whether to cache this? I did, and moved on.')).toBeNull();
    expect(detectQuestion('Done — everything passes.')).toBeNull();
  });

  it('falls back to a generic prompt when the marker has no text', () => {
    expect(detectQuestion(NEEDS_INPUT_SENTINEL)).toEqual({
      kind: 'question',
      prompt: 'Claude needs input to continue.',
      options: [],
    });
  });
});

describe('detectAttention', () => {
  it('detects a sentinel question in an assistant event', () => {
    const event: SessionEvent = { kind: 'assistant', text: `${NEEDS_INPUT_SENTINEL} pick one?` };
    expect(detectAttention(event)).toEqual({ kind: 'question', prompt: 'pick one?', options: [] });
  });

  it('ignores other event kinds and non-sentinel assistant text', () => {
    expect(detectAttention({ kind: 'assistant', text: 'working on it' })).toBeNull();
    expect(detectAttention({ kind: 'tool-use', name: 'Bash', toolId: 't', input: {} })).toBeNull();
    expect(detectAttention({ kind: 'exited', code: 0 })).toBeNull();
  });
});
