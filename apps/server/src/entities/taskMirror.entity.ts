import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { Task } from '@tm/shared/model';

/**
 * The server's mirror of one desktop Client's `Task` row.
 *
 * `data` holds the whole domain object — imported from `@tm/shared/model`,
 * never redeclared here — because `Task` (packages/shared/src/model.ts) is
 * ~80 mostly-optional fields deep and growing; a mirror table with one column
 * per field would need a migration for every field `@tm/shared` ever adds,
 * exactly the kind of drift a mirror exists to avoid. `id`/`projectId` are
 * pulled out as real columns because the sync/board reads filter and join on
 * them; `rowVersion` is what makes this table CATCH-UP READABLE at all — see
 * its own docstring below.
 */
@Entity('task_mirrors')
export class TaskMirror {
  /** Same id as the mirrored `Task` — this table mirrors it, not re-keys it. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 36 })
  projectId!: string;

  @Column({ type: 'simple-json' })
  data!: Task;

  /**
   * SQL Server ROWVERSION: an 8-byte value the DATABASE maintains itself,
   * guaranteed to change to a value higher than any other row in the database
   * on every insert or update — never written by the app (`insert`/`update:
   * false`). This is the monotonic cursor `GET /v1/board?since=<rowversion>`
   * reads by: "everything with a rowVersion greater than what you last saw",
   * which a `updatedAt` timestamp could not answer as safely (clock skew,
   * same-millisecond writes) and an app-maintained counter could not answer
   * without a race between the write and the counter bump.
   */
  @Index()
  @Column({ type: 'rowversion', insert: false, update: false })
  rowVersion!: Buffer;
}
