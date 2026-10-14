import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Skill } from '@tm/shared/skills';

/**
 * The server's mirror of one account's library `Skill`s (F7.11) — see `Skill`'s own
 * docstring in `@tm/shared/skills` for why this rides a dedicated `/v1/skills` endpoint
 * rather than `SyncRequest`.
 *
 * Composite primary key `(accountId, id)`, not `id` alone like `TaskMirror`/`ProjectMirror`.
 * A skill's `id` is minted on the desktop that creates it, with no account in the loop at
 * mint time, so two different accounts can mint the same uuid — vanishingly unlikely, but
 * `PUT /v1/skills/:id` is a bearer-scoped write with no cross-account existence check of its
 * own, and the composite key is what makes an id collision from account B physically unable
 * to touch account A's row rather than relying on every call site remembering to scope it.
 *
 * `deletedAt` is this table's own tombstone, not a row in the shared `tombstones` table:
 * that table is keyed and paged for a desktop Client's `/v1/sync` catch-up delta, and
 * `GET /v1/skills` has no cursor for a separate tombstone table to advance against — it
 * reads this account's whole set every time, the same reason `AutomationMirror` carries no
 * `rowVersion`. `data` is nulled alongside it to free the body; a `PUT` that revives the id
 * overwrites both in one upsert, so a revived skill's row never has one stale without the
 * other.
 */
@Entity('skill_mirrors')
export class SkillMirror {
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** Same id as the mirrored `Skill` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  /** Null once deleted — see the class docstring. */
  @Column({ type: 'simple-json', nullable: true })
  data!: Skill | null;

  /**
   * Epoch ms, or null while live. Stored as bigint, returned by the mssql driver as a
   * string to avoid silent precision loss — same convention as `PersonalAccessToken.revokedAt`.
   */
  @Column({ type: 'bigint', nullable: true })
  deletedAt!: string | null;

  /** Epoch ms, copied from `Skill.updatedAt`. Same string-for-bigint convention as above. */
  @Column({ type: 'bigint' })
  updatedAt!: string;
}
