/**
 * The sign-in gate: detecting that the `claude` CLI can no longer authenticate, and
 * holding all work until it can again.
 *
 * Shaped after `limitGate.ts` on purpose — same account-wide hold, same "the gate is the
 * only thing that remembers what it stopped" rule — but with no timer, because nothing
 * announces when a human will sign in. See `@shared/auth` for why this exists at all.
 *
 * PURE CORE
 * ---------
 * The judgement — *is this failure an authentication failure?* — is a pure function of
 * the CLI's own `result` event, unit-tested directly. Getting it wrong in the loud
 * direction would stop the whole board over one agent's prose, so the classifier is
 * deliberately split into wording only the CLI produces, and wording an agent might also
 * produce, which is believed only when the model was demonstrably never called.
 */
import type { SessionEvent } from '@shared/session';
import type { AuthState } from '@shared/auth';

/**
 * Phrases that are the CLI's (or this app's) own voice, never an agent's answer.
 *
 * "Failed to authenticate:" is a prefix the CLI prints instead of running; an agent
 * reporting on a login bug writes prose about a system, not this. These are believed on
 * sight, because the case that matters most — an expired OAuth session — costs $0.00 and
 * ~150ms, and waiting for corroboration would mean letting the next card try it too.
 */
const CLI_AUTH_PATTERNS: readonly RegExp[] = [
  /failed to authenticate/i,
  /oauth (token|session)/i,
  /not logged in/i,
  /please run `?\/login/i,
  /run `?claude`? once and sign in/i,
  /credentials? (are |is )?(expired|invalid|missing)/i,
  /(session|token) (has )?expired/i,
];

/**
 * Wording that genuinely means an auth failure *from the CLI*, but which an agent
 * working on authentication could also emit as its final answer.
 *
 * Believed only alongside proof that the model was never called (see
 * {@link neverCalledTheModel}): an agent that produced this text necessarily ran turns,
 * and a CLI that could not authenticate necessarily ran none. That single fact separates
 * them cleanly, and it is why this list is not simply merged into the one above.
 */
const AMBIGUOUS_AUTH_PATTERNS: readonly RegExp[] = [
  /\bunauthori[sz]ed\b/i,
  /authentication[_ -]?error/i,
  /invalid api key/i,
  /\b401\b/,
];

/** The `result` fields the judgement needs — a slice, so tests need no full event. */
export type AuthResultSlice = Pick<
  Extract<SessionEvent, { kind: 'result' }>,
  'resultText' | 'stopReason' | 'terminalReason' | 'usage'
>;

/**
 * Whether the run never reached the model.
 *
 * `usage` must be PRESENT and all-zero. The CLI omits the field entirely in some shapes,
 * and reading an omission as "no tokens" once misfiled three legitimate runs as dead — so
 * absence proves nothing here and is deliberately treated as "it may well have run".
 */
function neverCalledTheModel(usage: AuthResultSlice['usage']): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    usage.cacheReadTokens === 0
  );
}

/**
 * Whether `text` alone is unambiguous CLI auth wording. Exported for the failure
 * classifier, which has only a reason string and no event to weigh it against.
 */
export function isAuthFailureText(text: string): boolean {
  return CLI_AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The human-facing reason this run failed to authenticate, or null if it did not.
 *
 * Reads `resultText` first and `terminalReason`/`stopReason` only as a fallback, which is
 * the whole point: the CLI reported this failure as `terminalReason: "api_error"` while
 * the sentence that named the cause sat in `resultText`. Every classifier downstream was
 * being handed the useless half, so an expired sign-in read as a transient API blip —
 * worth an auto-retry, worth parking as `api_error`, worth doing again on the next card.
 */
export function detectAuthFailure(result: AuthResultSlice): string | null {
  const text = result.resultText?.trim() ?? '';
  const labels = [result.terminalReason ?? '', result.stopReason ?? ''].filter(Boolean);
  const candidates = [text, ...labels].filter((c) => c.length > 0);
  if (candidates.length === 0) return null;

  const spoken = candidates.find((c) => isAuthFailureText(c));
  if (spoken) return text || spoken;

  if (!neverCalledTheModel(result.usage)) return null;
  const ambiguous = candidates.find((c) => AMBIGUOUS_AUTH_PATTERNS.some((p) => p.test(c)));
  return ambiguous ? text || ambiguous : null;
}

/** Everything the gate needs from the outside world, injected so the class stays testable. */
export interface AuthGateDeps {
  /** Current time, epoch ms. */
  now(): number;
  /** The gate lifted: resume every task it had parked. */
  onResumeDue(state: AuthState): void;
  /** The gate engaged/changed (`state`) or lifted (`null`) — persist + tell the UI. */
  onChanged(state: AuthState | null): void;
}

/**
 * The account-wide sign-in hold.
 *
 * No timer and no probe: it goes up when a run proves the credential is dead, and comes
 * down when something proves otherwise — the CLI rewriting `~/.claude/.credentials.json`,
 * or the human saying so. Until then nothing new starts, which is the point: the failure
 * is free and instant, so an ungated queue converts one expired token into one parked
 * card per task in the time it takes to read the first one.
 */
export class AuthGate {
  private current: AuthState | null = null;

  constructor(private readonly deps: AuthGateDeps) {}

  /** True while the sign-in is known bad (all scheduling is held). */
  get active(): boolean {
    return this.current !== null;
  }

  /** The active gate, or null. */
  get state(): AuthState | null {
    return this.current;
  }

  /**
   * Raise the gate for `reason`, parking `taskIds`. Engaging an already-raised gate only
   * adds to the parked set: the FIRST reason is kept, because it is the one that has a
   * live run's failure behind it, while later ones are just the queue draining into the
   * same wall and would otherwise rewrite the banner every few hundred milliseconds.
   */
  engage(reason: string, taskIds: readonly string[]): AuthState {
    this.current = this.current
      ? { ...this.current, parkedTaskIds: merge(this.current.parkedTaskIds, taskIds) }
      : {
          since: this.deps.now(),
          reason,
          source: 'run',
          parkedTaskIds: [...new Set(taskIds)],
        };
    this.deps.onChanged(this.current);
    return this.current;
  }

  /** Re-raise a gate persisted before an app restart, flagged as not re-confirmed. */
  restore(state: AuthState): void {
    this.current = { ...state, source: 'restored' };
    this.deps.onChanged(this.current);
  }

  /**
   * Add tasks to a gate that is ALREADY up — work that wanted to start while the sign-in
   * was broken and so never got a run of its own to fail. The next step of a plan is the
   * case this exists for, exactly as it is for the usage limit: nothing else re-enters a
   * chain, so a step merely left `pending` here is a card that stops at 2/4 for good.
   * Returns the ids actually added (none if no gate is up — then just run them).
   */
  park(taskIds: readonly string[]): string[] {
    if (!this.current) return [];
    const known = new Set(this.current.parkedTaskIds);
    const added = [...new Set(taskIds)].filter((id) => !known.has(id));
    if (added.length === 0) return [];
    this.current = { ...this.current, parkedTaskIds: [...this.current.parkedTaskIds, ...added] };
    this.deps.onChanged(this.current);
    return added;
  }

  /** Forget some tasks so they are NOT resumed (the user stopped them while parked). */
  unpark(taskIds: readonly string[]): void {
    if (!this.current) return;
    const drop = new Set(taskIds);
    this.current = {
      ...this.current,
      parkedTaskIds: this.current.parkedTaskIds.filter((id) => !drop.has(id)),
    };
    this.deps.onChanged(this.current);
  }

  /**
   * The sign-in is believed good again: resume everything parked and clear the gate.
   *
   * Deliberately never verified first. If the credential is still bad the first resumed
   * run fails the same way in ~150ms and raises the gate again with the same parked set,
   * which is a cheaper and more honest answer than a probe that spends a session to say
   * the thing the next run was about to say anyway. No-op when no gate is up.
   */
  lift(): void {
    const state = this.current;
    if (!state) return;
    this.current = null;
    this.deps.onResumeDue(state);
    this.deps.onChanged(null);
  }

  /** Tear down without resuming (app shutdown). Leaves any persisted state intact. */
  dispose(): void {
    this.current = null;
  }
}

/** Union two id lists, preserving order and dropping duplicates. */
function merge(existing: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...existing, ...added])];
}
