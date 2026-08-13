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
 * Every decision here is a pure function, unit-tested directly: classifying the
 * limit (`classifyLimit`), computing when to resume (`computeResumeAt`), reading a
 * limit out of a run that merely FAILED (`detectLimitFailure`), and deciding whether
 * that reading is worth parking the board over (`decideLimitPark`). The `LimitGate`
 * class is a small state machine around them; its clock, jitter, and timer are all
 * injected, so it too is unit-tested with a mock clock (no real `setTimeout`, no
 * waiting).
 */
import type { SessionEvent } from '@shared/session';
import type { LimitState, LimitType } from '@shared/limit';
import type { CliUsageReading } from './claudeUsage';

/**
 * Classify the CLI's `rateLimitType` string into the two buckets docs/03 names.
 * The exact wording varies by CLI version (`five_hour`, `weekly`, `seven_day`…),
 * so we match on substrings and default anything unrecognized to `rolling` — the
 * common, short-wait case, which resumes soon and re-checks if the limit persists.
 */
export function classifyLimit(rateLimitType: string): LimitType {
  return /week|seven|7\s*d/i.test(rateLimitType) ? 'weekly' : 'rolling';
}

/**
 * Whether a `rate_limit_event` status means work is actually BLOCKED (park all
 * sessions) versus merely a heads-up. Claude's `rate_limit_info.status` reports
 * `allowed` while under the cap and an `allowed_warning`-style value as the cap
 * approaches; the event can also arrive with no status at all. Only a hard
 * rejection should engage the account-wide gate — treating a warning (or an empty
 * status) as a block is what falsely parked everything for a full weekly window.
 * Conservative on purpose: empty, `allowed`-prefixed, or "warn" statuses are all
 * treated as NOT blocking.
 */
export function isBlockingLimitStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  if (s === '' || s.startsWith('allowed') || s.includes('warn')) return false;
  return /reject|exceed|block|throttl|limit_reached|rate_limited|too_many/.test(s);
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

// ---------------------------------------------------------------------------
// Reading a limit out of a FAILURE
// ---------------------------------------------------------------------------
//
// Everything above this line is driven by the CLI's own `rate_limit_event`, which
// is structured and unambiguous. This section handles the other way the wall
// arrives: the run simply ends, and the only thing naming the cause is the text of
// the `result` event — the exact shape `authGate.ts` was written for, so it is
// written the same way and for the same reason. Believing an agent's prose here
// would park the whole board over one card's answer; disbelieving the CLI would
// blame a card for something the account did.

/** Which tier of evidence fired, so a caller can tell near-proof from a guess. */
export type LimitProofTier =
  /** The CLI's own machine-readable form: the phrase plus a trailing `|<epoch>`. */
  | 'epoch'
  /** The phrase alone, and it was the WHOLE message. Believable, not proof. */
  | 'text'
  /** A limit-specific label on the result, with no sentence naming the cause. */
  | 'label';

/** A `LimitSignal` plus the strength of the evidence behind it. */
export interface LimitDetection extends LimitSignal {
  tier: LimitProofTier;
}

/**
 * The `result` fields the judgement needs — a slice, so tests need no full event.
 *
 * Wider than `authGate.ts`'s `AuthResultSlice` by one field: `success`. The
 * sign-in classifier is only ever consulted about a run that already failed, whereas the
 * limit phrase is something a *successful* run can legitimately end with (an agent
 * reporting on this very feature), and a run that succeeded hit no wall by definition.
 */
export type LimitResultSlice = Pick<
  Extract<SessionEvent, { kind: 'result' }>,
  'success' | 'resultText' | 'stopReason' | 'terminalReason' | 'usage'
>;

/** The sentence the CLI ends on when the account is out of budget. */
const LIMIT_PHRASE = /usage limit reached|reached your usage limit/i;

/** The only lead-ins the CLI itself puts in front of that phrase. */
const LIMIT_LEAD_IN = /(?:claude(?: ai| code)?\s+|you(?:'|’)?ve\s+|you have\s+)?/;

/**
 * The phrase carrying the CLI's trailing epoch — `Claude AI usage limit reached|1754870400`.
 *
 * Believed on sight, wherever it appears. No agent writes a bare 10-digit unix timestamp
 * after a pipe; that field is the CLI telling a machine when the window clears, and it is
 * also the only source of a reset time on this path.
 */
const LIMIT_WITH_EPOCH = new RegExp(`(?:${LIMIT_PHRASE.source})\\s*\\|\\s*(\\d{10})(?!\\d)`, 'i');

/**
 * The phrase as the WHOLE message: anchored at both ends, single-line, and allowed only
 * the CLI's own decoration around it. A bare substring test is what makes this dangerous —
 * this repo's own agents write about usage limits, and a paragraph that merely *contains*
 * the phrase must not stop the board.
 */
const WHOLE_LIMIT_MESSAGE = new RegExp(
  `^${LIMIT_LEAD_IN.source}(?:${LIMIT_PHRASE.source})[^\\n]{0,140}$`,
  'i',
);

/** …and a hard cap on top of the anchors, so no amount of trailing clause qualifies. */
const MAX_LIMIT_MESSAGE_CHARS = 200;

/**
 * Labels that mean a limit and nothing else.
 *
 * `api_error` is deliberately absent. The CLI files a usage limit under it — but it files
 * every transient blip under it too, and matching it is precisely how one bad minute of
 * network would park the board for five hours.
 */
const LIMIT_LABELS = /rate[_ -]?limit(?:_?error|ed)?\b|(?<!\d)429(?!\d)/i;

/** Wording that names the long window rather than the rolling one. */
const WEEKLY_WORDING = /\bweek(ly)?\b|\bseven[- ]?day\b|\b7[- ]?d(ay)?s?\b/i;

/**
 * Read a usage limit out of a run's `result`, or null if this failure is the card's own.
 *
 * Three tiers, weakest last, each believed for a different reason — see the constants
 * above. Note what is NOT used as corroboration: `usage`. The sign-in gate can lean on
 * "the model was never called", because a dead credential runs no turns; a usage limit is
 * normally hit *mid-run*, with tokens spent, so all-zero usage is simply not available
 * here and its absence proves nothing either way.
 */
export function detectLimitFailure(result: LimitResultSlice): LimitDetection | null {
  // A run that finished its work hit no wall, whatever sentence it chose to end on.
  if (result.success) return null;

  const text = result.resultText?.trim() ?? '';
  const labels = [result.terminalReason ?? '', result.stopReason ?? ''].filter((l) => l.length > 0);
  const candidates = [text, ...labels].filter((c) => c.length > 0);

  for (const candidate of candidates) {
    const match = LIMIT_WITH_EPOCH.exec(candidate);
    if (match) return detected(Number(match[1]), candidates, 'epoch');
  }

  if (text.length > 0 && text.length <= MAX_LIMIT_MESSAGE_CHARS && WHOLE_LIMIT_MESSAGE.test(text)) {
    return detected(null, candidates, 'text');
  }

  if (labels.some((label) => LIMIT_LABELS.test(label))) return detected(null, candidates, 'label');

  return null;
}

/**
 * Build the signal, deriving `rateLimitType` rather than passing the sentence through.
 *
 * `classifyLimit` tests `/week|seven|7\s*d/i`, so handing it free text would park the
 * board for SEVEN DAYS over an agent saying "next week". Weekly is claimed only when the
 * wording says so *and* an epoch parsed — i.e. only from the tier that cannot be prose.
 * Rolling is the strictly safer wrong answer: it resumes early, hits the wall again, and
 * re-parks on a real `rate_limit_event`.
 */
function detected(
  resetsAt: number | null,
  candidates: readonly string[],
  tier: LimitProofTier,
): LimitDetection {
  const weekly = resetsAt !== null && candidates.some((c) => WEEKLY_WORDING.test(c));
  return {
    status: 'rejected',
    rateLimitType: weekly ? 'weekly' : 'five_hour',
    resetsAt,
    tier,
  };
}

/** At or above this share of a window's cap, the probe CORROBORATES the text. */
const AT_CAP_PCT = 95;

/** Text-only parks in a row before the text stops being believed unaided. */
const TEXT_PARK_FLOOR = 2;

/**
 * Whether a detection is worth parking the account over, or should fall through to the
 * ordinary failure path so the human is asked.
 *
 * Pure, with the `/usage` reading injected — the probe is a subprocess, and this decision
 * has to be testable without one. The ladder, in order:
 *
 *   - an epoch: the CLI said so in its own machine-readable field. Park.
 *   - a reading at/near the cap for the window in question: the account genuinely has
 *     nothing left, so the text is corroborated. Park.
 *   - a reading clearly UNDER the cap: the probe actively contradicts the sentence, and
 *     the sentence is the weaker witness. Ask.
 *   - no reading at all (probe failed, offline, CLI busy): park, because the cost of
 *     being wrong is a wait, not a wrong answer — but only up to {@link TEXT_PARK_FLOOR}
 *     in a row for one task. Past that, something is parking this card repeatedly on
 *     evidence nothing has ever confirmed, and a human should look at it.
 */
export function decideLimitPark(
  proof: LimitDetection,
  reading: CliUsageReading | null,
  priorTextParks: number,
): 'park' | 'ask' {
  if (proof.tier === 'epoch') return 'park';

  const window = classifyLimit(proof.rateLimitType) === 'weekly' ? 'weeklyPct' : 'sessionPct';
  // A reading that omits the window we care about tells us nothing about it, so it
  // counts as no reading rather than as a low one.
  const pct = reading ? reading[window] : null;
  if (pct !== null) return pct >= AT_CAP_PCT ? 'park' : 'ask';

  return priorTextParks >= TEXT_PARK_FLOOR ? 'ask' : 'park';
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
          limitType:
            this.current.limitType === 'weekly' || limitType === 'weekly' ? 'weekly' : 'rolling',
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
   * End the gate NOW instead of waiting for its timer — used to clear a false trip
   * from the UI. Resumes the parked tasks (via `onResumeDue`) and clears the gate
   * (`onChanged(null)`), exactly as the scheduled reset would. No-op if inactive.
   */
  resumeNow(): void {
    if (this.current === null) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.fire();
  }

  /**
   * Add tasks to the parked set of a gate that is ALREADY up — work that wanted to
   * start while the account was limited and therefore never got a run of its own.
   *
   * The engage path can only park what was running at the moment the wall was hit,
   * and that is not the same set as "everything the limit stopped". The next step of
   * a plan is the case that matters: its predecessor finished mid-limit, the chain
   * asked to advance, and there was no run to park — so without this the step was
   * simply dropped and the card sat at `2/4` for good. Returns the tasks actually
   * added (none, if no gate is up — the caller should then just run them).
   */
  park(taskIds: readonly string[]): string[] {
    if (!this.current) return [];
    const known = new Set(this.current.parkedTaskIds);
    const added = taskIds.filter((id) => !known.has(id));
    if (added.length === 0) return [];
    this.current = { ...this.current, parkedTaskIds: [...this.current.parkedTaskIds, ...added] };
    this.deps.onChanged(this.current);
    return added;
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
