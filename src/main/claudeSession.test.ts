/**
 * Unit tests for the pure parts of the session runner: the NDJSON→SessionEvent
 * mapper and the CLI argument builder. The sample events below are trimmed
 * copies of REAL output captured from `claude … --output-format stream-json`,
 * so these tests pin our parser to the actual protocol.
 */
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, encodeUserMessage, mapRawEvent } from './claudeSession';

describe('mapRawEvent', () => {
  it('maps the init system event to a started event with the session id', () => {
    const events = mapRawEvent({
      type: 'system',
      subtype: 'init',
      session_id: '68f412b8-9785-47ec-845e-42e51e6459c9',
      model: 'claude-haiku-4-5-20251001',
      cwd: 'C:\\work',
      permissionMode: 'acceptEdits',
    });
    expect(events).toEqual([
      {
        kind: 'started',
        sessionId: '68f412b8-9785-47ec-845e-42e51e6459c9',
        model: 'claude-haiku-4-5-20251001',
        cwd: 'C:\\work',
        permissionMode: 'acceptEdits',
      },
    ]);
  });

  it('extracts the reset time from a rate_limit_event', () => {
    const events = mapRawEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1783368600, rateLimitType: 'five_hour' },
    });
    expect(events).toEqual([
      { kind: 'rate-limit', status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1783368600 },
    ]);
  });

  it('splits an assistant message into thinking, text, and tool-use events', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'pong' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events).toEqual([
      { kind: 'thinking', text: 'let me think' },
      { kind: 'assistant', text: 'pong' },
      // tool_use now carries its input so the Phase 4 risk policy can inspect it.
      { kind: 'tool-use', name: 'Bash', toolId: 'toolu_1', input: { command: 'ls' } },
    ]);
  });

  it('maps a tool_result inside a user message', () => {
    const events = mapRawEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] },
    });
    expect(events).toEqual([{ kind: 'tool-result', toolId: 'toolu_1', isError: false }]);
  });

  it('maps the final result event with cost and stop reason', () => {
    const events = mapRawEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'pong',
      total_cost_usd: 0.0159,
      duration_ms: 1494,
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
    });
    expect(events).toEqual([
      {
        kind: 'result',
        success: true,
        resultText: 'pong',
        costUsd: 0.0159,
        durationMs: 1494,
        stopReason: 'end_turn',
        terminalReason: 'completed',
      },
    ]);
  });

  it('ignores noise (progress events, unknown types, non-objects)', () => {
    expect(mapRawEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
    expect(mapRawEvent({ type: 'something_new' })).toEqual([]);
    expect(mapRawEvent(null)).toEqual([]);
    expect(mapRawEvent('not-json')).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  it('builds print + stream-json args and never includes the prompt', () => {
    const args = buildClaudeArgs(
      { prompt: 'do the thing', cwd: 'C:\\work', model: 'haiku', permissionMode: 'acceptEdits' },
      'session-123',
    );
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--permission-mode',
      'acceptEdits',
      '--session-id',
      'session-123',
    ]);
    // The prompt must travel over stdin, never the command line.
    expect(args).not.toContain('do the thing');
  });

  it('adds the permission gate flags and forces default mode when gated', () => {
    const args = buildClaudeArgs(
      { prompt: 'x', cwd: 'C:\\work', model: 'haiku', permissionMode: 'acceptEdits' },
      'session-123',
      { configPath: 'C:\\tmp\\mcp-1.json' },
    );
    // The gate makes our policy authoritative for every tool, so mode is 'default'.
    const modeIndex = args.indexOf('--permission-mode');
    expect(args[modeIndex + 1]).toBe('default');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('C:\\tmp\\mcp-1.json');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('mcp__orchestrator-permissions__approve');
  });
});

describe('encodeUserMessage', () => {
  it('wraps text as a newline-terminated stream-json user turn', () => {
    const line = encodeUserMessage('hello');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
  });
});
