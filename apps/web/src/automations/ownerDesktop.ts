/**
 * Whether the desktop that owns an automation is live right now — from THIS tab's own
 * memory of it, which is the only memory there is: presence is an in-memory map on the
 * server, rebuilt from beats and never written to a durable row (`client.entity.ts`), so a
 * desktop that has been gone longer than `PRESENCE_TTL_MS` (90s) is simply absent from
 * `BoardResponse.clients` — there is no "last seen 3 hours ago" to ask the server for.
 *
 * Three states rather than `desktopPresence.ts`'s two-into-grace shape, because the
 * banner's copy differs for "this tab has never once seen that desktop" (`never-synced`)
 * versus "it was here, then went quiet" (`stale`) — `desktopPresence.ts` never has to tell
 * those apart since it only ever asks about ANY desktop, and the first poll back already
 * answers that one way or the other.
 */
import { BACKOFF_CAP_MS } from '@tm/protocol/cadence';
import type { ClientInfo, ClientPresence } from '@tm/protocol/wire';

export type OwnerDesktopState = 'live' | 'stale' | 'never-synced';

/** Same grace window as `desktopPresence.ts`'s own — see its `DESKTOP_PRESENCE_GRACE_MS`
 *  for why `BACKOFF_CAP_MS` is the shared answer to "how long may a healthy desktop
 *  legitimately go quiet". */
export const OWNER_DESKTOP_GRACE_MS = BACKOFF_CAP_MS;

/** What this tab remembers of one Client, kept past the moment it drops out of the live
 *  `clients` list — see this file's own header for why that memory has to live here. */
export interface RememberedClient {
  lastSeen: number;
  info?: ClientInfo;
}

export function ownerDesktopState(input: {
  lastSeen: number | null;
  now: number;
  graceMs?: number;
}): OwnerDesktopState {
  const { lastSeen, now, graceMs = OWNER_DESKTOP_GRACE_MS } = input;
  if (lastSeen === null) return 'never-synced';
  return now - lastSeen < graceMs ? 'live' : 'stale';
}

/**
 * Folds a fresh `clients` read into this tab's running memory, keyed by client id. Only
 * ever adds or refreshes an entry — a client missing from `clients` keeps whatever this tab
 * last saw it at, which is the whole reason this is a fold over time rather than a lookup
 * into the latest response alone.
 */
export function mergeLastSeen(
  prev: ReadonlyMap<string, RememberedClient>,
  clients: readonly ClientPresence[],
): ReadonlyMap<string, RememberedClient> {
  if (clients.length === 0) return prev;
  const next = new Map(prev);
  for (const client of clients)
    next.set(client.id, { lastSeen: client.lastSeen, info: client.info });
  return next;
}

/** The owning desktop's name, or the same short-id fallback `targetClient.ts`'s own
 *  `describeClient` uses — consistent naming for the same kind of absent `ClientInfo`. */
export function ownerDisplayName(
  ownerClientId: string,
  remembered: ReadonlyMap<string, RememberedClient>,
): string {
  return remembered.get(ownerClientId)?.info?.name ?? `desktop ${ownerClientId.slice(0, 8)}`;
}
