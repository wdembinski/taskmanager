/**
 * This browser tab's own `clientId` — the `X-TM-Client-Id` header on `GET /v1/board` and
 * the `PresenceRegistry` key the server files its beat under (see `@tm/protocol/wire`'s
 * `BOARD_CLIENT_HEADER` docstring). Persisted in `localStorage` rather than minted fresh
 * per tab: a stable id is what lets the server's presence map recognise "the same session
 * polling again" across a reload instead of leaking a new entry (which ages out on its own
 * via `PRESENCE_TTL_MS`, but there is no reason to churn one every reload either).
 *
 * Prefixed `web-` so a log line or a `ClientPresence.id` reads as which kind of Client it
 * is at a glance — the desktop build mints its own id the same way (`store.ts`'s
 * `loadCloudClientId`) with no such prefix, since a desktop install only ever has one.
 */
const STORAGE_KEY = 'tm.cloud.clientId';

export function getOrCreateClientId(storage: Storage): string {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const fresh = `web-${crypto.randomUUID()}`;
  storage.setItem(STORAGE_KEY, fresh);
  return fresh;
}
