/**
 * Unit tests for the pure parts of the session runner: the NDJSON→SessionEvent
 * mapper and the CLI argument builder. The sample events below are trimmed
 * copies of REAL output captured from `claude … --output-format stream-json`,
 * so these tests pin our parser to the actual protocol.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { MAX_TOOL_ERROR_CHARS } from './eventNoise';
import { HEADLESS_TURN_CONTRACT } from './headlessContract';
import {
  buildClaudeArgs,
  buildSessionEnv,
  encodeUserMessage,
  mapRawEvent,
  quoteCmdArg,
  runClaudeSession,
} from './claudeSession';
import type { ExecHost } from './exec';
import type { StartSessionRequest } from '@shared/session';

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
      // This message also calls a tool, so its text is narration, not an answer.
      { kind: 'assistant', text: 'pong', preamble: true },
      // tool_use now carries its input so the Phase 4 risk policy can inspect it.
      { kind: 'tool-use', name: 'Bash', toolId: 'toolu_1', input: { command: 'ls' } },
    ]);
  });

  it('flags preamble on EVERY text block when the message also calls a tool', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first, let me check the file' },
          { type: 'text', text: 'now let me run it' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events).toEqual([
      { kind: 'assistant', text: 'first, let me check the file', preamble: true },
      { kind: 'assistant', text: 'now let me run it', preamble: true },
      { kind: 'tool-use', name: 'Bash', toolId: 'toolu_1', input: { command: 'ls' } },
    ]);
  });

  it('does NOT flag a text-only message as preamble — it is the turn’s answer', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'here is the summary' }] },
    });
    expect(events).toEqual([{ kind: 'assistant', text: 'here is the summary', preamble: false }]);
  });

  it('maps a tool_result inside a user message', () => {
    const events = mapRawEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] },
    });
    expect(events).toEqual([{ kind: 'tool-result', toolId: 'toolu_1', isError: false }]);
  });

  it('carries a FAILED tool result’s reason, so the UI can say more than "a tool call failed"', () => {
    const events = mapRawEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: [{ type: 'text', text: 'error TS2322: Type string is not assignable' }],
          },
        ],
      },
    });
    expect(events).toEqual([
      {
        kind: 'tool-result',
        toolId: 'toolu_2',
        isError: true,
        errorText: 'error TS2322: Type string is not assignable',
        benign: false,
      },
    ]);
  });

  it('flags a failure the agent fixes on its own next turn', () => {
    const [event] = mapRawEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_3',
            is_error: true,
            content: 'String to replace not found in file.',
          },
        ],
      },
    });
    expect(event).toMatchObject({ isError: true, benign: true });
  });

  it('caps a runaway error so one tool cannot bloat the transcript', () => {
    const [event] = mapRawEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't', is_error: true, content: 'x'.repeat(50_000) },
        ],
      },
    });
    expect((event as { errorText: string }).errorText).toHaveLength(MAX_TOOL_ERROR_CHARS);
  });

  it('carries nothing extra on SUCCESS — the content there is the tool’s output, not ours', () => {
    const events = mapRawEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't', is_error: false, content: 'a whole file' },
        ],
      },
    });
    expect(events).toEqual([{ kind: 'tool-result', toolId: 't', isError: false }]);
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
        usage: {
          inputTokens: 12,
          outputTokens: 34,
          cacheCreationTokens: 100,
          cacheReadTokens: 900,
        },
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
      {
        kind: 'usage',
        inputTokens: 5,
        outputTokens: 7,
        cacheCreationTokens: 0,
        cacheReadTokens: 2048,
      },
      { kind: 'assistant', text: 'hi', preamble: false },
    ]);
  });

  it('omits the usage event when an assistant message has no usage block', () => {
    const events = mapRawEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(events).toEqual([{ kind: 'assistant', text: 'hi', preamble: false }]);
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

  it('passes disallowedTools as one comma-joined --disallowedTools flag', () => {
    const args = buildClaudeArgs(
      {
        prompt: 'x',
        cwd: 'C:\\work',
        model: 'haiku',
        permissionMode: 'plan',
        disallowedTools: ['Edit', 'Write', 'Bash'],
      },
      'session-123',
    );
    const index = args.indexOf('--disallowedTools');
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe('Edit,Write,Bash');
  });

  it('adds no --disallowedTools flag when the list is absent or empty', () => {
    for (const disallowedTools of [undefined, []]) {
      const args = buildClaudeArgs(
        { prompt: 'x', cwd: 'C:\\work', model: 'haiku', permissionMode: 'plan', disallowedTools },
        'session-123',
      );
      expect(args).not.toContain('--disallowedTools');
    }
  });
});

describe('buildClaudeArgs — tool restriction and settings isolation (F16.4)', () => {
  const base: StartSessionRequest = {
    prompt: 'x',
    cwd: 'C:\\work',
    model: 'haiku',
    permissionMode: 'acceptEdits',
  };
  const gate = { configPath: 'C:\\tmp\\mcp-1.json' };
  const head = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--model',
    'haiku',
  ];
  const gateTail = [
    '--mcp-config',
    'C:\\tmp\\mcp-1.json',
    '--permission-prompt-tool',
    'mcp__orchestrator-permissions__approve',
  ];

  // Every existing caller sets none of the new fields, so its arguments must not move by a
  // byte. The first three are written out in full on purpose.
  const unchanged: {
    name: string;
    req: StartSessionRequest;
    gate?: { configPath: string };
    resume?: boolean;
    contract?: string;
    expected: string[];
  }[] = [
    {
      name: 'plain',
      req: base,
      expected: [
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
      ],
    },
    {
      name: 'gated',
      req: base,
      gate,
      expected: [
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--verbose',
        '--model',
        'haiku',
        '--permission-mode',
        'default',
        '--session-id',
        'session-123',
        '--mcp-config',
        'C:\\tmp\\mcp-1.json',
        '--permission-prompt-tool',
        'mcp__orchestrator-permissions__approve',
      ],
    },
    {
      name: 'with disallowedTools',
      req: { ...base, disallowedTools: ['Edit', 'Write'] },
      expected: [
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
        '--disallowedTools',
        'Edit,Write',
      ],
    },
    {
      name: 'resume',
      req: base,
      resume: true,
      expected: [...head, '--permission-mode', 'acceptEdits', '--resume', 'session-123'],
    },
    {
      name: 'plan + gated',
      req: { ...base, permissionMode: 'plan' },
      gate,
      expected: [...head, '--permission-mode', 'plan', '--session-id', 'session-123', ...gateTail],
    },
    {
      name: 'with a contract path',
      req: base,
      contract: 'C:\\tmp\\contract.md',
      expected: [
        ...head,
        '--permission-mode',
        'acceptEdits',
        '--session-id',
        'session-123',
        '--append-system-prompt-file',
        'C:\\tmp\\contract.md',
      ],
    },
    {
      // boardReviewer / aiVisualReviewer: plan mode, AI_REVIEW_DISALLOWED_TOOLS, gated, contract.
      name: 'the boardReviewer / aiVisualReviewer shape',
      req: {
        ...base,
        permissionMode: 'plan',
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      },
      gate,
      contract: 'C:\\tmp\\contract.md',
      expected: [
        ...head,
        '--permission-mode',
        'plan',
        '--session-id',
        'session-123',
        '--append-system-prompt-file',
        'C:\\tmp\\contract.md',
        '--disallowedTools',
        'Edit,Write,MultiEdit,NotebookEdit,Bash',
        ...gateTail,
      ],
    },
  ];

  it.each(unchanged)(
    'builds byte-identical args when no new field is set: $name',
    ({ req, gate: g, resume, contract, expected }) => {
      expect(buildClaudeArgs(req, 'session-123', g, resume ?? false, contract)).toEqual(expected);
    },
  );

  const tailOf = (req: StartSessionRequest, g?: { configPath: string }): string[] =>
    buildClaudeArgs(req, 'session-123', g).slice(buildClaudeArgs(base, 'session-123', g).length);

  it('passes allowedTools as one comma-joined --allowedTools value, patterns intact', () => {
    expect(tailOf({ ...base, allowedTools: ['Read', 'Bash(git log:*)'] })).toEqual([
      '--allowedTools',
      'Read,Bash(git log:*)',
    ]);
  });

  it('adds no --allowedTools flag for an empty list', () => {
    expect(buildClaudeArgs({ ...base, allowedTools: [] }, 'session-123')).not.toContain(
      '--allowedTools',
    );
  });

  it('passes settingSources as --setting-sources, and an empty list as an empty value', () => {
    expect(tailOf({ ...base, settingSources: ['user'] })).toEqual(['--setting-sources', 'user']);
    // `''` means "load no settings" — a real choice, not the same as leaving the flag off.
    expect(tailOf({ ...base, settingSources: [] })).toEqual(['--setting-sources', '']);
  });

  it('adds --strict-mcp-config when set, alongside the gate', () => {
    expect(tailOf({ ...base, strictMcpConfig: true })).toEqual(['--strict-mcp-config']);
    const gated = buildClaudeArgs({ ...base, strictMcpConfig: true }, 'session-123', gate);
    // The relay's own --mcp-config must still load; only a repo's `.mcp.json` is shut out.
    expect(gated).toContain('--mcp-config');
    expect(gated).toContain('--strict-mcp-config');
    expect(buildClaudeArgs({ ...base, strictMcpConfig: false }, 'session-123')).not.toContain(
      '--strict-mcp-config',
    );
  });

  it('builds the full AI PR review shape with the exact tail', () => {
    const args = buildClaudeArgs(
      {
        ...base,
        permissionMode: 'plan',
        allowedTools: [
          'Read',
          'Grep',
          'Glob',
          'Bash(git log:*)',
          'Bash(git show:*)',
          'Bash(git diff:*)',
          'Bash(git blame:*)',
        ],
        disallowedTools: [
          'Edit',
          'Write',
          'MultiEdit',
          'NotebookEdit',
          'WebFetch',
          'WebSearch',
          'Task',
        ],
        settingSources: ['user'],
        strictMcpConfig: true,
      },
      'session-123',
      gate,
      false,
      'C:\\tmp\\contract.md',
    );
    expect(args).toEqual([
      ...head,
      '--permission-mode',
      'plan',
      '--session-id',
      'session-123',
      '--append-system-prompt-file',
      'C:\\tmp\\contract.md',
      '--disallowedTools',
      'Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task',
      ...gateTail,
      '--allowedTools',
      'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git blame:*)',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
    ]);
  });
});

describe('quoteCmdArg', () => {
  it('leaves an argument that needs no quoting unchanged', () => {
    expect(quoteCmdArg('-p')).toBe('-p');
    expect(quoteCmdArg('C:\\tmp\\x.md')).toBe('C:\\tmp\\x.md');
  });

  it('wraps a tool pattern (space, parentheses, commas) in double quotes', () => {
    expect(quoteCmdArg('Read,Bash(git log:*)')).toBe('"Read,Bash(git log:*)"');
  });

  it('quotes an empty argument so cmd.exe still passes it', () => {
    expect(quoteCmdArg('')).toBe('""');
  });

  it('refuses what cmd.exe cannot carry safely: a quote, a percent, a line break', () => {
    for (const bad of ['a"b', '50%', 'a\nb']) expect(() => quoteCmdArg(bad)).toThrow();
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
  /**
   * Contract files written by these tests. The real cleanup runs on the child's `close`
   * event, which a fake child never emits — so without this the suite quietly litters the
   * OS temp directory a few files at a time, every run.
   */
  const written: string[] = [];
  afterEach(() => {
    for (const path of written.splice(0)) {
      try {
        unlinkSync(path);
      } catch {
        // A test that cleaned up after itself already.
      }
    }
  });

  function fakeHost(): {
    host: ExecHost;
    argvs: string[][];
    envs: (Record<string, string> | undefined)[];
  } {
    const argvs: string[][] = [];
    const envs: (Record<string, string> | undefined)[] = [];
    const host = {
      target: { kind: 'local' } as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawn: (
        _cwd: string,
        _file: string,
        args: string[],
        opts?: { env?: Record<string, string> },
      ) => {
        argvs.push(args);
        envs.push(opts?.env);
        const contract = args[args.indexOf('--append-system-prompt-file') + 1];
        if (contract) written.push(contract);
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
    return { host, argvs, envs };
  }

  const request: StartSessionRequest = {
    prompt: 'do the thing',
    cwd: '/tmp',
    model: 'haiku',
    permissionMode: 'acceptEdits',
  };

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

  /**
   * The wiring, not just the argument builder: a run must actually materialize the
   * contract where it tells the CLI to look. A path pointing at nothing would leave every
   * agent free to strand itself again, and nothing else in the system would notice.
   */
  it('writes the headless contract and points the CLI at that exact file', () => {
    const { host, argvs } = fakeHost();
    runClaudeSession(request, () => undefined, { host });

    const i = argvs[0].indexOf('--append-system-prompt-file');
    expect(i).toBeGreaterThan(-1);
    const path = argvs[0][i + 1];
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(HEADLESS_TURN_CONTRACT);
  });

  it('appends the skills section after the contract when skillsSection is set', () => {
    const { host, argvs } = fakeHost();
    runClaudeSession(request, () => undefined, {
      host,
      skillsSection: '## Skills in force for this run\n\nDo the thing skillfully.',
    });

    const path = argvs[0][argvs[0].indexOf('--append-system-prompt-file') + 1];
    const contents = readFileSync(path, 'utf8');
    expect(contents.startsWith(HEADLESS_TURN_CONTRACT)).toBe(true);
    expect(contents).toContain('## Skills in force for this run');
    expect(contents).toContain('Do the thing skillfully.');
  });

  it('still appends the skills section on a chat resume', () => {
    const { host, argvs } = fakeHost();
    runClaudeSession(request, () => undefined, {
      host,
      resumeSessionId: '11111111-2222-3333-4444-555555555555',
      skillsSection: '## Skills in force for this run\n\nDo the thing skillfully.',
    });

    const path = argvs[0][argvs[0].indexOf('--append-system-prompt-file') + 1];
    const contents = readFileSync(path, 'utf8');
    expect(contents.startsWith(HEADLESS_TURN_CONTRACT)).toBe(true);
    expect(contents).toContain('## Skills in force for this run');
    expect(contents).toContain('Do the thing skillfully.');
  });

  it('gives concurrent runs their own contract file, so neither can delete the other’s', () => {
    const { host, argvs } = fakeHost();
    runClaudeSession(request, () => undefined, { host });
    runClaudeSession(request, () => undefined, { host });

    const paths = argvs.map((a) => a[a.indexOf('--append-system-prompt-file') + 1]);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it('passes neither CLI env override when the request sets neither', () => {
    const { host, envs } = fakeHost();
    runClaudeSession(request, () => undefined, { host });
    expect(envs[0]).toBeUndefined();
  });

  it('passes the compaction override alone when only autoCompactPercent is set', () => {
    const { host, envs } = fakeHost();
    runClaudeSession({ ...request, autoCompactPercent: 70 }, () => undefined, { host });
    expect(envs[0]).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' });
  });

  it('passes the subagent model override alone when only subagentModel is set', () => {
    const { host, envs } = fakeHost();
    runClaudeSession({ ...request, subagentModel: 'haiku' }, () => undefined, { host });
    expect(envs[0]).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  });

  it('passes both overrides when the request sets both', () => {
    const { host, envs } = fakeHost();
    runClaudeSession(
      { ...request, autoCompactPercent: 50, subagentModel: 'opus' },
      () => undefined,
      { host },
    );
    expect(envs[0]).toEqual({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
    });
  });
});

describe('buildSessionEnv', () => {
  const req = {
    prompt: 'x',
    cwd: '/tmp',
    model: 'haiku' as const,
    permissionMode: 'acceptEdits' as const,
  };

  it('is empty when neither setting is set', () => {
    expect(buildSessionEnv(req)).toEqual({});
  });

  it('treats null the same as unset — the AppSettings default for both', () => {
    expect(buildSessionEnv({ ...req, autoCompactPercent: null, subagentModel: null })).toEqual({});
  });

  it('sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE only when autoCompactPercent is set', () => {
    expect(buildSessionEnv({ ...req, autoCompactPercent: 70 })).toEqual({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
    });
  });

  it('sets CLAUDE_CODE_SUBAGENT_MODEL only when subagentModel is set', () => {
    expect(buildSessionEnv({ ...req, subagentModel: 'opus' })).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
    });
  });
});

describe('HEADLESS_TURN_CONTRACT — delegation rule', () => {
  it('tells a session to answer a lookup itself rather than always delegating', () => {
    expect(HEADLESS_TURN_CONTRACT).toContain('Grep/Read');
    expect(HEADLESS_TURN_CONTRACT).toContain('cheaper `model`');
  });
});

describe('buildClaudeArgs — the headless contract (Phase 18)', () => {
  const req = {
    prompt: 'x',
    cwd: 'C:\work',
    model: 'haiku' as const,
    permissionMode: 'acceptEdits' as const,
  };

  it('points the CLI at the contract FILE, never at its text', () => {
    const args = buildClaudeArgs(req, 's1', undefined, false, 'C:\tmp\contract.md');
    const i = args.indexOf('--append-system-prompt-file');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('C:\tmp\contract.md');
    // The inline form would be rewritten by cmd.exe: the CLI is spawned with shell: true,
    // and the contract is multi-line and full of quotes and ampersands.
    expect(args).not.toContain('--append-system-prompt');
  });

  // A resume is the path that most needs it — its prompt is the human's raw words, so it
  // carries no guidance of its own at all.
  it('still carries the contract when resuming', () => {
    const args = buildClaudeArgs(req, 's1', undefined, true, 'C:\tmp\contract.md');
    expect(args).toContain('--append-system-prompt-file');
    expect(args).toContain('--resume');
  });

  it('is omitted entirely when no contract could be written', () => {
    // Failing to materialize the file must not stop the run — a stranded agent is bad,
    // a card that will not start at all is worse.
    const args = buildClaudeArgs(req, 's1');
    expect(args).not.toContain('--append-system-prompt-file');
  });
});
