import { CADENCE_MS } from '@tm/protocol/cadence';
import type { CadenceDirective } from '@tm/protocol/cadence';

/**
 * Cadence is server-decided policy (docs/plan/README.md Phase 25, "No
 * realtime service — adaptive polling"), but the presence map that would let
 * the server tell a focused Client apart from an idle one is "Serve
 * presence-driven cadence from the server" — the next step, not this one.
 * Until then every caller is told to poll at the idle tier: always a safe,
 * conservative answer, never a wrong one, just not yet adaptive.
 */
export const IDLE_CADENCE: CadenceDirective = {
  tier: 'idle',
  intervalMs: CADENCE_MS.idle,
  reason: 'no-focus',
};
