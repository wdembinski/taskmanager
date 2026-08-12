import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * What a relayed command ANSWERED, on its way back to whoever is awaiting it.
 *
 * A separate table from `commands` rather than four more columns on it, for one reason
 * apiece: a result arrives on a different request from the one that queued the command (the
 * applying Client's next `/v1/sync`), it is read by a different route on a different cadence
 * (`GET /v1/results`), and it needs its own `rowVersion` cursor so a browser can ask "what
 * have you got since ..." without paging the command queue.
 *
 * `issuedBy` is copied from the command rather than joined for: it is what the results read
 * is SCOPED by, and a per-request join to enforce a scope is a scope one refactor away from
 * being dropped. Results are per-tab — two browser sessions on one account each await only
 * their own — which is exactly the distinction `BoardResponse` does not make.
 *
 * `value` is the channel's own return value as JSON text, `NULL` for a channel that resolves
 * to `undefined` (plenty do — `Promise<void>` is a common `IpcApi` shape) and for a failure.
 * Untyped here for the reason `Command.payload` is: this table stores and relays, it never
 * interprets.
 */
@Entity('command_results')
export class CommandResultRow {
  /** The `CommandEnvelope.id` this answers. One result per command, so it is the key. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  commandId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** The Client id that issued the command — the scope `GET /v1/results` filters on. */
  @Index()
  @Column({ type: 'nvarchar', length: 128 })
  issuedBy!: string;

  @Column({ type: 'bit' })
  ok!: boolean;

  /** JSON text, or null. See the class docstring. */
  @Column({ type: 'nvarchar', length: 'MAX', nullable: true })
  value!: string | null;

  /** The handler's message, verbatim. Null on success. */
  @Column({ type: 'nvarchar', length: 'MAX', nullable: true })
  error!: string | null;

  /**
   * Database-maintained, the same mechanism `TaskMirror`/`ProjectMirror` use for
   * `GET /v1/board?since=` — unique and increasing across the whole database, so a browser's
   * `since` cursor can never skip a row written while it was reading.
   */
  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;

  @CreateDateColumn()
  createdAt!: Date;
}
