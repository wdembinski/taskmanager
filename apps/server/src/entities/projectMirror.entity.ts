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

  /**
   * The ticket-number allocator for a `kind: 'ticket'` project — mirrors the desktop's own
   * `projects.ticketSeq` column (`apps/client/src/main/store.ts`). Deliberately NOT part of
   * `data`/`Project`: `Project.ticketPrefix`'s docstring explains why the allocator is a
   * counter, not a property, and folding it into the JSON blob would let a naive whole-object
   * write silently reset it. Zero for every project that is not a ticket project, and for a
   * ticket project that has not issued a key yet.
   */
  @Column({ type: 'int', default: 0 })
  ticketSeq!: number;

  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;
}
