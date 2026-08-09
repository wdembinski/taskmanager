/**
 * The presence-driven adaptive cadence policy from docs/plan/README.md Phase 25 ("No
 * realtime service — adaptive polling"): v1 ships no realtime push channel, so the only
 * lever for staleness is how often a Client polls. This is the one place that policy
 * lives — apps/server's {@link resolveCadence} call and each Client's
 * {@link nextPollDelayMs} call both import it, so the two sides can never drift apart.
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
    consecutiveFailures > 0
      ? Math.min(base * 2 ** consecutiveFailures, BACKOFF_CAP_MS)
      : base;

  if (base < CADENCE_MS.idle) return withBackoff;

  const jitterFactor = 1 + jitterRatio * (random() * 2 - 1);
  return Math.round(withBackoff * jitterFactor);
}
