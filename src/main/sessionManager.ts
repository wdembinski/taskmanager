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
import { runClaudeSession, type SessionHandle } from './claudeSession';
import type { SessionEvent, SessionEventEnvelope, StartSessionRequest } from '@shared/session';

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
   * `onEvent` is an optional per-run observer (the scheduler uses it to drive a
   * task's status), called with each event *in addition to* the global UI emit.
   */
  start(request: StartSessionRequest, onEvent?: (event: SessionEvent) => void): { runId: string } {
    const runId = randomUUID();
    const handle = runClaudeSession(request, (event) => {
      this.emit({ runId, event });
      onEvent?.(event);
      // Once the process has exited, forget it so the map doesn't grow forever.
      if (event.kind === 'exited') this.runs.delete(runId);
    });
    this.runs.set(runId, handle);
    return { runId };
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
