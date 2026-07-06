/**
 * Shared session types — the vocabulary for "run one Claude session for one task".
 *
 * These types are used by BOTH the engine (which spawns Claude) and the UI
 * (which displays it), so they live in `shared`. The engine translates Claude's
 * raw, verbose NDJSON output into the small, stable `SessionEvent` union defined
 * here; the UI only ever sees these tidy events.
 */

/** Which model to run. We expose the friendly aliases the CLI understands. */
export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';

/**
 * How much Claude may do without asking. Mirrors the CLI's `--permission-mode`
 * (we expose the subset that makes sense for orchestration).
 *   - acceptEdits       : auto-approve edits; stop for risky ops/questions (our default)
 *   - manual            : ask before every tool use
 *   - bypassPermissions : never ask (most autonomous, least safe)
 *   - plan              : read/plan only, make no changes
 */
export type PermissionMode = 'acceptEdits' | 'manual' | 'bypassPermissions' | 'plan';

/** Everything needed to start one session. */
export interface StartSessionRequest {
  /** What we want Claude to do. Sent to the CLI via stdin (no shell quoting). */
  prompt: string;
  /** The project directory the session runs in (Claude's working directory). */
  cwd: string;
  model: ClaudeModel;
  permissionMode: PermissionMode;
}

/**
 * The normalized events the engine streams to the UI. This is deliberately a
 * SMALL subset of Claude's raw output — just what a dashboard needs to show
 * progress, cost, limits, and completion.
 */
export type SessionEvent =
  /** First event: the session exists and has an id we can resume later. */
  | { kind: 'started'; sessionId: string; model: string; cwd: string; permissionMode: string }
  /** Claude's private reasoning (shown subtly, if at all). */
  | { kind: 'thinking'; text: string }
  /** A chunk of Claude's visible answer. */
  | { kind: 'assistant'; text: string }
  /** Claude decided to use a tool (edit a file, run a command, …). */
  | { kind: 'tool-use'; name: string; toolId: string }
  /** A tool finished. */
  | { kind: 'tool-result'; toolId: string; isError: boolean }
  /**
   * A usage-limit signal. `resetsAt` is a Unix timestamp (seconds) telling us
   * when the limit clears — the Phase 5 auto-respawn gate keys off this.
   */
  | { kind: 'rate-limit'; status: string; rateLimitType: string; resetsAt: number | null }
  /** The session finished a turn. Carries cost and why it stopped. */
  | {
      kind: 'result';
      success: boolean;
      resultText: string;
      costUsd: number | null;
      durationMs: number | null;
      stopReason: string | null;
      terminalReason: string | null;
    }
  /** Raw text Claude/CLI wrote to stderr (surfaced for debugging). */
  | { kind: 'stderr'; text: string }
  /** The underlying process exited. `code` 0 = clean. */
  | { kind: 'exited'; code: number | null };

/** High-level status of a run, derived by the UI from the event stream. */
export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * What the engine pushes over the `session:event` IPC channel. `runId` lets the
 * UI route each event to the right session (there can be several at once).
 */
export interface SessionEventEnvelope {
  runId: string;
  event: SessionEvent;
}
