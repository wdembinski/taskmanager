import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { Automation } from '@tm/shared/automation';

/**
 * The server's mirror of one desktop Client's `Automation` row (F1.12).
 *
 * `clientId` is NOT simply a copy of `data.ownerClientId`. An automation's own
 * `ownerClientId` is written relative to whichever desktop holds it locally — `null` means
 * "this one," that desktop's own perspective on itself — which means nothing once the row
 * has left that desktop. `applyAutomationDelta` resolves `null` to the syncing
 * `SyncRequest.clientId` before it ever reaches this column, so `clientId` here always names
 * an actual desktop.
 *
 * No `rowVersion`, unlike `TaskMirror`/`ProjectMirror`: this table is not read through
 * `GET /v1/board`'s incremental catch-up. `GET /v1/automations` reads an account's whole set
 * every time, the same way `GET /v1/settings` reads one whole blob — so there is no cursor
 * for it to advance. `updatedAt` is a plain epoch ms, copied from `Automation.updatedAt`.
 */
@Entity('automation_mirrors')
export class AutomationMirror {
  /** Same id as the mirrored `Automation` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** The desktop this automation actually belongs to — see the class docstring. */
  @Column({ type: 'nvarchar', length: 64 })
  clientId!: string;

  @Column({ type: 'simple-json' })
  data!: Automation;

  /**
   * Epoch ms, stored as bigint. TypeORM returns mssql `bigint` columns as strings to avoid
   * silent precision loss — same convention as `Command.issuedAt`. Reads go through `data`
   * (a real `number` inside the JSON blob), not this column, so the string round trip never
   * reaches a caller.
   */
  @Column({ type: 'bigint' })
  updatedAt!: string;
}
