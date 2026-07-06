/**
 * The usage-limit gate (Phase 5) — the app's headline feature.
 *
 * WHAT IT DOES
 * ------------
 * When Claude reports a usage limit, EVERYTHING stops: the limit is account-wide,
 * so there is no point letting other sessions keep trying. This module is the
 * account-wide gate that:
 *
 *   1. records when the limit resets (from the CLI's `rate_limit_event`),
 *   2. schedules a timer for that reset time **plus a little random jitter**, and
 *   3. when the timer fires, tells the scheduler to **resume** every parked task
 *      by its saved session id, then clears itself.
 *
 * It survives an app restart: the scheduler persists the gate's `LimitState` and
 * calls `restore()` on the next launch, which re-arms the timer (firing at once if
 * the reset already passed while the app was closed).
 *
 * PURE CORE
 * ---------
 * The two decisions — classifying the limit (`classifyLimit`) and computing when
 * to resume (`computeResumeAt`) — are pure functions, unit-tested directly. The
 * `LimitGate` class is a small state machine around them; its clock, jitter, and
 * timer are all injected, so it too is unit-tested with a mock clock (no real
 * `setTimeout`, no waiting).
 */
import type { LimitState, LimitType } from '@shared/limit';

/**
 * Classify the CLI's `rateLimitType` string into the two buckets docs/03 names.
 * The exact wording varies by CLI version (`five_hour`, `weekly`, `seven_day`…),
 * so we match on substrings and default anything unrecognized to `rolling` — the
 * common, short-wait case, which resumes soon and re-checks if the limit persists.
 */
export function classifyLimit(rateLimitType: string): LimitType {
  return /week|seven|7\s*d/i.test(rateLimitType) ? 'weekly' : 'rolling';
}

/** How long to wait when the CLI didn't give us a reset time — conservative per type. */
const DEFAULT_WAIT_MS: Record<LimitType, number> = {
  rolling: 5 * 60 * 60 * 1000, // 5 hours
  weekly: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * When to actually attempt resume (epoch ms): the reset time plus jitter, never in
 * the past. If the reset time is unknown, wait a conservative default for the type.
 */
export function computeResumeAt(
  resetsAt: number | null,
  limitType: LimitType,
  now: number,
  jitterMs: number,
): number {
  const base = resetsAt != null ? resetsAt * 1000 : now + DEFAULT_WAIT_MS[limitType];
  return Math.max(base, now) + jitterMs;
}

/** A raw usage-limit signal, as forwarded from a session's `rate-limit` event. */
export interface LimitSignal {
  status: string;
  rateLimitType: string;
  resetsAt: number | null;
}

/**
 * Everything the gate needs from the outside world, injected so the class stays
 * pure-testable. The scheduler supplies the real clock/timer and the two hooks.
 */
export interface LimitGateDeps {
  /** Current time, epoch ms. */
  now(): number;
  /** Random resume jitter in ms (e.g. 0–60_000). Injected so tests are deterministic. */
  jitter(): number;
  /** Schedule `cb` after `ms`; return an opaque handle. */
  setTimer(ms: number, cb: () => void): unknown;
  /** Cancel a handle from `setTimer`. */
  clearTimer(handle: unknown): void;
  /** The reset time arrived: resume every parked task in `state`. */
  onResumeDue(state: LimitState): void;
  /** The gate engaged/changed (`state`) or cleared (`null`) — persist + tell the UI. */
  onChanged(state: LimitState | null): void;
}

export class LimitGate {
  private current: LimitState | null = null;
  private timer: unknown = null;

  constructor(private readonly deps: LimitGateDeps) {}

  /** True while a limit is in force (all scheduling is held). */
  get active(): boolean {
    return this.current !== null;
  }

  /** The active gate, or null. */
  get state(): LimitState | null {
    return this.current;
  }

  /**
   * Engage (or extend) the gate from a limit signal. An `allowed` status is a
   * no-op (the limit is not in force). If a gate is already up, the two are
   * merged: resume only once the LATER reset clears, and treat the pair as weekly
   * if either is. Returns the resulting state, or null for a no-op signal.
   */
  engage(signal: LimitSignal, parkedTaskIds: readonly string[]): LimitState | null {
    if (signal.status === 'allowed') return null;

    const now = this.deps.now();
    const limitType = classifyLimit(signal.rateLimitType);
    const resumeAt = computeResumeAt(signal.resetsAt, limitType, now, this.deps.jitter());

    const next: LimitState = this.current
      ? {
          // Weekly is the more restrictive; if either limit is weekly, wait it out.
          limitType: this.current.limitType === 'weekly' || limitType === 'weekly' ? 'weekly' : 'rolling',
          resetsAt: pickLaterReset(this.current.resetsAt, signal.resetsAt),
          resumeAt: Math.max(this.current.resumeAt, resumeAt),
          parkedTaskIds: [...new Set([...this.current.parkedTaskIds, ...parkedTaskIds])],
        }
      : { limitType, resetsAt: signal.resetsAt, resumeAt, parkedTaskIds: [...parkedTaskIds] };

    this.arm(next);
    this.deps.onChanged(this.current);
    return this.current;
  }

  /**
   * Re-arm a gate persisted before an app restart. If its resume time already
   * passed while the app was closed, the timer fires (near-)immediately.
   */
  restore(state: LimitState): void {
    this.arm(state);
    this.deps.onChanged(this.current);
  }

  /**
   * Forget some tasks so they are NOT resumed (e.g. the user stopped them while
   * parked). Does not lift the gate — the account is still limited.
   */
  unpark(taskIds: readonly string[]): void {
    if (!this.current) return;
    const drop = new Set(taskIds);
    this.current = {
      ...this.current,
      parkedTaskIds: this.current.parkedTaskIds.filter((id) => !drop.has(id)),
    };
    this.deps.onChanged(this.current);
  }

  /** Tear down without resuming (app shutdown). Leaves any persisted state intact. */
  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.current = null;
  }

  // ---- internals ----------------------------------------------------------

  /** Replace the state and (re)schedule the resume timer for its `resumeAt`. */
  private arm(state: LimitState): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.current = state;
    const delay = Math.max(0, state.resumeAt - this.deps.now());
    this.timer = this.deps.setTimer(delay, () => this.fire());
  }

  /** The reset time arrived: hand the parked set to the scheduler and clear the gate. */
  private fire(): void {
    const state = this.current;
    this.current = null;
    this.timer = null;
    if (!state) return;
    this.deps.onResumeDue(state);
    this.deps.onChanged(null);
  }
}

/** Pick the later of two reset times (either may be unknown). */
function pickLaterReset(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
