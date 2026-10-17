import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { Milestone } from '@tm/shared/model';

/**
 * The server's mirror of one desktop Client's `Milestone` row (F14.11). See
 * {@link TaskMirror} for why the whole domain object is carried as one JSON column (importing
 * `Milestone` from `@tm/shared/model`, not redeclaring it) rather than a column per field, and
 * why `rowVersion` is what makes `GET /v1/board?since=<rowversion>` possible.
 *
 * `projectId` is indexed for the same reason `TaskMirror.projectId` is: per-project reads, and
 * `deleteProject`'s cascade needs to find a project's milestones without a table scan. It also
 * doubles as F19's future per-workspace read, the same role `TaskMirror.projectId` already
 * plays there.
 */
@Entity('milestone_mirrors')
export class MilestoneMirror {
  /** Same id as the mirrored `Milestone` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 36 })
  projectId!: string;

  @Column({ type: 'simple-json' })
  data!: Milestone;

  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;
}
