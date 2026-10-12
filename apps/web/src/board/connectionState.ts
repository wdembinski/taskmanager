/**
 * Picks the one worst thing to say about this tab's connection to the cloud service, out of
 * the three banners `App.tsx` already draws (F3.2): `UnreachableBanner`, `StaleBanner`,
 * `SkewBanner`. Lives beside them rather than inside `App.tsx` because the compact shell's
 * `StatusStrip` needs the exact same verdict rendered as one line instead of three banner
 * components, and a second copy of the ordering rule is how it would drift from the wide
 * layout's.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Order is unreachable > stale > skew — moved verbatim from `App.tsx`'s own banner
 *   comment.** A tab that cannot reach the server at all has no evidence about a desktop one
 *   way or the other, so it must outrank a claim ("no desktop has synced") that presupposes a
 *   working read. Stale outranks skew because skew cannot matter until a desktop is actually
 *   back (`App.tsx`: "Version skew, which cannot matter until a Client is back").
 * - **`worstConnectionState` takes the three raw inputs, not the three banner props**, so the
 *   wide `App.tsx` and the compact `StatusStrip` can each pass what they already compute
 *   (`board.pollError`, `presence === 'offline'` plus `everSeenClient`, `versionSkew(...)`
 *   plus `board.targetClient`) without either side re-deriving the other's shape.
 *   `unreachable` is the message string itself (or `null`); `stale`/`skew` are `null` exactly
 *   when that condition does not hold, mirroring the ternary chain `App.tsx` already has.
 * - **`connectionStripText` is strip-only** — it never renders a `MessageBar`, only the one
 *   line of text the strip shows plus the intent that colours it. `unreachable` and `stale`
 *   are `'error'`/`'warning'` the same way the wide banners already are (`UnreachableBanner`
 *   is `intent="error"`, `StaleBanner`/`SkewBanner` are `intent="warning"`); wording reuses
 *   `describeClient` for the skew case exactly as `SkewBanner` does, so the two surfaces never
 *   name a Client differently.
 * - **Wide `App.tsx`'s banner block becomes a `switch` over this same result**, replacing its
 *   nested ternary — same three components, same props, so the rendered wide tree is
 *   unchanged and the ordering lives only here from then on. That edit is NOT part of this
 *   step; it lands once this module itself does.
 */
import type { ClientPresence } from '@tm/protocol/wire';
import { describeClient, type VersionSkew } from './targetClient';

/** `StaleBanner`'s one input, renamed here to say what it's about rather than just echoing
 *  the prop. */
export interface StaleInput {
  everSeenClient: boolean;
}

/** `SkewBanner`'s two inputs, bundled — a skew direction is meaningless without the Client
 *  it's being compared against. */
export interface SkewInput {
  skew: VersionSkew;
  client: ClientPresence;
}

/** The one connection problem worth saying right now, or `null` when none applies. Mirrors
 *  `UnreachableBanner`/`StaleBanner`/`SkewBanner`'s own props exactly, so either renderer can
 *  be driven straight off the matching variant. */
export type ConnectionState =
  | { kind: 'unreachable'; message: string }
  | { kind: 'stale'; everSeenClient: boolean }
  | { kind: 'skew'; skew: VersionSkew; client: ClientPresence };

/**
 * The worst of the three, in the order fixed above — `null` when none of the three inputs is
 * set. `unreachable` wins outright; between `stale` and `skew`, `stale` wins.
 */
export function worstConnectionState(
  unreachable: string | null,
  stale: StaleInput | null,
  skew: SkewInput | null,
): ConnectionState | null {
  if (unreachable !== null) return { kind: 'unreachable', message: unreachable };
  if (stale !== null) return { kind: 'stale', everSeenClient: stale.everSeenClient };
  if (skew !== null) return { kind: 'skew', skew: skew.skew, client: skew.client };
  return null;
}

/**
 * The compact strip's one line for `state` — intent plus wording, reusing `describeClient`
 * for the `skew` case so the strip and `SkewBanner` never name a Client differently.
 */
export function connectionStripText(state: ConnectionState): {
  intent: 'error' | 'warning';
  text: string;
} {
  switch (state.kind) {
    case 'unreachable':
      return { intent: 'error', text: `Cannot reach the cloud service — ${state.message}` };
    case 'stale':
      return {
        intent: 'warning',
        text: state.everSeenClient
          ? 'No desktop app has synced recently.'
          : 'No desktop app has ever synced this account.',
      };
    case 'skew': {
      const name = describeClient(state.client);
      return {
        intent: 'warning',
        text:
          state.skew === 'desktop-older'
            ? `${name} is running an older version of the app.`
            : `${name} is running a newer version of the app.`,
      };
    }
  }
}
