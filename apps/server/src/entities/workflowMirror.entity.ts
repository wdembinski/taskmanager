import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { WorkflowDoc } from '@tm/shared/workflow';

/**
 * The server's mirror of one account's `WorkflowDoc`s (F8.12) — see `WorkflowDoc`'s own
 * docstring in `@tm/shared/workflow` for why this rides a dedicated `/v1/workflows`
 * endpoint rather than `SyncRequest`, same reasoning as `SkillMirror` (F7.11).
 *
 * Composite primary key `(accountId, id)`, not `id` alone like `TaskMirror`/`ProjectMirror`
 * — same reasoning as `SkillMirror`: a workflow's `id` is minted on the desktop that
 * creates it, with no account in the loop at mint time, so the composite key is what makes
 * an id collision from account B physically unable to touch account A's row.
 *
 * `id` is `nvarchar(64)`, not `(36)` like `SkillMirror`'s: a `WorkflowDoc.id` is an
 * arbitrary string chosen when the workflow is authored, not necessarily a uuid.
 *
 * `deletedAt` is this table's own tombstone, not a row in the shared `tombstones` table —
 * same reasoning as `SkillMirror`: `GET /v1/workflows` has no cursor to advance a separate
 * tombstone table against, so it reads this account's whole set every time. `data` is
 * nulled alongside it to free the body; a `PUT` that revives the id overwrites both in one
 * upsert, so a revived workflow's row never has one stale without the other.
 */
@Entity('workflow_mirrors')
export class WorkflowMirror {
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  accountId!: string;

  /** Same id as the mirrored `WorkflowDoc` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 64 })
  id!: string;

  /** Null once deleted — see the class docstring. */
  @Column({ type: 'simple-json', nullable: true })
  data!: WorkflowDoc | null;

  /**
   * Epoch ms, or null while live. Stored as bigint, returned by the mssql driver as a
   * string to avoid silent precision loss — same convention as `SkillMirror.deletedAt`.
   */
  @Column({ type: 'bigint', nullable: true })
  deletedAt!: string | null;

  /**
   * Epoch ms of the last write. Same string-for-bigint convention as above. Unlike
   * `SkillMirror.updatedAt`, this is not copied from the document itself — `WorkflowDoc`
   * carries no `updatedAt` field (see `workflowDocBytes`'s docstring on the fingerprint
   * convention instead) — so the service stamps it at write time.
   */
  @Column({ type: 'bigint' })
  updatedAt!: string;
}
