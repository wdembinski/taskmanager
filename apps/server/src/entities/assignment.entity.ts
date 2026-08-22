import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { AssignmentStatus } from '@tm/shared/agent';

/**
 * One queued ticket: `AgentProfile.id` + `TaskMirror.id`, and where it stands in the
 * claim/run lifecycle (`AssignmentStatus`'s own docstring in `@tm/shared/agent` has the
 * state machine). Real columns for the same reason as `AgentProfile`: this row
 * originates here, so a whole-object `data` blob would only add drift to guard
 * against, not remove any.
 *
 * `updatedAt` is a plain, service-stamped column, not `@UpdateDateColumn()` — see
 * `AgentProfile`'s own docstring for why: every write here goes through
 * `manager.upsert(...)`, which bypasses that decorator's listener.
 */
@Entity('assignments')
export class Assignment {
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 36 })
  projectId!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 36 })
  ticketId!: string;

  @Column({ type: 'nvarchar', length: 36 })
  profileId!: string;

  /** An {@link AssignmentStatus} string. Indexed: the desktop poller's whole query is
   *  "queued rows for a project I serve", i.e. filtered by this column first. */
  @Index()
  @Column({ type: 'varchar', length: 16 })
  status!: AssignmentStatus;

  /** The desktop `Client` id that claimed this row. Null until claimed. */
  @Column({ type: 'nvarchar', length: 64, nullable: true })
  claimedByClientId!: string | null;

  @Column({ type: 'datetime2', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'datetime2', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'datetime2', nullable: true })
  completedAt!: Date | null;

  /** The scheduler's own `runId` for the session this assignment started, once known. */
  @Column({ type: 'nvarchar', length: 64, nullable: true })
  runId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'datetime2' })
  updatedAt!: Date;
}
