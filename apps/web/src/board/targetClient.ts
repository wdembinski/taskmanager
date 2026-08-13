/**
 * Which desktop this tab is driving, and what to call it.
 *
 * One module for both because they are one question asked twice: a picker cannot offer
 * choices it can't name, and a name is only worth showing because there might be more than
 * one. Both halves are pure over a `Storage` and a `ClientPresence[]`, so the whole of it is
 * testable without a browser.
 */
import { PROTOCOL_VERSION, type ClientPresence } from '@tm/protocol/wire';

const LAST_KNOWN_CLIENT_KEY = 'tm.cloud.lastKnownDesktopClientId';

/**
 * The desktop the human PICKED, as opposed to the one that happens to have polled most
 * recently. Its own key rather than writing the choice into `lastKnownDesktopClientId`: that
 * one is a record of what was observed and is overwritten on every poll, and a preference
 * that a single poll could silently overwrite is not a preference.
 */
const PREFERRED_CLIENT_KEY = 'tm.cloud.preferredDesktopClientId';

/**
 * Which desktop Client a queued command (`POST /v1/commands`'s `targetClientId`) should go
 * to, in order: the one this browser picked if it is live, else the most recently seen live
 * one, else the last one it ever saw. Remembered in `localStorage` so a command still has
 * somewhere to go the instant a Client's presence entry lapses between polls (see
 * `PRESENCE_TTL_MS`) — the queue outlives that, only the *banner* (`clients.length === 0`)
 * needs to know it happened.
 *
 * A preference for a Client that is NOT live is skipped rather than honoured, and deliberately
 * not cleared: the machine is off, not disowned, and it takes the target back the moment it
 * polls again. Meanwhile an edit made here goes to a desktop that can actually apply it.
 *
 * `null` only for an account this browser has never once seen a live desktop Client on —
 * there is nowhere at all to send a command, and `BoardScreen` disables editing rather than
 * queue one with no addressee.
 */
export function resolveTargetClientId(
  storage: Storage,
  clients: readonly ClientPresence[],
): string | null {
  const preferred = storage.getItem(PREFERRED_CLIENT_KEY);
  const chosen = preferred !== null && clients.some((c) => c.id === preferred) ? preferred : null;

  const mostRecent = chosen ?? clients[0]?.id;
  if (mostRecent) {
    storage.setItem(LAST_KNOWN_CLIENT_KEY, mostRecent);
    return mostRecent;
  }
  return storage.getItem(LAST_KNOWN_CLIENT_KEY);
}

/** Records the human's choice from the status bar's picker. Read back by
 *  {@link resolveTargetClientId} on the very next render. */
export function setPreferredClientId(storage: Storage, clientId: string): void {
  storage.setItem(PREFERRED_CLIENT_KEY, clientId);
}

/**
 * What to call a Client in one line: the machine's own name, or a short form of its id for
 * one that has never told us (a desktop older than `SyncRequest.info`).
 *
 * The id is truncated rather than shown whole because it is a UUID, it means nothing to
 * anybody, and its only job here is to tell two anonymous Clients apart — for which the first
 * eight characters are plenty and the other twenty-eight are just width taken off the rest of
 * the status bar.
 */
export function describeClient(client: ClientPresence): string {
  return client.info?.name ?? `desktop ${client.id.slice(0, 8)}`;
}

/** The same, with what it is running — `WORKSTATION · v0.84.5 · win32`. For the picker, which
 *  has the room, and where the version is the thing that tells two of the user's own machines
 *  apart. */
export function describeClientDetail(client: ClientPresence): string {
  const info = client.info;
  return [
    describeClient(client),
    info?.appVersion ? `v${info.appVersion}` : null,
    info?.platform ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * How this tab's `PROTOCOL_VERSION` compares to the one that desktop last reported.
 *
 * `null` for a match, and for a Client that has never said — an unknown version is not a
 * mismatch, and warning about one would fire on every desktop older than this feature, which
 * is all of them at the moment it ships.
 *
 * `desktop-older` is the case worth showing. It is the exact condition behind `ipcRegistry`'s
 * "…is probably older than the browser tab talking to it — update it and try again.", which
 * today is only discovered by clicking something and having it refuse; knowing it up front
 * turns a mysterious dead button into a sentence about the desktop app.
 *
 * `desktop-newer` is reported too, and it is the browser that is stale — a tab left open
 * across a deploy. Saying so beats the alternative, which is a tab quietly not knowing about
 * half the wire until somebody reloads it.
 */
export type VersionSkew = 'desktop-older' | 'desktop-newer';

export function versionSkew(
  client: ClientPresence | null,
  ours: number = PROTOCOL_VERSION,
): VersionSkew | null {
  const theirs = client?.info?.protocolVersion;
  if (theirs === undefined || theirs === ours) return null;
  return theirs < ours ? 'desktop-older' : 'desktop-newer';
}
