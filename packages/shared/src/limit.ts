/**
 * Shared usage-limit vocabulary (Phase 5).
 *
 * The headline feature: when Claude hits a usage limit, the engine parks ALL work
 * behind one account-wide **gate** and automatically resumes each session when the
 * limit resets. These types describe the gate's state as it crosses the UI↔engine
 * boundary — the engine raises/clears it, the UI shows a banner with a live
 * countdown — so they live in `shared`.
 *
 * Two kinds of limit exist (see `docs/03-how-orchestration-works.md`):
 *   - the **5-hour rolling** limit (hit fairly often; auto-resumes shortly), and
 *   - the **weekly cap** (the hard ceiling; work waits out the weekly window).
 * We label them differently but treat them the same way — wait for the reset,
 * then resume.
 */

/** Which limit was hit: the 5-hour rolling window, or the weekly cap. */
export type LimitType = 'rolling' | 'weekly';

/**
 * The active gate. `null` (not this type — see the IPC event) means no limit is in
 * force. While a `LimitState` is present, no session runs account-wide.
 */
export interface LimitState {
  /** Which limit is in force, so the UI can label it correctly. */
  limitType: LimitType;
  /**
   * The CLI-reported reset time as a Unix timestamp (seconds), or `null` if the
   * CLI didn't tell us — in which case we fall back to a conservative wait.
   */
  resetsAt: number | null;
  /**
   * Epoch **ms** when we will actually attempt to resume: the reset time plus a
   * little random jitter (so many parked apps don't all retry the same instant).
   * This is what the UI counts down to.
   */
  resumeAt: number;
  /** The task ids parked behind this gate — resumed by their saved session id at reset. */
  parkedTaskIds: string[];
}
