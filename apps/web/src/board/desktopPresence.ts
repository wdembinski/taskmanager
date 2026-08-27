/**
 * Whether a desktop Client is out there at all — a claim about ANOTHER machine, which is why
 * this is its own file rather than a rule folded into `syncGate.ts`: that module latches
 * whether THIS tab's own read loop has caught up, a fact this tab can prove for itself the
 * moment its first poll lands. Whether a desktop is present is never provable that fast —
 * `clients` empty on the first poll back is exactly what a healthy desktop mid-deploy looks
 * like too — so the honest answer starts at `unknown` and only becomes `offline` after waiting
 * out a grace period, never on the strength of a single empty response.
 *
 * `pollError` is deliberately not an input here. `App.tsx`'s banner order already puts
 * `UnreachableBanner` ahead of `StaleBanner` for the same reason: a tab that cannot reach the
 * server has no evidence about a desktop one way or the other, and merging the two questions
 * is the bug this file exists to not repeat.
 */
import { BACKOFF_CAP_MS } from '@tm/protocol/cadence';
import type { ClientPresence } from '@tm/protocol/wire';

export type DesktopPresence = 'unknown' | 'online' | 'offline';

/**
 * How long an absent desktop stays `unknown` rather than `offline` — imported rather than a
 * fresh constant, because `BACKOFF_CAP_MS` is already this repo's answer to "how long may a
 * healthy desktop legitimately be missing" (see its own docstring: a deploy erases the
 * server's in-memory presence map, and `CADENCE_MS.idle` alone would put a recovering client's
 * `nextPollDelayMs` at up to 50s — well past a shorter grace).
 */
export const DESKTOP_PRESENCE_GRACE_MS = BACKOFF_CAP_MS;

/**
 * Rules, in order:
 *  1. No poll has come back at all (`lastPolledAt === null`) → `unknown`. This tab has no
 *     evidence yet, positive or negative.
 *  2. A live Client is in the response → `online`.
 *  3. No Client has ever gone missing (`missingSince === null`) → `unknown` — covers the one
 *     poll between "never polled" and "first empty response" landing in the same tick.
 *  4. Still inside the grace window since it went missing → `unknown`.
 *  5. Past the grace window → `offline`.
 */
export function desktopPresence(input: {
  clients: readonly ClientPresence[];
  missingSince: number | null;
  lastPolledAt: number | null;
  now: number;
  graceMs?: number;
}): DesktopPresence {
  const { clients, missingSince, lastPolledAt, now, graceMs = DESKTOP_PRESENCE_GRACE_MS } = input;
  if (lastPolledAt === null) return 'unknown';
  if (clients.length > 0) return 'online';
  if (missingSince === null) return 'unknown';
  if (now - missingSince < graceMs) return 'unknown';
  return 'offline';
}
