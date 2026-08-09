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
 */
@Entity('clients')
export class Client {
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
