import type { CommandEnvelope, CommandKind } from '@tm/protocol/wire';
import type { Command } from '../entities/command.entity';

/**
 * `Command` (the row, mssql `bigint`/`varchar` columns, untyped `payload`)
 * back to `CommandEnvelope` (the wire contract's discriminated union).
 *
 * The cast on `kind`/`payload` is deliberate, not an oversight: the database
 * stores whatever the caller sent as opaque JSON (see command.entity.ts's
 * docstring — this table relays, it never interprets), so nothing here can
 * verify the payload actually matches its kind. That verification already
 * happened once, on the way IN via `POST /v1/commands` accepting a real
 * `CommandEnvelope`; a row read back out is trusted to still be one.
 */
export function toCommandEnvelope(
  row: Pick<Command, 'id' | 'issuedAt' | 'issuedBy' | 'kind' | 'payload'>,
): CommandEnvelope {
  return {
    id: row.id,
    issuedAt: Number(row.issuedAt),
    issuedBy: row.issuedBy,
    kind: row.kind as CommandKind,
    payload: row.payload,
  } as CommandEnvelope;
}
