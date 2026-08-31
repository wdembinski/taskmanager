/**
 * Shared sign-in vocabulary — the account-wide **auth gate**.
 *
 * The app orchestrates one external thing: the `claude` CLI, signed in with the user's
 * subscription. That sign-in expires. When it does, every run dies in about 150ms for
 * $0.00 with *"Failed to authenticate: OAuth session expired and could not be refreshed"*
 * — and, before this gate existed, each card discovered that separately: burn an
 * auto-retry, park in the inbox as a generic `api_error`, and hand the human one
 * unexplained failure per card while the queue kept feeding fresh ones into the same wall.
 *
 * So this is deliberately shaped like `@shared/limit`: one account-wide gate, all work
 * held behind it, everything it stopped remembered *in* the gate and resumed together.
 * The one structural difference is the clock. A usage limit resets at a time the CLI
 * tells us, so the gate can arm a timer; nothing tells us when a human will sign in, so
 * this gate is lifted by an event instead — the CLI rewriting its credentials file, or
 * the human pressing the button.
 */
import { formatExecTarget, type ExecTarget } from './execTarget';

/** How the gate found out, which decides how much the banner may promise. */
export type AuthFailureSource =
  /** A run died on an authentication error — work is definitely blocked. */
  | 'run'
  /** Restored from disk on launch; nothing has been retried yet this session. */
  | 'restored';

/**
 * The active gate. `null` (see the `auth:changed` event) means the sign-in is believed
 * good — which is not the same as *verified*: nothing probes the credential, because the
 * only free way to test it is to run something, and that is what raised this in the
 * first place. The gate is a memory of a real failure, not a health check.
 */
export interface AuthState {
  /** Epoch ms when the gate went up — the banner says how long work has been held. */
  since: number;
  /**
   * What the CLI actually said, kept verbatim. The banner shows it because the failures
   * in this family are not interchangeable: an expired OAuth session is fixed by signing
   * in again, `ANTHROPIC_API_KEY` billing the paid API is fixed by unsetting it, and a
   * human told only "authentication failed" cannot tell those apart.
   */
  reason: string;
  /** Where the verdict came from, so a restored gate can say it is unconfirmed. */
  source: AuthFailureSource;
  /**
   * The tasks this gate stopped, resumed together when it lifts. Everything the
   * usage-limit gate learned applies here: a gate is the ONLY thing that remembers work
   * across the pause, so anything held has to be parked *in* it rather than left
   * `pending` with a comment hoping someone re-runs it.
   */
  parkedTaskIds: string[];
  /**
   * The exec target of the run that proved the credential dead — a WSL distro has its
   * OWN sign-in, separate from the one on the machine the GUI runs on. Optional so a gate
   * persisted by a build that predates this field restores as "unknown host", which reads
   * as `local` everywhere it is consulted: there is no migration for a JSON blob, and a
   * wrong guess here would send the Sign in button (or the credential poll) at the wrong
   * machine. Set once, on the first `engage` — later tasks parked into an already-raised
   * gate never move it, because the gate names the host that actually failed, not
   * whichever host happened to queue into it next.
   */
  target?: ExecTarget;
}

/**
 * The command that fixes it, shown in the banner and used by the Sign in button.
 *
 * Running `claude` interactively is what re-mints the credential; there is no headless
 * form of it, which is the whole reason this gate ends with a human rather than a timer.
 * Host-aware because a WSL target's credential lives inside the distro: signing in on
 * Windows would re-mint the wrong one.
 */
export function signInCommandText(target?: ExecTarget): string {
  return target && target.kind === 'wsl' ? `wsl -d ${target.distro} claude` : 'claude';
}

/** One line naming what is wrong and what to do — shared so banner and timeline agree. */
export function describeAuthFailure(state: AuthState): string {
  const host =
    state.target && state.target.kind !== 'local' ? ` on ${formatExecTarget(state.target)}` : '';
  return state.source === 'restored'
    ? `Claude could not authenticate${host} when the app last ran: ${state.reason}`
    : `Claude could not authenticate${host}: ${state.reason}`;
}
