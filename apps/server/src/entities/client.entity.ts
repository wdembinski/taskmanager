import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A registered Client (a desktop app instance or a web session) — the
 * `clientId` a {@link SyncRequest} carries and a {@link CommandRequest}
 * targets.
 *
 * Rows are upserted lazily, the first time a Client's id is seen on
 * `POST /v1/sync` — there is no separate registration step. Presence
 * (focused/lastSeen) deliberately does NOT live here: per docs/plan/README.md
 * Phase 25 ("No realtime service — adaptive polling"), presence is an
 * in-memory map on the server, not a database row, so this table stays purely
 * "which Clients exist" rather than growing a write on every poll.
 *
 * The four `ClientInfo` columns are the exception, and they are the reason the
 * distinction above survives: they say WHO a Client is, which changes when the
 * machine is renamed or the app is updated — roughly never — so writing them on
 * the upsert that already happens costs nothing per poll. `lastSeen` would have
 * cost a write on every one. All four are nullable: a row that predates
 * `SyncRequest.info` has never been told, and the browser names that Client by
 * its id exactly as it did before.
 */
@Entity('clients')
export class Client {
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** `os.hostname()` on the desktop — see `ClientInfo` on `@tm/protocol/wire`. */
  @Column({ type: 'nvarchar', length: 128, nullable: true })
  name!: string | null;

  /** `process.platform` — `win32` / `linux` / `darwin`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  platform!: string | null;

  /** The desktop app's own version, `app.getVersion()`. */
  @Column({ type: 'nvarchar', length: 64, nullable: true })
  appVersion!: string | null;

  /** `PROTOCOL_VERSION` as that Client understands it — the web's version-skew warning. */
  @Column({ type: 'int', nullable: true })
  protocolVersion!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
