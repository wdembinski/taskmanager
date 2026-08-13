/**
 * The two halves of "who is this Client" — request in, presence out.
 *
 * Both are pure, and here rather than inline in `mirror.service.ts`, because both are rules
 * rather than plumbing: which columns a sync is allowed to overwrite (the answer is "only
 * the ones it actually said"), and when a row is worth describing at all. The service around
 * them needs a database to run; these need nothing, and are tested accordingly.
 */
import type { ClientInfo, ClientPresence, SyncRequest } from '@tm/protocol/wire';
import type { Client } from '../entities/client.entity';

/** The `clients` columns `ClientInfo` owns. */
type InfoColumns = Pick<Client, 'name' | 'platform' | 'appVersion' | 'protocolVersion'>;

/**
 * What one sync should write to its Client's row, as columns.
 *
 * Only the fields the request actually carried, which is the whole point of building this by
 * hand: `manager.upsert` derives its update set from the keys present, so an omitted key
 * leaves the stored value alone. Spreading a `ClientInfo` with `undefined` holes in it, or
 * defaulting the misses to null, would let a Client that says nothing this tick erase what it
 * said last tick — and the commonest sender of nothing is a build that predates the field.
 *
 * `protocolVersion` falls back to {@link SyncRequest.protocolVersion}, the top-level number a
 * Client has been sending since before `info` existed. It is the same fact, and taking it
 * means a desktop too old to name itself can still be caught by the skew warning once this
 * contract moves past it — which is precisely the build that warning exists for.
 */
export function clientInfoColumns(request: SyncRequest): Partial<InfoColumns> {
  const info = request.info;
  const columns: Partial<InfoColumns> = {};
  if (info?.name !== undefined) columns.name = info.name;
  if (info?.platform !== undefined) columns.platform = info.platform;
  if (info?.appVersion !== undefined) columns.appVersion = info.appVersion;

  const protocolVersion = info?.protocolVersion ?? request.protocolVersion;
  if (protocolVersion !== undefined) columns.protocolVersion = protocolVersion;

  return columns;
}

/**
 * A stored row as the wire's `ClientInfo`, or `undefined` when the row says nothing at all —
 * a Client registered by a build that predates this. `undefined` rather than an empty object
 * so the browser's "did it tell us who it is?" is one check rather than four.
 */
export function toClientInfo(row: Pick<Client, keyof InfoColumns>): ClientInfo | undefined {
  const info: ClientInfo = {};
  if (row.name !== null) info.name = row.name;
  if (row.platform !== null) info.platform = row.platform;
  if (row.appVersion !== null) info.appVersion = row.appVersion;
  if (row.protocolVersion !== null) info.protocolVersion = row.protocolVersion;
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Joins the live presence entries to their stored identities.
 *
 * Presence order is preserved (most recently seen first — `PresenceService.clients`), and a
 * presence with no row behind it passes through untouched: a Client is live because it beat,
 * not because a row was found for it, and dropping it here would take away the command target
 * the browser is actually able to reach.
 */
export function describeClients(
  presences: readonly ClientPresence[],
  rows: readonly Pick<Client, 'id' | keyof InfoColumns>[],
): ClientPresence[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return presences.map((presence) => {
    const row = byId.get(presence.id);
    const info = row ? toClientInfo(row) : undefined;
    return info ? { ...presence, info } : presence;
  });
}
