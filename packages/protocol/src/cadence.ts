/**
 * The presence-driven adaptive cadence policy from docs/plan/README.md Phase 25 ("No
 * realtime service — adaptive polling"): the only lever on how stale the MIRROR is, is how
 * often a Client polls for it. This is the one place that policy lives — apps/server's
 * {@link resolveCadence} call and each Client's {@link nextPollDelayMs} call both import it,
 * so the two sides can never drift apart.
 *
 * THERE IS NOW A PUSH CHANNEL, AND IT DOES NOT CHANGE ANY NUMBER HERE
 * ------------------------------------------------------------------
 * Phase 25 wrote the paragraph above when nothing was pushed at all. Phase 26's successor
 * round added one (`/v1/events`, SSE — `apps/server/src/events/`), so the premise "nothing
 * is pushed" has expired while every number below has not, and the distinction is worth
 * being exact about: the stream carries ENGINE EVENTS (a transcript line, `task:changed`),
 * and the mirror's task and project ROWS still travel only on the poll this file paces.
 *
 * So a browser watching a live SSE stream still polls `GET /v1/board` at the cadence set
 * here, and still beats presence on its own timer — `useCloudBoard.ts` builds the poller and
 * the heartbeat as two effects that neither know nor care whether the stream is up. Wiring
 * the tiers to the stream's health would be a real change, not a tidy-up: it would make the
 * mirror's freshness depend on a channel whose whole design assumption is that it may drop.
 */

/** Two tiers in v1 — see the plan doc for why a third "warm" tier isn't built yet. */
export type CadenceTier = 'active' | 'idle';

/** ~2.5s while a session is focused, ~25s while it's merely open. */
export const CADENCE_MS: Record<CadenceTier, number> = { active: 2_500, idle: 25_000 };

/** ~3 missed idle beats before a presence entry is treated as gone. */
export const PRESENCE_TTL_MS = 90_000;

/** Ceiling for exponential poll backoff after repeated failures. */
export const BACKOFF_CAP_MS = 300_000;

export interface CadenceDirective {
  tier: CadenceTier;
  intervalMs: number;
  reason: 'web-focused' | 'client-focused' | 'no-focus';
}

/** Which runtime sent a presence beat — used only to label {@link CadenceDirective.reason}. */
export type PresenceSource = 'web' | 'client';

/** One session's last-known focus state, as read from the server's in-memory presence map. */
export interface PresenceBeat {
  clientId: string;
  source: PresenceSource;
  focused: boolean;
  /** Epoch ms this beat was received. */
  lastSeen: number;
}

/**
 * Server side: active if ANY session on the account beat recently AND said it was
 * focused — one focused tab or window anywhere is enough to keep the whole account fast,
 * since every session mirrors the same board. A session that hasn't beaten within
 * {@link PRESENCE_TTL_MS} doesn't count, so a Client that vanished without saying so
 * (closed, machine asleep) stops holding the account on the fast tier once it ages out.
 */
export function resolveCadence(sessions: readonly PresenceBeat[], now: number): CadenceDirective {
  const focused = sessions.find((s) => s.focused && now - s.lastSeen <= PRESENCE_TTL_MS);

  if (!focused) {
    return { tier: 'idle', intervalMs: CADENCE_MS.idle, reason: 'no-focus' };
  }

  return {
    tier: 'active',
    intervalMs: CADENCE_MS.active,
    reason: focused.source === 'web' ? 'web-focused' : 'client-focused',
  };
}

/**
 * Client side: fastest wins, then backoff, then jitter.
 *
 * `min(serverIntervalMs, localFocused ? active : idle)` — the server's directive covers
 * every session on the account, but this Client's OWN focus state can only ever pull that
 * down, never push it up: if the server says idle but this window is focused right now,
 * there's no reason to wait 25s to find that out locally too.
 *
 * A run of failures backs that off exponentially, capped at {@link BACKOFF_CAP_MS} so a
 * long outage doesn't grow the wait forever.
 *
 * Jitter — for the same reason `AppSettings.limitJitterMs` exists, so many parked apps
 * don't all retry the same instant — is applied to the idle tier only. Jittering a 2.5s
 * beat buys nothing (nothing is thundering at that cadence) and costs liveness, so it's
 * skipped whenever the winning interval is the fast one.
 */
export function nextPollDelayMs(input: {
  serverIntervalMs: number;
  localFocused: boolean;
  consecutiveFailures: number;
  jitterRatio: number;
  random: () => number;
}): number {
  const { serverIntervalMs, localFocused, consecutiveFailures, jitterRatio, random } = input;

  const localTierMs = localFocused ? CADENCE_MS.active : CADENCE_MS.idle;
  const base = Math.min(serverIntervalMs, localTierMs);

  const withBackoff =
    consecutiveFailures > 0 ? Math.min(base * 2 ** consecutiveFailures, BACKOFF_CAP_MS) : base;

  if (base < CADENCE_MS.idle) return withBackoff;

  const jitterFactor = 1 + jitterRatio * (random() * 2 - 1);
  return Math.round(withBackoff * jitterFactor);
}
