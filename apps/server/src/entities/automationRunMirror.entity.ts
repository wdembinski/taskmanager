import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { AutomationRun } from '@tm/shared/automation';

/**
 * The server's mirror of one `AutomationRun` receipt (F1.12) — a desktop's run log for an
 * automation, pushed up the same way its `Automation` rows are.
 *
 * No `rowVersion`, for the same reason `AutomationMirror` has none: `GET
 * /v1/automations/:id/runs` reads newest-first off the `(accountId, automationId, at)` index
 * below, not an incremental catch-up cursor. `applyAutomationDelta`'s retention sweep
 * (`runsToPrune`) reads and deletes against that same shape, scoped to one automation.
 */
@Entity('automation_run_mirrors')
@Index(['accountId', 'automationId', 'at'])
export class AutomationRunMirror {
  /** Same id as the mirrored `AutomationRun`. */
  @PrimaryColumn({ type: 'nvarchar', length: 36 })
  id!: string;

  @Column({ type: 'nvarchar', length: 64 })
  accountId!: string;

  @Column({ type: 'nvarchar', length: 36 })
  automationId!: string;

  @Column({ type: 'simple-json' })
  data!: AutomationRun;

  /**
   * Epoch ms, stored as bigint — same string round trip as `AutomationMirror.updatedAt`, and
   * the same reason reads go through `data` rather than this column.
   */
  @Column({ type: 'bigint' })
  at!: string;
}
