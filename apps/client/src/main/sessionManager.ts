/**
 * Keeps track of all running Claude sessions and forwards their events to the UI.
 *
 * Each call to `start()` launches one session (one task = one session) and gets
 * a unique `runId`. Every normalized event from that session is wrapped in an
 * envelope tagged with its runId and handed to the `emit` callback, which the
 * main process wires to `window.webContents.send('session:event', …)`.
 *
 * In Phase 1 this is intentionally simple (start / stop / forward). Later phases
 * grow it into the scheduler's execution layer.
 */
import { randomUUID } from 'node:crypto';
import { runClaudeSession, type PermissionGate, type SessionHandle } from './claudeSession';
import { shouldSurfaceEvent } from './eventNoise';
import type { ExecHost } from './exec';
import type { SessionEvent, SessionEventEnvelope, StartSessionRequest } from '@shared/session';

/** Optional per-run knobs for `SessionManager.start`. */
export interface StartOptions {
  /** Observe this run's events (the scheduler uses it to drive task status). */
  onEvent?: (event: SessionEvent) => void;
  /** Gate the run's tool uses through the broker (a true pre-execution veto). */
  permission?: PermissionGate;
  /** Resume an existing conversation by its session id (Phase 5 auto-respawn). */
  resumeSessionId?: string;
  /** Use this run id instead of generating one (lets a caller reserve it up front). */
  runId?: string;
  /**
   * Which machine runs the CLI. Defaults to the machine the GUI runs on; the
   * scheduler passes the host matching the project's configured target.
   */
  host?: ExecHost;
}

export class SessionManager {
  private readonly runs = new Map<string, SessionHandle>();

  /**
   * @param emit  How to deliver an event envelope to the UI. Injected so the
   *              manager doesn't depend on Electron directly (easier to test).
   */
  constructor(private readonly emit: (envelope: SessionEventEnvelope) => void) {}

  /**
   * Launch a session and start streaming its events to the UI.
   *
   * `options.onEvent` is an optional per-run observer (the scheduler uses it to
   * drive a task's status), called with each event *in addition to* the global UI
   * emit. `options.permission`, when set, gates the run's tools through the broker.
   */
  start(request: StartSessionRequest, options: StartOptions = {}): { runId: string } {
    const { onEvent, permission, resumeSessionId, host } = options;
    const runId = options.runId ?? randomUUID();
    const handle = runClaudeSession(
      request,
      (event) => {
        // The UI sees only what means something; OBSERVERS see everything. The order and
        // the asymmetry both matter: `Scheduler.onRunEvent` needs the healthy rate-limit
        // events the UI must never show, because they are what `getUsagePressure()` reads
        // to report how close the account is to its cap.
        if (shouldSurfaceEvent(event)) this.emit({ runId, event });
        onEvent?.(event);
        // Phase 4 keeps stdin open, so a session no longer exits by itself after a
        // `result`. A MANAGED run (the scheduler passes an observer) drives its own
        // lifecycle — it may keep the session alive to answer a question. An
        // UNMANAGED one-shot run (e.g. the Scratch view) has no such controller, so
        // close it on `result` to keep the old fire-and-forget behavior.
        if (event.kind === 'result' && !onEvent) this.stop(runId);
        // Once the process has exited, forget it so the map doesn't grow forever.
        if (event.kind === 'exited') this.runs.delete(runId);
      },
      { runId, permission, resumeSessionId, host },
    );
    this.runs.set(runId, handle);
    return { runId };
  }

  /**
   * Push a message into a running session's open input stream (Phase 4), so a
   * human's answer continues the same session. No-op if the runId is unknown.
   */
  send(runId: string, message: string): void {
    this.runs.get(runId)?.send(message);
  }

  /** Stop one run if it is still alive. No-op if the runId is unknown. */
  stop(runId: string): void {
    this.runs.get(runId)?.stop();
    this.runs.delete(runId);
  }

  /** Stop everything (called on app shutdown so no orphan processes linger). */
  stopAll(): void {
    for (const handle of this.runs.values()) handle.stop();
    this.runs.clear();
  }
}
