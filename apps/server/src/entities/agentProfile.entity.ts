import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';

/**
 * A reusable run configuration a ticket can be queued against (`Assignment.profileId`,
 * `@tm/shared/agent`'s own docstring has the full "why a queue, not `agentProjectId`"
 * story). Real columns, not a `data` JSON blob like `ProjectMirror`/`TaskMirror`: this
 * table originates here — there is no desktop-side row it mirrors — so there is no
 * drift to guard against by carrying the whole shared type in one column.
 *
 * `updatedAt` is a plain column the service stamps on every write, not
 * `@UpdateDateColumn()`: every write here goes through `manager.upsert(...)`
 * (`TicketsService`'s own convention), and an upsert is a raw INSERT/UPDATE that does
 * not run through the listener a decorator like that relies on.
 */
@Entity('agent_profiles')
export class AgentProfile {
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Index()
  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Column({ type: 'nvarchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  model!: ClaudeModel;

  @Column({ type: 'varchar', length: 32 })
  permissionMode!: PermissionMode;

  @Column({ type: 'nvarchar', length: 36, nullable: true })
  defaultProjectId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'datetime2' })
  updatedAt!: Date;
}
