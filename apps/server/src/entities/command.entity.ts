import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A queued {@link CommandEnvelope} (@tm/protocol/wire), relayed from one
 * Client to another via `POST /v1/commands` and delivered on the target's
 * next `POST /v1/sync`.
 *
 * `id` is the envelope's own id (caller-assigned), not server-generated —
 * acking is by that id (see wire.ts), so the server must keep it rather than
 * mint a second one. `payload` is untyped JSON here: {@link CommandKind}'s
 * discriminated union lives in the wire contract, not the database row: this
 * table only stores and relays, it never interprets a payload.
 *
 * Rows are kept (not deleted) once delivered, marked via `deliveredAt` — a
 * small audit trail of what was relayed, and it means `POST /v1/sync` never
 * has to reason about a queue that shrinks out from under it.
 *
 * `deliveredAt` is a LEASE, not a tombstone: it used to be the whole filter
 * (`deliveredAt IS NULL`), which made delivery at-most-once while every
 * docstring on the wire claimed at-least-once — a command whose HTTP response
 * was lost was never sent again. `ackedAt` is what actually retires a row now.
 * See ../mirror/commandQueue.ts for the rule and why the lease is as long as
 * it is.
 */
@Entity('commands')
export class Command {
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  targetClientId!: string;

  /**
   * Epoch ms, stored as bigint. TypeORM returns mssql `bigint` columns as
   * strings to avoid silent precision loss — see ../mirror/commandMapping.ts
   * for the trip back to the wire contract's `number`.
   */
  @Column({ type: 'bigint' })
  issuedAt!: string;

  @Column({ type: 'nvarchar', length: 128 })
  issuedBy!: string;

  /** A {@link CommandKind} string, stored untyped — see the class docstring. */
  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  @Column({ type: 'simple-json' })
  payload!: unknown;

  /** When this row was last put on the wire. Null until its first delivery. */
  @Index()
  @Column({ type: 'datetime2', nullable: true })
  deliveredAt!: Date | null;

  /**
   * When the target Client confirmed it had this command
   * (`SyncRequest.ackedCommandIds`). Null means it is still owed, whatever
   * `deliveredAt` says — which is the whole point of having both.
   */
  @Index()
  @Column({ type: 'datetime2', nullable: true })
  ackedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
