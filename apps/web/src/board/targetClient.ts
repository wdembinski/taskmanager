import type { ClientPresence } from '@tm/protocol/wire';

const LAST_KNOWN_CLIENT_KEY = 'tm.cloud.lastKnownDesktopClientId';

/**
 * Which desktop Client a queued command (`POST /v1/commands`'s `targetClientId`) should go
 * to: the most recently seen live one, from `GET /v1/board`'s own `clients` list. Remembered
 * in `localStorage` so a command still has somewhere to go the instant a Client's presence
 * entry lapses between polls (see `PRESENCE_TTL_MS`) — the queue outlives that, only the
 * *banner* (`clients.length === 0`) needs to know it happened.
 *
 * `null` only for an account this browser has never once seen a live desktop Client on —
 * there is nowhere at all to send a command, and `BoardScreen` disables editing rather than
 * queue one with no addressee.
 */
export function resolveTargetClientId(storage: Storage, clients: readonly ClientPresence[]): string | null {
  const mostRecent = clients[0]?.id;
  if (mostRecent) {
    storage.setItem(LAST_KNOWN_CLIENT_KEY, mostRecent);
    return mostRecent;
  }
  return storage.getItem(LAST_KNOWN_CLIENT_KEY);
}
