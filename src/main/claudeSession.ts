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
 *   2. We spawn `claude -p --output-format stream-json --verbose …` in the
 *      project's directory, and feed the PROMPT via stdin (never the command
 *      line — that avoids all Windows quoting/escaping problems).
 *   3. Claude streams newline-delimited JSON (NDJSON) events on stdout. We split
 *      those into lines, parse each, and translate the raw shapes into our small,
 *      stable `SessionEvent` union (see mapRawEvent).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionEvent, StartSessionRequest } from '@shared/session';

/** A live handle to a running session so callers can stop it. */
export interface SessionHandle {
  /** The session id we assigned (also arrives in the 'started' event). */
  sessionId: string;
  /** Terminate the underlying process. */
  stop(): void;
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
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          out.push({ kind: 'assistant', text: block['text'] });
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          out.push({ kind: 'thinking', text: block['thinking'] });
        } else if (block['type'] === 'tool_use') {
          out.push({
            kind: 'tool-use',
            name: String(block['name'] ?? 'tool'),
            toolId: String(block['id'] ?? ''),
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
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Build the CLI arguments for a run. Kept separate (and pure) so it is easy to
 * read and test. The prompt is NOT here — it goes over stdin.
 */
export function buildClaudeArgs(req: StartSessionRequest, sessionId: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // required by the CLI when using stream-json in print mode
    '--model',
    req.model,
    '--permission-mode',
    req.permissionMode,
    '--session-id',
    sessionId,
  ];
}

/**
 * Start a Claude session. `onEvent` is called for every normalized event as it
 * arrives (started → assistant/tool/rate-limit … → result → exited). Returns a
 * handle with the pre-assigned session id and a stop() method.
 */
export function runClaudeSession(
  req: StartSessionRequest,
  onEvent: (event: SessionEvent) => void,
): SessionHandle {
  const sessionId = randomUUID();
  const args = buildClaudeArgs(req, sessionId);

  // shell:true lets Windows resolve `claude.cmd` from PATH the way a terminal
  // does. windowsHide stops a console window flashing up for each run.
  const child = spawn('claude', args, { cwd: req.cwd, shell: true, windowsHide: true });

  // Feed the prompt via stdin, then close it so Claude knows the input is done.
  child.stdin.write(req.prompt);
  child.stdin.end();

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

  child.on('close', (code) => onEvent({ kind: 'exited', code }));

  return {
    sessionId,
    stop: () => child.kill(),
  };
}
