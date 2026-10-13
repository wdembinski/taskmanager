/**
 * Which of the three things `WebActivityScreen` can be showing — a pure read of the exact
 * same signals the status bar already computes (`desktopPresence.ts`'s `DesktopPresence`,
 * `useCloudBoard.ts`'s `pollError`), same pattern as `connectionState.ts`'s own
 * `worstConnectionState`. A separate module rather than a branch inside the screen, so the
 * three-way choice is a fact table a test can enumerate without mounting anything.
 *
 * ## Design decisions fixed here
 *
 * - **`pollError` outranks `presence`.** A relay that cannot get through has no evidence about
 *   a desktop one way or the other — same ordering `connectionState.ts` already uses for the
 *   board's own banners, and the reason it's checked first regardless of what `presence` reads.
 * - **`presence === 'offline'` is also `unreachable`, not a fourth state.** Unlike the board
 *   (which still has a stale read to show under `StaleBanner`), there is nothing true an
 *   activity feed could display once its one source — a live desktop — is gone, so the gate
 *   folds that case into the same `unreachable` variant with its own message rather than
 *   introducing a `stale`-style state nothing downstream could render differently anyway.
 * - **`ready` requires a `targetClientId`, not just `presence === 'online'`.** `presence` can
 *   read `'online'` for a tick before `useCloudBoard` has picked a target Client (the picker's
 *   own selection round trip) — the Activity tab has nothing to key a per-desktop cursor
 *   against until a target exists, so that gap reads as `checking`, same as a `presence` that
 *   hasn't resolved yet.
 */
import type { DesktopPresence } from '../board/desktopPresence';

export type ActivityGateState =
  { kind: 'unreachable'; message: string } | { kind: 'checking' } | { kind: 'ready' };

export function activityGate(input: {
  pollError: string | null;
  presence: DesktopPresence;
  targetClientId: string | null;
}): ActivityGateState {
  if (input.pollError !== null) return { kind: 'unreachable', message: input.pollError };
  if (input.presence === 'offline') {
    return { kind: 'unreachable', message: 'No desktop app is currently online.' };
  }
  if (input.presence === 'unknown' || input.targetClientId === null) return { kind: 'checking' };
  return { kind: 'ready' };
}
