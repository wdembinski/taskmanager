/**
 * The session runner — the piece that actually drives Claude.
 *
 * We do NOT bundle Anthropic's SDK (it is proprietary). Instead we treat the
 * user's installed `claude` command as an external tool — like calling `git` —
 * and talk to it over its documented stream-json protocol. This keeps our own
 * dependency tree permissive (MIT/Apache) for commercial use.
 *
 * How one run works:
 *   1. We generate a session id (UUID) up front and pass it with `--session-id`,
 *      so we can resume this exact conversation later (after a limit reset or an
 *      app restart) without losing context.
 *   2. We spawn `claude -p --output-format stream-json --input-format stream-json
 *      --verbose …` in the project's directory, and feed the PROMPT via stdin as
 *      a stream-json user message (never the command line — that avoids all
 *      Windows quoting/escaping problems).
 *   3. Claude streams newline-delimited JSON (NDJSON) events on stdout. We split
 *      those into lines, parse each, and translate the raw shapes into our small,
 *      stable `SessionEvent` union (see mapRawEvent).
 *
 * Phase 4 keeps the INPUT stream open (`--input-format stream-json`, stdin not
 * closed) so we can push more messages into a live session — the answer to a
 * question, or an approval — via `SessionHandle.send`, and Claude continues the
 * same conversation without a restart. Because stdin stays open the process no
 * longer exits on its own after a `result`; the caller ends it with `stop()`.
 */
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvent, StartSessionRequest } from '@shared/session';
import { localHost, type ExecHost } from './exec';
import { PERMISSION_MCP_SERVER_KEY, PERMISSION_PROMPT_TOOL } from './permissionServerSource';

/** A live handle to a running session so callers can send to / stop it. */
export interface SessionHandle {
  /** The session id we assigned (also arrives in the 'started' event). */
  sessionId: string;
  /** Push a user message into the still-open input stream (Phase 4). */
  send(message: string): void;
  /** Terminate the underlying process. */
  stop(): void;
}

/**
 * Everything the CLI needs to route this session's tool uses through our
 * pre-execution veto (Phase 4 hardening). When present, the session runs with the
 * broker's MCP approval tool wired in; when absent, it runs ungated.
 */
export interface PermissionGate {
  /** Localhost URL of the in-app broker the relay POSTs decisions to. */
  brokerUrl: string;
  /** Per-run bearer token the relay must present. */
  token: string;
  /** Path to the materialized MCP relay script (`permission-server.cjs`). */
  serverScriptPath: string;
  /** Directory to write this session's throwaway MCP config file into. */
  configDir: string;
}

/** Optional extras for a run: a correlation id and the permission gate. */
export interface RunSessionOptions {
  /** Correlation id shared with the gate (the SessionManager runId). */
  runId?: string;
  /** When set, gate every tool use through the broker (a true veto). */
  permission?: PermissionGate;
  /**
   * Resume an existing conversation (Phase 5 auto-respawn) instead of starting a
   * fresh one. When set, the CLI runs with `--resume <id>` on this exact session,
   * preserving all prior context; the prompt becomes a nudge to continue.
   */
  resumeSessionId?: string;
  /**
   * Which machine runs the CLI. Defaults to the machine the GUI runs on, so an
   * unconfigured project behaves exactly as it always has; a project targeting WSL
   * passes its own host and the session runs inside the distro instead.
   */
  host?: ExecHost;
}

/**
 * Encode one user turn as a stream-json input line (the shape the CLI reads on
 * stdin under `--input-format stream-json`). Pure, so it is easy to read/test.
 */
export function encodeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * Translate ONE raw Claude NDJSON event into zero or more normalized events.
 *
 * Pure and side-effect free, so it is unit-tested directly (see the .test.ts).
 * Returns an array because a single Claude "assistant" message can contain
 * several content blocks (thinking + text + tool_use), and many raw events
 * (progress spam) map to nothing at all.
 */
export function mapRawEvent(raw: unknown): SessionEvent[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const e = raw as Record<string, unknown>;

  switch (e['type']) {
    case 'system': {
      // The 'init' subtype is the very first event and confirms the session id.
      if (e['subtype'] === 'init') {
        return [
          {
            kind: 'started',
            sessionId: String(e['session_id'] ?? ''),
            model: String(e['model'] ?? ''),
            cwd: String(e['cwd'] ?? ''),
            permissionMode: String(e['permissionMode'] ?? ''),
          },
        ];
      }
      // Other system events (thinking_tokens progress, etc.) are noise for the UI.
      return [];
    }

    case 'rate_limit_event': {
      const info = (e['rate_limit_info'] ?? {}) as Record<string, unknown>;
      const resetsAt = typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null;
      return [
        {
          kind: 'rate-limit',
          status: String(info['status'] ?? ''),
          rateLimitType: String(info['rateLimitType'] ?? ''),
          resetsAt,
        },
      ];
    }

    case 'assistant': {
      // message.content is an array of blocks; emit one event per interesting block.
      const message = (e['message'] ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message['content']) ? message['content'] : [];
      const out: SessionEvent[] = [];
      // Each assistant turn carries a `usage` block — the incremental token cost of
      // THIS model call. Emit it so the app can account for what every run burns.
      const usage = readUsage(message['usage']);
      if (usage) {
        out.push({ kind: 'usage', ...usage });
      }
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          out.push({ kind: 'assistant', text: block['text'] });
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          out.push({ kind: 'thinking', text: block['thinking'] });
        } else if (block['type'] === 'tool_use') {
          const input = block['input'];
          out.push({
            kind: 'tool-use',
            name: String(block['name'] ?? 'tool'),
            toolId: String(block['id'] ?? ''),
            input:
              input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined,
          });
        }
      }
      return out;
    }

    case 'user': {
      // Tool results come back as 'user' messages with tool_result blocks.
      const message = (e['message'] ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message['content']) ? message['content'] : [];
      const out: SessionEvent[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_result') {
          out.push({
            kind: 'tool-result',
            toolId: String(block['tool_use_id'] ?? ''),
            isError: block['is_error'] === true,
          });
        }
      }
      return out;
    }

    case 'result': {
      return [
        {
          kind: 'result',
          success: e['is_error'] !== true,
          resultText: typeof e['result'] === 'string' ? e['result'] : '',
          costUsd: typeof e['total_cost_usd'] === 'number' ? e['total_cost_usd'] : null,
          durationMs: typeof e['duration_ms'] === 'number' ? e['duration_ms'] : null,
          stopReason: typeof e['stop_reason'] === 'string' ? e['stop_reason'] : null,
          terminalReason: typeof e['terminal_reason'] === 'string' ? e['terminal_reason'] : null,
          usage: readUsage(e['usage']),
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Safely pull the four token counts out of a raw CLI `usage` object, mapping the
 * snake_case wire names to our camelCase fields. Returns `null` if the value isn't
 * a usage object at all (so callers can skip emitting a usage event). Missing
 * individual fields default to 0 — a turn may report only some kinds.
 */
export function readUsage(raw: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheCreationTokens: num(u['cache_creation_input_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
  };
}

/**
 * Build the CLI arguments for a run. Kept separate (and pure) so it is easy to
 * read and test. The prompt is NOT here — it goes over stdin.
 *
 * When `gate` is set, the session runs the broker's MCP approval tool and, so our
 * risk policy governs EVERY tool use (edits included), forces `--permission-mode
 * default` — the mode under which the CLI consults the permission tool — rather
 * than the project's own mode. Ungated runs keep the requested mode.
 *
 * `plan` is the one mode that survives the gate (Phase 11). It is not a risk setting
 * but a different job: research and propose, change nothing. Rewriting it to `default`
 * would let a "plan this" run start editing, and it would never produce the
 * `ExitPlanMode` call the orchestrator turns into an approvable plan. The gate still
 * applies on top — the CLI consults the permission tool in plan mode too — so keeping
 * it loosens nothing.
 */
export function buildClaudeArgs(
  req: StartSessionRequest,
  sessionId: string,
  gate?: { configPath: string },
  resume = false,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json', // keep stdin open so we can answer a live session (Phase 4)
    '--verbose', // required by the CLI when using stream-json in print mode
    '--model',
    req.model,
    '--permission-mode',
    gate && req.permissionMode !== 'plan' ? 'default' : req.permissionMode,
    // Resuming (Phase 5) continues THIS conversation with its full history;
    // otherwise we claim a fresh id we can resume later. Both key off the same id.
    resume ? '--resume' : '--session-id',
    sessionId,
  ];
  if (gate) {
    args.push('--mcp-config', gate.configPath, '--permission-prompt-tool', PERMISSION_PROMPT_TOOL);
  }
  return args;
}

/**
 * Write the throwaway MCP config that tells the CLI how to spawn our relay for
 * one session. The host decides how the relay is launched — locally that is
 * Electron-as-Node; on a WSL target it is still the Windows binary, reached through
 * interop, so the relay can keep talking to the broker over loopback.
 *
 * Two paths come back because they name the same file to different machines: the
 * config is written (and later deleted) by this process, but the CLI reads it from
 * wherever IT runs.
 */
function writeSessionMcpConfig(
  gate: PermissionGate,
  runId: string,
  host: ExecHost,
): { appPath: string; hostPath: string } {
  const config = {
    mcpServers: {
      [PERMISSION_MCP_SERVER_KEY]: host.relaySpec({
        brokerUrl: gate.brokerUrl,
        token: gate.token,
        runId,
        serverScriptPath: gate.serverScriptPath,
      }),
    },
  };
  const appPath = join(gate.configDir, `mcp-${runId}.json`);
  writeFileSync(appPath, JSON.stringify(config), 'utf8');
  return { appPath, hostPath: host.toNative(appPath) };
}

/**
 * Start a Claude session. `onEvent` is called for every normalized event as it
 * arrives (started → assistant/tool/rate-limit … → result → exited). Returns a
 * handle with the pre-assigned session id and a stop() method.
 */
export function runClaudeSession(
  req: StartSessionRequest,
  onEvent: (event: SessionEvent) => void,
  options: RunSessionOptions = {},
): SessionHandle {
  // Resuming keeps the SAME session id (so the task's persisted id stays stable);
  // a fresh run claims a new one we can resume later.
  const resuming = options.resumeSessionId != null;
  const sessionId = options.resumeSessionId ?? randomUUID();
  const host = options.host ?? localHost();

  // If this run is gated, materialize its MCP config so the CLI spawns our relay.
  let config: { appPath: string; hostPath: string } | null = null;
  if (options.permission && options.runId) {
    config = writeSessionMcpConfig(options.permission, options.runId, host);
  }
  const args = buildClaudeArgs(
    req,
    sessionId,
    config ? { configPath: config.hostPath } : undefined,
    resuming,
  );

  // resolveViaShell lets Windows resolve `claude.cmd` from PATH the way a terminal
  // does; the host also hides the console window that would otherwise flash up.
  const { child, terminate } = host.spawn(req.cwd, 'claude', args, { resolveViaShell: true });

  // Feed the prompt as the first stream-json message and LEAVE stdin open, so we
  // can push follow-up answers into the running session (see send() below).
  child.stdin.write(encodeUserMessage(req.prompt));

  // stdout is NDJSON; buffer partial lines across chunks.
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON noise
      }
      for (const event of mapRawEvent(parsed)) onEvent(event);
    }
  });

  // stderr is human-readable diagnostics; surface it so problems are visible.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => onEvent({ kind: 'stderr', text: chunk }));

  // If the binary can't be spawned at all (e.g. not installed), report it.
  child.on('error', (err) =>
    onEvent({ kind: 'stderr', text: `Failed to start Claude: ${err.message}` }),
  );

  child.on('close', (code) => {
    // Clean up the throwaway MCP config once the session is gone.
    if (config) {
      try {
        unlinkSync(config.appPath);
      } catch {
        // Already gone / never written — nothing to do.
      }
    }
    onEvent({ kind: 'exited', code });
  });

  return {
    sessionId,
    // Push another user turn into the open input stream. Guarded because stdin is
    // gone once the process has exited (a late send should be a harmless no-op).
    send: (message: string) => {
      if (child.stdin.writable) child.stdin.write(encodeUserMessage(message));
    },
    stop: () => {
      child.stdin.end(); // signal end-of-input first, then terminate
      // The host owns tree termination: the real `claude` and anything an agent's
      // own tool calls spawned are DESCENDANTS of what we hold, and signalling only
      // the immediate child orphans that tree — the agent keeps running after Stop.
      terminate();
    },
  };
}
