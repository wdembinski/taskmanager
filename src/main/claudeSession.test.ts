/**
 * Unit tests for the pure parts of the session runner: the NDJSON→SessionEvent
 * mapper and the CLI argument builder. The sample events below are trimmed
 * copies of REAL output captured from `claude … --output-format stream-json`,
 * so these tests pin our parser to the actual protocol.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  buildClaudeArgs,
  encodeUserMessage,
  mapRawEvent,
  runClaudeSession,
} from './claudeSession';
import type { ExecHost } from './exec';

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

  it('maps the final result event with cost, stop reason, and cumulative usage', () => {
    const events = mapRawEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'pong',
      total_cost_usd: 0.0159,
      duration_ms: 1494,
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 900,
      },
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
        usage: { inputTokens: 12, outputTokens: 34, cacheCreationTokens: 100, cacheReadTokens: 900 },
      },
    ]);
  });

  it('carries usage: null on a result event that lacks a usage block', () => {
    const [event] = mapRawEvent({ type: 'result', is_error: false, result: 'ok' });
    expect(event).toMatchObject({ kind: 'result', usage: null });
  });

  it('emits a per-turn usage event from an assistant message that reports usage', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2048,
        },
        content: [{ type: 'text', text: 'hi' }],
      },
    });
    expect(events).toEqual([
      { kind: 'usage', inputTokens: 5, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 2048 },
      { kind: 'assistant', text: 'hi' },
    ]);
  });

  it('omits the usage event when an assistant message has no usage block', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(events).toEqual([{ kind: 'assistant', text: 'hi' }]);
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

  it('resumes an existing conversation with --resume instead of --session-id', () => {
    const args = buildClaudeArgs(
      { prompt: 'continue', cwd: 'C:\\work', model: 'haiku', permissionMode: 'acceptEdits' },
      'session-123',
      undefined,
      true,
    );
    // Phase 5 auto-respawn: same id, but as a resume so history is preserved.
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    const resumeIndex = args.indexOf('--resume');
    expect(args[resumeIndex + 1]).toBe('session-123');
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

  it('keeps plan mode even when gated, and still gates it (Phase 11)', () => {
    const args = buildClaudeArgs(
      { prompt: 'x', cwd: 'C:\\work', model: 'haiku', permissionMode: 'plan' },
      'session-123',
      { configPath: 'C:\\tmp\\mcp-1.json' },
    );
    // Rewriting plan → default would let a "plan this" run start editing, and would
    // never produce the ExitPlanMode call the orchestrator turns into subtasks.
    const modeIndex = args.indexOf('--permission-mode');
    expect(args[modeIndex + 1]).toBe('plan');
    expect(args).toContain('--permission-prompt-tool');
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

/**
 * One task = one session, and one SUBTASK = one session too. This is what keeps a
 * plan's context (and its token cost) from accumulating across steps, so it is
 * pinned rather than left as an implicit consequence of how ids are generated.
 *
 * A fake host makes this checkable without spawning anything — the same seam the
 * WSL target uses.
 */
describe('session isolation', () => {
  function fakeHost(): { host: ExecHost; argvs: string[][] } {
    const argvs: string[][] = [];
    const host = {
      target: { kind: 'local' } as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawn: (_cwd: string, _file: string, args: string[]) => {
        argvs.push(args);
        const child = {
          stdin: Object.assign(new PassThrough(), { writable: true }),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          on: () => undefined,
          kill: () => undefined,
        };
        return { child: child as never, terminate: () => undefined };
      },
      toNative: (p: string) => p,
      toApp: (p: string) => p,
      relaySpec: () => ({ command: '', args: [], env: {} }),
      homeDir: async () => '/home/test',
    } as unknown as ExecHost;
    return { host, argvs };
  }

  const request = {
    prompt: 'do the thing',
    cwd: '/tmp',
    model: 'haiku',
    permissionMode: 'acceptEdits',
  } as never;

  it('gives every fresh run its own session id, claimed with --session-id', () => {
    const { host, argvs } = fakeHost();
    const first = runClaudeSession(request, () => undefined, { host });
    const second = runClaudeSession(request, () => undefined, { host });

    // Two steps of one plan must never share a conversation.
    expect(first.sessionId).not.toBe(second.sessionId);
    for (const args of argvs) {
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
    }
    expect(argvs[0]).toContain(first.sessionId);
    expect(argvs[1]).toContain(second.sessionId);
  });

  it('resumes only when explicitly asked, keeping the SAME id', () => {
    const { host, argvs } = fakeHost();
    const existing = '11111111-2222-3333-4444-555555555555';
    const handle = runClaudeSession(request, () => undefined, {
      host,
      resumeSessionId: existing,
    });

    expect(handle.sessionId).toBe(existing);
    expect(argvs[0]).toContain('--resume');
    expect(argvs[0]).not.toContain('--session-id');
  });
});
