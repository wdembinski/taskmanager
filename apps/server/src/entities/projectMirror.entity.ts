import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { Project } from '@tm/shared/model';

/**
 * The server's mirror of one desktop Client's `Project` row. See
 * {@link TaskMirror} for why the whole domain object is carried as one JSON
 * column (importing `Project` from `@tm/shared/model`, not redeclaring it)
 * rather than a column per field, and why `rowVersion` is what makes
 * `GET /v1/board?since=<rowversion>` possible.
 */
@Entity('project_mirrors')
export class ProjectMirror {
  /** Same id as the mirrored `Project` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Column({ type: 'simple-json' })
  data!: Project;

  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;
}
